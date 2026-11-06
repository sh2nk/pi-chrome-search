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
 * When `config.reflex.enabled` is true, an optional read gate (P5-D) may decline
 * the page before a tab is spent; a disabled reflex is not consulted at all.
 *
 * Output is Markdown (or plain text) produced by `extract/read.ts`; raw HTML is
 * never returned. The audit log records `host + path` only — a read URL may
 * carry a session token or a personal query, and the log is not the place for
 * it.
 */

import { Type, type Static } from "typebox";

import { pageLockFor, readSlotKeys } from "../cdp/page-lock.ts";
import type { CdpPage, PageKey } from "../cdp/types.ts";
import type { Config } from "../config.ts";
import type { EngineId } from "../engines/types.ts";
import {
  extractPdfText,
  renderPdfWindow,
  type PdfExtractor,
} from "../extract/pdf.ts";
import {
  READ_MAX_CHARS_CEILING,
  extractReadableDocument,
  renderReadableDocument,
  type ReadBlock,
  type ReadInline,
  type ReadableDocument,
} from "../extract/read.ts";
import type { Reflex } from "../reflex/types.ts";
import { saveFailureArtifact } from "../runtime/artifacts.ts";
import type { FailureDetails, Stage, WebSearchError } from "../runtime/error-codes.ts";
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
  /** Effective window width after the ceiling clamp. */
  maxChars: number;
  /** True when the caller asked for more than the ceiling and was clamped. */
  clamped: boolean;
  /** Length of the whole rendered document; the valid `offset` range is `0..totalChars-1`. */
  totalChars: number;
  format: "md" | "text";
  /** Present when the page was a PDF (P12): which rung produced the text. */
  pdf?: { pageCount: number; extractor: PdfExtractor };
  /** Artifact directory, when one was written (e.g. `read.keepPdf`). */
  artifact?: string;
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
  "Read a public page via the user's Chrome as clean Markdown. PDFs become text with page markers; scans are refused. 6000 chars default; offset/maxChars <=20000. Private/local URLs refused.";

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
 * `E_UNSUPPORTED` is the least misleading code in the frozen taxonomy for a
 * declined read: the page was not refused as private (`E_BLOCKED_URL`), not
 * walled, not unparseable — the reflex simply judged it not worth a page load.
 * The hint names the escape hatch so a wrong verdict is actionable.
 */
const READ_GATE_HINT =
  "the reflex read gate declined this page (spam/ad host, login or checkout, or unlikely to answer); " +
  "read another URL or set reflex.enabled=false to turn the gate off";

/**
 * Reads get their own work tabs (`PageKey` in `src/cdp/types.ts`): a long article
 * must never navigate the google SERP tab out from under a result the tool just
 * cached, and a read must not inherit the engine's humanize/focus state.
 * `config.read.pool` (default 1) decides how many slots exist; each slot has its
 * own exclusive lock, so two reads on the same slot can never interleave.
 */

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
  clamped: boolean;
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
  // P9-D: the clamp is reported, not hidden. A caller who asked for 99999 must
  // be able to tell a short page from a window that was silently narrowed.
  const clamped = typeof raw.maxChars === "number" && Math.floor(raw.maxChars) > maxChars;

  if (raw.format !== undefined && raw.format !== "md" && raw.format !== "text") {
    return { ok: false, message: `format: expected "md" or "text", got ${JSON.stringify(raw.format)}` };
  }
  const format = raw.format === "text" ? "text" : "md";

  return { ok: true, value: { url, offset, maxChars, clamped, format } };
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
  fallbackCode: "E_CDP_DISCONNECTED" | "E_PARSE" | "E_PDF_UNSUPPORTED" = "E_CDP_DISCONNECTED",
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

/**
 * The read gate (P5-D). `web_read` has no query, so the URL itself is the only
 * honest subject: a rules gate screens spam/ad hosts, login and binary paths,
 * and a classifier judges the URL/title pair (SPEC §9.3 gateRead).
 *
 * Fail-open: a reflex that throws is a reflex problem, never a reason to refuse
 * a page the caller explicitly asked for.
 */
async function readGateAllows(reflex: Reflex, url: string): Promise<boolean> {
  try {
    return await reflex.gateRead(url, { title: url, url, snippet: "", engine: "read" });
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Failure snapshots + the post-navigate proof
// ---------------------------------------------------------------------------

/**
 * Codes whose failure is a property of the *page* (or of the tab's integrity),
 * not of the transport: those leave an artifact. An abort or a dropped socket
 * has nothing to inspect, and a snapshot would only add noise.
 */
const ARTIFACT_CODES: ReadonlySet<string> = new Set([
  "E_PARSE",
  "E_TIMEOUT",
  "E_BLOCKED_URL",
  "E_NAVIGATION_MISMATCH",
  "E_PDF_SCANNED",
  "E_PDF_UNSUPPORTED",
]);

/**
 * `currentUrl()` can legitimately fail on a detached tab (the target is gone);
 * the cached URL is then the best evidence the artifact writer can get.
 */
async function safeCurrentUrl(page: CdpPage): Promise<string> {
  try {
    const value = await page.currentUrl();
    if (typeof value === "string" && value.trim() !== "") return value;
  } catch {
    // Fall through to the cached value.
  }
  try {
    return page.url();
  } catch {
    return "";
  }
}

/**
 * Write the failure snapshot when the code warrants one. `query` is empty on
 * purpose: a read has no query, and the URL already carries the subject.
 */
async function snapshotFailure(
  deps: ToolDeps,
  page: CdpPage,
  failure: FailureDetails,
): Promise<string | undefined> {
  if (!ARTIFACT_CODES.has(failure.code)) return undefined;
  return await saveFailureArtifact(deps, {
    code: failure.code,
    stage: failure.stage,
    url: await safeCurrentUrl(page),
    query: "",
    page,
  });
}

/** Re-throw a failure with the artifact directory attached (P9-C). */
async function failWithArtifact(
  deps: ToolDeps,
  page: CdpPage,
  failure: WebSearchError,
): Promise<never> {
  const artifact = await snapshotFailure(deps, page, failure.details);
  throw fail(failure.details.code, failure.details.stage, {
    ...(failure.details.engine === undefined ? {} : { engine: failure.details.engine }),
    hint: failure.details.hint,
    ...(failure.details.wall === undefined ? {} : { wall: failure.details.wall }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(failure.details.message === undefined ? {} : { message: failure.details.message }),
  });
}

/**
 * Same-document check for the post-navigate proof. A fragment or a trailing
 * slash is not a different page; a host, path or query change is.
 */
function sameDocument(left: string, right: string): boolean {
  const strip = (value: string): string => value.replace(/#.*$/s, "").replace(/\/+$/, "");
  if (left === right) return true;
  return strip(left) === strip(right);
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

  /**
   * P9-A: one exclusive lock per read slot. `pick` is synchronous and runs
   * immediately before `run` registers the task, so two callers in the same
   * tick choose different slots instead of queueing behind each other.
   */
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

    // Reflex read gate (P5-D): after the SSRF guard, before a tab is acquired, so
    // a refused page costs nothing and a private URL still reports E_BLOCKED_URL.
    if (deps.config.reflex.enabled && deps.reflex !== undefined) {
      const allowed = await readGateAllows(deps.reflex, requested.href);
      if (!allowed) {
        throw fail("E_UNSUPPORTED", "read", {
          hint: READ_GATE_HINT,
          message: "the reflex read gate declined this URL",
        });
      }
    }

    const lock = pageLockFor(deps.cdp);
    const slots = readSlotKeys(deps.config.read.pool);
    const slot = lock.pick(slots) as PageKey;

    return await lock.run(slot, () => readSlot(deps, input, requested, slot, signal));
  }

  /**
   * `document.contentType` is the only reliable signal that the tab switched to
   * Chrome's PDF viewer: `innerText()` is empty and the DOM is a placeholder, so
   * waiting for a readability failure would produce `E_PARSE` on a valid PDF.
   */
  async function documentContentType(page: CdpPage): Promise<string> {
    try {
      const value = await page.evaluate<unknown>("document.contentType");
      return typeof value === "string" ? value.trim().toLowerCase() : "";
    } catch {
      return "";
    }
  }

  /**
   * The PDF branch: fetch the bytes through Chrome (cookies/redirects are the
   * browser's), re-run the SSRF guard on the final hop, then parse in-tree.
   * `read.keepPdf` keeps the payload next to the text artifact.
   */
  async function readPdf(
    deps: ToolDeps,
    page: CdpPage,
    final: URL,
    requested: URL,
    input: NormalizedInput,
    signal: AbortSignal | undefined,
  ): Promise<WebReadResult> {
    const fetcher = deps.cdp.fetchBytes;
    if (fetcher === undefined) {
      throw await failWithArtifact(
        deps,
        page,
        fail("E_UNSUPPORTED", "read", {
          message: "this connector cannot fetch response bytes; the PDF branch needs CDP Fetch",
          hint: "the browser session must be the built-in Chrome connector, not a stub",
        }),
      );
    }

    let fetched;
    try {
      fetched = await fetcher.call(deps.cdp, final.href, {
        maxBytes: deps.config.read.pdfMaxBytes,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw await failWithArtifact(deps, page, asFailure(error, "read", "E_PDF_UNSUPPORTED", signal));
    }

    // Second SSRF pass: a public PDF URL may redirect to a private host, and the
    // bytes came from the *final* hop, not from the URL the caller supplied.
    try {
      await recheckLanding(fetched.url, options);
    } catch (error) {
      throw await failWithArtifact(
        deps,
        page,
        isWebSearchError(error)
          ? error
          : fail("E_BLOCKED_URL", "read", { message: "the PDF redirect target failed the SSRF guard" }),
      );
    }

    const mime = fetched.contentType;
    if (mime !== "application/pdf" && !mime.endsWith("+pdf")) {
      throw await failWithArtifact(
        deps,
        page,
        fail("E_PDF_UNSUPPORTED", "extract", {
          message: `the viewer showed a PDF but the fetched response is ${mime === "" ? "untyped" : mime}`,
          hint: "the host may require a login or serve an HTML interstitial; open it in the browser instead",
        }),
      );
    }

    let extracted;
    try {
      extracted = await extractPdfText(fetched.bytes, {
        pageMaxChars: deps.config.read.pdfPageMaxChars,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw await failWithArtifact(deps, page, asFailure(error, "extract", "E_PDF_UNSUPPORTED", signal));
    }

    const window = renderPdfWindow(extracted, { offset: input.offset, maxChars: input.maxChars });
    if (input.offset > 0 && input.offset >= window.totalChars) {
      throw await failWithArtifact(
        deps,
        page,
        fail("E_OFFSET_RANGE", "render", {
          message:
            `offset ${input.offset} is past the end: the rendered PDF is ${window.totalChars} chars ` +
            `(valid range 0..${Math.max(0, window.totalChars - 1)})`,
        }),
      );
    }

    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "";
    }
    if (title.trim() === "") title = final.pathname.split("/").pop() ?? final.host;

    let artifact: string | undefined;
    if (deps.config.read.keepPdf && deps.config.artifacts.enabled) {
      try {
        const dir = await deps.artifacts.save({
          code: "PDF_OK",
          stage: "read",
          url: final.href,
          query: "",
          page,
          files: { "doc.pdf": fetched.bytes },
          extra: {
            pdf: { pageCount: extracted.pageCount, extractor: extracted.extractor, bytes: fetched.bytes.length },
          },
        });
        if (dir !== "") artifact = dir;
      } catch {
        // Saving a copy is a convenience; the read itself already succeeded.
      }
    }

    const details: WebReadDetails = {
      url: requested.href,
      finalUrl: final.href,
      title,
      chars: window.chars,
      truncated: window.truncated,
      ...(window.nextOffset === undefined ? {} : { nextOffset: window.nextOffset }),
      maxChars: input.maxChars,
      clamped: input.clamped,
      totalChars: window.totalChars,
      format: input.format,
      pdf: { pageCount: extracted.pageCount, extractor: extracted.extractor },
      ...(artifact === undefined ? {} : { artifact }),
    };

    void deps.log
      .write({ kind: "read", domain: auditDomain(final), chars: window.chars, truncated: window.truncated })
      .catch(() => undefined);

    return { content: [{ type: "text", text: window.text }], details };
  }

  async function readSlot(
    deps: ToolDeps,
    input: NormalizedInput,
    requested: URL,
    slot: PageKey,
    signal: AbortSignal | undefined,
  ): Promise<WebReadResult> {
    let page: CdpPage;
    try {
      page = await deps.cdp.acquirePage(slot);
    } catch (error) {
      throw asFailure(error, "connect", "E_CDP_DISCONNECTED", signal);
    }

    try {
      await page.navigate(requested.href, signal === undefined ? {} : { signal });
    } catch (error) {
      throw await failWithArtifact(deps, page, asFailure(error, "navigate", "E_CDP_DISCONNECTED", signal));
    }

    // P9-B: `page.url()` is a target-event cache; a redirect or the typed path
    // can leave it stale. Ask the document, then prove it did not move again
    // after the extractor ran (a second writer would be a stranger's page).
    const landed = await safeCurrentUrl(page);
    if (typeof landed !== "string" || landed.trim() === "") {
      throw await failWithArtifact(
        deps,
        page,
        fail("E_BLOCKED_URL", "read", {
          hint: "the tab did not report a URL; retry or use a public site",
          message: "navigation landed without a URL",
        }),
      );
    }
    let final: URL;
    try {
      final = await recheckLanding(landed, options);
    } catch (error) {
      throw await failWithArtifact(
        deps,
        page,
        isWebSearchError(error)
          ? error
          : fail("E_BLOCKED_URL", "read", { message: "the landing URL failed the SSRF guard" }),
      );
    }

    // P12-A: Chrome's PDF viewer is an out-of-process extension document, so
    // the readability pass would see an empty placeholder. Branch on the
    // document's own MIME type before extracting anything, then read the bytes
    // through Chrome again and parse them in our tree.
    const mime = await documentContentType(page);
    if (mime === "application/pdf") {
      try {
        return await readPdf(deps, page, final, requested, input, signal);
      } finally {
        // Chrome swaps a PDF tab's document into an out-of-process viewer; the
        // flattened session can be detached afterwards. Reusing that tab makes
        // the *next* read fail with E_TARGET_LOST, so release this slot and let
        // the next read open a clean one.
        await deps.cdp.releasePage?.(slot).catch(() => undefined);
      }
    }

    let raw: unknown;
    try {
      raw = await page.evaluate<unknown>(`(${extractReadableDocument.toString()})(document)`);
    } catch (error) {
      throw await failWithArtifact(deps, page, asFailure(error, "extract", "E_PARSE", signal));
    }

    const after = await safeCurrentUrl(page);
    if (!sameDocument(landed, after)) {
      throw await failWithArtifact(
        deps,
        page,
        fail("E_NAVIGATION_MISMATCH", "read", {
          message: "the tab changed document between navigation and extraction; retry the read",
        }),
      );
    }

    const data = toReadableDocument(raw);
    if (data === null) {
      throw await failWithArtifact(
        deps,
        page,
        fail("E_PARSE", "extract", {
          hint: "the readability pass returned an unusable payload; retry or open the page manually",
          message: "page extraction did not return a readable document",
        }),
      );
    }
    if (data.blocks.length === 0) {
      throw await failWithArtifact(
        deps,
        page,
        fail("E_PARSE", "extract", {
          hint: UNSUPPORTED_HINT,
          message: "the readability pass found no text blocks",
        }),
      );
    }

    const rendered = renderReadableDocument(data, {
      format: input.format,
      offset: input.offset,
      maxChars: input.maxChars,
    });

    // P9-D: an offset past the end used to return "" with no explanation. The
    // caller needs the length to compute the next call, not a silent empty page.
    if (input.offset > 0 && input.offset >= rendered.totalChars) {
      throw await failWithArtifact(
        deps,
        page,
        fail("E_OFFSET_RANGE", "render", {
          message:
            `offset ${input.offset} is past the end: the rendered document is ${rendered.totalChars} chars ` +
            `(valid range 0..${Math.max(0, rendered.totalChars - 1)})`,
        }),
      );
    }

    const details: WebReadDetails = {
      url: requested.href,
      finalUrl: final.href,
      title: data.title,
      ...(data.byline === undefined ? {} : { byline: data.byline }),
      ...(data.publishedAt === undefined ? {} : { publishedAt: data.publishedAt }),
      chars: rendered.chars,
      truncated: rendered.truncated,
      ...(rendered.nextOffset === undefined ? {} : { nextOffset: rendered.nextOffset }),
      maxChars: input.maxChars,
      clamped: input.clamped,
      totalChars: rendered.totalChars,
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
