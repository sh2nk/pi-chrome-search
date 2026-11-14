/**
 * `image_search` — the deferred image vertical (SPEC §6.4/§7.3, PLAN P4-B).
 *
 * Thin, deterministic orchestration over `engines/images.ts`: limiter → owned
 * page → one navigation → selector settle → wall check → extraction → compact
 * lines. It never imports a socket or the browser; every side effect goes
 * through `ToolDeps`, so the unit suite is offline.
 *
 * Output shape is the SPEC line, one per item:
 *
 *     alt — pageUrl (thumbUrl)
 *
 * `attach` is OFF by default (vision tokens are expensive). P12-C makes it
 * real: up to four thumbnail *bytes* are fetched through Chrome (`attach:
 * "bytes"` is the explicit spelling, `true` is the compatible alias) and emitted
 * as image blocks, so the model actually sees the picture. A fetch that fails
 * is reported (`attachedImages` < requested) instead of printing a URL and
 * calling that an attachment.
 *
 * Failures leave through `renderToolFailure` with code + stage + hint (+ an
 * artifact for a wall/parse), exactly like `web_search`.
 */

import { Type, type Static } from "typebox";

import type { CdpPage } from "../cdp/types.ts";
import { announceWork } from "../runtime/panel.ts";
import { pageLockFor } from "../session/index.ts";
import type { Config } from "../config/index.ts";
import {
  IMAGE_ENGINE_IDS,
  buildImagesUrl,
  detectImagesWallOnPage,
  extractImages,
  settleImages,
  type ImageEngineId,
  type ImageItem,
  type ImagesQuery,
} from "../engines/images.ts";
import type { Wall } from "../engines/types.ts";
import type { ErrorCode, FailureDetails, Stage } from "../runtime/error-codes.ts";
import type { FetchedBytes } from "../cdp/types.ts";
import { isWebSearchError } from "../runtime/error-codes.ts";
import { fail, renderToolFailure, toFailure } from "../runtime/errors.ts";
import { assertPublicUrl, type ResolveHost } from "../runtime/ssrf.ts";
import type { FailureJson, ToolContentBlock, ToolImageBlock } from "../runtime/errors.ts";
import { saveFailureArtifact } from "../runtime/artifacts.ts";
import type { ToolDeps } from "./types.ts";

// ---------------------------------------------------------------------------
// Input schema (provider-safe: plain literal union, no `StringEnum`)
// ---------------------------------------------------------------------------

const imageEngineSchema = Type.Union([Type.Literal("google"), Type.Literal("yandex")]);

/** SPEC §7.3: `n <= 12`, default 4; `attach` off by default. */
export const imageSearchSchema = Type.Object({
  q: Type.String({ minLength: 1 }),
  n: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  engine: Type.Optional(imageEngineSchema),
  /** `true` is kept as an alias for `"bytes"`; both attach actual image blocks. */
  attach: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("bytes")])),
});

export type ImageSearchInput = Static<typeof imageSearchSchema>;

export interface ImageSearchDetails {
  engine: ImageEngineId;
  /** Item lines actually rendered, after the output cap. */
  items: number;
  chars: number;
  /** True when items were dropped, by `n` on the page or by the output budget. */
  pageCarried: boolean;
  attach: boolean;
  /**
   * What `pageUrl` in each line points at (P9-E). Google tiles give the host
   * page; Yandex 2026 tiles disclose only the source image file — calling it a
   * page would be the kind of small lie this phase removes.
   */
  pageUrlKind: "page" | "image";
  /** Image blocks actually emitted (≤ 4); 0 when `attach` was off. */
  attachedImages: number;
  /** Thumbnails whose bytes could not be fetched, with their line index. */
  attachFailed: number;
}

export interface ImageSearchSuccess {
  content: ToolContentBlock[];
  details: ImageSearchDetails;
}

export interface ImageSearchFailure {
  content: ToolContentBlock[];
  details: FailureJson;
  isError: true;
}

export type ImageSearchResult = ImageSearchSuccess | ImageSearchFailure;

export interface ImageSearchTool {
  name: "image_search";
  label: string;
  description: string;
  parameters: typeof imageSearchSchema;
  exposure: "deferred";
  annotations: { readOnlyHint: false; openWorldHint: true; idempotentHint: false };
  execute(
    toolCallId: string,
    params: ImageSearchInput,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx?: unknown,
  ): Promise<ImageSearchResult>;
}

/**
 * Kept under 350 chars (asserted in the unit test). Deferred, so it costs the
 * prompt nothing until `tool_search` activates it; it still has to be honest
 * about the two engines, the line shape and the expensive `attach` flag.
 */
export const IMAGE_SEARCH_DESCRIPTION =
  "Search images in your visible Chrome (Google, Yandex). Line: alt — pageUrl (thumbUrl); Yandex gives the image file, not a page. n<=12, default 4; attach/attach:\"bytes\" adds ≤4 image blocks.";

const DEFAULT_N = 4;
const MAX_N = 12;
const MAX_ATTACH = 4;
const MAX_ALT_CHARS = 200;
/**
 * One uncut URL can legitimately be long. The floor keeps the budget usable if
 * a session configured `search.outputMaxChars` absurdly low; the hard ceiling
 * stops 12 lines of 1 KB URLs from becoming a prompt-sized result.
 */
const MIN_OUTPUT_CHARS = 600;
const MAX_OUTPUT_CHARS = 4_000;
const ATTACH_HEADER = "attach: no thumbnail bytes could be fetched (the lines above are still valid):";

const INPUT_HINT =
  'check the image_search arguments: q (non-empty), n 1..12, engine "google"|"yandex", attach boolean';
const UNSUPPORTED_HINT =
  `image_search supports engine "google" or "yandex"; run /web-doctor for the registered set`;

// ---------------------------------------------------------------------------
// Input normalization (execute is a public surface: re-validate everything)
// ---------------------------------------------------------------------------

interface NormalizedImageInput {
  q: string;
  n: number;
  engine: ImageEngineId;
  attach: boolean;
}

type Validation =
  | { ok: true; value: NormalizedImageInput }
  | { ok: false; code: ErrorCode; stage: Stage; message: string; hint?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageEngineId(value: unknown): value is ImageEngineId {
  return typeof value === "string" && (IMAGE_ENGINE_IDS as readonly string[]).includes(value);
}

function normalizeInput(raw: unknown): Validation {
  if (!isRecord(raw)) {
    return { ok: false, code: "E_CONFIG", stage: "config", message: "arguments: expected an object", hint: INPUT_HINT };
  }

  const q = raw.q;
  if (typeof q !== "string") {
    return { ok: false, code: "E_CONFIG", stage: "config", message: "q: expected a string", hint: INPUT_HINT };
  }
  const text = q.trim();
  if (text === "") {
    return {
      ok: false,
      code: "E_CONFIG",
      stage: "config",
      message: "q: expected a non-empty query (after trimming whitespace)",
      hint: INPUT_HINT,
    };
  }

  if (raw.n !== undefined && (typeof raw.n !== "number" || !Number.isFinite(raw.n))) {
    return {
      ok: false,
      code: "E_CONFIG",
      stage: "config",
      message: `n: expected a number 1..12, got ${JSON.stringify(raw.n)}`,
      hint: INPUT_HINT,
    };
  }
  const requestedN = typeof raw.n === "number" ? raw.n : DEFAULT_N;
  // Clamp instead of rejecting: codemode can bypass the schema, and a
  // hallucinated `n: 50` must not ask the profile for 50 tiles.
  const n = Math.min(MAX_N, Math.max(1, Math.floor(requestedN)));

  if (raw.engine !== undefined && !isImageEngineId(raw.engine)) {
    return {
      ok: false,
      code: "E_UNSUPPORTED",
      stage: "resolve",
      message: `unknown image engine ${JSON.stringify(raw.engine)}`,
      hint: UNSUPPORTED_HINT,
    };
  }
  const engine: ImageEngineId = raw.engine === undefined ? "google" : raw.engine;

  if (raw.attach !== undefined && typeof raw.attach !== "boolean" && raw.attach !== "bytes") {
    return {
      ok: false,
      code: "E_CONFIG",
      stage: "config",
      message: 'attach: expected a boolean or "bytes"',
      hint: INPUT_HINT,
    };
  }
  const attach = raw.attach === true || raw.attach === "bytes";

  return { ok: true, value: { q: text, n, engine, attach } };
}

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

/**
 * `"auto"` (any case) means "let the engine decide", never a literal sentinel.
 * Same rule as `web_search`, so both tools read the config identically.
 */
function resolveLocale(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" || trimmed.toLowerCase() === "auto" ? undefined : trimmed;
}

function asFailure(
  error: unknown,
  stage: Stage,
  engine: ImageEngineId,
  signal?: AbortSignal,
): ReturnType<typeof fail> {
  if (signal?.aborted === true && !isWebSearchError(error)) {
    return fail("E_CANCELLED", stage, { engine, message: "aborted by the caller" });
  }
  if (isWebSearchError(error)) {
    if (error.details.engine !== undefined) return error;
    return fail(error.details.code, error.details.stage, {
      engine,
      hint: error.details.hint,
      ...(error.details.wall === undefined ? {} : { wall: error.details.wall }),
      ...(error.details.artifact === undefined ? {} : { artifact: error.details.artifact }),
      ...(error.details.message === undefined ? {} : { message: error.details.message }),
    });
  }
  const details = toFailure(error, { code: "E_CDP_DISCONNECTED", stage });
  return fail(details.code, details.stage, {
    engine,
    ...(details.wall === undefined ? {} : { wall: details.wall }),
    ...(details.message === undefined ? {} : { message: details.message }),
    ...(details.hint === undefined ? {} : { hint: details.hint }),
  });
}

function failureResult(error: unknown, fallback?: { code: ErrorCode; stage: Stage }): ImageSearchFailure {
  const details: FailureDetails = isWebSearchError(error)
    ? error.details
    : toFailure(error, fallback ?? { code: "E_CDP_DISCONNECTED", stage: "navigate" });
  const rendered = renderToolFailure("image_search", details);
  return { content: rendered.content, details: rendered.details, isError: true };
}

function wallFailure(
  engine: ImageEngineId,
  wall: Wall,
  artifact: string | undefined,
): ReturnType<typeof fail> {
  const markers = wall.markers.length > 0 ? `; markers: ${wall.markers.join(", ")}` : "";
  return fail("E_WALL", "navigate", {
    engine,
    wall: wall.kind,
    ...(artifact === undefined ? {} : { artifact }),
    message: `${wall.kind} wall at ${wall.url}${markers}`,
  });
}

// ---------------------------------------------------------------------------
// Side-effect helpers (artifacts/surfacing are best-effort, never new failures)
// ---------------------------------------------------------------------------

async function surface(page: CdpPage): Promise<void> {
  try {
    await page.bringToFront();
  } catch {
    // A closed tab is reported by the failure itself, not by this helper.
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Alt is page text; strip tag-shaped fragments and keep a usable fallback. */
function safeAlt(item: ImageItem): string {
  const cleaned = oneLine(item.alt.replace(/<[^>]*>/g, " "));
  if (cleaned === "") return item.domain;
  return cleaned.length > MAX_ALT_CHARS ? cleaned.slice(0, MAX_ALT_CHARS) : cleaned;
}

function renderItem(item: ImageItem): string {
  return `${safeAlt(item)} — ${item.pageUrl} (${item.thumbUrl})`;
}

/** Keep whole lines only; a URL is never cut. */
function fitLines(lines: readonly string[], maxChars: number): string[] {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = kept.length === 0 ? line.length : length + 1 + line.length;
    if (next > maxChars) break;
    kept.push(line);
    length = next;
  }
  return kept;
}

/**
 * P12-C: fetch the thumbnail bytes through Chrome and return image blocks.
 * Every URL still passes the SSRF guard — an image SERP is attacker-influenced
 * content, and a `127.0.0.1` thumbnail must not become an agent-readable image.
 * A per-thumbnail failure is counted, never fatal: the search itself succeeded.
 */
async function attachImages(
  deps: ToolDeps,
  items: readonly ImageItem[],
  resolve: ResolveHost | undefined,
): Promise<{ blocks: ToolImageBlock[]; failed: number }> {
  const fetcher = deps.cdp.fetchBytes;
  if (fetcher === undefined) return { blocks: [], failed: Math.min(items.length, MAX_ATTACH) };
  const blocks: ToolImageBlock[] = [];
  let failed = 0;
  for (const item of items.slice(0, MAX_ATTACH)) {
    try {
      const requested = await assertPublicUrl(
        item.thumbUrl,
        resolve === undefined ? {} : { resolve },
      );
      const fetched: FetchedBytes = await fetcher.call(deps.cdp, requested.href, {
        maxBytes: deps.config.image.attachMaxBytes,
        ceilingKey: "image.attachMaxBytes",
      });
      const mime = fetched.contentType;
      if (!mime.startsWith("image/") || fetched.bytes.length === 0) {
        failed += 1;
        continue;
      }
      blocks.push({ type: "image", data: fetched.bytes.toString("base64"), mimeType: mime });
    } catch {
      failed += 1;
    }
  }
  return { blocks, failed };
}

function outputBudget(config: Config): number {
  const configured = Number.isFinite(config.search.outputMaxChars)
    ? Math.floor(config.search.outputMaxChars)
    : MAX_OUTPUT_CHARS;
  return Math.max(MIN_OUTPUT_CHARS, Math.min(MAX_OUTPUT_CHARS, configured));
}

interface RenderedImages {
  text: string;
  items: number;
}

function renderImages(items: readonly ImageItem[], attachFailed: boolean, maxChars: number): RenderedImages {
  const itemLines = items.map(renderItem);
  const lines = [...itemLines];
  if (attachFailed) lines.push(ATTACH_HEADER);

  const kept = fitLines(lines, maxChars);
  // A single item line longer than the budget still beats an empty success, and
  // cutting it would cut a URL. The floor above makes this path rare.
  if (kept.length === 0 && itemLines.length > 0) kept.push(itemLines[0] as string);

  const renderedItems = Math.min(itemLines.length, kept.length);
  return { text: kept.join("\n"), items: renderedItems };
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

function buildQuery(engine: ImageEngineId, input: NormalizedImageInput, config: Config): ImagesQuery {
  const query: ImagesQuery = { text: input.q };
  if (engine === "google") {
    const lang = resolveLocale(config.engines.google.lang);
    if (lang !== undefined) query.lang = lang;
  } else {
    const region = resolveLocale(config.engines.yandex.lr);
    if (region !== undefined) query.region = region;
  }
  return query;
}

async function search(
  deps: ToolDeps,
  params: unknown,
  signal: AbortSignal | undefined,
  resolve: ResolveHost | undefined,
): Promise<ImageSearchResult> {
  const validation = normalizeInput(params);
  if (!validation.ok) {
    return failureResult(
      fail(validation.code, validation.stage, {
        message: validation.message,
        ...(validation.hint === undefined ? {} : { hint: validation.hint }),
      }),
    );
  }
  const input = validation.value;
  const engine = input.engine;

  // The image vertical is outside the text `EngineRegistry` (no `Engine`
  // adapter), so the config gate is applied here; `disabled` and `unknown` both
  // mean "this session may not use the engine" and share E_UNSUPPORTED.
  if (!deps.config.engines[engine].enabled) {
    return failureResult(
      fail("E_UNSUPPORTED", "resolve", {
        engine,
        message: `image engine "${engine}" is disabled in config`,
        hint: `set config.engines.${engine}.enabled = true, or pick another engine`,
      }),
    );
  }

  if (signal?.aborted === true) {
    return failureResult(fail("E_CANCELLED", "navigate", { engine, message: "aborted by the caller" }));
  }

  // Same tab, same FIFO lock as `web_search`: an image query and a web search on
  // one engine must never navigate (or type into) the same tab at once. A
  // validation or config error never waits on a lock.
  return await pageLockFor(deps.cdp).run(engine, async () => {
    // S12.5: an image query is visible on the anchor and raises its own tab under
    // `window.follow`, exactly like a text search. Announced inside the lock so a
    // queued caller cannot claim the panel before it owns the tab.
    await announceWork(deps.cdp, { stage: "navigate", engine, query: input.q });
    const result = await searchLocked(deps, input, signal, resolve);
    if ("isError" in result) {
      await announceWork(deps.cdp, { stage: "error", engine, error: { code: result.details.code } });
      // A wall keeps the page and the work tab in front for the human (D5); any
      // other failure hands the screen back to the anchor after `window.idleMs`.
      if (result.details.code !== "E_WALL") await announceWork(deps.cdp, { stage: "done", engine });
    } else {
      await announceWork(deps.cdp, { stage: "done", engine });
    }
    return result;
  });
}

async function searchLocked(
  deps: ToolDeps,
  input: NormalizedImageInput,
  signal: AbortSignal | undefined,
  resolve: ResolveHost | undefined,
): Promise<ImageSearchResult> {
  const engine = input.engine;

  try {
    await deps.limiter.acquire(engine, signal);
  } catch (error) {
    return failureResult(asFailure(error, "navigate", engine, signal));
  }

  let page: CdpPage;
  try {
    page = await deps.cdp.acquirePage(engine);
  } catch (error) {
    return failureResult(asFailure(error, "connect", engine, signal));
  }

  const query = buildQuery(engine, input, deps.config);
  const url = buildImagesUrl(engine, query);
  try {
    await page.navigate(url, signal === undefined ? {} : { signal });
  } catch (error) {
    return failureResult(asFailure(error, "navigate", engine, signal));
  }

  try {
    await settleImages(page, engine, signal === undefined ? {} : { signal });
  } catch (error) {
    return failureResult(asFailure(error, "settle", engine, signal));
  }

  let wall: Wall | null;
  try {
    wall = await detectImagesWallOnPage(page);
  } catch (error) {
    return failureResult(asFailure(error, "extract", engine, signal));
  }

  if (wall !== null) {
    const artifact = await saveFailureArtifact(deps, {
      code: "E_WALL",
      stage: "navigate",
      engine,
      url: page.url(),
      query: input.q,
      page,
      extra: { wall: { kind: wall.kind, url: wall.url, markers: [...wall.markers] } },
    });
    await surface(page);
    return failureResult(wallFailure(engine, wall, artifact));
  }

  let extraction;
  try {
    extraction = await extractImages(page, { engine, n: input.n });
  } catch (error) {
    const failure = asFailure(error, "extract", engine, signal);
    // Only a page-state failure is worth a snapshot; a transport drop or an
    // abort is not a property of the document.
    if (failure.details.code !== "E_PARSE" && failure.details.code !== "E_WALL") {
      return failureResult(failure);
    }
    const artifact = await saveFailureArtifact(deps, {
      code: failure.details.code,
      stage: failure.details.stage,
      engine,
      url: page.url(),
      query: input.q,
      page,
    });
    return failureResult(
      fail(failure.details.code, failure.details.stage, {
        engine,
        hint: failure.details.hint,
        ...(artifact === undefined ? {} : { artifact }),
        ...(failure.details.message === undefined ? {} : { message: failure.details.message }),
      }),
    );
  }

  if (extraction.items.length === 0) {
    return failureResult(
      fail("E_EMPTY", "extract", {
        engine,
        message: "the image search returned no usable tiles",
      }),
    );
  }

  const attached = input.attach
    ? await attachImages(deps, extraction.items, resolve)
    : { blocks: [] as ToolImageBlock[], failed: 0 };
  // The "could not fetch" note only appears when attach was requested and not
  // one block made it; a partial attach is visible in `details.attachedImages`.
  const rendered = renderImages(
    extraction.items,
    input.attach && attached.blocks.length === 0 && attached.failed > 0,
    outputBudget(deps.config),
  );
  // "pageCarried" answers "did the caller get less than was available?". Two
  // independent places shorten the list: the page (more usable tiles than `n`)
  // and this renderer (whole lines dropped by the output budget). Reporting
  // only the page half would say `false` while the result visibly stops early.
  const pageCarried = extraction.pageCarried || extraction.items.length > rendered.items;
  const first = extraction.items[0];
  const pageUrlKind = first?.pageUrlKind ?? (engine === "yandex" ? "image" : "page");
  const details: ImageSearchDetails = {
    engine,
    items: rendered.items,
    chars: rendered.text.length,
    pageCarried,
    attach: input.attach,
    pageUrlKind,
    attachedImages: attached.blocks.length,
    attachFailed: attached.failed,
  };
  return { content: [{ type: "text", text: rendered.text }, ...attached.blocks], details };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * `getDeps` is injected by the extension wiring so a call resolves the session's
 * services lazily and per-context. There is deliberately no module-level
 * instance: constructing CDP/lock/config is wiring work, not a tool's.
 */
export interface ImageSearchOptions {
  /** Injected resolver for the thumbnail SSRF guard; tests always set it. */
  resolve?: ResolveHost;
}

export function createImageSearchTool(
  getDeps: (ctx?: unknown) => ToolDeps | Promise<ToolDeps>,
  options: ImageSearchOptions = {},
): ImageSearchTool {
  async function execute(
    _toolCallId: string,
    params: ImageSearchInput,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: unknown,
  ): Promise<ImageSearchResult> {
    let deps: ToolDeps;
    try {
      deps = await getDeps(ctx);
    } catch (error) {
      return failureResult(error, { code: "E_CONFIG", stage: "config" });
    }

    // Last-resort barrier: a dependency bug still reaches the agent as a
    // rendered failure with a code and a stage, never as a bare throw.
    try {
      return await search(deps, params, signal, options.resolve);
    } catch (error) {
      return failureResult(error);
    }
  }

  return {
    name: "image_search",
    label: "Image Search",
    description: IMAGE_SEARCH_DESCRIPTION,
    parameters: imageSearchSchema,
    exposure: "deferred",
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    execute,
  };
}
