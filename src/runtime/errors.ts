/**
 * Error constructors + renderers (SPEC §10.1).
 *
 * The taxonomy itself is frozen in `error-codes.ts` (P0) so config loading can
 * throw before this module exists. This file only adds the behaviour every
 * caller wants: fill the hint/retryable defaults, normalize unknown throws, and
 * render the two shapes the agent and codemode actually consume.
 */

import type { EngineId, WallKind } from "../engines/types.ts";
import {
  ERROR_HINTS,
  RETRYABLE,
  WebSearchError,
  isWebSearchError,
} from "./error-codes.ts";
import type { ErrorCode, FailureDetails, Stage } from "./error-codes.ts";

/** Long enough for an actionable cause, short enough not to bloat a tool result. */
const MAX_MESSAGE_CHARS = 300;

/**
 * C0/C1 controls (except the newlines/tabs we normalize separately), DEL,
 * Unicode line separators, and bidi overrides/isolates. U+2028/U+2029 render as
 * line breaks in many terminals (forging a second error line) and the bidi
 * controls let text visually reorder or hide part of a hint.
 */
const CONTROL_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/**
 * A tool result is rendered by pi as text and may be echoed into a terminal;
 * control characters would corrupt that output (or hide text). Newlines become
 * spaces here because hints are single-line in the SPEC shape.
 */
function sanitizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(CONTROL_CHARS, "")
    .replace(/\n+/g, " ")
    .trim();
}

/** Sanitize a rendered field even when an untyped details object supplies junk. */
function renderField(value: unknown): string {
  if (value === undefined || value === null) return "";
  return sanitizeText(typeof value === "string" ? value : String(value));
}

function cleanMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = sanitizeText(value);
  if (cleaned.length <= MAX_MESSAGE_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_MESSAGE_CHARS - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbort(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.name === "AbortError" || error.code === "ABORT_ERR") return true;
  // Some abort errors carry the originating signal instead of a recognizable name.
  const signal = error.signal;
  return isRecord(signal) && signal.aborted === true;
}

function isTimeout(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.name === "TimeoutError" || error.code === "ETIMEDOUT";
}

/** Never touches `.stack`: stacks contain local paths and are not user-facing. */
function messageOf(error: unknown): string {
  if (typeof error === "string") return cleanMessage(error);
  if (error instanceof Error) return cleanMessage(error.message);
  if (isRecord(error) && typeof error.message === "string") return cleanMessage(error.message);
  if (error === undefined || error === null) return "";
  try {
    const json = JSON.stringify(error);
    return cleanMessage(json ?? String(error));
  } catch {
    return cleanMessage(String(error));
  }
}

export interface FailOptions {
  engine?: EngineId;
  wall?: WallKind;
  artifact?: string;
  /** Explicit context for the log/doctor; never a replacement for the code hint story. */
  message?: string;
  /**
   * Override the default hint. An empty/whitespace-only value falls back to
   * ERROR_HINTS instead of producing a useless "hint: " line.
   */
  hint?: string;
}

/**
 * Build the one error type the extension throws. `retryable` always derives
 * from the frozen table, so a caller cannot accidentally mark E_PARSE retryable
 * (that would turn a broken selector into a retry loop).
 */
export function fail(code: ErrorCode, stage: Stage, opts: FailOptions = {}): WebSearchError {
  const explicitHint = typeof opts.hint === "string" ? sanitizeText(opts.hint) : "";
  const hint = explicitHint.length > 0 ? explicitHint : sanitizeText(ERROR_HINTS[code]);
  const message = cleanMessage(opts.message);

  const details: FailureDetails = {
    code,
    ...(opts.engine === undefined ? {} : { engine: opts.engine }),
    stage,
    ...(opts.wall === undefined ? {} : { wall: opts.wall }),
    ...(opts.artifact === undefined ? {} : { artifact: sanitizeText(opts.artifact) }),
    retryable: RETRYABLE[code],
    hint,
    ...(message.length === 0 ? {} : { message }),
  };

  return new WebSearchError(details);
}

export interface FailureFallback {
  code: ErrorCode;
  stage: Stage;
}

/**
 * Map anything a dependency can throw onto the taxonomy. WebSearchError is
 * already precise; everything else would otherwise leak `fetch failed` or a
 * Node errno to the agent without a code, stage or action.
 */
export function toFailure(error: unknown, fallback: FailureFallback): FailureDetails {
  if (isWebSearchError(error)) return error.details;

  const message = messageOf(error);
  if (isAbort(error)) {
    return fail("E_CANCELLED", fallback.stage, message.length > 0 ? { message } : {}).details;
  }
  if (isTimeout(error)) {
    return fail("E_TIMEOUT", fallback.stage, message.length > 0 ? { message } : {}).details;
  }
  return fail(fallback.code, fallback.stage, message.length > 0 ? { message } : {}).details;
}

export interface RenderTextOptions {
  /** Defaults to `web_search`; doctor/research may pass their own tool name. */
  tool?: string;
}

/**
 * The human/agent-facing block, exactly the SPEC §10.1 shape:
 *
 *   web_search failed [E_PARSE] engine=google stage=extract
 *   hint: selector canary failed (results=0); artifact: ~/.pi/agent/web-search/artifacts/…
 *
 * `artifact` and `wall` are appended to the hint line only when the field
 * exists: a separate `artifact:` line would both diverge from the SPEC and send
 * the agent looking for a directory that is not there. Every interpolated field
 * is sanitized, not just the hint — an untyped details object must not be able
 * to smuggle a newline into the header and forge extra lines.
 */
export function renderFailureText(details: FailureDetails, opts: RenderTextOptions = {}): string {
  const tool = renderField(opts.tool) || "web_search";
  const hint = renderField(details.hint) || renderField(ERROR_HINTS[details.code]);
  const engine = renderField(details.engine);
  const header = `${tool} failed [${renderField(details.code)}]${
    engine === "" ? "" : ` engine=${engine}`
  } stage=${renderField(details.stage)}`;

  const parts = [hint];
  const artifact = renderField(details.artifact);
  if (artifact !== "") parts.push(`artifact: ${artifact}`);
  const wall = renderField(details.wall);
  if (wall !== "") parts.push(`wall: ${wall}`);

  return [header, `hint: ${parts.join("; ")}`].join("\n");
}

/**
 * `code`/`stage`/`engine`/`wall` are enums in the type system, but `details`
 * can also arrive from a cast, a log round-trip or a sibling extension. Sanitize
 * them like the text renderer so no control or bidi byte reaches codemode; the
 * value stays visible (and auditable) instead of being dropped.
 */
function sanitizeEnum<T extends string>(value: unknown): T | undefined {
  return value === undefined ? undefined : (renderField(value) as T);
}

/** The codemode-facing subset (SPEC §10.1). Hints stay out of machine JSON. */
export interface FailureJson {
  code: ErrorCode;
  engine?: EngineId;
  stage: Stage;
  wall?: WallKind;
  artifact?: string;
  retryable: boolean;
  message?: string;
}

export function toFailureJson(details: FailureDetails): FailureJson {
  const message = cleanMessage(details.message);
  const engine = sanitizeEnum<EngineId>(details.engine);
  const wall = sanitizeEnum<WallKind>(details.wall);
  // `stage` is required by FailureJson: a hostile object without one renders "".
  const stage = renderField(details.stage) as Stage;
  const artifact = sanitizeEnum<string>(details.artifact);
  // Key order is fixed by construction so JSON snapshots/tests are deterministic.
  return {
    code: details.code,
    ...(engine === undefined ? {} : { engine }),
    stage,
    ...(wall === undefined ? {} : { wall }),
    ...(artifact === undefined ? {} : { artifact }),
    retryable: details.retryable,
    ...(message.length === 0 ? {} : { message }),
  };
}

export function renderFailureJson(details: FailureDetails): string {
  return JSON.stringify(toFailureJson(details));
}

export interface ToolTextBlock {
  type: "text";
  text: string;
}

export interface ToolFailureResult {
  content: ToolTextBlock[];
  details: FailureJson;
}

/**
 * Plain-object pi tool result. Deliberately not importing pi's tool types: this
 * module stays testable offline and `details` must serialize for codemode.
 */
export function renderToolFailure(tool: string, details: FailureDetails): ToolFailureResult {
  return {
    content: [{ type: "text", text: renderFailureText(details, { tool }) }],
    details: toFailureJson(details),
  };
}
