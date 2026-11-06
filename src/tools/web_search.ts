/**
 * `web_search` — the only `direct` tool (SPEC §7.1, PLAN P2-D).
 *
 * The tool is a thin, deterministic orchestrator over frozen contracts: engine
 * selection/fallback, cache, pacing, human-shaped navigation and compaction. It
 * never imports a socket or the browser; every side effect goes through
 * `ToolDeps`, which is what makes the whole unit suite offline.
 *
 * Ordering rules that are easy to get wrong:
 * - Cache *before* the limiter. A cache hit must not consume a daily slot, wait
 *   for the pacing gap, or touch the page — that is the whole point of the SERP
 *   cache (§8) and the reason a repeated query is instant.
 * - Engines run sequentially in `select()` order (D10: `auto` = google → ddg →
 *   yandex; an explicit list keeps the caller's order), because only one search
 *   may hit a profile at a time (§5.5). `auto` stops at the first success — the
 *   next engine is only a fallback; an explicit list merges every engine that
 *   works. Fallback happens only for codes that a different engine can plausibly
 *   cure; a parse failure, an abort or a timeout stops the loop instead of
 *   multiplying the damage.
 * - Human typing happens on an engine's first successful search in this tool
 *   instance (or always, when `humanize: "always"`). Later searches navigate the
 *   SERP URL directly: people reopen result links too, and typing every time
 *   costs seconds without adding realism.
 *
 * All failures leave through `renderToolFailure` with code + stage + hint (+
 * artifact where one was written); `execute` never throws at the agent.
 */

import { Type, type Static } from "typebox";

import { humanSearch } from "../cdp/humanize.ts";
import type { CdpPage } from "../cdp/types.ts";
import type { Config } from "../config.ts";
import { compactSerps } from "../extract/compact.ts";
import { createGotoResolver } from "../extract/goto.ts";
import { isHttpUrl, normalizeUrl, parseLink } from "../extract/urls.ts";
import {
  ENGINE_IDS,
  type Engine,
  type EngineId,
  type EngineSelection,
  type Freshness,
  type Query,
  type RawSerp,
  type Wall,
} from "../engines/types.ts";
import type { Candidate, Reflex, Route } from "../reflex/types.ts";
import { serpKey } from "../runtime/cache.ts";
import type { ErrorCode, FailureDetails, Stage } from "../runtime/error-codes.ts";
import { isWebSearchError } from "../runtime/error-codes.ts";
import { fail, renderToolFailure, toFailure } from "../runtime/errors.ts";
import type { FailureFallback, FailureJson, ToolTextBlock } from "../runtime/errors.ts";
import type { ArtifactInput } from "../runtime/types.ts";
import type { ToolDeps } from "./types.ts";

// ---------------------------------------------------------------------------
// Input schema (provider-safe: plain literal unions, no `StringEnum`)
// ---------------------------------------------------------------------------

const engineIdSchema = Type.Union([
  Type.Literal("google"),
  Type.Literal("duckduckgo"),
  Type.Literal("yandex"),
]);

/**
 * SPEC §7.1 / D9. `engines` accepts one id, a list, or `auto`; the array form is
 * capped at three because that is every engine the extension supports.
 */
export const webSearchSchema = Type.Object({
  q: Type.String({ minLength: 1 }),
  n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  engines: Type.Optional(
    Type.Union([Type.Literal("auto"), engineIdSchema, Type.Array(engineIdSchema, { minItems: 1, maxItems: 3 })]),
  ),
  summary: Type.Optional(Type.Boolean()),
  freshness: Type.Optional(
    Type.Union([Type.Literal("d"), Type.Literal("w"), Type.Literal("m"), Type.Literal("y")]),
  ),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("json")])),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

/** The serializable `details` object pi shows next to the text block. */
export interface WebSearchDetails {
  /** Engines that contributed results, in try order (cache hits included). */
  engines: EngineId[];
  /** Number of compact items actually rendered, after caps/dedup. */
  results: number;
  ai: boolean;
  chars: number;
  truncated: boolean;
  cached: boolean;
  pageCarried: boolean;
  /**
   * DuckDuckGo has no pagination until M2: a `page > 1` request is served as
   * page 1. Set only when that happened, so the caller knows the page was not
   * actually honoured (the fallback engines still paginate normally).
   */
  pageIgnored?: boolean;
  /** Set only by the keyless HTTP fallback (SPEC §6.5); never by a real SERP. */
  degraded?: boolean;
}

export interface WebSearchSuccess {
  content: ToolTextBlock[];
  details: WebSearchDetails;
}

export interface WebSearchFailure {
  content: ToolTextBlock[];
  details: FailureJson;
  isError: true;
}

export type WebSearchResult = WebSearchSuccess | WebSearchFailure;

/** The object shape pi registers (P2-E wires it into the extension). */
export interface WebSearchTool {
  name: "web_search";
  label: string;
  description: string;
  parameters: typeof webSearchSchema;
  exposure: "direct";
  annotations: { readOnlyHint: true; openWorldHint: true; idempotentHint: true };
  execute(
    toolCallId: string,
    params: WebSearchInput,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx?: unknown,
  ): Promise<WebSearchResult>;
}

/**
 * Kept under 350 chars (asserted in the unit test and re-measured by P2-E's
 * tool-budget test). It names the real browser, the three engines, the summary
 * and the syntax that needs no rewriting, and nothing else: the prompt pays for
 * every word.
 */
export const WEB_SEARCH_DESCRIPTION =
  "Search the web for free in the user's visible Chrome (Google, DuckDuckGo, Yandex) with each engine's native AI summary. Compact results, n<=10; site:/filetype:/quoted queries pass through; engines: id, list, or auto.";

/**
 * Codes a sibling engine can plausibly cure. Everything else (E_PARSE, E_TIMEOUT,
 * E_CANCELLED, E_RATE_LIMITED, E_CONFIG) is a property of the request or the
 * session, so fanning out would waste the user's pacing budget and hide the cause.
 */
const FALLBACK_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "E_WALL",
  "E_EMPTY",
  "E_UNSUPPORTED",
  "E_CDP_DISCONNECTED",
  "E_CDP_UNAVAILABLE",
  "E_TARGET_LOST",
]);

/** SPEC §7.1: yandex gets exactly one retry, after the user has had 3 s to solve a captcha. */
const WALL_RETRY_MS = 3_000;

/** Every defensive validation failure shares this hint: the fix is in the call, not the file. */
const INPUT_HINT =
  "check the web_search arguments: q (non-empty), n 1..10, page >= 1, engines auto|google|duckduckgo|yandex";

const UNSUPPORTED_HINT =
  "no enabled engine matched the request; run /web-doctor (or node src/cli/doctor.ts --json) and check config.engines";

// ---------------------------------------------------------------------------
// Input normalization (execute is a public surface: re-validate everything)
// ---------------------------------------------------------------------------

interface NormalizedInput {
  q: string;
  n: number;
  engines: EngineSelection;
  summary: boolean;
  freshness?: Freshness;
  page: number;
  format: "md" | "json";
  /**
   * Locale suggested by a reflex route. Applied per engine only when the config
   * did not pin one; absent when the caller has no reflex or the flag is off.
   */
  routed?: { lang?: string; region?: string };
}

type Validation = { ok: true; value: NormalizedInput } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

/** The schema says 10; config may lower the ceiling but never raise it past 10. */
function effectiveMaxN(config: Config): number {
  const configured = Number.isFinite(config.search.nMax) ? Math.floor(config.search.nMax) : 10;
  return Math.min(10, Math.max(1, configured));
}

function normalizeEngines(value: unknown): EngineSelection | null {
  if (value === undefined) return "auto";
  if (value === "auto") return "auto";
  if (isEngineId(value)) return value;
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > ENGINE_IDS.length) return null;
    const ids: EngineId[] = [];
    for (const id of value as unknown[]) {
      if (!isEngineId(id)) return null;
      ids.push(id);
    }
    return ids;
  }
  return null;
}

function normalizeInput(raw: unknown, config: Config): Validation {
  if (!isRecord(raw)) return { ok: false, message: "arguments: expected an object" };

  const q = raw.q;
  if (typeof q !== "string") return { ok: false, message: "q: expected a string" };
  const text = q.trim();
  if (text === "") return { ok: false, message: "q: expected a non-empty query (after trimming whitespace)" };

  // The schema is the first line of defence, but codemode and a future repeat
  // tool call both bypass it; a hallucinated `n: 42` must be a rendered error,
  // not 42 results requested from the profile.
  if (raw.n !== undefined) {
    if (typeof raw.n !== "number" || !Number.isInteger(raw.n) || raw.n < 1 || raw.n > 10) {
      return { ok: false, message: `n: expected an integer 1..10, got ${JSON.stringify(raw.n)}` };
    }
  }
  const requestedN = typeof raw.n === "number" ? raw.n : config.search.n;
  const n = Math.min(Math.max(1, Math.floor(requestedN)), effectiveMaxN(config));

  if (raw.page !== undefined) {
    if (typeof raw.page !== "number" || !Number.isInteger(raw.page) || raw.page < 1) {
      return { ok: false, message: `page: expected an integer >= 1, got ${JSON.stringify(raw.page)}` };
    }
  }
  const page = typeof raw.page === "number" ? raw.page : 1;

  if (raw.summary !== undefined && typeof raw.summary !== "boolean") {
    return { ok: false, message: "summary: expected a boolean" };
  }
  const summary = raw.summary !== false;

  if (raw.freshness !== undefined) {
    const allowed: readonly string[] = ["d", "w", "m", "y"];
    if (typeof raw.freshness !== "string" || !allowed.includes(raw.freshness)) {
      return { ok: false, message: `freshness: expected one of d|w|m|y, got ${JSON.stringify(raw.freshness)}` };
    }
  }
  const freshness = raw.freshness as Freshness | undefined;

  if (raw.format !== undefined && raw.format !== "md" && raw.format !== "json") {
    return { ok: false, message: `format: expected "md" or "json", got ${JSON.stringify(raw.format)}` };
  }
  const format = raw.format === "json" ? "json" : "md";

  const engines = normalizeEngines(raw.engines);
  if (engines === null) {
    return {
      ok: false,
      message: `engines: expected "auto", an engine id, or a non-empty list of ${ENGINE_IDS.join("|")}`,
    };
  }

  return {
    ok: true,
    value: { q: text, n, engines, summary, ...(freshness === undefined ? {} : { freshness }), page, format },
  };
}

// ---------------------------------------------------------------------------
// Query + failure helpers
// ---------------------------------------------------------------------------

/** `"auto"` (any case) means "let the engine decide", never a literal sentinel. */
function resolveLocale(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" || trimmed.toLowerCase() === "auto" ? undefined : trimmed;
}

/**
 * Map the tool-level input onto the frozen `Query` contract.
 *
 * Locale plumbing is deliberately engine-specific:
 * - google sends `hl` (lang) and `gl` (region/country);
 * - duckduckgo has a single `kl` parameter that encodes region *and* language
 *   (`ru-ru`, `us-en`), so it travels in `region` — splitting it would invent a
 *   language the user never configured;
 * - yandex sends `lr` (region id/name) and has no independent UI language here.
 *
 * `page` is Google/Yandex-only per the `Query` contract; passing it to
 * DuckDuckGo would ask for a page the adapter cannot build (and would key page 2
 * separately while returning page 1).
 *
 * A routed locale (P5-D) is a *suggestion*: `config.engines.*` is the user's own
 * pinning, so a route may only fill a locale the config left as `auto`. A config
 * value always wins — a model must not silently change the user's UI language.
 */
function buildQuery(engine: EngineId, input: NormalizedInput, config: Config): Query {
  const query: Query = { text: input.q, n: input.n, summary: input.summary };
  if (input.freshness !== undefined) query.freshness = input.freshness;
  if (engine !== "duckduckgo") query.page = input.page;

  const routedLang = resolveLocale(input.routed?.lang ?? "");
  const routedRegion = resolveLocale(input.routed?.region ?? "");

  switch (engine) {
    case "google": {
      const lang = resolveLocale(config.engines.google.lang) ?? routedLang;
      const region = resolveLocale(config.engines.google.gl) ?? routedRegion;
      if (lang !== undefined) query.lang = lang;
      if (region !== undefined) query.region = region;
      break;
    }
    case "duckduckgo": {
      const region = resolveLocale(config.engines.duckduckgo.kl) ?? routedRegion;
      if (region !== undefined) query.region = region;
      break;
    }
    case "yandex": {
      const region = resolveLocale(config.engines.yandex.lr) ?? routedRegion;
      if (region !== undefined) query.region = region;
      break;
    }
  }
  return query;
}

/**
 * Normalize anything a dependency throws. `WebSearchError` passes through with
 * its code/stage/hint intact; an abort becomes E_CANCELLED and a timeout
 * E_TIMEOUT (via the shared taxonomy), and the remaining CDP-layer throws are
 * E_CDP_DISCONNECTED — the only honest guess at this level.
 */
function asFailure(
  error: unknown,
  stage: Stage,
  engine?: EngineId,
  signal?: AbortSignal,
): ReturnType<typeof fail> {
  // A dependency may abort with `signal.reason` (any value), which the taxonomy
  // cannot recognise by shape; an aborted signal is the authoritative fact.
  if (signal?.aborted === true && !isWebSearchError(error)) {
    return fail("E_CANCELLED", stage, {
      ...(engine === undefined ? {} : { engine }),
      message: "aborted by the caller",
    });
  }
  if (isWebSearchError(error)) {
    if (engine === undefined || error.details.engine !== undefined) return error;
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
    ...(engine === undefined ? {} : { engine }),
    ...(details.wall === undefined ? {} : { wall: details.wall }),
    ...(details.message === undefined ? {} : { message: details.message }),
    ...(details.hint === undefined ? {} : { hint: details.hint }),
  });
}

function failureResult(error: unknown, fallback?: FailureFallback): WebSearchFailure {
  const details: FailureDetails = isWebSearchError(error)
    ? error.details
    : toFailure(error, fallback ?? { code: "E_CDP_DISCONNECTED", stage: "navigate" });
  const rendered = renderToolFailure("web_search", details);
  return { content: rendered.content, details: rendered.details, isError: true };
}

function wallFailure(engine: EngineId, wall: Wall, artifact: string | undefined): ReturnType<typeof fail> {
  const markers = wall.markers.length > 0 ? `; markers: ${wall.markers.join(", ")}` : "";
  return fail("E_WALL", "navigate", {
    engine,
    wall: wall.kind,
    ...(artifact === undefined ? {} : { artifact }),
    message: `${wall.kind} wall at ${wall.url}${markers}`,
  });
}

// ---------------------------------------------------------------------------
// Side-effect helpers
// ---------------------------------------------------------------------------

/**
 * Artifacts are evidence, never a new failure: a read-only agent dir must not
 * turn a parse error into an artifact error. The original failure is rethrown
 * with the path only when a directory was actually written.
 */
async function saveArtifact(deps: ToolDeps, input: ArtifactInput): Promise<string | undefined> {
  if (!deps.config.artifacts.enabled) return undefined;
  try {
    return await deps.artifacts.save(input);
  } catch {
    return undefined;
  }
}

/** Surfacing the user's window is best-effort; the E_WALL hint still explains the fix. */
async function surface(page: CdpPage): Promise<void> {
  try {
    await page.bringToFront();
  } catch {
    // A closed tab is reported by the wall error and the retry path, not here.
  }
}

/**
 * The payload the JSON fitter actually emitted. `details` must be derived from
 * this, never from the pre-fit `compact.data`: the blockers here already dropped
 * results and the AI, so reporting the original counts would overstate the tool
 * output (observed 5 results / `ai:true` for a 3-result payload with no AI).
 */
interface JsonRender {
  text: string;
  /** Number of results in the emitted JSON. */
  results: number;
  truncated: boolean;
  ai: boolean;
}

/**
 * Smallest honest JSON envelope: no engine, no query, no results, no AI, just
 * the wrapper and its accounting fields. `chars` is settled to the real length,
 * so the floor is that envelope's length (85 chars at the time of writing).
 *
 * This is the documented JSON floor. `config.search.outputMaxChars` accepts 1,
 * but valid JSON with `engine`/`results`/`truncated`/`chars` cannot be shorter
 * than the envelope. Rather than reject a legitimate `format: "json"` request
 * with E_CONFIG (a rendering limit is not a caller error), the fitter returns
 * this envelope and keeps `truncated: true`. The Markdown view is still capped
 * exactly; only the JSON view has a floor.
 */
export const JSON_MIN_ENVELOPE = ((): number => {
  const envelope: Record<string, unknown> = {
    engine: "",
    query: "",
    results: [],
    pageCarried: false,
    chars: 0,
    truncated: true,
  };
  return settleChars(envelope).length;
})();

/** Rewrite `chars` until it equals the serialized length (digit count can grow). */
function settleChars(copy: Record<string, unknown>): string {
  let text = JSON.stringify(copy);
  for (let pass = 0; pass < 4 && copy.chars !== text.length; pass += 1) {
    copy.chars = text.length;
    text = JSON.stringify(copy);
  }
  return text;
}

function minimalJson(): string {
  return settleChars({
    engine: "",
    query: "",
    results: [],
    pageCarried: false,
    chars: 0,
    truncated: true,
  });
}

/**
 * One step of the D13 order inside the JSON fitter: sources first, then the
 * prose (halved with an ellipsis), then the whole block. Only the AI moves, so a
 * long summary can never cost a result. Returns false once no AI is left.
 */
function shrinkJsonAi(copy: Record<string, unknown>): boolean {
  const ai = copy.ai;
  if (!isRecord(ai)) return false;

  if (Array.isArray(ai.sources) && ai.sources.length > 0) {
    ai.sources = ai.sources.slice(0, -1);
    return true;
  }

  const text = typeof ai.text === "string" ? ai.text : "";
  if (text.length > 2) {
    // Strictly shorter than the input (a halved 3-char line is `x…`), so the
    // fitter always terminates.
    const keep = Math.max(1, Math.floor(text.length / 2) - 1);
    ai.text = `${text.slice(0, keep).trimEnd()}…`;
    return true;
  }

  delete copy.ai;
  return true;
}

/**
 * Make the JSON view honour `outputMaxChars`.
 *
 * `compact.ts` only caps the Markdown render: JSON escaping can inflate the same
 * data well past the cap (quote-heavy text grows ~2×). Order of loss is D13 —
 * the AI absorbs it first (sources → prose → block), then snippets shrink
 * (100 → 60 → 30 → 0), then whole tail results are dropped. A URL is never cut;
 * an item that cannot fit is removed whole. `chars` is rewritten to the *actual*
 * length of the returned text, not the Markdown length it started with.
 *
 * Below `JSON_MIN_ENVELOPE` the cap cannot be honoured without invalid JSON, so
 * the minimal envelope is returned (documented floor, still `truncated: true`).
 */
function serializeJsonWithin(data: Record<string, unknown>, maxChars: number): JsonRender {
  const copy: Record<string, unknown> = { ...data };
  const rawItems = Array.isArray(copy.results) ? (copy.results as unknown[]) : [];
  const items: Array<Record<string, unknown>> = rawItems.map((item) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? { ...(item as Record<string, unknown>) }
      : {},
  );
  copy.results = items;
  // `data` is owned by the caller; the fitter must not mutate it (the AI object
  // is shared by reference and gets trimmed below).
  if (isRecord(copy.ai)) {
    const ai = copy.ai;
    copy.ai = {
      ...ai,
      ...(Array.isArray(ai.sources) ? { sources: [...(ai.sources as unknown[])] } : {}),
    };
  }
  // A placeholder with the widest possible digit count: once the content fits,
  // every real length has the same or fewer digits, so this is a safe upper bound
  // for the fitting loop below.
  copy.chars = maxChars;

  const snippetSteps = [100, 60, 30, 0];
  let step = 0;
  while (JSON.stringify(copy).length > maxChars) {
    // D13: trim the AI before touching the result list.
    if (shrinkJsonAi(copy)) {
      copy.truncated = true;
      continue;
    }

    // Then every snippet width (same ladder as Markdown) before dropping a result.
    if (step < snippetSteps.length) {
      const cap = snippetSteps[step]!;
      step += 1;
      for (const item of items) {
        const snippet = item.snippet;
        if (typeof snippet !== "string" || snippet.length <= cap) continue;
        item.snippet = cap === 0 ? "" : `${snippet.slice(0, cap - 1).trimEnd()}…`;
        copy.truncated = true;
      }
      continue;
    }

    // Finally whole tail results; a URL is never cut.
    if (items.length > 0) {
      items.pop();
      copy.truncated = true;
      continue;
    }

    const query = copy.query;
    if (typeof query === "string" && query.length > 8) {
      copy.query = `${query.slice(0, Math.floor(query.length / 2))}…`;
      copy.truncated = true;
      continue;
    }

    // Only the bare envelope is left; below this cap the floor below applies.
    break;
  }

  let text = settleChars(copy);
  let truncated = copy.truncated === true;
  let results = items.length;
  let ai = copy.ai !== undefined;
  if (text.length > maxChars) {
    // The cap is below the envelope: return the floor and report exactly that,
    // even if the starting data already had no results/AI to drop.
    text = minimalJson();
    truncated = true;
    results = 0;
    ai = false;
  }

  return { text, results, truncated, ai };
}

async function navigateAndSettle(
  page: CdpPage,
  engine: Engine,
  query: Query,
  signal: AbortSignal | undefined,
): Promise<void> {
  const url = engine.buildUrl(query);
  try {
    await page.navigate(url, signal === undefined ? {} : { signal });
  } catch (error) {
    throw asFailure(error, "navigate", engine.id, signal);
  }
  try {
    await engine.settle(page, signal);
  } catch (error) {
    throw asFailure(error, "settle", engine.id, signal);
  }
}

/**
 * Google wraps organic links as `/goto?url=<opaque protobuf>` (SPEC §6.1).
 * Adapters are pure DOM extractors, so they hand back the wrapper; resolving it
 * is a browser-cookie HTTP GET with a single-navigation fallback
 * (`extract/goto.ts`), cached 24 h.
 *
 * Failure policy: an unresolvable wrapper stays in the result. A link the user
 * cannot click is worse than one with an ugly URL, and a single stuck redirect
 * must not fail a SERP that was extracted successfully. Abort still wins: a
 * cancelled search must not be reported as a success.
 */
async function resolveGotoResults(
  page: CdpPage,
  serp: RawSerp,
  deps: ToolDeps,
  signal: AbortSignal | undefined,
): Promise<void> {
  const base = page.url();
  if (!serp.results.some((item) => parseLink(item.url, base)?.kind === "goto")) return;

  const resolver = createGotoResolver({
    cache: deps.cache,
    clock: deps.clock,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    cookieSource: (urls) => page.cookiesFor([...urls]),
    navigateFallback: async (wrapperUrl) => {
      await page.navigate(wrapperUrl, signal === undefined ? {} : { signal });
      return page.url();
    },
  });

  let resolved = 0;
  for (const item of serp.results) {
    const link = parseLink(item.url, base);
    if (link === null || link.kind !== "goto" || link.wrapperUrl === null) continue;
    try {
      const resolution = await resolver.resolve(link.wrapperUrl, signal);
      if (resolution.url !== null) {
        item.url = resolution.url;
        resolved += 1;
      }
    } catch {
      // Keep the wrapper; see the policy above.
    }
  }

  if (signal?.aborted === true) {
    throw fail("E_CANCELLED", "extract", {
      engine: serp.engine,
      message: "the search was aborted while resolving result links",
    });
  }
  void deps.log.write({
    kind: "goto",
    engine: serp.engine,
    links: serp.results.length,
    resolved,
  });
}

type UpdateFn = (update: { content: ToolTextBlock[]; details: Record<string, unknown> }) => void | Promise<void>;

function asUpdater(value: unknown): UpdateFn | undefined {
  return typeof value === "function" ? (value as UpdateFn) : undefined;
}

async function notifySearching(update: UpdateFn | undefined, engine: EngineId): Promise<void> {
  if (update === undefined) return;
  try {
    await update({ content: [{ type: "text", text: `searching ${engine}…` }], details: {} });
  } catch {
    // A UI callback must never abort a search that is already pacing itself.
  }
}

// ---------------------------------------------------------------------------
// Reflex hooks (P5-D)
// ---------------------------------------------------------------------------

/**
 * SPEC §9.3 triage trigger: `multi-engine-or-n>10`. A single-engine `n=5` search
 * must not pay classifier latency; `n` above the schema ceiling is unreachable
 * through `execute` today but the predicate stays honest for codemode callers
 * and for `reflex.triage.when` staying a config expression.
 */
export const TRIAGE_N_THRESHOLD = 10;

/** The trigger expressions `reflex.triage.when` accepts. */
export type TriageWhen = "multi-engine-or-n>10" | "multi-engine" | "n>10" | "always" | "never";

const TRIAGE_WHEN_VALUES: ReadonlySet<string> = new Set([
  "multi-engine-or-n>10",
  "multi-engine",
  "n>10",
  "always",
  "never",
]);

/**
 * `reflex.triage.when` is a config expression, not decoration: a user who sets
 * `"never"` must not pay classifier latency, and `"always"` must not silently
 * fall back to the default. An unknown string keeps the documented default.
 */
export function triageWanted(when: string, multiEngine: boolean, n: number): boolean {
  const mode = TRIAGE_WHEN_VALUES.has(when) ? (when as TriageWhen) : "multi-engine-or-n>10";
  switch (mode) {
    case "always":
      return true;
    case "never":
      return false;
    case "multi-engine":
      return multiEngine;
    case "n>10":
      return n > TRIAGE_N_THRESHOLD;
    default:
      return multiEngine || n > TRIAGE_N_THRESHOLD;
  }
}

/**
 * A swallowed reflex error must still be visible; the search itself is unaffected.
 * `kind: "reflex_error"` keeps these rows out of the decision schema (a decision
 * row must carry verdict/confidence/model/usage/costUsd, which a throw has none of).
 */
function logReflexFailure(deps: ToolDeps, decision: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    void Promise.resolve(
      deps.log.write({ kind: "reflex_error", decision, message: message.slice(0, 200) }),
    ).catch(() => undefined);
  } catch {
    // Observability must never fail the search that triggered it.
  }
}

/**
 * `Yandex` is last by policy (D10) because a captcha wall costs the user a manual
 * solve. A route may list it anywhere; the tool caps the damage here rather than
 * trusting the model with the ordering rule.
 */
function yandexLast(order: readonly EngineId[]): EngineId[] {
  const rest = order.filter((id) => id !== "yandex");
  return order.includes("yandex") ? [...rest, "yandex"] : rest;
}

function clampN(value: number, config: Config): number {
  const requested = Number.isFinite(value) ? Math.floor(value) : config.search.n;
  return Math.min(Math.max(1, requested), effectiveMaxN(config));
}

interface RoutePlan {
  input: NormalizedInput;
  order: EngineId[];
  /**
   * True when the route asked for several engines, i.e. a coverage set the tool
   * merges (explicit-list semantics). A single-engine route keeps D10 semantics:
   * try it, fall back on failure, stop at the first success.
   */
  merge: boolean;
}

/**
 * Apply a routed preference to the request. Only `"auto"` is routed (the caller
 * who named engines already decided), and only fields the caller left unset are
 * filled: `n: 3` from the agent beats `n: 5` from a classifier.
 */
function planRoute(route: Route, input: NormalizedInput, raw: WebSearchInput, deps: ToolDeps): RoutePlan | undefined {
  const usable = deps.engines.select(yandexLast(route.engines));
  if (usable.length === 0) return undefined;

  const next: NormalizedInput = { ...input };
  const routed: { lang?: string; region?: string } = {};
  if (typeof route.lang === "string" && route.lang !== "") routed.lang = route.lang;
  if (typeof route.region === "string" && route.region !== "") routed.region = route.region;
  if (routed.lang !== undefined || routed.region !== undefined) next.routed = routed;

  if (route.freshness !== undefined && raw.freshness === undefined) next.freshness = route.freshness;
  if (typeof route.n === "number" && raw.n === undefined) next.n = clampN(route.n, deps.config);
  if (typeof route.summary === "boolean" && raw.summary === undefined) next.summary = route.summary;

  // A single-engine route is a *preference*, not a restriction: keep the other
  // enabled engines behind it so one wall cannot turn a routed search into a
  // failure. A multi-engine route is a coverage set and is used as given.
  let order = usable;
  if (usable.length === 1) {
    const primary = usable[0]!;
    order = [primary, ...deps.engines.select("auto").filter((id) => id !== primary)];
  }

  return { input: next, order, merge: usable.length > 1 };
}

/**
 * Route + plan in one guarded step. A reflex can only ever *suggest*: any throw,
 * malformed route or unusable engine list leaves the canonical D10 order intact.
 */
async function routedPlan(
  reflex: Reflex,
  input: NormalizedInput,
  raw: WebSearchInput,
  deps: ToolDeps,
): Promise<RoutePlan | undefined> {
  try {
    const route = await reflex.route(input.q);
    // A route crosses a model boundary: anything but a usable engine list means
    // "no opinion", and the canonical order applies.
    if (typeof route !== "object" || route === null || !Array.isArray(route.engines)) return undefined;
    return planRoute(route, input, raw, deps);
  } catch (error) {
    logReflexFailure(deps, "route", error);
    return undefined;
  }
}

/**
 * The merged candidate list, mirroring `compact.ts`'s merge key (normalised URL,
 * ads and non-http hrefs dropped) so triage indices address what will actually
 * be shown. First occurrence wins, exactly like the compactor.
 */
function mergedCandidates(serps: readonly RawSerp[]): Candidate[] {
  const seen = new Set<string>();
  const items: Candidate[] = [];
  for (const serp of serps) {
    for (const raw of serp.results) {
      if (raw.isAd === true) continue;
      const href = typeof raw.url === "string" ? raw.url.trim() : "";
      if (!href || !isHttpUrl(href)) continue;
      const normalized = normalizeUrl(href);
      if (normalized === null || seen.has(normalized)) continue;
      seen.add(normalized);
      items.push({
        title: typeof raw.title === "string" ? raw.title : "",
        url: normalized,
        snippet: typeof raw.snippet === "string" ? raw.snippet : "",
        engine: raw.engine ?? serp.engine,
      });
    }
  }
  return items;
}

/** URLs selected by triage; null when the verdict cannot be applied safely. */
function keptUrls(candidates: readonly Candidate[], keep: unknown): Set<string> | null {
  if (!Array.isArray(keep)) return null;
  const urls = new Set<string>();
  for (const index of keep) {
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    urls.add(candidate.url);
  }
  return urls.size === 0 ? null : urls;
}

/**
 * Keep only the selected candidates. Engine order inside a SERP is preserved:
 * `compact.ts` owns display order (D10 merge order), and a model must not
 * reshuffle the user's engines. Dropping the unselected tail is the whole
 * token-saving point.
 */
function triagedSerps(serps: readonly RawSerp[], urls: ReadonlySet<string>): RawSerp[] {
  const out: RawSerp[] = [];
  for (const serp of serps) {
    const results = serp.results.filter((item) => {
      const href = typeof item.url === "string" ? item.url.trim() : "";
      if (!href) return false;
      const normalized = normalizeUrl(href);
      return normalized !== null && urls.has(normalized);
    });
    // A SERP that lost every result still carries the AI summary; keep it for
    // that, but do not claim an engine that contributes nothing else.
    if (results.length === 0 && serp.ai === undefined) continue;
    out.push({ ...serp, results });
  }
  return out;
}

/**
 * Triage is advisory but applied: an exception, an unusable verdict or an empty
 * keep list returns the unrefined SERPs. Recall loss is the expensive mistake,
 * so the input is never replaced with nothing.
 */
async function refineSerps(
  reflex: Reflex,
  query: string,
  serps: readonly RawSerp[],
  deps: ToolDeps,
): Promise<readonly RawSerp[]> {
  try {
    const candidates = mergedCandidates(serps);
    if (candidates.length === 0) return serps;
    const triage = await reflex.triage(query, candidates);
    const urls = keptUrls(candidates, triage?.keep);
    if (urls === null) return serps;
    const filtered = triagedSerps(serps, urls);
    if (filtered.length === 0 || filtered.every((serp) => serp.results.length === 0)) return serps;
    return filtered;
  } catch (error) {
    logReflexFailure(deps, "triage", error);
    return serps;
  }
}

// ---------------------------------------------------------------------------
// One engine attempt
// ---------------------------------------------------------------------------

/**
 * Cache and limiter are the caller's job; this function owns one live attempt:
 * acquire the tab, navigate (typed on first use), detect a wall, extract, cache.
 *
 * `firstUse` is consumed only after a successful extraction, so a wall or parse
 * failure on the typed path still makes the *next* call the human-shaped one.
 */
async function runEngine(
  engine: Engine,
  query: Query,
  key: string,
  deps: ToolDeps,
  firstUse: Set<EngineId>,
  signal: AbortSignal | undefined,
): Promise<RawSerp> {
  try {
    await deps.limiter.acquire(engine.id, signal);
  } catch (error) {
    throw asFailure(error, "navigate", engine.id, signal);
  }

  let page: CdpPage;
  try {
    page = await deps.cdp.acquirePage(engine.id);
  } catch (error) {
    throw asFailure(error, "connect", engine.id, signal);
  }

  const firstInSession = !firstUse.has(engine.id);
  const interaction = engine.interaction;
  const useHuman = interaction !== undefined && (firstInSession || deps.config.humanize === "always");

  /**
   * A wall page often does not satisfy the adapter's "results are ready" gate
   * (`/sorry`, a captcha, a consent interstitial), so settle fails with
   * `E_TIMEOUT`/`E_PARSE` before `detectWall` ever runs. Asking the adapter one
   * more question turns that into the honest `E_WALL` plus a snapshot instead of
   * an unexplainable timeout (and `E_TIMEOUT` is not a fallbackable code).
   */
  const wallOnNavigationFailure = async (
    failure: FailureDetails,
  ): Promise<Wall | null> => {
    if (failure.code !== "E_TIMEOUT" && failure.code !== "E_PARSE") return null;
    try {
      return await engine.detectWall(page);
    } catch {
      return null;
    }
  };

  /** One artifact for the wall the caller actually sees, then surface and fail. */
  const reportWall = async (wall: Wall, retried: boolean): Promise<never> => {
    const artifact = await saveArtifact(deps, {
      code: "E_WALL",
      stage: "navigate",
      engine: engine.id,
      url: page.url(),
      query: query.text,
      page,
      extra: {
        wall: { kind: wall.kind, url: wall.url, markers: [...wall.markers] },
        ...(retried ? { retried: true } : {}),
      },
    });
    await surface(page);
    throw wallFailure(engine.id, wall, artifact);
  };

  if (useHuman && interaction !== undefined) {
    try {
      await humanSearch({
        page,
        query: query.text,
        homeUrl: interaction.homeUrl,
        serpUrl: engine.buildUrl(query),
        boxSelectors: [...interaction.boxSelectors],
        marker: interaction.marker,
        ...(interaction.selector === undefined ? {} : { selector: interaction.selector }),
        ...(interaction.minCount === undefined ? {} : { minCount: interaction.minCount }),
        engine: engine.id,
        mode: deps.config.humanize,
        firstInSession,
        focus: deps.config.window.focus,
        clock: deps.clock,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      const failure = asFailure(error, "navigate", engine.id, signal);
      const wall = await wallOnNavigationFailure(failure.details);
      if (wall !== null) await reportWall(wall, false);
      throw failure;
    }
  } else {
    try {
      await navigateAndSettle(page, engine, query, signal);
    } catch (error) {
      const failure = asFailure(error, "navigate", engine.id, signal);
      const wall = await wallOnNavigationFailure(failure.details);
      if (wall !== null) await reportWall(wall, false);
      throw failure;
    }
  }

  let wall: Wall | null;
  try {
    wall = await engine.detectWall(page);
  } catch (error) {
    throw asFailure(error, "extract", engine.id, signal);
  }

  if (wall !== null) {
    let retried = false;

    if (engine.retryOnWall === true && deps.config.captcha.retryYandexOnce) {
      // The user solves the captcha in the visible window; we only wait, never click.
      await surface(page);
      try {
        await deps.clock.sleep(WALL_RETRY_MS, signal);
      } catch (error) {
        throw asFailure(error, "navigate", engine.id, signal);
      }
      await navigateAndSettle(page, engine, query, signal);

      try {
        wall = await engine.detectWall(page);
      } catch (error) {
        throw asFailure(error, "extract", engine.id, signal);
      }
      retried = true;

      // `captcha.waitMs` is the configurable extra grace after the fixed retry:
      // a human may need longer than 3 s. One more look, no navigation, no clicks.
      if (wall !== null && deps.config.captcha.waitMs > 0) {
        await surface(page);
        try {
          await deps.clock.sleep(deps.config.captcha.waitMs, signal);
        } catch (error) {
          throw asFailure(error, "navigate", engine.id, signal);
        }
        try {
          wall = await engine.detectWall(page);
        } catch (error) {
          throw asFailure(error, "extract", engine.id, signal);
        }
      }
    }

    if (wall !== null) {
      // Capturing before the retry would leave an orphan directory when the
      // retry clears it, so the snapshot happens once, here.
      await reportWall(wall, retried);
    }
  }

  let serp: RawSerp;
  try {
    serp = await engine.extract(page, query);
  } catch (error) {
    const failure = asFailure(error, "extract", engine.id, signal);
    // Only a page-state failure is worth a snapshot; an abort, a timeout or a
    // transport drop is not a property of the document and would add noise.
    if (failure.details.code !== "E_PARSE" && failure.details.code !== "E_WALL") throw failure;
    const artifact = await saveArtifact(deps, {
      code: failure.details.code,
      stage: failure.details.stage,
      engine: engine.id,
      url: page.url(),
      query: query.text,
      page,
    });
    throw fail(failure.details.code, failure.details.stage, {
      engine: engine.id,
      hint: failure.details.hint,
      ...(artifact === undefined ? {} : { artifact }),
      ...(failure.details.wall === undefined ? {} : { wall: failure.details.wall }),
      ...(failure.details.message === undefined ? {} : { message: failure.details.message }),
    });
  }

  // Google organics arrive as /goto wrappers; resolve them before caching so
  // the stored SERP already holds clickable targets (cache hits skip this).
  await resolveGotoResults(page, serp, deps, signal);

  // A SERP with zero organic results is a failed search, not an empty success:
  // it must trigger the next engine and must never be cached as the answer.
  if (serp.results.length === 0) {
    throw fail("E_EMPTY", "extract", {
      engine: engine.id,
      message: "the engine returned no organic results",
    });
  }

  deps.cache.set(key, serp, deps.config.cache.serpTtlMs);
  firstUse.add(engine.id);
  return serp;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build one tool instance. `getDeps` is injected by P2-E so a tool call resolves
 * the session's services lazily and per-context; the returned closure owns only
 * the per-instance first-use set, never global state.
 *
 * There is deliberately no default instance: constructing dependencies (CDP,
 * lock, config) belongs to the extension wiring, not to the tool module.
 */
export function createWebSearchTool(
  getDeps: (ctx?: unknown) => ToolDeps | Promise<ToolDeps>,
): WebSearchTool {
  const firstUse = new Set<EngineId>();

  async function execute(
    _toolCallId: string,
    params: WebSearchInput,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx?: unknown,
  ): Promise<WebSearchResult> {
    let deps: ToolDeps;
    try {
      deps = await getDeps(ctx);
    } catch (error) {
      return failureResult(error, { code: "E_CONFIG", stage: "config" });
    }

    // Last-resort barrier: a dependency bug must still reach the agent as a
    // rendered failure with a code and a stage, never as a bare thrown error.
    try {
      return await search(deps, params, signal, onUpdate);
    } catch (error) {
      return failureResult(error);
    }
  }

  async function search(
    deps: ToolDeps,
    params: WebSearchInput,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
  ): Promise<WebSearchResult> {
    const validation = normalizeInput(params, deps.config);
    if (!validation.ok) {
      return failureResult(fail("E_CONFIG", "config", { hint: INPUT_HINT, message: validation.message }));
    }
    let input = validation.value;
    if (signal?.aborted === true) {
      return failureResult(fail("E_CANCELLED", "navigate", { message: "aborted by the caller" }));
    }

    // One user search = one budget. The policy also resets on a query change,
    // but an explicit reset keeps two identical searches independent.
    const reflex = deps.reflex;
    try {
      reflex?.beginSearch?.();
    } catch {
      // Telemetry plumbing must never turn a good search into a failure.
    }
    const reflexOn = deps.config.reflex.enabled && reflex !== undefined;

    let order: EngineId[];
    let merge = Array.isArray(input.engines);
    try {
      order = deps.engines.select(input.engines);
    } catch (error) {
      return failureResult(asFailure(error, "resolve"));
    }
    if (reflexOn && reflex !== undefined && input.engines === "auto") {
      // `auto` is the only routable mode: a caller who named engines already
      // decided, and their order is the contract (D9).
      const plan = await routedPlan(reflex, input, params, deps);
      if (plan !== undefined) {
        input = plan.input;
        order = plan.order;
        merge = plan.merge;
      }
    }
    if (order.length === 0) {
      return failureResult(
        fail("E_UNSUPPORTED", "resolve", {
          hint: UNSUPPORTED_HINT,
          message: `no enabled engine for ${JSON.stringify(input.engines)}`,
        }),
      );
    }

    const startedAt = deps.clock.now();
    const update = asUpdater(onUpdate);
    // Only engines that actually produced a SERP (fresh or cached) are reported.
    const serps: RawSerp[] = [];
    let cachedAny = false;
    let firstFailure: ReturnType<typeof fail> | undefined;

    for (const id of order) {
      let engine: Engine;
      try {
        engine = deps.engines.get(id);
      } catch (error) {
        const failure = asFailure(error, "resolve", id, signal);
        firstFailure ??= failure;
        if (!FALLBACK_CODES.has(failure.details.code)) return failureResult(failure);
        continue;
      }

      const query = buildQuery(id, input, deps.config);
      const key = serpKey({
        engine: id,
        text: query.text,
        n: query.n,
        ...(query.page === undefined ? {} : { page: query.page }),
        ...(query.freshness === undefined ? {} : { freshness: query.freshness }),
        ...(query.lang === undefined ? {} : { lang: query.lang }),
        ...(query.region === undefined ? {} : { region: query.region }),
        summary: query.summary,
      });

      // Cache first: a hit is free, so it must not touch the limiter or the tab.
      const hit = deps.cache.get<RawSerp>(key);
      if (hit !== undefined) {
        cachedAny = true;
        serps.push(hit);
        // D10: `auto` means "first enabled engine that works", not a merge.
        if (!merge) break;
        continue;
      }

      await notifySearching(update, id);
      try {
        serps.push(await runEngine(engine, query, key, deps, firstUse, signal));
        // D10: stop at the first success in auto mode; only an explicit list (or
        // a multi-engine route) merges.
        if (!merge) break;
      } catch (error) {
        const failure = asFailure(error, "extract", id, signal);
        firstFailure ??= failure;
        if (!FALLBACK_CODES.has(failure.details.code)) return failureResult(failure);
      }
    }

    if (serps.length === 0) {
      return failureResult(firstFailure ?? fail("E_EMPTY", "extract"));
    }

    // Triage (SPEC §9.3) only for a merged or wide request: a plain single-engine
    // search must not pay classifier latency. A thrown reflex is logged and the
    // unrefined SERPs are returned, so the model can never break a working search.
    const multiEngine = merge && order.length >= 2;
    const refined =
      reflexOn &&
      reflex !== undefined &&
      triageWanted(deps.config.reflex.triage.when, multiEngine, input.n)
        ? await refineSerps(reflex, input.q, serps, deps)
        : serps;

    const elapsedMs = deps.clock.now() - startedAt;
    const compact = compactSerps(refined, {
      n: input.n,
      summaryMaxChars: deps.config.search.summaryMaxChars,
      snippetMaxChars: deps.config.search.snippetMaxChars,
      outputMaxChars: deps.config.search.outputMaxChars,
      format: input.format,
      cached: cachedAny,
      elapsedMs,
    });

    // The JSON view needs its own cap: `compact.ts` caps Markdown, while JSON
    // escaping can push the same data well past `outputMaxChars`. The fitter also
    // rewrites `chars` inside `data` to the length of the text we actually return.
    // `details` is derived from the fitted render, never from `compact.data`:
    // pre-fit counts would claim results and an AI that were dropped to fit.
    const json =
      input.format === "json"
        ? serializeJsonWithin(compact.data, deps.config.search.outputMaxChars)
        : null;
    const text = json === null ? compact.text : json.text;
    const contributed = [...new Set(refined.map((serp) => serp.engine))];
    const rendered = json === null ? compact.items.length : json.results;
    const truncated = json === null ? compact.truncated : json.truncated;
    const hasAi = json === null ? compact.ai !== undefined : json.ai;
    const details: WebSearchDetails = {
      engines: contributed,
      results: rendered,
      ai: hasAi,
      chars: text.length,
      truncated,
      cached: cachedAny,
      pageCarried: compact.pageCarried,
      // DuckDuckGo has no pagination yet (M2): `page` is requested but not honoured.
      ...(input.page > 1 && contributed.includes("duckduckgo") ? { pageIgnored: true } : {}),
      ...(compact.degraded ? { degraded: true } : {}),
    };

    return { content: [{ type: "text", text }], details };
  }

  return {
    name: "web_search",
    label: "Web Search",
    description: WEB_SEARCH_DESCRIPTION,
    parameters: webSearchSchema,
    exposure: "direct",
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    execute,
  };
}
