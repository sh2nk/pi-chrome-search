/**
 * `web_read` — deferred page reading (SPEC §7.2, PLAN P4-A).
 *
 * The tool is a thin orchestrator over frozen contracts, like `web_search`:
 * validate the URL through the SSRF guard, acquire the work tab, navigate,
 * re-check the *landed* URL (a public host may redirect to 127.0.0.1), run the
 * self-contained readability pass in the page, and render one `offset` window.
 *
 * Two security facts are non-negotiable here:
 * - the guard runs before `acquirePage`, so a private URL causes no navigation;
 * - it runs again on `page.url()`, because the first check cannot see redirects.
 *
 * Output is Markdown (or plain text) produced by `extract/read.ts`; raw HTML is
 * never returned. The audit log records `host + path` only — a read URL may
 * carry a session token or a personal query, and the log is not the place for
 * it.
 */

import { Type, type Static } from "typebox";

import type { CdpPage } from "../cdp/types.ts";
import type { Config } from "../config.ts";
import type { EngineId } from "../engines/types.ts";
import {
  READ_MAX_CHARS_CEILING,
  extractReadableDocument,
  renderReadableDocument,
  type ReadBlock,
  type ReadInline,
  type ReadableDocument,
} from "../extract/read.ts";
import type { Stage } from "../runtime/error-codes.ts";
import { isWebSearchError } from "../runtime/error-codes.ts";
import { fail, renderToolFailure, toFailure } from "../runtime/errors.ts";
import type { FailureFallback, FailureJson, ToolTextBlock } from "../runtime/errors.ts";
import { assertPublicUrl, type ResolveHost } from "../runtime/ssrf.ts";
import type { ToolDeps } from "./types.ts";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

/**
 * `maxChars` has no `maximum` on purpose: a large request is clamped to the
 * ceiling (SPEC §7.2), not rejected. `offset` and `maxChars` are re-validated in
 * `execute` because codemode bypasses the schema.
 */
export const webReadSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("text")])),
});

export type WebReadInput = Static<typeof webReadSchema>;

export interface WebReadDetails {
  /** The normalised URL the caller asked for. */
  url: string;
  /** The URL the tab actually landed on (after redirects). */
  finalUrl: string;
  title: string;
  byline?: string;
  publishedAt?: string;
  /** Length of the returned window. */
  chars: number;
  truncated: boolean;
  /** Pass back as `offset` to continue. */
  nextOffset?: number;
  format: "md" | "text";
}

export interface WebReadSuccess {
  content: ToolTextBlock[];
  details: WebReadDetails;
}

export interface WebReadFailure {
  content: ToolTextBlock[];
  details: FailureJson;
  isError: true;
}

export type WebReadResult = WebReadSuccess | WebReadFailure;

/** The object shape pi registers (P4-D wires it into the extension). */
export interface WebReadTool {
  name: "web_read";
  label: string;
  description: string;
  parameters: typeof webReadSchema;
  exposure: "deferred";
  annotations: { readOnlyHint: true; openWorldHint: true; idempotentHint: true };
  execute(
    toolCallId: string,
    params: WebReadInput,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx?: unknown,
  ): Promise<WebReadResult>;
}

/**
 * Under 350 chars (asserted in the unit test; P4-D re-measures the whole
 * surface). It says what the tool is, what it strips, the continuation
 * parameters and the hard security rule, and nothing else.
 */
export const WEB_READ_DESCRIPTION =
  "Read one public page through the user's visible Chrome and return clean Markdown (nav, ads, scripts stripped). Defaults to 6000 chars; use offset/maxChars (max 20000) for long pages. Private, local and non-http(s) URLs are refused.";

export interface WebReadOptions {
  /**
   * Injectable DNS resolver for the SSRF guard. Production leaves it unset;
   * every offline test must set it so the suite can never open a socket.
   */
  resolve?: ResolveHost;
}

/** Validation hint: the fix is in the call, not in a config file. */
const INPUT_HINT =
  "check the web_read arguments: url (public http/https), offset >= 0, maxChars >= 1, format md|text";

const UNSUPPORTED_HINT = "the page produced no readable text; try a different URL";

/**
 * Reads get their own work tab (`PageKey` in `src/cdp/types.ts`): a long article
 * must never navigate the google SERP tab out from under a result the tool just
 * cached, and a read must not inherit the engine's humanize/focus state.
 */
const READ_PAGE_KEY = "read" as const;

const BLOCK_KINDS: ReadonlySet<string> = new Set([
  "heading",
  "paragraph",
  "listItem",
  "quote",
  "code",
  "table",
]);

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

interface NormalizedInput {
  url: string;
  offset: number;
  maxChars: number;
  format: "md" | "text";
}

type Validation = { ok: true; value: NormalizedInput } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInput(raw: unknown, config: Config): Validation {
  if (!isRecord(raw)) return { ok: false, message: "arguments: expected an object" };

  const rawUrl = raw.url;
  if (typeof rawUrl !== "string") return { ok: false, message: "url: expected a string" };
  const url = rawUrl.trim();
  if (url === "") return { ok: false, message: "url: expected a non-empty URL" };

  if (raw.offset !== undefined) {
    if (typeof raw.offset !== "number" || !Number.isInteger(raw.offset) || raw.offset < 0) {
      return { ok: false, message: `offset: expected an integer >= 0, got ${JSON.stringify(raw.offset)}` };
    }
  }
  const offset = typeof raw.offset === "number" ? raw.offset : 0;

  if (raw.maxChars !== undefined) {
    if (typeof raw.maxChars !== "number" || !Number.isInteger(raw.maxChars) || raw.maxChars < 1) {
      return { ok: false, message: `maxChars: expected an integer >= 1, got ${JSON.stringify(raw.maxChars)}` };
    }
  }

  const configuredCeiling = Number.isFinite(config.read.maxCharsCeiling)
    ? Math.floor(config.read.maxCharsCeiling)
    : READ_MAX_CHARS_CEILING;
  const ceiling = Math.min(READ_MAX_CHARS_CEILING, Math.max(1, configuredCeiling));
  const configuredDefault = Number.isFinite(config.read.defaultMaxChars)
    ? Math.floor(config.read.defaultMaxChars)
    : ceiling;
  const requested = typeof raw.maxChars === "number" ? raw.maxChars : configuredDefault;
  // The ceiling is a clamp, never an error: a caller asking for 999999 gets the
  // largest window the SPEC allows instead of a wasted E_CONFIG round trip.
  const maxChars = Math.min(ceiling, Math.max(1, Math.floor(requested)));

  if (raw.format !== undefined && raw.format !== "md" && raw.format !== "text") {
    return { ok: false, message: `format: expected "md" or "text", got ${JSON.stringify(raw.format)}` };
  }
  const format = raw.format === "text" ? "text" : "md";

  return { ok: true, value: { url, offset, maxChars, format } };
}

// ---------------------------------------------------------------------------
// Failure mapping (same taxonomy as web_search)
// ---------------------------------------------------------------------------

function failureResult(error: unknown, fallback: FailureFallback): WebReadFailure {
  const details = isWebSearchError(error) ? error.details : toFailure(error, fallback);
  const rendered = renderToolFailure("web_read", details);
  return { content: rendered.content, details: rendered.details, isError: true };
}

/**
 * Anything a dependency throws becomes a taxonomy error. An abort wins over the
 * dependency's own shape because `signal.reason` may be any value, and a
 * WebSearchError already carries a precise code/stage.
 */
function asFailure(
  error: unknown,
  stage: Stage,
  fallbackCode: "E_CDP_DISCONNECTED" | "E_PARSE" = "E_CDP_DISCONNECTED",
  signal?: AbortSignal,
): ReturnType<typeof fail> {
  if (signal?.aborted === true && !isWebSearchError(error)) {
    return fail("E_CANCELLED", stage, { message: "aborted by the caller" });
  }
  if (isWebSearchError(error)) return error;
  const details = toFailure(error, { code: fallbackCode, stage });
  return fail(details.code, details.stage, {
    ...(details.hint === undefined ? {} : { hint: details.hint }),
    ...(details.message === undefined ? {} : { message: details.message }),
  });
}

// ---------------------------------------------------------------------------
// Web payload validation
// ---------------------------------------------------------------------------

function toInlines(value: unknown): ReadInline[] {
  if (!Array.isArray(value)) return [];
  const inlines: ReadInline[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (entry.kind !== "text" && entry.kind !== "code" && entry.kind !== "link") continue;
    if (typeof entry.text !== "string") continue;
    const inline: ReadInline = { kind: entry.kind, text: entry.text };
    if (entry.kind === "link" && typeof entry.href === "string" && entry.href !== "") inline.href = entry.href;
    inlines.push(inline);
  }
  return inlines;
}

function toRows(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: string[][] = [];
  for (const row of value) {
    if (!Array.isArray(row)) continue;
    rows.push(row.map((cell) => (typeof cell === "string" ? cell : "")));
  }
  return rows.length > 0 ? rows : undefined;
}

/**
 * `page.evaluate` is typed `unknown` on purpose. The extractor is ours, but the
 * result crosses a browser boundary, so every field is re-checked before it can
 * reach the renderer; an unknown block kind is dropped instead of trusted.
 */
function toReadableDocument(value: unknown): ReadableDocument | null {
  if (!isRecord(value)) return null;
  if (typeof value.title !== "string") return null;
  if (!Array.isArray(value.blocks)) return null;

  const blocks: ReadBlock[] = [];
  for (const entry of value.blocks) {
    if (!isRecord(entry) || typeof entry.kind !== "string" || !BLOCK_KINDS.has(entry.kind)) continue;
    const block: ReadBlock = { kind: entry.kind as ReadBlock["kind"] };
    if (typeof entry.level === "number" && Number.isFinite(entry.level)) block.level = entry.level;
    if (typeof entry.code === "string") block.code = entry.code;
    if (typeof entry.language === "string") block.language = entry.language;
    if (typeof entry.marker === "number" && Number.isFinite(entry.marker)) block.marker = entry.marker;
    if (typeof entry.depth === "number" && Number.isFinite(entry.depth)) block.depth = entry.depth;
    if (entry.inlines !== undefined) block.inlines = toInlines(entry.inlines);
    if (entry.rows !== undefined) block.rows = toRows(entry.rows);
    blocks.push(block);
  }

  const doc: ReadableDocument = { title: value.title, blocks };
  if (typeof value.byline === "string" && value.byline.trim() !== "") doc.byline = value.byline.trim();
  if (typeof value.publishedAt === "string" && value.publishedAt.trim() !== "") {
    doc.publishedAt = value.publishedAt.trim();
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Redirect re-check + audit domain
// ---------------------------------------------------------------------------

/**
 * The second guard pass. Its hint names the redirect (the caller's URL passed)
 * and its message stays generic: a redirect target may itself embed credentials
 * or a private host, neither of which belongs in an error string.
 */
async function recheckLanding(finalUrl: string, options: WebReadOptions): Promise<URL> {
  try {
    return await assertPublicUrl(finalUrl, options.resolve === undefined ? {} : { resolve: options.resolve });
  } catch (error) {
    const reason = isWebSearchError(error) ? error.details.message ?? "" : "";
    throw fail("E_BLOCKED_URL", "read", {
      hint: "the page redirected to a blocked address; read a public site instead",
      message: `redirect target blocked by the SSRF guard${reason === "" ? "" : ` (${reason})`}`,
    });
  }
}

/**
 * `host + path`, deliberately without the query string and fragment: read URLs
 * carry search terms, tokens and one-time links. The path can still identify a
 * page, which is what the domain audit needs.
 */
function auditDomain(finalUrl: URL): string {
  const path = finalUrl.pathname === "" ? "/" : finalUrl.pathname;
  const value = `${finalUrl.host}${path}`;
  return value.length > 300 ? `${value.slice(0, 299)}…` : value;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebReadTool(
  getDeps: (ctx?: unknown) => ToolDeps | Promise<ToolDeps>,
  options: WebReadOptions = {},
): WebReadTool {
  async function execute(
    _toolCallId: string,
    params: WebReadInput,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: unknown,
  ): Promise<WebReadResult> {
    let deps: ToolDeps;
    try {
      deps = await getDeps(ctx);
    } catch (error) {
      return failureResult(error, { code: "E_CONFIG", stage: "config" });
    }

    // Last-resort barrier: a dependency bug must still reach the agent as a
    // rendered failure with a code and a stage, never as a bare thrown error.
    try {
      return await read(deps, params, signal);
    } catch (error) {
      return failureResult(error, { code: "E_CDP_DISCONNECTED", stage: "read" });
    }
  }

  async function read(
    deps: ToolDeps,
    params: WebReadInput,
    signal: AbortSignal | undefined,
  ): Promise<WebReadResult> {
    const validation = normalizeInput(params, deps.config);
    if (!validation.ok) {
      throw fail("E_CONFIG", "config", { hint: INPUT_HINT, message: validation.message });
    }
    const input = validation.value;
    if (signal?.aborted === true) {
      throw fail("E_CANCELLED", "read", { message: "aborted by the caller" });
    }

    // First guard pass: before any tab is touched. A blocked URL therefore
    // cannot navigate, cannot leak the user's session, and cannot log a domain.
    const requested = await assertPublicUrl(
      input.url,
      options.resolve === undefined ? {} : { resolve: options.resolve },
    );

    let page: CdpPage;
    try {
      page = await deps.cdp.acquirePage(READ_PAGE_KEY);
    } catch (error) {
      throw asFailure(error, "connect", "E_CDP_DISCONNECTED", signal);
    }

    try {
      await page.navigate(requested.href, signal === undefined ? {} : { signal });
    } catch (error) {
      throw asFailure(error, "navigate", "E_CDP_DISCONNECTED", signal);
    }

    const landed = page.url();
    if (typeof landed !== "string" || landed.trim() === "") {
      throw fail("E_BLOCKED_URL", "read", {
        hint: "the tab did not report a URL; retry or use a public site",
        message: "navigation landed without a URL",
      });
    }
    const final = await recheckLanding(landed, options);

    let raw: unknown;
    try {
      raw = await page.evaluate<unknown>(`(${extractReadableDocument.toString()})(document)`);
    } catch (error) {
      throw asFailure(error, "extract", "E_PARSE", signal);
    }

    const data = toReadableDocument(raw);
    if (data === null) {
      throw fail("E_PARSE", "extract", {
        hint: "the readability pass returned an unusable payload; retry or open the page manually",
        message: "page extraction did not return a readable document",
      });
    }
    if (data.blocks.length === 0) {
      throw fail("E_PARSE", "extract", { hint: UNSUPPORTED_HINT, message: "the readability pass found no text blocks" });
    }

    const rendered = renderReadableDocument(data, {
      format: input.format,
      offset: input.offset,
      maxChars: input.maxChars,
    });

    const details: WebReadDetails = {
      url: requested.href,
      finalUrl: final.href,
      title: data.title,
      ...(data.byline === undefined ? {} : { byline: data.byline }),
      ...(data.publishedAt === undefined ? {} : { publishedAt: data.publishedAt }),
      chars: rendered.chars,
      truncated: rendered.truncated,
      ...(rendered.nextOffset === undefined ? {} : { nextOffset: rendered.nextOffset }),
      format: input.format,
    };

    // One domain line per read; a logger failure must never fail a read that
    // already produced text (the audit is evidence, not a dependency).
    void deps.log
      .write({ kind: "read", domain: auditDomain(final), chars: rendered.chars, truncated: rendered.truncated })
      .catch(() => undefined);

    return { content: [{ type: "text", text: rendered.text }], details };
  }

  return {
    name: "web_read",
    label: "Web Read",
    description: WEB_READ_DESCRIPTION,
    parameters: webReadSchema,
    exposure: "deferred",
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    execute,
  };
}
