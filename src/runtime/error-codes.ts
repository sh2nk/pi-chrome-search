/**
 * Frozen error taxonomy (SPEC §10.1). Every failure in the extension is a
 * `WebSearchError` with a code, a stage, an actionable hint and — where useful —
 * an artifact directory. No bare `throw new Error("failed")`.
 *
 * The class lives here (not in runtime/errors.ts) so config loading can throw a
 * contract-shaped error before runtime/errors.ts exists (P0 vs P1-C split).
 */

import type { EngineId, WallKind } from "../engines/types.ts";

export type ErrorCode =
  | "E_CONFIG"
  | "E_CDP_UNAVAILABLE"
  | "E_CDP_DISCONNECTED"
  | "E_TARGET_LOST"
  | "E_WALL"
  | "E_EMPTY"
  | "E_PARSE"
  | "E_TIMEOUT"
  | "E_RATE_LIMITED"
  | "E_BUSY"
  | "E_BLOCKED_URL"
  | "E_UNSUPPORTED"
  | "E_CANCELLED";

export const ERROR_CODES = [
  "E_CONFIG",
  "E_CDP_UNAVAILABLE",
  "E_CDP_DISCONNECTED",
  "E_TARGET_LOST",
  "E_WALL",
  "E_EMPTY",
  "E_PARSE",
  "E_TIMEOUT",
  "E_RATE_LIMITED",
  "E_BUSY",
  "E_BLOCKED_URL",
  "E_UNSUPPORTED",
  "E_CANCELLED",
] as const satisfies readonly ErrorCode[];

export type Stage =
  | "config"
  | "discover"
  | "connect"
  | "navigate"
  | "settle"
  | "extract"
  | "resolve"
  | "render"
  | "read"
  | "reflex";

export const STAGES = [
  "config",
  "discover",
  "connect",
  "navigate",
  "settle",
  "extract",
  "resolve",
  "render",
  "read",
  "reflex",
] as const satisfies readonly Stage[];

export interface FailureDetails {
  code: ErrorCode;
  engine?: EngineId;
  stage: Stage;
  wall?: WallKind;
  artifact?: string;
  retryable: boolean;
  hint: string;
  /** Free-form context (config key path, selector name, status code). Must stay serializable. */
  message?: string;
}

/**
 * One hint per code. Tests assert completeness, so adding a code without a hint
 * fails `npm test`.
 */
export const ERROR_HINTS: Record<ErrorCode, string> = {
  E_CONFIG:
    "fix the named key in web-search.json (or $PI_CODING_AGENT_DIR/web-search.json); unknown keys are rejected",
  E_CDP_UNAVAILABLE:
    "open the browser's remote-debugging page (chrome://inspect/#remote-debugging for Chrome; " +
    "edge://, brave:// or chromium:// for the other Chromium-family browsers), tick " +
    "\"Discover network targets\" and click Allow, then retry; or set " +
    "PI_CHROME_CDP_WS=ws://127.0.0.1:<port><path>",
  E_CDP_DISCONNECTED: "the CDP socket dropped; retry once — if it repeats, run /web-doctor and check the lock file",
  E_TARGET_LOST: "the owned tab was closed or navigated away; retry to reopen it",
  E_WALL: "solve the captcha/consent in the visible browser window, then retry — never automate it",
  E_EMPTY: "the engine returned no organic results; rephrase, try another engine, or drop freshness filters",
  E_PARSE: "a selector canary failed; inspect the artifact directory, run /web-doctor, then patch the adapter",
  E_TIMEOUT: "the deadline was exceeded; retry or raise the timeout in config",
  E_RATE_LIMITED: "the per-engine gap or daily soft cap is active; wait or use another engine",
  E_BUSY: "another pi session holds ~/.pi/agent/web-search.lock; close it or wait for its heartbeat to expire",
  E_BLOCKED_URL: "use a public http(s) URL; localhost, private ranges, file: and data: are blocked",
  E_UNSUPPORTED: "this engine or vertical is not implemented yet; check /web-doctor for per-engine status",
  E_CANCELLED: "the call was aborted; retry if it was not intentional",
};

export const RETRYABLE: Record<ErrorCode, boolean> = {
  E_CONFIG: false,
  E_CDP_UNAVAILABLE: false,
  E_CDP_DISCONNECTED: true,
  E_TARGET_LOST: true,
  E_WALL: true,
  E_EMPTY: true,
  E_PARSE: false,
  E_TIMEOUT: true,
  E_RATE_LIMITED: true,
  E_BUSY: true,
  E_BLOCKED_URL: false,
  E_UNSUPPORTED: false,
  E_CANCELLED: true,
};

export class WebSearchError extends Error {
  readonly details: FailureDetails;

  constructor(details: FailureDetails) {
    super(`${details.code} during ${details.stage}: ${details.message ?? details.hint}`);
    this.name = "WebSearchError";
    this.details = details;
  }
}

export function isWebSearchError(value: unknown): value is WebSearchError {
  return value instanceof WebSearchError;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
