/**
 * CDP endpoint discovery (SPEC §5.1).
 *
 * Precedence: `PI_CHROME_CDP_WS` → `PI_CHROME_CDP_PORTS` → `DevToolsActivePort`
 * in the well-known profile dirs → plain port scan. The file step never probes
 * `/json/version`: on Chrome 136+ the default profile ignores
 * `--remote-debugging-port`, and enabling `chrome://inspect/#remote-debugging`
 * (tick "Discover network targets", Allow) writes `DevToolsActivePort` while the
 * HTTP endpoint stays disabled. In that state the file is the only truth, so it
 * must win without any HTTP answer.
 *
 * This module never launches Chrome, never writes to the profile and never
 * returns a non-loopback endpoint (AGENTS hard rules 1, 2, 4). Every probe is
 * bounded by `timeoutMs`; a timeout, a non-200 or malformed JSON is a miss for
 * that candidate, not an exception.
 */

import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ERROR_HINTS, RETRYABLE, WebSearchError } from "../runtime/error-codes.ts";
import type { CdpEndpoint, CdpSource } from "./types.ts";

/** Chrome answers `/json/version` instantly on loopback or not at all. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/** SPEC §5.1: 9222 is the last-resort candidate when no file exists. */
export const DEFAULT_PORTS: readonly number[] = [9222];

/**
 * Chrome always advertises its browser target as `/devtools/browser/<uuid>` —
 * both in `DevToolsActivePort` and in `/json/version`. Sources that read those
 * two must enforce it; a page target is only legitimate via the escape hatch.
 */
const BROWSER_PATH_PREFIX = "/devtools/browser/";

/**
 * Paths and port lines are used to build a URL, so whitespace, fragments,
 * queries and raw control bytes (which Node would percent-encode but Chrome
 * never writes) are all malformed. `\u007f` (DEL) is not matched by `\s`.
 */
const INVALID_URL_BYTES = /[\s\u0000-\u001f\u007f?#]/;

export type ReadTextFile = (path: string) => Promise<string>;
export type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>;

export type DevToolsActivePortReason =
  | "empty"
  | "port-not-numeric"
  | "port-out-of-range"
  | "missing-path"
  | "invalid-path";

export interface DevToolsActivePortEndpoint {
  port: number;
  /** Line 2 of the file, normalised to start with "/". */
  path: string;
  wsUrl: string;
}

/**
 * `parseDevToolsActivePort` never throws: malformed files are a normal miss
 * (another profile dir may still be valid), so they are reported as data.
 */
export type DevToolsActivePortResult =
  | { ok: true; endpoint: DevToolsActivePortEndpoint }
  | { ok: false; reason: DevToolsActivePortReason };

export interface DiscoverOptions {
  /** Environment to read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Explicit endpoint from config (`cdp.ws`). `loadConfig()` already folds
   * `PI_CHROME_CDP_WS` into that key, so an explicit value is the same thing
   * the env var would say; `null`/absent falls through to the raw env var.
   */
  ws?: string | null;
  /** Defaults to `node:fs/promises` `readFile(..., "utf8")`. */
  readFile?: ReadTextFile;
  /** Defaults to `fetch` with `AbortSignal.timeout`. */
  fetchJson?: FetchJson;
  /** Replaces the platform profile-dir list (tests, non-standard installs). */
  profileDirs?: readonly string[];
  /** Ports probed via `/json/version` after the file check. Defaults to `[9222]`. */
  ports?: readonly number[];
  /** Per-probe bound in ms. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Linux profile dirs from SPEC §5.1, in precedence order. Only Chrome is
 * officially supported; the other Chromium-family dirs are best-effort.
 */
const PROFILE_SUFFIXES = [
  ".config/google-chrome",
  ".config/google-chrome-beta",
  ".config/google-chrome-unstable",
  ".config/chromium",
  ".config/chromium-browser",
  ".config/BraveSoftware/Brave-Browser",
  ".config/microsoft-edge",
] as const;

export function parseDevToolsActivePort(text: string): DevToolsActivePortResult {
  const lines = text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) return { ok: false, reason: "empty" };

  const portText = lines[0];
  if (INVALID_URL_BYTES.test(portText) || !/^\d+$/.test(portText)) {
    return { ok: false, reason: "port-not-numeric" };
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "port-out-of-range" };
  }

  // Chrome writes "<port>\n/devtools/browser/<uuid>". A missing second line is
  // a truncated/foreign file, not a usable endpoint.
  if (lines.length < 2) return { ok: false, reason: "missing-path" };

  const rawPath = lines[1];
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  // Reject control bytes, whitespace/query bytes and any path that is not the
  // browser target Chrome advertises (the file is authoritative, so a foreign
  // shape means this file is not Chrome's).
  if (!path.startsWith(BROWSER_PATH_PREFIX) || INVALID_URL_BYTES.test(path)) {
    return { ok: false, reason: "invalid-path" };
  }

  return { ok: true, endpoint: { port, path, wsUrl: `ws://127.0.0.1:${port}${path}` } };
}

export async function discoverEndpoint(options: DiscoverOptions = {}): Promise<CdpEndpoint> {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultReadFile;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const timeoutMs = normaliseTimeout(options.timeoutMs);
  const notes: string[] = [];
  const probed = new Set<number>();

  // 1. A full URL is authoritative: the user pasted it from the DevTools UI.
  const optionWs = firstNonEmpty(options.ws);
  if (optionWs !== null) return endpointFromWsUrl(optionWs, "env-ws", "cdp.ws");

  const envWs = firstNonEmpty(env.PI_CHROME_CDP_WS);
  if (envWs !== null) return endpointFromWsUrl(envWs, "env-ws", "PI_CHROME_CDP_WS");
  notes.push("PI_CHROME_CDP_WS is unset");

  // 2. Explicit ports from the environment.
  const envPorts = parseEnvPorts(env.PI_CHROME_CDP_PORTS);
  if (envPorts !== null) {
    const found = await probePorts(envPorts, "env-ports", { fetchJson, timeoutMs, probed }, notes);
    if (found !== null) return found;
  } else {
    notes.push("PI_CHROME_CDP_PORTS is unset");
  }

  // 3. DevToolsActivePort files. No HTTP probe: see the module comment.
  const dirs = options.profileDirs ?? defaultProfileDirs();
  const profileNotes: string[] = [];
  for (const dir of dirs) {
    const file = join(dir, "DevToolsActivePort");
    let text: string;
    try {
      text = await withDeadline(readFile(file), `reading ${file}`, timeoutMs);
    } catch (error) {
      profileNotes.push(`${tildify(file)}: ${describeReadMiss(error)}`);
      continue;
    }

    const parsed = parseDevToolsActivePort(text);
    if (!parsed.ok) {
      profileNotes.push(`${tildify(file)}: malformed (${parsed.reason})`);
      continue;
    }

    return {
      port: parsed.endpoint.port,
      wsUrl: parsed.endpoint.wsUrl,
      source: "devtools-active-port",
      profileDir: dir,
    };
  }
  notes.push(
    profileNotes.length > 0
      ? `DevToolsActivePort: ${profileNotes.join(", ")}`
      : "no profile directories to inspect",
  );

  // 4. Configured candidates (default 9222), skipping ports already tried.
  const candidates = sanitisePorts(options.ports ?? DEFAULT_PORTS);
  const remaining = candidates.filter((port) => !probed.has(port));
  if (remaining.length > 0) {
    const found = await probePorts(remaining, "port-scan", { fetchJson, timeoutMs, probed }, notes);
    if (found !== null) return found;
  } else {
    notes.push("port scan: no unprobed candidate ports");
  }

  throw new WebSearchError({
    code: "E_CDP_UNAVAILABLE",
    stage: "discover",
    retryable: RETRYABLE.E_CDP_UNAVAILABLE,
    hint:
      `${ERROR_HINTS.E_CDP_UNAVAILABLE}; Chrome 136+ ignores --remote-debugging-port on the ` +
      "default profile, so the chrome://inspect toggle is the only way in; this extension " +
      "never launches Chrome for you.",
    message: `no CDP endpoint found; ${notes.join("; ")}`,
  });
}

interface ProbeContext {
  fetchJson: FetchJson;
  timeoutMs: number;
  /** Ports already tried by an earlier step, so a retry cannot happen by accident. */
  probed: Set<number>;
}

async function probePorts(
  ports: readonly number[],
  source: CdpSource,
  context: ProbeContext,
  notes: string[],
): Promise<CdpEndpoint | null> {
  for (const port of ports) {
    if (context.probed.has(port)) continue;
    context.probed.add(port);

    let payload: unknown;
    try {
      payload = await withDeadline(
        context.fetchJson(`http://127.0.0.1:${port}/json/version`, context.timeoutMs),
        `probe http://127.0.0.1:${port}/json/version`,
        context.timeoutMs,
      );
    } catch (error) {
      notes.push(`port ${port}: ${describeFetchMiss(error, context.timeoutMs)}`);
      continue;
    }

    const advertised = readAdvertisedWs(payload);
    if (!advertised.ok) {
      notes.push(`port ${port}: ${advertised.miss}`);
      continue;
    }

    // `port` is the TCP port we actually connected to; the advertised URL may
    // omit its port (Node then resolves ws → 80/wss → 443) or name a different
    // one. We keep `wsUrl` exactly as advertised (loopback-checked, browser
    // path enforced) but report the probed port so callers never re-derive it
    // from a URL default.
    return { port, wsUrl: advertised.wsUrl, source };
  }
  return null;
}

type AdvertisedWs = { ok: true; wsUrl: string } | { ok: false; miss: string };

function readAdvertisedWs(payload: unknown): AdvertisedWs {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, miss: "no JSON body" };
  }
  const value = (payload as Record<string, unknown>).webSocketDebuggerUrl;
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, miss: "no webSocketDebuggerUrl" };
  }

  const raw = value.trim();
  const url = parseWsUrl(raw);
  if (url === null) return { ok: false, miss: "webSocketDebuggerUrl is not a ws:// URL" };
  if (!isLoopbackHost(url.hostname)) {
    return { ok: false, miss: "webSocketDebuggerUrl is not loopback (refused)" };
  }
  if (!hasBrowserPath(url)) {
    return { ok: false, miss: "webSocketDebuggerUrl has no /devtools/browser/ path" };
  }

  return { ok: true, wsUrl: raw };
}

/** Step 1: validate a user-supplied URL; failures here are configuration errors. */
function endpointFromWsUrl(raw: string, source: CdpSource, label: string): CdpEndpoint {
  const url = parseWsUrl(raw);
  if (url === null) {
    throw configError(
      `${label}: expected a full ws:// or wss:// URL, got "${raw}"`,
      `set ${label} to a WebSocket URL, e.g. ` +
        `ws://127.0.0.1:9222/devtools/browser/<id> (a page target such as ` +
        `/devtools/page/<id> is also accepted for this escape hatch); ${ERROR_HINTS.E_CONFIG}`,
    );
  }

  if (!isLoopbackHost(url.hostname)) {
    throw configError(
      `${label}: refusing non-loopback host "${url.hostname}" (${raw})`,
      `CDP must stay on 127.0.0.1 (localhost and [::1] are also loopback); ` +
        `refusing "${raw}". ${ERROR_HINTS.E_CONFIG}`,
    );
  }

  if (!hasAnyPath(url)) {
    throw configError(
      `${label}: "${raw}" has no target path`,
      `include the path from DevToolsActivePort or /json/version, e.g. ` +
        `ws://127.0.0.1:9222/devtools/browser/<id> (a page path such as ` +
        `/devtools/page/<id> is also accepted for this escape hatch); ${ERROR_HINTS.E_CONFIG}`,
    );
  }

  const port = wsPort(url);
  if (port === null) {
    throw configError(
      `${label}: "${raw}" has no usable port`,
      `include the port, e.g. ws://127.0.0.1:9222/devtools/browser/<id>; ${ERROR_HINTS.E_CONFIG}`,
    );
  }

  return { port, wsUrl: raw, source };
}

function parseEnvPorts(raw: string | undefined): number[] | null {
  const text = raw?.trim();
  if (text === undefined || text === "") return null;

  const ports: number[] = [];
  for (const part of text.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    if (!/^\d+$/.test(token)) {
      throw envPortsError(text, token, "is not a number");
    }
    const port = Number(token);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw envPortsError(text, token, "is outside 1-65535");
    }
    ports.push(port);
  }

  return ports.length > 0 ? sanitisePorts(ports) : null;
}

function envPortsError(text: string, token: string, why: string): WebSearchError {
  return configError(
    `PI_CHROME_CDP_PORTS: "${token}" ${why} in "${text}"`,
    "PI_CHROME_CDP_PORTS must be a comma-separated list of TCP ports (1-65535), " +
      `e.g. 9222 or 9222,9333; ${ERROR_HINTS.E_CONFIG}`,
  );
}

function sanitisePorts(ports: readonly number[]): number[] {
  const out: number[] = [];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (!out.includes(port)) out.push(port);
  }
  return out;
}

function normaliseTimeout(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_PROBE_TIMEOUT_MS;
}

function parseWsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "ws:" || url.protocol === "wss:" ? url : null;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Discovered endpoints (file, `/json/version`) must be the browser target:
 * Chrome always advertises `/devtools/browser/<uuid>` in those places.
 */
function hasBrowserPath(url: URL): boolean {
  return url.pathname.startsWith(BROWSER_PATH_PREFIX);
}

/**
 * The `PI_CHROME_CDP_WS` / `cdp.ws` escape hatch may point at a page target,
 * so any non-root path is accepted there — loopback is still enforced.
 */
function hasAnyPath(url: URL): boolean {
  return url.pathname !== "/" && url.pathname !== "";
}

function wsPort(url: URL): number | null {
  if (url.port === "") return url.protocol === "wss:" ? 443 : 80;
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function configError(message: string, hint: string): WebSearchError {
  return new WebSearchError({
    code: "E_CONFIG",
    stage: "config",
    retryable: RETRYABLE.E_CONFIG,
    hint,
    message,
  });
}

function defaultProfileDirs(): string[] {
  const home = homedir();
  return PROFILE_SUFFIXES.map((suffix) => join(home, suffix));
}

function tildify(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/**
 * Bound any injected IO by `timeoutMs`. A local file read on a sick mount and
 * a third-party `fetchJson` that ignores its `timeoutMs` argument must both
 * produce a miss instead of hanging discovery. `Promise.race` also attaches a
 * handler to `task`, so a late rejection is not reported as unhandled.
 */
async function withDeadline<T>(task: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${timeoutMs}ms`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function describeFetchMiss(error: unknown, timeoutMs: number): string {
  if (isTimeoutError(error)) return `timed out after ${timeoutMs}ms`;
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message !== "") return `request failed (${truncate(message, 100)})`;
  }
  return "request failed";
}

function describeReadMiss(error: unknown): string {
  if (isTimeoutError(error)) return "read timed out";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "ENOENT") return "no file";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  return "unreadable";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function defaultReadFile(path: string): Promise<string> {
  return fsReadFile(path, "utf8");
}

async function defaultFetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  return (await response.json()) as unknown;
}
