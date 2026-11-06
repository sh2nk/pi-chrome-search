/**
 * Doctor report assembly (SPEC §10.3, PLAN P1-E).
 *
 * The doctor is a *diagnostic*, so it is built to be boringly total: every
 * failure — no connector, a dead socket, a busy lock, an adapter that throws, a
 * clock that returns NaN — becomes a field in the report instead of an
 * exception. The CLI turns `verdict: "blocked"` into exit code 2; `/web-doctor`
 * turns it into a notification; neither should ever see a stack trace.
 *
 * Two behaviours are deliberate:
 *
 *  - **One probe per enabled, registered engine, sequentially.** Probing is a
 *    live browser action (SPEC §5.5): parallel probes would hammer the profile,
 *    and a probe for an engine without an adapter can only invent data. The
 *    probe itself is built by `createEngineProbe` (the production factory) and
 *    injected; the report stays offline-testable because no probe means no
 *    browser.
 *
 *  - **Probe absence is not health.** A registered adapter with no probe wired
 *    by the caller (or `--no-probe`, or an unreachable CDP) is `unavailable`,
 *    never `ok`: the report must not claim an engine works when nothing was
 *    exercised. The extension, the CLI and `/web-doctor` wire
 *    `createEngineProbe`; a caller that does not is told "no probe configured",
 *    not that the engine is fine. P5 extends `reflex` the same way.
 *
 * The report is plain JSON with a fixed key order (no Maps, no class instances)
 * so `--json` output is diffable and the schema test can validate it. It never
 * contains cookies, page HTML, or a non-loopback address: the only URLs in it
 * are the loopback CDP endpoint the user already owns and local paths.
 */

import { readFile, unlink } from "node:fs/promises";

import type { Connector, ConnectorInfo } from "../cdp/browser.ts";
import { defaultLockPath, parseLockRecord, pidAlive } from "../cdp/browser.ts";
import type { CdpSource } from "../cdp/types.ts";
import type { Config, FocusPolicy, HumanizeMode, Mode, ReflexBackend } from "../config.ts";
import type { EngineId, EngineRegistry, Query, WallKind } from "../engines/types.ts";
import { ENGINE_IDS } from "../engines/types.ts";
import { ERROR_HINTS, type FailureDetails } from "./error-codes.ts";
import { fail, toFailure } from "./errors.ts";
import type { Artifacts, Cache, Clock, Limiter } from "./types.ts";
import { EXTENSION_NAME, EXTENSION_VERSION } from "../version.ts";

/**
 * `connect()` is bounded by `cdp.connectTimeoutMs`, and discovery by 1.5 s
 * before it. The doctor adds that discovery budget so a hung endpoint cannot
 * keep `--json` waiting forever (PLAN V1.5), without pretending to know a
 * tighter number than the connector's own contract.
 */
const CONNECT_GRACE_MS = 2_000;

/** The wall vocabulary is frozen in `engines/types.ts`; probe data arrives as `unknown`. */
const WALL_KINDS = ["captcha", "consent", "sorry", "blocked"] as const;

export type EngineVerdict = "ok" | "wall" | "layout_changed" | "blocked" | "unavailable";
export type CdpStatus = "ok" | "unavailable" | "busy" | "error";
export type DoctorVerdict = "ok" | "degraded" | "blocked";

/** Structured failure inside a probe result (SPEC §10.1 fields the probe owns). */
export interface ProbeError {
  code: string;
  stage: string;
  hint: string;
}

/** What one cheap, live probe (n=1, summary off) observed. */
export interface EngineProbeResult {
  ms: number;
  results: number;
  ai: boolean;
  wall?: WallKind;
  canaries?: Record<string, number>;
  error?: ProbeError;
}

/** Built by {@link createEngineProbe}; absent means the caller wired no probe, not that engines are fine. */
export type EngineProbe = (id: EngineId) => Promise<EngineProbeResult>;

/** Stable, non-personal query: the probe is a smoke test, not a user search. */
export const DOCTOR_PROBE_QUERY = "pi-chrome-search doctor probe";

export interface EngineProbeOptions {
  config: Config;
  connector: Connector;
  registry: EngineRegistry;
  clock: Clock;
  /**
   * Pacing for the probe (SPEC §5.5). A diagnostic that fires three searches
   * back-to-back is a captcha vector (AGENTS §2 rule 7), so the probe paces
   * exactly like `web_search`. Optional only because a unit test may not care
   * about the limiter; every production surface passes the runtime one.
   */
  limiter?: Limiter;
  /** Test seam; production keeps {@link DOCTOR_PROBE_QUERY}. */
  query?: string;
}

/** `"auto"`/empty means "let the engine decide", never a literal sentinel (same rule as web_search). */
function resolveProbeLocale(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" || trimmed.toLowerCase() === "auto" ? undefined : trimmed;
}

/** Mirror `web_search`'s locale mapping so the probe exercises the same URLs a real search would. */
function probeLocale(engine: EngineId, config: Config): Pick<Query, "lang" | "region"> {
  switch (engine) {
    case "google": {
      const lang = resolveProbeLocale(config.engines.google.lang);
      const region = resolveProbeLocale(config.engines.google.gl);
      return {
        ...(lang === undefined ? {} : { lang }),
        ...(region === undefined ? {} : { region }),
      };
    }
    case "duckduckgo": {
      const region = resolveProbeLocale(config.engines.duckduckgo.kl);
      return region === undefined ? {} : { region };
    }
    case "yandex": {
      const region = resolveProbeLocale(config.engines.yandex.lr);
      return region === undefined ? {} : { region };
    }
  }
}

/**
 * The production probe: one `n=1`, summary-off search per engine through the
 * same connector + registry the tools use, paced by the same limiter.
 *
 * The probe never throws a browser failure at the doctor: it returns
 * `error: { code, stage, hint }` so the report keeps the latency and the verdict
 * mapper owns the interpretation. A wall detected after a settle timeout is
 * promoted to `wall` — a captcha page usually fails the adapter's readiness
 * marker before `detectWall()` is ever reached. A limiter rejection (daily cap,
 * abort) is reported the same way and never navigates: a paced-out probe must
 * not burn an unthrottled search on the user's profile.
 */
export function createEngineProbe(options: EngineProbeOptions): EngineProbe {
  const text = options.query ?? DOCTOR_PROBE_QUERY;

  return async (id) => {
    const startedAt = options.clock.now();
    const elapsed = (): number => Math.max(0, Math.round(options.clock.now() - startedAt));

    try {
      const engine = options.registry.get(id);
      // Pace before acquiring a page: the doctor is a live search like any
      // other, and three back-to-back probes are exactly what a bot looks like.
      if (options.limiter !== undefined) {
        try {
          await options.limiter.acquire(id);
        } catch (error) {
          const details = toFailure(error, { code: "E_RATE_LIMITED", stage: "navigate" });
          return {
            ms: elapsed(),
            results: 0,
            ai: false,
            error: { code: details.code, stage: details.stage, hint: details.hint },
          };
        }
      }
      const query: Query = { text, n: 1, summary: false, ...probeLocale(id, options.config) };
      const page = await options.connector.acquirePage(id);
      await page.navigate(engine.buildUrl(query));

      try {
        await engine.settle(page);
      } catch (error) {
        const failure = toFailure(error, { code: "E_TIMEOUT", stage: "settle" });
        const wall =
          failure.code === "E_TIMEOUT" || failure.code === "E_PARSE"
            ? await engine.detectWall(page).catch(() => null)
            : null;
        if (wall === null) throw error;
        return { ms: elapsed(), results: 0, ai: false, wall: wall.kind };
      }

      const wall = await engine.detectWall(page);
      if (wall !== null) return { ms: elapsed(), results: 0, ai: false, wall: wall.kind };

      const serp = await engine.extract(page, query);
      const canaries = await engine.canaries(page).catch(() => undefined);
      return {
        ms: elapsed(),
        results: serp.results.length,
        ai: serp.ai !== undefined && serp.ai.text.trim() !== "",
        ...(canaries === undefined ? {} : { canaries }),
      };
    } catch (error) {
      const details = toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
      return {
        ms: elapsed(),
        results: 0,
        ai: false,
        error: { code: details.code, stage: details.stage, hint: details.hint },
      };
    }
  };
}

export interface DoctorDeps {
  config: Config;
  configPath: string;
  connector?: Connector;
  registry: EngineRegistry;
  clock: Clock;
  cache?: Cache;
  artifacts?: Artifacts;
  probe?: EngineProbe;
  /**
   * Pacing for the injected probe. `buildDoctorReport` does not probe by
   * itself; the deps factory in `commands/doctor.ts` hands this to
   * `createEngineProbe`, so `/web-doctor` obeys the same pacing as a search.
   */
  limiter?: Limiter;
  env?: NodeJS.ProcessEnv;
  extensionVersion?: string;
  nodeVersion?: string;
}

export interface DoctorDepsOptions {
  /** `false` skips every probe (`--no-probe`). Default: probe when one is injected. */
  probe?: boolean;
}

export interface DoctorExtensionInfo {
  name: string;
  version: string;
  node: string;
}

export interface DoctorConfigInfo {
  path: string;
  mode: Mode;
  focus: FocusPolicy;
  humanize: HumanizeMode;
  debug: boolean;
}

export interface DoctorEndpoint {
  port: number;
  wsUrl: string;
  source: CdpSource;
  profileDir?: string;
}

export interface DoctorBrowser {
  product: string;
  protocolVersion: string;
}

export interface DoctorError {
  code: string;
  stage: string;
  hint: string;
  message?: string;
}

export interface DoctorLock {
  /** True when a lock file exists — held by this run or by another session. */
  locked: boolean;
  path: string;
  /** `self` means this doctor run holds it (it must, to inspect the browser). */
  owner: "none" | "self" | "other";
  pid?: number;
}

export interface DoctorCdp {
  status: CdpStatus;
  endpoint: DoctorEndpoint | null;
  browser: DoctorBrowser | null;
  webdriver: boolean | null;
  windowId: number | null;
  windowDegraded: boolean;
  lock: DoctorLock;
  error?: DoctorError;
}

export interface DoctorCacheInfo {
  entries: number;
}

export interface DoctorArtifactsInfo {
  dir: string;
  bytes: number;
}

export interface DoctorEngine {
  id: EngineId;
  enabled: boolean;
  verdict: EngineVerdict;
  note?: string;
  probe?: EngineProbeResult;
}

export interface DoctorReflexInfo {
  enabled: boolean;
  backend: ReflexBackend;
  localOnly: boolean;
  /** `disabled` when reflex is off; `unavailable` until P5 injects a classifier probe. */
  classifier: "disabled" | "unavailable";
}

export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  extension: DoctorExtensionInfo;
  config: DoctorConfigInfo;
  cdp: DoctorCdp;
  cache: DoctorCacheInfo | null;
  artifacts: DoctorArtifactsInfo | null;
  engines: DoctorEngine[];
  reflex: DoctorReflexInfo;
  verdict: DoctorVerdict;
}

// ---------------------------------------------------------------------------
// Guards (the report accepts injected/runtime data, not just typed values)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeInt(value: unknown): number {
  const number = finite(value, 0);
  return Math.max(0, Math.round(number));
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

type ParsedLock = NonNullable<ReturnType<typeof parseLockRecord>>;

async function readLockRecord(path: string): Promise<ParsedLock | null> {
  try {
    return parseLockRecord(await readFile(path, "utf8"));
  } catch {
    // Missing (no session), unreadable (EACCES) or a rename in flight: all mean
    // "no lock we can attribute". The doctor reports that, it does not throw.
    return null;
  }
}

function lockPathOf(connector: Connector | undefined, env: NodeJS.ProcessEnv): string {
  if (connector !== undefined) {
    try {
      return connector.lockPath();
    } catch {
      // A broken connector must not cost us the lock line of the report.
    }
  }
  return defaultLockPath(env);
}

async function collectLock(connector: Connector | undefined, env: NodeJS.ProcessEnv): Promise<DoctorLock> {
  const path = lockPathOf(connector, env);
  const record = await readLockRecord(path);
  if (record === null) return { locked: false, path, owner: "none" };
  return {
    locked: true,
    path,
    owner: record.pid === process.pid ? "self" : "other",
    pid: record.pid,
  };
}

// ---------------------------------------------------------------------------
// Timeout (the connector already bounds itself; this is the belt)
// ---------------------------------------------------------------------------

async function withDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`the CDP connect did not settle within ${timeoutMs}ms`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Safe `--fix`
// ---------------------------------------------------------------------------

export interface DoctorFixOptions {
  /** Test seam; defaults to the signal-free `/proc` liveness check. */
  alive?: (pid: number) => boolean;
  /** Test seam; defaults to `fs.unlink`. */
  remove?: (path: string) => Promise<void>;
}

function isConnected(connector: Connector | undefined): boolean {
  if (connector === undefined) return false;
  try {
    return connector.isConnected();
  } catch {
    return false;
  }
}

/** Connect once with the same deadline the report uses, so `--fix` cannot hang either. */
async function boundedConnect(connector: Connector, config: Config): Promise<void> {
  await withDeadline(connector.connect(), config.cdp.connectTimeoutMs + CONNECT_GRACE_MS);
}

/**
 * The actions `--fix` may take (SPEC §10.3): reconnect once, close only targets
 * this connector created (never a foreign tab), prune artifacts, and remove a
 * lock whose owner is provably dead.
 *
 * It never signals a process, never launches or restarts Chrome and never
 * touches the profile: a lock reported as `E_BUSY` was judged live by the
 * connector itself and is left alone even if a platform cannot prove liveness.
 * Every action is returned as a line so the CLI/tool can report what happened;
 * a failure never aborts the run, because the report that follows is the product.
 */
export async function applyDoctorFix(
  deps: DoctorDeps,
  options: DoctorFixOptions = {},
): Promise<string[]> {
  const actions: string[] = [];
  const connector = deps.connector;
  const alive = options.alive ?? pidAlive;
  const remove = options.remove ?? ((path: string) => unlink(path));
  let busy = false;

  if (connector !== undefined) {
    if (!isConnected(connector)) {
      try {
        await boundedConnect(connector, deps.config);
        actions.push("connected to CDP");
      } catch (error) {
        const details = toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
        if (details.code === "E_BUSY") busy = true;
        actions.push(`connect failed: ${details.code}`);
        // Exactly one retry (SPEC §10.3: reconnect), never a loop.
        try {
          await boundedConnect(connector, deps.config);
          actions.push("reconnected to CDP once");
        } catch (retryError) {
          const retry = toFailure(retryError, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
          if (retry.code === "E_BUSY") busy = true;
          actions.push(`reconnect failed: ${retry.code}`);
        }
      }
    }

    if (isConnected(connector)) {
      let owned = 0;
      try {
        owned = connector.ownedTargets().length;
      } catch {
        owned = 0;
      }
      try {
        // `releaseAll` closes only targets this connector created and releases its
        // own lock; a tab the user opened can never be in that set.
        await connector.releaseAll();
        actions.push(owned > 0 ? `closed ${owned} owned tab(s)` : "released connector state");
      } catch (error) {
        const details = toFailure(error, { code: "E_CDP_DISCONNECTED", stage: "connect" });
        actions.push(`release failed: ${details.code}`);
      }

      try {
        await boundedConnect(connector, deps.config);
        // Distinct from the retry above: a first-attempt failure already logged
        // "reconnected to CDP once", and printing that twice makes the action
        // log lie about how many times the doctor actually reconnected.
        actions.push("reconnected after release");
      } catch (error) {
        const details = toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
        if (details.code === "E_BUSY") busy = true;
        actions.push(`reconnect failed: ${details.code}`);
      }
    }
  }

  if (deps.artifacts !== undefined) {
    try {
      const pruned = await deps.artifacts.prune();
      actions.push(`pruned artifacts: ${pruned.removed} removed, ${pruned.kept} kept`);
    } catch (error) {
      const details = toFailure(error, { code: "E_CONFIG", stage: "config" });
      actions.push(`artifact prune failed: ${details.code}`);
    }
  }

  // A connector that answered `E_BUSY` has already judged the holder live; never
  // override that judgement from a liveness heuristic we cannot prove.
  if (!busy) {
    const path = lockPathOf(connector, deps.env ?? process.env);
    const record = await readLockRecord(path);
    if (record !== null && record.pid !== process.pid && !alive(record.pid)) {
      try {
        await remove(path);
        actions.push(`cleared stale lock (pid ${record.pid} is not running)`);
      } catch (error) {
        const details = toFailure(error, { code: "E_CONFIG", stage: "config" });
        actions.push(`stale lock clear failed: ${details.code}`);
      }
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------

function statusForCode(code: string): CdpStatus {
  if (code === "E_BUSY") return "busy";
  if (code === "E_CDP_UNAVAILABLE" || code === "E_CDP_DISCONNECTED" || code === "E_TARGET_LOST") {
    return "unavailable";
  }
  // E_TIMEOUT is a reachability problem, not a config/internal error.
  if (code === "E_TIMEOUT") return "unavailable";
  return "error";
}

function doctorError(details: FailureDetails): DoctorError {
  return {
    code: details.code,
    stage: details.stage,
    hint: details.hint,
    ...(details.message === undefined || details.message === "" ? {} : { message: details.message }),
  };
}

function failedCdp(status: CdpStatus, details: FailureDetails, lock: DoctorLock): DoctorCdp {
  return {
    status,
    endpoint: null,
    browser: null,
    webdriver: null,
    windowId: null,
    windowDegraded: false,
    lock,
    error: doctorError(details),
  };
}

function endpointOf(info: ConnectorInfo): DoctorEndpoint {
  return {
    port: nonNegativeInt(info.endpoint.port),
    wsUrl: safeText(info.endpoint.wsUrl, "ws://127.0.0.1"),
    source: info.endpoint.source,
    ...(info.endpoint.profileDir === undefined ? {} : { profileDir: info.endpoint.profileDir }),
  };
}

/**
 * Connect when needed and describe the result. `buildDoctorReport` must not
 * throw, so every path here returns a `DoctorCdp`; the lock is re-read after a
 * failed connect because `connect()` may have reclaimed a stale lock or kept a
 * foreign one.
 */
async function collectCdp(deps: DoctorDeps): Promise<DoctorCdp> {
  const env = deps.env ?? process.env;
  const connector = deps.connector;

  if (connector === undefined) {
    const details = fail("E_CDP_UNAVAILABLE", "connect", {
      message: "no CDP connector was injected into the doctor",
      hint: ERROR_HINTS.E_CDP_UNAVAILABLE,
    }).details;
    return failedCdp("unavailable", details, await collectLock(undefined, env));
  }

  if (!connector.isConnected()) {
    try {
      const timeoutMs = deps.config.cdp.connectTimeoutMs + CONNECT_GRACE_MS;
      await withDeadline(connector.connect(), timeoutMs);
    } catch (error) {
      const details = toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
      return failedCdp(statusForCode(details.code), details, await collectLock(connector, env));
    }
  }

  let info: ConnectorInfo | null;
  try {
    info = connector.info();
  } catch (error) {
    const details = toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
    return failedCdp(statusForCode(details.code), details, await collectLock(connector, env));
  }

  if (info === null) {
    const details = fail("E_CDP_DISCONNECTED", "connect", {
      message: "the connector reports a live socket but no connection info",
      hint: ERROR_HINTS.E_CDP_DISCONNECTED,
    }).details;
    return failedCdp("error", details, await collectLock(connector, env));
  }

  const lock = await collectLock(connector, env);

  if (info.webdriver === true) {
    // browser.ts refuses this at connect time, but the doctor also covers a
    // connector built elsewhere: an automation browser is never a usable attach.
    const details = fail("E_CDP_UNAVAILABLE", "connect", {
      message: "navigator.webdriver is true on the attached browser",
      hint:
        "navigator.webdriver is true: this Chrome was started by an automation tool; close it and " +
        "attach to your normal profile via chrome://inspect → Allow — the extension never starts a " +
        "browser itself",
    }).details;
    return {
      status: "error",
      endpoint: endpointOf(info),
      browser: { product: info.browser.product, protocolVersion: info.browser.protocolVersion },
      webdriver: true,
      windowId: info.windowId,
      windowDegraded: info.windowDegraded,
      lock,
      error: doctorError(details),
    };
  }

  return {
    status: "ok",
    endpoint: endpointOf(info),
    browser: { product: info.browser.product, protocolVersion: info.browser.protocolVersion },
    webdriver: false,
    windowId: info.windowId,
    windowDegraded: info.windowDegraded,
    lock,
  };
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

function normaliseWall(value: unknown): WallKind | undefined {
  return typeof value === "string" && (WALL_KINDS as readonly string[]).includes(value)
    ? (value as WallKind)
    : undefined;
}

function normaliseCanaries(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries: Array<[string, number]> = [];
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    entries.push([key, Math.max(0, Math.round(raw))]);
  }
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function normaliseProbeError(value: unknown): ProbeError | undefined {
  if (!isRecord(value)) return undefined;
  return {
    code: safeText(value.code, "E_PARSE"),
    stage: safeText(value.stage, "extract"),
    hint: safeText(value.hint, ERROR_HINTS.E_PARSE),
  };
}

/** Fixed key order and coerced scalars: probe data is injected, so treat it as unknown. */
function normaliseProbe(result: EngineProbeResult): EngineProbeResult {
  const raw = result as unknown as Record<string, unknown>;
  const wall = normaliseWall(raw.wall);
  const canaries = normaliseCanaries(raw.canaries);
  const error = normaliseProbeError(raw.error);
  return {
    ms: nonNegativeInt(raw.ms),
    results: nonNegativeInt(raw.results),
    ai: raw.ai === true,
    ...(wall === undefined ? {} : { wall }),
    ...(canaries === undefined ? {} : { canaries }),
    ...(error === undefined ? {} : { error }),
  };
}

/** True only when at least one canary exists and every one is exactly zero. */
function canariesAllZero(canaries: Record<string, number> | undefined): boolean {
  if (canaries === undefined) return false;
  const values = Object.values(canaries);
  return values.length > 0 && values.every((value) => value === 0);
}

function verdictForError(code: string): EngineVerdict {
  if (code === "E_PARSE") return "layout_changed";
  if (code === "E_UNSUPPORTED") return "unavailable";
  return "blocked";
}

function judgeProbe(result: EngineProbeResult): { verdict: EngineVerdict; note?: string } {
  if (result.wall !== undefined) {
    return {
      verdict: "wall",
      note: `wall: ${result.wall}; solve it in the visible window, then retry — never automate it`,
    };
  }

  const error = result.error;
  if (error !== undefined) {
    if (error.code === "E_PARSE") {
      return {
        verdict: "layout_changed",
        note: `E_PARSE during ${error.stage}: ${error.hint}`,
      };
    }
    if (error.code === "E_WALL" || error.code.startsWith("E_CDP_")) {
      return { verdict: "blocked", note: `${error.code} during ${error.stage}: ${error.hint}` };
    }
    if (error.code === "E_UNSUPPORTED") {
      return { verdict: "unavailable", note: `${error.code}: ${error.hint}` };
    }
    // An unmapped error is still a failure: reporting `ok` for a probe that
    // returned E_TIMEOUT/E_EMPTY would be the one dishonest verdict here.
    return { verdict: "blocked", note: `${error.code} during ${error.stage}: ${error.hint}` };
  }

  if (canariesAllZero(result.canaries)) {
    return {
      verdict: "layout_changed",
      note: "every selector canary returned 0; the SERP layout may have changed",
    };
  }

  return { verdict: "ok" };
}

async function engineEntry(
  id: EngineId,
  deps: DoctorDeps,
  probeEnabled: boolean,
  cdpStatus: CdpStatus,
): Promise<DoctorEngine> {
  const enabled = deps.config.engines[id].enabled;
  if (!enabled) {
    return { id, enabled: false, verdict: "unavailable", note: "disabled in config" };
  }

  if (!deps.registry.has(id)) {
    return {
      id,
      enabled: true,
      verdict: "unavailable",
      note: "no adapter registered (E_UNSUPPORTED)",
    };
  }

  const probe = deps.probe;
  if (probe === undefined) {
    return {
      id,
      enabled: true,
      verdict: "unavailable",
      note: "no probe configured (no live probe was wired into the doctor)",
    };
  }
  if (!probeEnabled) {
    return { id, enabled: true, verdict: "unavailable", note: "probe skipped (--no-probe)" };
  }
  // Without a live CDP session every probe would just repeat the same failed
  // connect (three times, each up to connectTimeoutMs). Report the truthful
  // reason instead of hammering discovery.
  if (cdpStatus !== "ok") {
    return {
      id,
      enabled: true,
      verdict: "unavailable",
      note: `probe skipped: CDP is ${cdpStatus}`,
    };
  }

  let result: EngineProbeResult;
  try {
    result = await probe(id);
  } catch (error) {
    const details = toFailure(error, { code: "E_PARSE", stage: "extract" });
    return {
      id,
      enabled: true,
      verdict: verdictForError(details.code),
      note: `${details.code} during ${details.stage}: ${details.hint}`,
    };
  }

  const normalised = normaliseProbe(result);
  const judged = judgeProbe(normalised);
  return {
    id,
    enabled: true,
    verdict: judged.verdict,
    ...(judged.note === undefined ? {} : { note: judged.note }),
    probe: normalised,
  };
}

async function collectEngines(
  deps: DoctorDeps,
  probeEnabled: boolean,
  cdpStatus: CdpStatus,
): Promise<DoctorEngine[]> {
  const engines: DoctorEngine[] = [];
  for (const id of ENGINE_IDS) {
    let enabled = false;
    try {
      enabled = deps.config.engines[id].enabled === true;
    } catch {
      // A hostile config object must not take down the doctor; report it disabled.
    }
    try {
      engines.push(await engineEntry(id, deps, probeEnabled, cdpStatus));
    } catch (error) {
      const details = toFailure(error, { code: "E_UNSUPPORTED", stage: "resolve" });
      engines.push({
        id,
        enabled,
        verdict: "blocked",
        note: `could not evaluate engine: ${details.code} during ${details.stage}: ${details.hint}`,
      });
    }
  }
  return engines;
}

// ---------------------------------------------------------------------------
// Cache / artifacts
// ---------------------------------------------------------------------------

function readCache(cache: Cache | undefined): DoctorCacheInfo | null {
  if (cache === undefined) return null;
  try {
    return { entries: Math.max(0, Math.round(cache.size())) };
  } catch {
    // Cache stats are optional diagnostics; a broken cache is reported as "not
    // available" rather than silently as zero entries.
    return null;
  }
}

async function readArtifacts(artifacts: Artifacts | undefined): Promise<DoctorArtifactsInfo | null> {
  if (artifacts === undefined) return null;
  try {
    return {
      dir: artifacts.root(),
      bytes: Math.max(0, Math.round(await artifacts.size())),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function overallVerdict(cdp: DoctorCdp, engines: DoctorEngine[]): DoctorVerdict {
  if (cdp.status !== "ok" || cdp.webdriver === true) return "blocked";
  if (engines.some((engine) => engine.verdict !== "ok")) return "degraded";
  return "ok";
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Deterministic ISO timestamp; a broken injected clock must not throw out of the report. */
function isoNow(clock: Clock): string {
  try {
    const now = clock.now();
    return (Number.isFinite(now) ? new Date(now) : new Date(0)).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Assemble the report. Total by construction: the only way to leave is a
 * returned `DoctorReport`, with failures recorded in `cdp.error` / engine notes.
 */
export async function buildDoctorReport(
  deps: DoctorDeps,
  opts: DoctorDepsOptions = {},
): Promise<DoctorReport> {
  const generatedAt = isoNow(deps.clock);

  let cdp: DoctorCdp;
  try {
    cdp = await collectCdp(deps);
  } catch (error) {
    const details = toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
    cdp = failedCdp(
      statusForCode(details.code),
      details,
      await collectLock(deps.connector, deps.env ?? process.env).catch(() => ({
        locked: false,
        path: defaultLockPath(deps.env ?? process.env),
        owner: "none" as const,
      })),
    );
  }

  const engines = await collectEngines(deps, opts.probe !== false, cdp.status);
  const cache = readCache(deps.cache);
  const artifacts = await readArtifacts(deps.artifacts);
  const verdict = overallVerdict(cdp, engines);

  return {
    schemaVersion: 1,
    generatedAt,
    extension: {
      name: EXTENSION_NAME,
      version: deps.extensionVersion ?? EXTENSION_VERSION,
      node: deps.nodeVersion ?? process.version,
    },
    config: {
      path: deps.configPath,
      mode: deps.config.mode,
      focus: deps.config.window.focus,
      humanize: deps.config.humanize,
      debug: deps.config.debug,
    },
    cdp,
    cache,
    artifacts,
    engines,
    reflex: {
      enabled: deps.config.reflex.enabled,
      backend: deps.config.reflex.backend,
      localOnly: deps.config.reflex.localOnly,
      classifier: deps.config.reflex.enabled ? "unavailable" : "disabled",
    },
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function tildify(path: string): string {
  const home = process.env.HOME;
  if (home === undefined || home === "") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/** Human-readable report for the terminal and `/web-doctor` notifications. */
export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push(`${report.extension.name} ${report.extension.version} — doctor (node ${report.extension.node})`);
  lines.push(`generated ${report.generatedAt}`);
  lines.push(
    `config: ${tildify(report.config.path)} (${report.config.mode}, focus=${report.config.focus}, ` +
      `humanize=${report.config.humanize}, debug=${report.config.debug ? "on" : "off"})`,
  );

  const { cdp } = report;
  if (cdp.endpoint !== null) {
    const browser =
      cdp.browser === null
        ? "browser unknown"
        : `${cdp.browser.product} (protocol ${cdp.browser.protocolVersion})`;
    lines.push(`cdp: ${cdp.status} — ${browser}`);
    lines.push(`  endpoint: ${cdp.endpoint.wsUrl} (source: ${cdp.endpoint.source})`);
    if (cdp.endpoint.profileDir !== undefined) {
      lines.push(`  profile: ${tildify(cdp.endpoint.profileDir)}`);
    }
  } else {
    lines.push(`cdp: ${cdp.status}`);
  }

  if (cdp.webdriver !== null) lines.push(`  webdriver: ${cdp.webdriver}`);
  if (cdp.windowId !== null) {
    lines.push(
      `  window: ${cdp.windowId}${cdp.windowDegraded ? " (dedicated; placement degraded)" : ""}`,
    );
  }
  if (cdp.error !== undefined) {
    lines.push(`  error [${cdp.error.code}] ${cdp.error.stage}: ${cdp.error.hint}`);
    if (cdp.error.message !== undefined) lines.push(`  detail: ${cdp.error.message}`);
  }
  const lockState =
    cdp.lock.owner === "self"
      ? "held by this run"
      : cdp.lock.owner === "other"
        ? `held by another session (pid ${cdp.lock.pid ?? "?"})`
        : "free";
  lines.push(`  lock: ${tildify(cdp.lock.path)} (${lockState})`);

  lines.push(report.cache === null ? "cache: not wired in this process" : `cache: ${report.cache.entries} entries`);
  lines.push(
    report.artifacts === null
      ? "artifacts: not wired in this process"
      : `artifacts: ${tildify(report.artifacts.dir)} (${formatBytes(report.artifacts.bytes)})`,
  );

  lines.push("engines:");
  for (const engine of report.engines) {
    const probe =
      engine.probe === undefined
        ? ""
        : ` (${engine.probe.results} results, ai=${engine.probe.ai ? "yes" : "no"}, ${engine.probe.ms}ms)`;
    const note = engine.note === undefined ? "" : ` — ${engine.note}`;
    lines.push(`  ${engine.id.padEnd(11)} ${engine.verdict}${probe}${note}`);
  }

  lines.push(
    `reflex: ${report.reflex.enabled ? "enabled" : "disabled"} (backend=${report.reflex.backend}, ` +
      `localOnly=${report.reflex.localOnly ? "on" : "off"}, classifier=${report.reflex.classifier})`,
  );
  lines.push(`verdict: ${report.verdict}`);

  return `${lines.join("\n")}\n`;
}

/** Exported for the CLI's exit-code mapping and tests. */
export const DOCTOR_BLOCKED_EXIT_CODE = 2;
