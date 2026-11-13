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
  | "E_EMPTY_PAGE"
  | "E_PARSE"
  | "E_TIMEOUT"
  | "E_BUSY"
  | "E_BLOCKED_URL"
  | "E_UNSUPPORTED"
  | "E_CANCELLED"
  | "E_NAVIGATION_MISMATCH"
  | "E_OFFSET_RANGE"
  | "E_CDP_AWAITING_ALLOW"
  | "E_PDF_SCANNED"
  | "E_PDF_UNSUPPORTED";

export const ERROR_CODES = [
  "E_CONFIG",
  "E_CDP_UNAVAILABLE",
  "E_CDP_DISCONNECTED",
  "E_TARGET_LOST",
  "E_WALL",
  "E_EMPTY",
  "E_EMPTY_PAGE",
  "E_PARSE",
  "E_TIMEOUT",
  "E_BUSY",
  "E_BLOCKED_URL",
  "E_UNSUPPORTED",
  "E_CANCELLED",
  "E_NAVIGATION_MISMATCH",
  "E_OFFSET_RANGE",
  "E_CDP_AWAITING_ALLOW",
  "E_PDF_SCANNED",
  "E_PDF_UNSUPPORTED",
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
  | "read";

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
  E_EMPTY: "the engine returned no organic results; rephrase the query or try another engine",
  E_PARSE: "a selector canary failed; inspect the artifact directory, run /web-doctor, then patch the adapter",
  E_EMPTY_PAGE:
    "the document rendered no readable text; the page may be client-side, so open the artifact " +
    "and try another URL (or retry once if the page loads late)",
  E_TIMEOUT: "the deadline was exceeded; retry, or ask for less (a smaller `n` or `maxChars`)",
  E_BUSY: "another pi session holds ~/.pi/agent/web-search.lock; close it or wait for its heartbeat to expire",
  E_BLOCKED_URL: "use a public http(s) URL; localhost, private ranges, file: and data: are blocked",
  E_UNSUPPORTED: "this engine or vertical is not implemented yet; check /web-doctor for per-engine status",
  E_CANCELLED: "the call was aborted; retry if it was not intentional",
  E_NAVIGATION_MISMATCH:
    "the tab changed document between navigation and extraction; retry once — reads are serialized, " +
    "so a repeat means the page navigated itself",
  E_OFFSET_RANGE:
    "offset is past the end of the rendered document; pass an offset below the reported totalChars " +
    "(or 0 to start over)",
  E_CDP_AWAITING_ALLOW:
    "the browser is waiting for the DevTools Allow: open the remote-debugging page " +
    "(chrome://inspect/#remote-debugging for Chrome; edge://, brave:// or chromium:// for the other " +
    "Chromium-family browsers), tick \"Discover network targets\" and click Allow — the call resumes by itself",
  E_PDF_SCANNED:
    "the PDF is a scan with no text layer; OCR is out of scope and silently inventing text is forbidden — " +
    "open it in the browser or find an HTML/text version with the same content",
  E_PDF_UNSUPPORTED:
    "the PDF could not be decoded; the in-tree extractor found no readable text and no installed " +
    "pdftotext/mutool fallback succeeded — try the HTML version of the document or open the artifact",
};

export const RETRYABLE: Record<ErrorCode, boolean> = {
  E_CONFIG: false,
  E_CDP_UNAVAILABLE: false,
  E_CDP_DISCONNECTED: true,
  E_TARGET_LOST: true,
  E_WALL: true,
  E_EMPTY: true,
  E_EMPTY_PAGE: false,
  E_PARSE: false,
  E_TIMEOUT: true,
  E_BUSY: true,
  E_BLOCKED_URL: false,
  E_UNSUPPORTED: false,
  E_CANCELLED: true,
  E_NAVIGATION_MISMATCH: true,
  E_OFFSET_RANGE: false,
  E_CDP_AWAITING_ALLOW: true,
  E_PDF_SCANNED: false,
  E_PDF_UNSUPPORTED: false,
};

/**
 * Codes whose owning phase has not added a dedicated offline test yet (S9.5).
 * Production paths may throw them, but the contract is not proven until the
 * named phase lands its test, so a reservation cannot become a permanent pass.
 */
export const RESERVED_CODES: Partial<Record<ErrorCode, string>> = {
  E_EMPTY_PAGE: "P5 read: a thin document after readiness",
  E_NAVIGATION_MISMATCH: "P5 read: URL changed between navigation and extraction",
  E_OFFSET_RANGE: "P5 read: offset past totalChars",
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
