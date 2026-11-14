/**
 * `web_search` — a direct tool, paired with direct `web_read` (S3).
 *
 * The tool is a thin, deterministic orchestrator over frozen contracts: engine
 * selection/fallback, cache, pacing, human-shaped navigation and compaction. It
 * never imports a socket or the browser; every side effect goes through
 * `ToolDeps`, which is what makes the whole unit suite offline.
 *
 * Ordering rules that are easy to get wrong:
 * - Cache *before* the limiter. A cache hit must not spend pacing time or touch
 *   the page — that is the whole point of the SERP cache (§8) and the reason a
 *   repeated query is instant.
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

import { humanSearch, type HumanSearchResult } from "../cdp/humanize.ts";
import { pageLockFor } from "../session/index.ts";
import { waitForAi, type AiWaitResult } from "../cdp/ai-wait.ts";
import type { CdpPage } from "../cdp/types.ts";
import type { Config } from "../config/index.ts";
import { compactSerps } from "../extract/compact.ts";
import { GOTO_BATCH_TIMEOUT_MS, createGotoResolver, resolveGotoBatch } from "../extract/goto.ts";
import { parseLink } from "../extract/urls.ts";
import {
  ENGINE_IDS,
  SUPPORT_MATRIX,
  type AiState,
  type Engine,
  type EngineId,
  type EngineSelection,
  type Query,
  type RawSerp,
  type SupportArgument,
  type Wall,
} from "../engines/types.ts";
import { serpKey } from "../runtime/cache.ts";
import type { ErrorCode, FailureDetails, Stage } from "../runtime/error-codes.ts";
import { isWebSearchError } from "../runtime/error-codes.ts";
import { fail, renderToolFailure, toFailure } from "../runtime/errors.ts";
import type { FailureFallback, FailureJson, ToolTextBlock } from "../runtime/errors.ts";
import { saveFailureArtifact } from "../runtime/artifacts.ts";
import { createCallBudget, raceSignal, type CallBudget } from "../runtime/budget.ts";
import { announceWork, type PanelCounter } from "../runtime/panel.ts";
import type { Clock } from "../runtime/types.ts";
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
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("json")])),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

/**
 * P10: what the human-shaped navigation actually did. Optional because a cache
 * hit never navigates and a merged route has one answer per engine.
 */
export interface HumanRunDetails {
  engine: EngineId;
  typed: boolean;
  typedPath: boolean;
  fellBackToSerp: boolean;
  fellBackReason?: HumanSearchResult["fellBackReason"];
  homeRedirectHost?: string;
  homeMs: number;
  typeMs: number;
  settleMs: number;
}

/** The serializable `details` object pi shows next to the text block. */
export interface WebSearchDetails {
  /** Engines that contributed results, in try order (cache hits included). */
  engines: EngineId[];
  /** Number of compact items actually rendered, after caps/dedup. */
  results: number;
  /** True only for an `answer`; kept for callers written before the three states. */
  ai: boolean;
  /** `answer` | `lead` | `none` (PLAN-v2 P8); `ai` here is honest by construction. */
  aiState: AiState;
  /** Clock time spent waiting for the streaming summary (0 when not waited). */
  aiWaitMs: number;
  /** Characters of the rendered AI block (0 for a lead/none or when dropped). */
  aiChars: number;
  chars: number;
  truncated: boolean;
  cached: boolean;
  pageCarried: boolean;
  /**
   * Honour-or-flag (S4.2, S7.1): an accepted argument an engine could not
   * honour, with the engine as the value. DuckDuckGo has no pagination, so a
   * `page > 1` request that reached it is reported as
   * `{ page: "duckduckgo" }` — never dropped silently.
   */
  ignored?: Partial<Record<SupportArgument, string>>;
  /** Set only by the keyless HTTP fallback (SPEC §6.5); never by a real SERP. */
  degraded?: boolean;
  /**
   * Per-engine output counts for a merged multi-engine search (P9-D). Failed
   * engines appear as `0` and their code in `failedEngines`, so "n=3 across two
   * engines" cannot silently mean "yandex never ran".
   */
  perEngine?: Record<string, number>;
  failedEngines?: Partial<Record<EngineId, string>>;
  /** P10: typed-path facts for a single-engine search; absent on cache hits. */
  human?: HumanRunDetails;
  /**
   * Number of emitted results whose Google `/goto` wrapper stayed opaque. Such a
   * result keeps its wrapper URL and is marked `unresolved` in the output (S3.5,
   * S7.4), so a caller can tell a real destination from a wrapper that may still
   * redirect in the browser.
   */
  unresolved?: number;
  /**
   * Time from the SERP request to the result marker (summed across engines).
   * P10 measures the typed path's *page* cost against the direct one with this:
   * keystroke time is deliberate human work, not search latency.
   */
  settleMs?: number;
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
  annotations: { readOnlyHint: false; openWorldHint: true; idempotentHint: false };
  /** Search operators the model can use without a tool-level date filter (S3.6). */
  promptGuidelines?: readonly string[];
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
  "Search the web for free in the user's visible Chrome (Google, DuckDuckGo, Yandex) with each engine's native AI summary. Compact results, n<=10. Call web_read on a result URL to get that page as paged Markdown. site:/filetype:/quoted queries pass through; engines: id, list, or auto.";

/**
 * SPEC S3.6: `q` is passed verbatim, so narrowing happens in the query. The
 * guideline is prompt text, not an argument, and stays under 400 chars.
 */
export const WEB_SEARCH_GUIDELINES: readonly string[] = [
  "web_search passes q verbatim: use quoted phrases, -term, OR, site:, filetype:; narrow by date with after:/before: on Google or date: on Yandex (there is no date argument).",
];

/**
 * Codes a sibling engine can plausibly cure. Everything else (E_PARSE, E_TIMEOUT,
 * E_CANCELLED, E_CONFIG) is a property of the request or the
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
  page: number;
  format: "md" | "json";
}

type Validation = { ok: true; value: NormalizedInput } | { ok: false; message: string };

function isPerEngineCounts(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((count) => typeof count === "number");
}

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
    value: { q: text, n, engines, summary, page, format },
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
 * `config.engines.*` is the user's own pinning; a value left as `auto` omits the
 * parameter rather than inventing one.
 */
function buildQuery(engine: EngineId, input: NormalizedInput, config: Config): Query {
  const query: Query = { text: input.q, n: input.n, summary: input.summary };
  // S4.2 is data (`SUPPORT_MATRIX`): an engine that cannot paginate never
  // receives `page`, and the caller is told so through `ignored` below.
  if (SUPPORT_MATRIX.page[engine] === "yes") query.page = input.page;

  switch (engine) {
    case "google": {
      const lang = resolveLocale(config.engines.google.lang);
      const region = resolveLocale(config.engines.google.gl);
      if (lang !== undefined) query.lang = lang;
      if (region !== undefined) query.region = region;
      break;
    }
    case "duckduckgo": {
      const region = resolveLocale(config.engines.duckduckgo.kl);
      if (region !== undefined) query.region = region;
      break;
    }
    case "yandex": {
      const region = resolveLocale(config.engines.yandex.lr);
      if (region !== undefined) query.region = region;
      break;
    }
  }
  return query;
}

/**
 * S4.2/S7.1: an argument is honoured by every engine that contributed, or it is
 * reported. The walk reads `SUPPORT_MATRIX`, so adding an engine or changing a
 * cell moves the behaviour and the test together.
 */
function ignoredArguments(
  input: NormalizedInput,
  engines: readonly EngineId[],
): Partial<Record<SupportArgument, string>> | undefined {
  const requested: Record<SupportArgument, boolean> = {
    n: true,
    page: input.page > 1,
    summary: input.summary,
  };
  const ignored: Partial<Record<SupportArgument, string>> = {};
  for (const argument of ["n", "page", "summary"] as const) {
    if (!requested[argument]) continue;
    const flagged = engines.filter((engine) => SUPPORT_MATRIX[argument][engine] === "flag");
    if (flagged.length > 0) ignored[argument] = flagged.join(",");
  }
  return Object.keys(ignored).length === 0 ? undefined : ignored;
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
  /** Characters of the AI prose that survived the JSON fit (honest, not pre-fit). */
  aiChars: number;
  /** P9-D: per-engine counts of the results that survived the fit, when requested. */
  perEngine?: Record<string, number>;
  /** Emitted results that still carry an unresolved `/goto` wrapper (S3.5, S7.4). */
  unresolved?: number;
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

  // P9-D: the per-engine accounting must describe the emitted JSON, not the
  // pre-fit plan (the fitter may have dropped results from the tail).
  const perEngineCounts: Record<string, number> | undefined = isRecord(copy.perEngine)
    ? (() => {
        const counts: Record<string, number> = {};
        for (const item of items) {
          const engine = item.engine;
          if (typeof engine === "string") counts[engine] = (counts[engine] ?? 0) + 1;
        }
        for (const key of Object.keys(copy.perEngine as Record<string, unknown>)) {
          if (counts[key] === undefined) counts[key] = 0;
        }
        copy.perEngine = counts;
        return counts;
      })()
    : undefined;

  let text = settleChars(copy);
  let truncated = copy.truncated === true;
  let results = items.length;
  let ai = copy.ai !== undefined;
  const aiText = isRecord(copy.ai) && typeof copy.ai.text === "string" ? copy.ai.text : "";
  let aiChars = aiText.length;
  let unresolved = items.filter((item) => item.unresolved === true).length;
  if (text.length > maxChars) {
    // The cap is below the envelope: return the floor and report exactly that,
    // even if the starting data already had no results/AI to drop.
    text = minimalJson();
    truncated = true;
    results = 0;
    ai = false;
    aiChars = 0;
    unresolved = 0;
  }

  return {
    text,
    results,
    truncated,
    ai,
    aiChars,
    ...(unresolved === 0 ? {} : { unresolved }),
    ...(perEngineCounts === undefined ? {} : { perEngine: perEngineCounts }),
  };
}

/** P10: daily counters for the anchor panel. A limiter without stats must not fail a search. */
function panelCounters(deps: ToolDeps): PanelCounter[] {
  const counters: PanelCounter[] = [];
  for (const id of ENGINE_IDS) {
    try {
      const stats = deps.limiter.stats(id);
      counters.push({ engine: id, today: stats.today });
    } catch {
      // Observability only: the panel shows what it can.
    }
  }
  return counters;
}

async function navigateAndSettle(
  page: CdpPage,
  engine: Engine,
  query: Query,
  signal: AbortSignal | undefined,
  clock?: Clock,
): Promise<number> {
  const url = engine.buildUrl(query);
  try {
    await page.navigate(url, signal === undefined ? {} : { signal });
  } catch (error) {
    throw asFailure(error, "navigate", engine.id, signal);
  }
  const settleStart = clock?.now();
  try {
    await engine.settle(page, signal);
    return settleStart === undefined ? 0 : Math.max(0, (clock?.now() ?? settleStart) - settleStart);
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
  budget: CallBudget,
): Promise<void> {
  const base = page.url();
  const pending = serp.results
    .map((item) => ({ item, link: parseLink(item.url, base) }))
    .filter(
      (entry): entry is { item: (typeof serp.results)[number]; link: NonNullable<ReturnType<typeof parseLink>> } =>
        entry.link !== null && entry.link.kind === "goto" && entry.link.wrapperUrl !== null,
    );
  if (pending.length === 0) return;

  budget.check("resolve", serp.engine);
  const resolver = createGotoResolver({
    cache: deps.cache,
    clock: deps.clock,
    ttlMs: deps.config.cache.gotoTtlMs,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    cookieSource: (urls) => page.cookiesFor([...urls]),
    navigateFallback: async (wrapperUrl) => {
      await page.navigate(wrapperUrl, { signal: budget.signal });
      return page.url();
    },
  });

  // S8.3: concurrency 3 and one total deadline, clamped by what is left of the
  // call. A wrapper the batch did not reach stays the wrapper and is marked.
  const batch = await resolveGotoBatch({
    resolver,
    wrappers: pending.map((entry) => entry.link.wrapperUrl as string),
    deadlineMs: Math.min(GOTO_BATCH_TIMEOUT_MS, budget.remainingMs()),
    signal: budget.signal,
  });

  for (const { item, link } of pending) {
    const wrapperUrl = link.wrapperUrl as string;
    const resolution = batch.byWrapper.get(wrapperUrl);
    if (resolution?.url != null) {
      item.url = resolution.url;
    } else {
      // The wrapper stays clickable in the user's browser, but the caller must
      // be able to tell that this is not a verified destination (S3.5, S7.4).
      item.unresolved = true;
    }
  }

  if (budget.signal.aborted === true) {
    throw fail("E_CANCELLED", "extract", {
      engine: serp.engine,
      message: "the search was aborted while resolving result links",
    });
  }
  void deps.log.write({
    kind: "goto",
    engine: serp.engine,
    links: pending.length,
    resolved: batch.resolved,
    unresolved: batch.unresolved,
    timedOut: batch.timedOut,
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
// One engine attempt
// ---------------------------------------------------------------------------

/**
 * Cache and limiter are the caller's job; this function owns one live attempt:
 * acquire the tab, navigate (typed on first use), detect a wall, extract, cache.
 *
 * `firstUse` is consumed only after a successful extraction, so a wall or parse
 * failure on the typed path still makes the *next* call the human-shaped one.
 *
 * The limiter paces but does not hold the tab: pi runs the tool calls of one
 * turn concurrently, and two attempts on the same engine would type into one
 * search box at the same time (`CloudCflloaurdef…`). Every live attempt on an
 * engine tab therefore runs under the same FIFO page lock `web_read` uses — one
 * writer per tab (AGENTS hard rule 8). The lock also makes `firstUse` honest:
 * the second caller sees the first call's success and takes the fast path
 * instead of typing a duplicate search.
 */
interface PageHolder {
  page?: CdpPage;
}

async function runEngine(
  engine: Engine,
  query: Query,
  key: string,
  deps: ToolDeps,
  firstUse: Set<EngineId>,
  budget: CallBudget,
  onHuman?: (human: HumanSearchResult) => void,
): Promise<RawSerp> {
  const holder: PageHolder = {};
  const work = pageLockFor(deps.cdp).run(engine.id, async () => {
    try {
      return await runEngineLive(engine, query, key, deps, firstUse, budget, holder, onHuman);
    } catch (error) {
      if (!budget.expired()) throw error;
      // S8.1: an exhausted budget is reported as such, with the page we were
      // looking at when there is one. A cancelled caller keeps its E_CANCELLED.
      let artifact: string | undefined;
      if (holder.page !== undefined) {
        artifact = await saveFailureArtifact(deps, {
          code: "E_TIMEOUT",
          stage: "budget",
          engine: engine.id,
          url: holder.page.url(),
          query: query.text,
          page: holder.page,
        });
      }
      throw fail("E_TIMEOUT", "budget", {
        engine: engine.id,
        ...(artifact === undefined ? {} : { artifact }),
        message: `search budget of ${budget.budgetMs} ms exhausted`,
      });
    }
  });
  // A queued attempt must not outlive the call's deadline. The losing task is
  // left to finish; it checks the budget again before touching the tab.
  return await raceSignal(work, budget.signal);
}

async function runEngineLive(
  engine: Engine,
  query: Query,
  key: string,
  deps: ToolDeps,
  firstUse: Set<EngineId>,
  budget: CallBudget,
  holder: PageHolder,
  onHuman?: (human: HumanSearchResult) => void,
): Promise<RawSerp> {
  const signal = budget.signal;
  budget.check("navigate", engine.id);
  const pacing = deps.config.pacing[engine.id];
  // P10-A: the query reaches the anchor before the pacing sleep, so the panel
  // shows what is about to happen even when the limiter waits for seconds.
  await announceWork(deps.cdp, {
    engine: engine.id,
    query: query.text,
    stage: "pace",
    pace: pacing,
    counters: panelCounters(deps),
  });

  try {
    await deps.limiter.acquire(engine.id, signal);
  } catch (error) {
    throw asFailure(error, "navigate", engine.id, signal);
  }

  budget.check("navigate", engine.id);
  let page: CdpPage;
  try {
    page = await deps.cdp.acquirePage(engine.id);
  } catch (error) {
    throw asFailure(error, "connect", engine.id, signal);
  }
  holder.page = page;
  budget.check("navigate", engine.id);

  const firstInSession = !firstUse.has(engine.id);
  const interaction = engine.interaction;
  const useHuman = interaction !== undefined && (firstInSession || deps.config.humanize !== "auto");

  // The tab exists now: this is the first stage that can raise it under
  // `window.follow: "work"`. The panel also gets the fresh daily counters.
  await announceWork(deps.cdp, {
    engine: engine.id,
    query: query.text,
    stage: "navigate",
    pace: pacing,
    counters: panelCounters(deps),
  });

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
  const reportWall = async (wall: Wall): Promise<never> => {
    const artifact = await saveFailureArtifact(deps, {
      code: "E_WALL",
      stage: "navigate",
      engine: engine.id,
      url: page.url(),
      query: query.text,
      page,
      extra: { wall: { kind: wall.kind, url: wall.url, markers: [...wall.markers] } },
    });
    await surface(page);
    throw wallFailure(engine.id, wall, artifact);
  };

  /** P10: measured page-ready time, from the request to the marker. */
  let measuredSettleMs = 0;
  if (useHuman && interaction !== undefined) {
    try {
      const human = await humanSearch({
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
        ...(interaction.homeHosts === undefined ? {} : { homeHosts: interaction.homeHosts }),
        ...(interaction.typeProfile === undefined ? {} : { typeProfile: interaction.typeProfile }),
        ...(interaction.typeOn === undefined ? {} : { typeOn: interaction.typeOn }),
        clock: deps.clock,
        ...(signal === undefined ? {} : { signal }),
      });
      onHuman?.(human);
      measuredSettleMs = human.settleMs;
      // P10: the typed-path facts belong in the log even when the live gate is
      // not watching: `typed` is what proves the box path really ran.
      void deps.log.write({
        kind: "human_search",
        engine: engine.id,
        typed: human.typed,
        typedPath: human.typedPath,
        fellBackToSerp: human.fellBackToSerp,
        ...(human.fellBackReason === undefined ? {} : { fellBackReason: human.fellBackReason }),
        ...(human.homeRedirectHost === undefined ? {} : { homeRedirectHost: human.homeRedirectHost }),
        homeMs: human.homeMs,
        typeMs: human.typeMs,
        settleMs: human.settleMs,
      });
    } catch (error) {
      const failure = asFailure(error, "navigate", engine.id, signal);
      const wall = await wallOnNavigationFailure(failure.details);
      if (wall !== null) await reportWall(wall);
      throw failure;
    }
  } else {
    try {
      measuredSettleMs = await navigateAndSettle(page, engine, query, signal, deps.clock);
    } catch (error) {
      const failure = asFailure(error, "navigate", engine.id, signal);
      const wall = await wallOnNavigationFailure(failure.details);
      if (wall !== null) await reportWall(wall);
      throw failure;
    }
  }

  let wall: Wall | null;
  try {
    wall = await engine.detectWall(page);
  } catch (error) {
    throw asFailure(error, "extract", engine.id, signal);
  }

  // ADR-0001 D5: a wall is reported at once. No retry, no timer, no automatic
  // re-navigation; the human solves it and retries.
  if (wall !== null) await reportWall(wall);

  // PLAN-v2 P8-A: wait for the native summary *before* extracting. Bounded by
  // `search.aiWaitMs`, and skipped entirely by `summary:false` and by adapters
  // without a probe — a wait nobody asked for is pure latency.
  await announceWork(deps.cdp, { engine: engine.id, stage: "extract" });
  let aiWait: AiWaitResult | undefined;
  if (query.summary === true && engine.ai !== undefined) {
    // A visible expand is opt-in (`search.aiExpand`) because it is a real click
    // in the user's window. A failed expand is not a search failure: extraction
    // reports the collapsed state honestly.
    if (deps.config.search.aiExpand === true && engine.ai.expand !== undefined) {
      try {
        await engine.ai.expand(page, { signal });
      } catch (error) {
        if (signal?.aborted === true) throw asFailure(error, "extract", engine.id, signal);
        void deps.log.write({
          kind: "ai_expand",
          engine: engine.id,
          message: (toFailure(error, { code: "E_PARSE", stage: "extract" }).message ?? "").slice(0, 200),
        });
      }
    }

    aiWait = await waitForAi(page, engine.ai, {
      // Derive the wait from what is left of the call (S8.1), not from a
      // second independent deadline.
      deadlineMs: Math.min(deps.config.search.aiWaitMs, budget.remainingMs()),
      clock: deps.clock,
      engine: engine.id,
      signal,
    });

    if (aiWait.timedOut) {
      // V8.5: a wait that ended without an answer leaves proof behind — the page
      // exactly as the extractor is about to see it — for a lead and for a page
      // with no AI block alike.
      await saveFailureArtifact(deps, {
        code: "AI_TIMEOUT",
        stage: "extract",
        engine: engine.id,
        url: page.url(),
        query: query.text,
        page,
        extra: {
          aiWait: {
            state: aiWait.state,
            chars: aiWait.chars,
            waitMs: aiWait.waitMs,
            polls: aiWait.polls,
            budgetMs: deps.config.search.aiWaitMs,
          },
        },
      });
    }
  }

  budget.check("extract", engine.id);
  let serp: RawSerp;
  try {
    serp = await engine.extract(page, query);
  } catch (error) {
    const failure = asFailure(error, "extract", engine.id, signal);
    // Only a page-state failure is worth a snapshot; an abort, a timeout or a
    // transport drop is not a property of the document and would add noise.
    if (failure.details.code !== "E_PARSE" && failure.details.code !== "E_WALL") throw failure;
    const artifact = await saveFailureArtifact(deps, {
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
  if (aiWait !== undefined) {
    serp.timings = { ...serp.timings, aiWaitMs: aiWait.waitMs };
  }
  if (measuredSettleMs > 0) serp.timings = { ...serp.timings, settleMs: measuredSettleMs };
  await resolveGotoResults(page, serp, deps, budget);
  budget.check("render", engine.id);

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

    let budget: CallBudget;
    try {
      budget = createCallBudget({
        clock: deps.clock,
        budgetMs: deps.config.search.budgetMs,
        ...(signal === undefined ? {} : { parent: signal }),
        label: "web_search",
      });
    } catch (error) {
      return failureResult(error, { code: "E_CONFIG", stage: "config" });
    }

    // Last-resort barrier: a dependency bug must still reach the agent as a
    // rendered failure with a code and a stage, never as a bare thrown error.
    try {
      return await search(deps, params, budget, onUpdate);
    } catch (error) {
      return failureResult(error);
    } finally {
      budget.dispose();
    }
  }

  async function search(
    deps: ToolDeps,
    params: WebSearchInput,
    budget: CallBudget,
    onUpdate: unknown,
  ): Promise<WebSearchResult> {
    const signal = budget.signal;
    const validation = normalizeInput(params, deps.config);
    if (!validation.ok) {
      return failureResult(fail("E_CONFIG", "config", { hint: INPUT_HINT, message: validation.message }));
    }
    const input = validation.value;
    if (signal?.aborted === true) {
      return failureResult(fail("E_CANCELLED", "navigate", { message: "aborted by the caller" }));
    }

    let order: EngineId[];
    const merge = Array.isArray(input.engines);
    try {
      order = deps.engines.select(input.engines);
    } catch (error) {
      return failureResult(asFailure(error, "resolve"));
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
    /** P10: only a single-engine search has one unambiguous typed-path record. */
    let humanRun: HumanRunDetails | undefined;
    let firstFailure: ReturnType<typeof fail> | undefined;
    /** P9-D: failures inside a merged route are reported, not silently swallowed. */
    const failed: Partial<Record<EngineId, string>> = {};
    // A coverage set splits `n` across its engines instead of asking every
    // engine for `n` and letting the first one fill every slot.
    const perEngineN = merge && order.length > 1 ? Math.ceil(input.n / order.length) : input.n;

    for (const id of order) {
      let engine: Engine;
      try {
        engine = deps.engines.get(id);
      } catch (error) {
        const failure = asFailure(error, "resolve", id, signal);
        firstFailure ??= failure;
        if (!FALLBACK_CODES.has(failure.details.code)) return failureResult(failure);
        if (merge) failed[id] = failure.details.code;
        continue;
      }

      const query = buildQuery(id, perEngineN === input.n ? input : { ...input, n: perEngineN }, deps.config);
      const key = serpKey({
        engine: id,
        text: query.text,
        n: query.n,
        ...(query.page === undefined ? {} : { page: query.page }),
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
        budget.check("navigate", id);
        const single = order.length === 1;
        serps.push(
          await runEngine(
            engine,
            query,
            key,
            deps,
            firstUse,
            budget,
            single
              ? (human) => {
                  humanRun = {
                    engine: id,
                    typed: human.typed,
                    typedPath: human.typedPath,
                    fellBackToSerp: human.fellBackToSerp,
                    ...(human.fellBackReason === undefined
                      ? {}
                      : { fellBackReason: human.fellBackReason }),
                    ...(human.homeRedirectHost === undefined
                      ? {}
                      : { homeRedirectHost: human.homeRedirectHost }),
                    homeMs: human.homeMs,
                    typeMs: human.typeMs,
                    settleMs: human.settleMs,
                  };
                }
              : undefined,
          ),
        );
        await announceWork(deps.cdp, { engine: id, stage: "done" });
        // D10: stop at the first success in auto mode; only an explicit list (or
        // a multi-engine route) merges.
        if (!merge) break;
      } catch (error) {
        const failure = asFailure(error, "extract", id, signal);
        await announceWork(deps.cdp, {
          engine: id,
          stage: "error",
          error: { code: failure.details.code, ...(failure.details.hint === undefined ? {} : { hint: failure.details.hint }) },
        });
        // A wall keeps the work tab surfaced for the user to solve; every other
        // failure hands the screen back to the panel.
        if (failure.details.code !== "E_WALL") await announceWork(deps.cdp, { engine: id, stage: "done" });
        firstFailure ??= failure;
        if (!FALLBACK_CODES.has(failure.details.code)) return failureResult(failure);
        if (merge) failed[id] = failure.details.code;
      }
    }

    if (serps.length === 0) {
      return failureResult(firstFailure ?? fail("E_EMPTY", "extract"));
    }

    const elapsedMs = deps.clock.now() - startedAt;
    const multiEngineSearch = merge && order.length > 1;
    const contributed = [...new Set(serps.map((serp) => serp.engine))];
    const ignored = ignoredArguments(input, contributed);
    const compact = compactSerps(serps, {
      n: input.n,
      summaryMaxChars: deps.config.search.summaryMaxChars,
      snippetMaxChars: deps.config.search.snippetMaxChars,
      outputMaxChars: deps.config.search.outputMaxChars,
      format: input.format,
      cached: cachedAny,
      elapsedMs,
      perEngine: multiEngineSearch,
      failedEngines: failed,
      ...(ignored === undefined ? {} : { ignored }),
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
    const rendered = json === null ? compact.items.length : json.results;
    const truncated = json === null ? compact.truncated : json.truncated;
    const shownAi = json === null ? compact.ai !== undefined : json.ai;
    // The JSON fitter can drop the AI for space; the state must follow the
    // output, never the pre-fit plan (`ai:yes` with no line is the P8 bug).
    const aiState: AiState = shownAi
      ? "answer"
      : json !== null && compact.aiState === "lead"
        ? "lead"
        : json === null
          ? compact.aiState
          : "none";
    const aiChars = json === null ? compact.aiChars : json.aiChars;
    const aiWaitMs = serps.reduce((sum, serp) => sum + (serp.timings.aiWaitMs ?? 0), 0);
    const settleMs = serps.reduce((sum, serp) => sum + (serp.timings.settleMs ?? 0), 0);
    const accounting =
      json === null ? compact.data.perEngine : json.perEngine;
    const unresolved =
      json === null
        ? compact.items.filter((item) => item.unresolved === true).length
        : json.unresolved ?? 0;
    const details: WebSearchDetails = {
      engines: contributed,
      results: rendered,
      ai: aiState === "answer",
      aiState,
      aiWaitMs,
      aiChars,
      chars: text.length,
      truncated,
      cached: cachedAny,
      pageCarried: compact.pageCarried,
      ...(ignored === undefined ? {} : { ignored }),
      ...(compact.degraded ? { degraded: true } : {}),
      ...(isPerEngineCounts(accounting) ? { perEngine: accounting } : {}),
      ...(Object.keys(failed).length === 0 ? {} : { failedEngines: { ...failed } }),
      ...(humanRun === undefined ? {} : { human: humanRun }),
      ...(unresolved === 0 ? {} : { unresolved }),
      ...(settleMs <= 0 ? {} : { settleMs }),
    };

    // One row per search (SPEC §9.3 observability): the AI verdict and the wait
    // it cost are the numbers the P8 latency table is built from.
    void deps.log.write({
      kind: "search",
      engines: contributed,
      aiState,
      aiWaitMs,
      aiChars,
      results: rendered,
      chars: details.chars,
      cached: cachedAny,
    });

    return { content: [{ type: "text", text }], details };
  }

  return {
    name: "web_search",
    label: "Web Search",
    description: WEB_SEARCH_DESCRIPTION,
    parameters: webSearchSchema,
    exposure: "direct",
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    promptGuidelines: WEB_SEARCH_GUIDELINES,
    execute,
  };
}
