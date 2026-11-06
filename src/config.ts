/**
 * Strict config loader (SPEC §11). Path: `$PI_CODING_AGENT_DIR/web-search.json`
 * or `~/.pi/agent/web-search.json`. Missing file → defaults; malformed JSON,
 * wrong types and unknown keys → `E_CONFIG` naming the exact key path.
 *
 * Additive key vs SPEC §11: `cdp.profileDir` backs the `PI_CHROME_SEARCH_PROFILE`
 * env var (launch mode only). It defaults to null and is never written by us.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ENGINE_IDS, type EngineId } from "./engines/types.ts";
import { agentDir, expandHome } from "./runtime/host.ts";
import { WebSearchError, type FailureDetails } from "./runtime/error-codes.ts";

export type FocusPolicy = "session" | "always" | "never";
/**
 * P10-B: which owned tab is raised during work and after it.
 *
 * - `work`   — raise the engine tab when a stage begins, hand the screen back
 *              to the anchor `window.idleMs` after the stage ends (default).
 * - `anchor` — keep the anchor visible; useful while explaining the run.
 * - `never`  — no extra raising at all: exactly the pre-P10 behaviour, which is
 *              the only safe setting while the user is presenting.
 *
 * `window.focus: "never"` still dominates every value here: with it the
 * extension never moves focus, whatever `follow` says.
 */
export type FollowPolicy = "work" | "anchor" | "never";
export type HumanizeMode = "auto" | "always" | "typing";
export type Mode = "attach" | "launch";
export type ReflexBackend = "auto" | "local" | "openrouter" | "rules";
export type BatchBackend = "classifier" | "chat-small";

export interface CdpConfig {
  ports: number[];
  ws: string | null;
  connectTimeoutMs: number;
  profileDir: string | null;
  /**
   * How long an attach may wait for the user's CDP Allow (P11). The prompt is
   * the only manual step in the product; a short connect timeout turns an
   * unanswered prompt into a misleading `E_CDP_UNAVAILABLE`. `0` disables the
   * wait (one attempt, the pre-P11 behaviour).
   */
  attachWaitMs: number;
}

export interface WindowConfig {
  focus: FocusPolicy;
  reuse: boolean;
  /**
   * P11: on the Allow prompt, try to raise the browser window once (best effort,
   * adapter-based). `never` keeps the session fully passive.
   */
  raiseOnPrompt: "auto" | "never";
  /**
   * P10-A: the bootstrap tab is the local anchor control panel instead of
   * `about:blank`. `false` restores the old blank anchor exactly (and stops all
   * panel painting).
   */
  panel: boolean;
  /** P10-B: which tab is raised during and after a stage. */
  follow: FollowPolicy;
  /** P10-B: ms after the last stage before the anchor is raised again. */
  idleMs: number;
}

export interface GoogleConfig {
  enabled: boolean;
  lang: string;
  gl: string;
  dailyCap: number;
}

export interface DuckDuckGoConfig {
  enabled: boolean;
  kl: string;
  dailyCap: number;
}

export interface YandexConfig {
  enabled: boolean;
  lr: string;
  dailyCap: number;
}

export interface EnginesConfig {
  google: GoogleConfig;
  duckduckgo: DuckDuckGoConfig;
  yandex: YandexConfig;
}

export type PacingWindow = [number, number];

export interface PacingConfig {
  google: PacingWindow;
  duckduckgo: PacingWindow;
  yandex: PacingWindow;
}

export interface SearchConfig {
  n: number;
  nMax: number;
  summaryMaxChars: number;
  snippetMaxChars: number;
  outputMaxChars: number;
  /** Bounded wait for a streaming native AI summary (P8-A); 0 disables waiting. */
  aiWaitMs: number;
  /** Allow one visible expand click inside the AI block (P8-B); default off. */
  aiExpand: boolean;
}

export interface ReadConfig {
  defaultMaxChars: number;
  maxCharsCeiling: number;
  /**
   * How many read tabs may exist (P9-A). `1` serializes every read on one tab;
   * `2..3` gives each slot its own tab AND its own exclusive lock, so parallel
   * reads cannot navigate each other's page. Never more than 3 (profile safety).
   */
  pool: number;
  /** Hard ceiling for a fetched PDF (P12-A). A larger file fails fast, naming its size. */
  pdfMaxBytes: number;
  /** Keep the fetched PDF bytes next to the text artifact (P12-A); default off. */
  keepPdf: boolean;
  /** Per-page text cap before the next `--- p.N ---` marker (P12-B). */
  pdfPageMaxChars: number;
}

export interface ImageConfig {
  /** Per-thumbnail byte ceiling for `attach:"bytes"` (P12-C); default 8 MB. */
  attachMaxBytes: number;
}

export interface CacheConfig {
  serpTtlMs: number;
  gotoTtlMs: number;
  maxEntries: number;
}

export interface CaptchaConfig {
  waitMs: number;
  retryYandexOnce: boolean;
}

export interface ArtifactsConfig {
  enabled: boolean;
  keep: number;
  maxBytes: number;
}

export interface OpenRouterReflexConfig {
  primary: string;
  fallback: string[];
}

export interface TriageConfig {
  /** Rule expression: "multi-engine-or-n>10" by default. */
  when: string;
  keep: number;
}

export interface ReflexConfig {
  enabled: boolean;
  backend: ReflexBackend;
  localOnly: boolean;
  provider: string;
  model: string | null;
  prefer: string[];
  openrouter: OpenRouterReflexConfig;
  abstainBelow: number;
  maxLatencyMs: number;
  maxCallsPerSearch: number;
  maxCallsPerSession: number;
  maxUsdPerSession: number;
  batchBackend: BatchBackend;
  triage: TriageConfig;
}

export interface Config {
  mode: Mode;
  cdp: CdpConfig;
  window: WindowConfig;
  humanize: HumanizeMode;
  engines: EnginesConfig;
  pacing: PacingConfig;
  search: SearchConfig;
  read: ReadConfig;
  image: ImageConfig;
  cache: CacheConfig;
  captcha: CaptchaConfig;
  artifacts: ArtifactsConfig;
  reflex: ReflexConfig;
  debug: boolean;
}

export const DEFAULT_CONFIG: Config = {
  mode: "attach",
  cdp: { ports: [9222], ws: null, connectTimeoutMs: 5000, profileDir: null, attachWaitMs: 60000 },
  window: { focus: "session", reuse: true, raiseOnPrompt: "auto", panel: true, follow: "work", idleMs: 1500 },
  humanize: "auto",
  engines: {
    google: { enabled: true, lang: "auto", gl: "auto", dailyCap: 300 },
    duckduckgo: { enabled: true, kl: "auto", dailyCap: 300 },
    yandex: { enabled: true, lr: "auto", dailyCap: 150 },
  },
  pacing: { google: [2500, 5000], yandex: [5000, 9000], duckduckgo: [2000, 4000] },
  search: {
    n: 5,
    nMax: 10,
    summaryMaxChars: 1200,
    snippetMaxChars: 140,
    outputMaxChars: 2500,
    aiWaitMs: 6000,
    aiExpand: false,
  },
  read: {
    defaultMaxChars: 6000,
    maxCharsCeiling: 20000,
    pool: 1,
    pdfMaxBytes: 20 * 1024 * 1024,
    keepPdf: false,
    pdfPageMaxChars: 4000,
  },
  image: { attachMaxBytes: 8 * 1024 * 1024 },
  cache: { serpTtlMs: 600000, gotoTtlMs: 86400000, maxEntries: 200 },
  captcha: { waitMs: 0, retryYandexOnce: true },
  artifacts: { enabled: true, keep: 30, maxBytes: 52428800 },
  reflex: {
    enabled: false,
    backend: "auto",
    localOnly: false,
    provider: "auto",
    model: null,
    prefer: ["llama.cpp", "openrouter"],
    openrouter: {
      primary: "~typesafe/jev-latest",
      fallback: [
        "cloudflare/clef-flash",
        "~perplexity/pplx-decider-flash-latest",
        "respan/span-01-lite:free",
      ],
    },
    abstainBelow: 0.55,
    maxLatencyMs: 1200,
    maxCallsPerSearch: 30,
    maxCallsPerSession: 500,
    maxUsdPerSession: 0.05,
    batchBackend: "classifier",
    triage: { when: "multi-engine-or-n>10", keep: 6 },
  },
  debug: false,
};

// ---------------------------------------------------------------------------
// Validation schema (hand-rolled: no dependency, exact key paths in errors)
// ---------------------------------------------------------------------------

type Spec =
  | { kind: "string"; nonEmpty?: boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "number"; integer?: boolean; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "array"; item: Spec; minItems?: number; maxItems?: number }
  | { kind: "tuple"; items: readonly [Spec, Spec] }
  | { kind: "nullable"; of: Spec }
  | { kind: "object"; fields: Record<string, Spec> };

const STRING: Spec = { kind: "string" };
const STRING_NE: Spec = { kind: "string", nonEmpty: true };
const BOOL: Spec = { kind: "boolean" };
const NUM = (min = 0, integer = true, max?: number): Spec =>
  max === undefined ? { kind: "number", min, integer } : { kind: "number", min, integer, max };

const CONFIG_SPEC: Spec = {
  kind: "object",
  fields: {
    mode: { kind: "enum", values: ["attach", "launch"] },
    cdp: {
      kind: "object",
      fields: {
        ports: { kind: "array", item: NUM(1, true, 65535), minItems: 1 },
        ws: { kind: "nullable", of: STRING_NE },
        connectTimeoutMs: NUM(1),
        profileDir: { kind: "nullable", of: STRING_NE },
        attachWaitMs: NUM(0, true, 600_000),
      },
    },
    window: {
      kind: "object",
      fields: {
        focus: { kind: "enum", values: ["session", "always", "never"] },
        reuse: BOOL,
        raiseOnPrompt: { kind: "enum", values: ["auto", "never"] },
        panel: BOOL,
        follow: { kind: "enum", values: ["work", "anchor", "never"] },
        idleMs: NUM(0, true, 60_000),
      },
    },
    humanize: { kind: "enum", values: ["auto", "always", "typing"] },
    engines: {
      kind: "object",
      fields: {
        google: {
          kind: "object",
          fields: { enabled: BOOL, lang: STRING_NE, gl: STRING_NE, dailyCap: NUM(0) },
        },
        duckduckgo: {
          kind: "object",
          fields: { enabled: BOOL, kl: STRING_NE, dailyCap: NUM(0) },
        },
        yandex: {
          kind: "object",
          fields: { enabled: BOOL, lr: STRING_NE, dailyCap: NUM(0) },
        },
      },
    },
    pacing: {
      kind: "object",
      fields: {
        google: { kind: "tuple", items: [NUM(0), NUM(0)] },
        duckduckgo: { kind: "tuple", items: [NUM(0), NUM(0)] },
        yandex: { kind: "tuple", items: [NUM(0), NUM(0)] },
      },
    },
    search: {
      kind: "object",
      fields: {
        n: NUM(1),
        nMax: NUM(1),
        summaryMaxChars: NUM(1),
        snippetMaxChars: NUM(1),
        outputMaxChars: NUM(1),
        aiWaitMs: NUM(0, true, 60_000),
        aiExpand: BOOL,
      },
    },
    read: {
      kind: "object",
      fields: {
        defaultMaxChars: NUM(1),
        maxCharsCeiling: NUM(1),
        pool: NUM(1, true, 3),
        pdfMaxBytes: NUM(1),
        keepPdf: BOOL,
        pdfPageMaxChars: NUM(1),
      },
    },
    image: {
      kind: "object",
      fields: { attachMaxBytes: NUM(1) },
    },
    cache: {
      kind: "object",
      fields: { serpTtlMs: NUM(0), gotoTtlMs: NUM(0), maxEntries: NUM(1) },
    },
    captcha: {
      kind: "object",
      fields: { waitMs: NUM(0), retryYandexOnce: BOOL },
    },
    artifacts: {
      kind: "object",
      fields: { enabled: BOOL, keep: NUM(1), maxBytes: NUM(1) },
    },
    reflex: {
      kind: "object",
      fields: {
        enabled: BOOL,
        backend: { kind: "enum", values: ["auto", "local", "openrouter", "rules"] },
        localOnly: BOOL,
        provider: STRING_NE,
        model: { kind: "nullable", of: STRING_NE },
        prefer: { kind: "array", item: STRING_NE },
        openrouter: {
          kind: "object",
          fields: {
            primary: STRING_NE,
            fallback: { kind: "array", item: STRING_NE },
          },
        },
        abstainBelow: NUM(0, false, 1),
        maxLatencyMs: NUM(1),
        maxCallsPerSearch: NUM(0),
        maxCallsPerSession: NUM(0),
        maxUsdPerSession: NUM(0, false),
        batchBackend: { kind: "enum", values: ["classifier", "chat-small"] },
        triage: {
          kind: "object",
          fields: { when: STRING_NE, keep: NUM(1) },
        },
      },
    },
    debug: BOOL,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string, source: string): WebSearchError {
  const details: FailureDetails = {
    code: "E_CONFIG",
    stage: "config",
    retryable: false,
    hint: `check ${source}: ${message}`,
    message,
  };
  return new WebSearchError(details);
}

function validate(spec: Spec, value: unknown, path: string, source: string): unknown {
  switch (spec.kind) {
    case "string": {
      if (typeof value !== "string") {
        throw configError(`${path}: expected string, got ${describe(value)}`, source);
      }
      if (spec.nonEmpty && value.trim() === "") {
        throw configError(`${path}: expected a non-empty string`, source);
      }
      return value;
    }
    case "enum": {
      if (typeof value !== "string" || !spec.values.includes(value)) {
        throw configError(`${path}: expected one of ${spec.values.join(" | ")}, got ${describe(value)}`, source);
      }
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw configError(`${path}: expected number, got ${describe(value)}`, source);
      }
      if (spec.integer && !Number.isInteger(value)) {
        throw configError(`${path}: expected an integer, got ${value}`, source);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw configError(`${path}: must be >= ${spec.min}, got ${value}`, source);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw configError(`${path}: must be <= ${spec.max}, got ${value}`, source);
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw configError(`${path}: expected boolean, got ${describe(value)}`, source);
      }
      return value;
    }
    case "null": {
      if (value !== null) {
        throw configError(`${path}: expected null, got ${describe(value)}`, source);
      }
      return value;
    }
    case "nullable": {
      return value === null ? null : validate(spec.of, value, path, source);
    }
    case "array": {
      if (!Array.isArray(value)) {
        throw configError(`${path}: expected array, got ${describe(value)}`, source);
      }
      if (spec.minItems !== undefined && value.length < spec.minItems) {
        throw configError(`${path}: expected at least ${spec.minItems} item(s)`, source);
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        throw configError(`${path}: expected at most ${spec.maxItems} item(s)`, source);
      }
      return value.map((item, index) => validate(spec.item, item, `${path}[${index}]`, source));
    }
    case "tuple": {
      if (!Array.isArray(value) || value.length !== spec.items.length) {
        throw configError(`${path}: expected a ${spec.items.length}-item array`, source);
      }
      const [first, second] = spec.items;
      return [
        validate(first, value[0], `${path}[0]`, source),
        validate(second, value[1], `${path}[1]`, source),
      ];
    }
    case "object": {
      if (!isPlainObject(value)) {
        throw configError(`${path}: expected an object, got ${describe(value)}`, source);
      }
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(spec.fields, key)) {
          throw configError(`${path}.${key}: unknown key (unknown keys are rejected)`, source);
        }
      }
      const result: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(spec.fields)) {
        if (!Object.hasOwn(value, key)) {
          throw configError(`${path}.${key}: missing required key`, source);
        }
        result[key] = validate(field, value[key], `${path}.${key}`, source);
      }
      return result;
    }
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Deep-merge a partial config over defaults. Objects merge recursively; arrays
 * (including pacing tuples) are replaced by the patch.
 */
function mergeConfig(base: unknown, patch: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = Object.hasOwn(base, key) ? mergeConfig(base[key], value) : value;
    }
    return merged;
  }
  return patch;
}

/**
 * Merge a partial config over defaults, then validate the result strictly.
 * Unknown keys survive the merge and are rejected by the validator.
 */
export function parseConfig(raw: unknown, opts: { source?: string } = {}): Config {
  const source = opts.source ?? "config";
  if (!isPlainObject(raw)) {
    throw configError("top level: expected a JSON object", source);
  }
  const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), raw);
  const validated = validate(CONFIG_SPEC, merged, "config", source) as Config;
  assertCrossField(validated, source);
  return validated;
}

function assertCrossField(config: Config, source: string): void {
  if (config.search.n > config.search.nMax) {
    throw configError(`config.search.n: ${config.search.n} exceeds config.search.nMax (${config.search.nMax})`, source);
  }
  if (config.search.nMax > 10) {
    throw configError(`config.search.nMax: ${config.search.nMax} exceeds the supported ceiling of 10`, source);
  }
  for (const engine of ENGINE_IDS) {
    const window = config.pacing[engine];
    if (window[0] > window[1]) {
      throw configError(`config.pacing.${engine}: min gap ${window[0]} > max ${window[1]}`, source);
    }
  }
  if (config.read.defaultMaxChars > config.read.maxCharsCeiling) {
    throw configError(
      `config.read.defaultMaxChars: ${config.read.defaultMaxChars} exceeds maxCharsCeiling (${config.read.maxCharsCeiling})`,
      source,
    );
  }
  if (!ENGINE_IDS.some((id) => config.engines[id].enabled)) {
    throw configError("config.engines: at least one engine must be enabled", source);
  }
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "web-search.json");
}

/** Apply env overrides after file parsing (SPEC §11). */
export function applyEnv(config: Config, env: NodeJS.ProcessEnv = process.env, source = "env"): Config {
  const next: Config = structuredClone(config);

  const ws = env.PI_CHROME_CDP_WS?.trim();
  if (ws) {
    if (!ws.startsWith("ws://") && !ws.startsWith("wss://")) {
      throw configError("PI_CHROME_CDP_WS: expected a ws:// or wss:// URL", source);
    }
    next.cdp.ws = ws;
  }

  const ports = env.PI_CHROME_CDP_PORTS?.trim();
  if (ports) {
    const parsed = ports.split(",").map((part) => Number(part.trim()));
    if (parsed.length === 0 || parsed.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw configError(`PI_CHROME_CDP_PORTS: expected comma-separated ports, got "${ports}"`, source);
    }
    next.cdp.ports = parsed;
  }

  const debug = env.PI_CHROME_SEARCH_DEBUG?.trim();
  if (debug !== undefined && debug !== "") {
    next.debug = debug === "1" || debug.toLowerCase() === "true";
  }

  const profile = env.PI_CHROME_SEARCH_PROFILE?.trim();
  if (profile) {
    next.cdp.profileDir = expandHome(profile);
  }

  return next;
}

export interface LoadConfigOptions {
  /** Explicit config file path; defaults to resolveConfigPath(env). */
  path?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Load config from disk. A missing file is not an error: defaults apply.
 * Everything else (unreadable file, bad JSON, bad shape) is `E_CONFIG`.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const path = opts.path ?? resolveConfigPath(env);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return applyEnv(DEFAULT_CONFIG, env, path);
    }
    throw configError(`cannot read ${path} (${code ?? "unknown error"})`, path);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw configError(`invalid JSON (${message})`, path);
  }

  return applyEnv(parseConfig(raw, { source: path }), env, path);
}
