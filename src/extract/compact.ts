/**
 * Compaction: the single place where output caps live (SPEC §8, PLAN P2-A).
 * Adapters return raw `RawSerp` objects; the tool layer hands them here and
 * renders either the Markdown (`text`) or the JSON (`data`) view.
 *
 * Invariants:
 * - `text.length <= outputMaxChars` for ANY input and any option mix.
 * - AI summary and results have separate budgets (see `compactSerps`): the
 *   results floor is reserved *before* capping the AI, so a long summary can
 *   never starve the result list (PLAN V3.5: `ai:yes` still yields n results).
 * - Snippets shrink (140 → 100) before whole results are dropped; AI text is
 *   cut inside its own budget; results are dropped only when even the 100-char
 *   floor does not fit. Inside the AI block the source list is trimmed first (it
 *   may take at most a quarter of the line), then the prose is cut.
 * - The AI is dropped only when its block is narrower than 6 chars (`\nAI: x`),
 *   the smallest block that can carry a summary.
 * - A URL is never truncated: if an item does not fit, the whole item is dropped.
 * - Inputs are read-only and the output is deterministic.
 *
 * JSON schema (`data`, for codemode):
 * ```json
 * {
 *   "engine": "google",                 // engineLabel, "google+duckduckgo" when mixed
 *   "query": "…",
 *   "ai": { "text": "…", "sources": ["a.com"] },   // omitted when absent
 *   "results": [
 *     { "title": "…", "url": "…", "domain": "…", "snippet": "…", "engine": "google",
 *       "unresolved": true }
 *     // "engine" only when the caller mixed engines; "unresolved" only for an
 *     // opaque Google /goto wrapper that stayed unresolved (S3.5, S7.4)
 *   ],
 *   "pageCarried": true,
 *   "degraded": true,                   // only when true
 *   "cached": true,                     // only when true
 *   "chars": 1234,                      // == text.length
 *   "truncated": false                  // true when outputMaxChars forced a cut
 * }
 * ```
 * String caps are identical to the Markdown view; only `text` has a total-length
 * cap (JSON escaping can inflate the serialized form — consumers must not rely on
 * `JSON.stringify(data).length <= outputMaxChars`).
 *
 * `format` is advisory: both renders are always produced so the caller can switch
 * without another pass over the SERPs.
 */

import { AI_ANSWER_MIN_CHARS, ENGINE_IDS, type AiState, type AiSummary, type EngineId, type RawSerp } from "../engines/types.ts";
import { domainOf, isHttpUrl, normalizeUrl } from "./urls.ts";

/** Extra caps that are not in `SearchConfig`, kept here so they stay in one place. */
export const COMPACT_CAPS = {
  /** A SERP title longer than this is noise (site name + breadcrumbs). */
  titleMaxChars: 200,
  /** Visible AI source names; the page rarely shows more than a handful. */
  maxAiSources: 8,
  /** Per-source name cap. */
  sourceMaxChars: 120,
  /**
   * Snippet floor: the results floor is reserved at this width, and the renderer
   * falls back to it before dropping any result (SPEC §8 rules 1 and 6).
   */
  fallbackSnippetMaxChars: 100,
  /** SearchConfig.nMax; the caller cannot ask for more anyway. */
  maxN: 10,
  /** Results per domain before the domain cap starts deferring them. */
  perDomainLimit: 2,
} as const;

export interface CompactOptions {
  n: number;
  summaryMaxChars: number;
  snippetMaxChars: number;
  outputMaxChars: number;
  format?: "md" | "json";
  cached?: boolean;
  elapsedMs?: number;
  /**
   * P9-D: a merged multi-engine search reports what each engine actually
   * contributed (`google:3 yandex:0(E_WALL)`), so "n=3, two engines" can no
   * longer hide an engine that silently took every slot (or failed quietly).
   */
  perEngine?: boolean;
  /** Codes of engines that failed inside a merged search; rendered as `id:0(CODE)`. */
  failedEngines?: Partial<Record<EngineId, string>>;
}

export interface CompactItem {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  engine?: EngineId;
  /** The URL is an opaque `/goto` wrapper that stayed unresolved (S3.5, S7.4). */
  unresolved?: boolean;
}

export interface CompactAi {
  text: string;
  sources: string[];
  /** `answer` is the only state that renders an `AI:` line; `lead` is header-only. */
  state?: AiState;
}

export interface CompactResult {
  engineLabel: string;
  /** Present only for an `answer`; a `lead` is reported through `aiState`. */
  ai?: CompactAi;
  /** Three-state AI verdict; drives the header (`ai:yes` / `ai:lead` / `ai:no`). */
  aiState: AiState;
  items: CompactItem[];
  pageCarried: boolean;
  degraded: boolean;
  cached: boolean;
  /** Markdown render (always produced). */
  text: string;
  /** JSON render; see the schema above. */
  data: Record<string, unknown>;
  chars: number;
  /** Rendered AI block (`""` newline prefix included); 0 when no summary. */
  aiChars: number;
  /** Rendered results block (`"\n\n"` separator and item newlines included); 0 when empty. */
  resultsChars: number;
  truncated: boolean;
}

interface MergedItem {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  engine?: EngineId;
  unresolved?: boolean;
}

interface Opts {
  n: number;
  summaryMaxChars: number;
  snippetMaxChars: number;
  outputMaxChars: number;
  cached: boolean;
  elapsedMs: number | undefined;
  perEngine: boolean;
  failedEngines: Partial<Record<EngineId, string>> | undefined;
}

const DEFAULT_N = 5;
const DEFAULT_SUMMARY_MAX_CHARS = 1200;
const DEFAULT_SNIPPET_MAX_CHARS = 140;
const DEFAULT_OUTPUT_MAX_CHARS = 2500;

/**
 * The results floor is measured with snippets this short (SPEC §8 rule 6). It is
 * a *reservation*, not a promise: the renderer still uses the caller's snippet
 * cap when the total fits.
 */
const MIN_SNIPPET = COMPACT_CAPS.fallbackSnippetMaxChars;

const AI_PREFIX = "AI: ";
/** The AI line is preceded by one newline in `render`. */
const AI_NEWLINE = 1;
/**
 * Smallest AI block worth rendering: the leading newline, the `AI: ` prefix and
 * one prose character (`…` when the budget is exactly this). A narrower block
 * would render a bare `AI: ` line — a label with no summary — so the AI is
 * dropped instead. This is the *only* reason the AI is dropped for space; it is
 * not tied to the results floor (a floor that leaves 5 chars drops the AI, and so
 * would any other way of arriving at 5).
 */
const AI_MIN_BLOCK = AI_NEWLINE + AI_PREFIX.length + 1;
/**
 * Sources may take at most this share of the AI line. The list is decoration; the
 * prose is the value, so a long source list is trimmed from the tail instead of
 * eating the summary (SPEC §8 rule 1).
 */
const AI_SOURCES_MAX_SHARE = 0.25;
const PAGE_LINE = "\npage: more results available";

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

function resolveOpts(opts: CompactOptions): Opts {
  return {
    n: clampInt(opts.n, DEFAULT_N, 1, COMPACT_CAPS.maxN),
    summaryMaxChars: clampInt(opts.summaryMaxChars, DEFAULT_SUMMARY_MAX_CHARS, 0, 100_000),
    snippetMaxChars: clampInt(opts.snippetMaxChars, DEFAULT_SNIPPET_MAX_CHARS, 0, 100_000),
    outputMaxChars: clampInt(opts.outputMaxChars, DEFAULT_OUTPUT_MAX_CHARS, 1, 1_000_000),
    cached: opts.cached === true,
    elapsedMs: typeof opts.elapsedMs === "number" && Number.isFinite(opts.elapsedMs) ? opts.elapsedMs : undefined,
    perEngine: opts.perEngine === true,
    failedEngines: opts.failedEngines,
  };
}

/** SERP text is one line per field; newlines would break the item format. */
function collapse(text: string): string {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim();
}

function safeSlice(text: string, end: number): string {
  if (end <= 0) return "";
  let cut = text.slice(0, end);
  const last = cut.charCodeAt(cut.length - 1);
  // Do not leave half of a surrogate pair behind.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Character cap with an ellipsis that counts toward the cap. */
function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${safeSlice(text, maxChars - 1).trimEnd()}…`;
}

function formatElapsed(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Suffix after the AI text; it counts toward the AI budget. */
function aiSuffix(sources: readonly string[]): string {
  return sources.length > 0 ? ` [sources: ${sources.join(", ")}]` : "";
}

/** The AI line without its leading newline; `AI_NEWLINE` is accounted separately. */
function aiLine(ai: CompactAi): string {
  return `${AI_PREFIX}${ai.text}${aiSuffix(ai.sources)}`;
}

interface FittedAi {
  ai: CompactAi | undefined;
  /** True when the summary had to lose text or sources to fit the budget. */
  cut: boolean;
}

/**
 * Keep the longest prefix of `sources` whose rendered suffix fits `budget`.
 * The suffix grows monotonically, so a prefix is the maximal choice; when even
 * the first source does not fit, the list is dropped entirely. The input array is
 * returned unchanged when nothing is dropped, which keeps `fitAi`'s `cut` flag
 * honest.
 */
function fitSources(sources: readonly string[], budget: number): string[] {
  if (sources.length === 0) return [];
  const kept: string[] = [];
  for (const source of sources) {
    if (aiSuffix([...kept, source]).length > budget) break;
    kept.push(source);
  }
  if (kept.length === sources.length) return sources as string[];
  return kept;
}

/**
 * Fit the whole AI block (prefix, text, source list, leading newline) into
 * `blockBudget` chars. Sources go first: they may take at most
 * `AI_SOURCES_MAX_SHARE` of the line, so a long list is trimmed before the prose
 * is cut (prose is the value, the list is decoration). The summary is dropped
 * entirely when the block is narrower than `AI_MIN_BLOCK` (6 chars: `\nAI: x`),
 * which is the smallest block that can carry any summary at all.
 */
function fitAi(ai: CompactAi | undefined, blockBudget: number): FittedAi {
  if (!ai) return { ai: undefined, cut: false };
  // `AI: ` with no prose would be a label, not a summary.
  if (blockBudget < AI_MIN_BLOCK) return { ai: undefined, cut: true };

  const lineBudget = blockBudget - AI_NEWLINE;
  const proseBudget = lineBudget - AI_PREFIX.length;
  const sources = fitSources(ai.sources, Math.floor(proseBudget * AI_SOURCES_MAX_SHARE));
  const textBudget = proseBudget - aiSuffix(sources).length;
  if (textBudget <= 0) return { ai: undefined, cut: true };

  const text = truncate(ai.text, textBudget);
  if (!text) return { ai: undefined, cut: true };
  return { ai: { text, sources }, cut: text !== ai.text || sources !== ai.sources };
}

/**
 * First non-empty summary wins: engines are passed in canonical order, so this
 * is deterministic. Sources are de-duplicated and capped; they are never derived
 * from the results (that would be fabrication).
 *
 * Three states (PLAN-v2 P8). An answer anywhere wins over a lead elsewhere; a
 * lead is header-only (`ai:lead`) and never gets an `AI:` line, because a lead
 * by definition has no answer prose to show.
 */
interface PickedAi {
  state: AiState;
  ai?: CompactAi;
}

/**
 * Re-derive the honest state from the text — never trust the adapter alone.
 *
 * Two promises are enforced here for *every* input (including a hand-built
 * `RawSerp` in a test or a third-party adapter): `ai:yes` means at least
 * {@link AI_ANSWER_MIN_CHARS} characters, and an echo of the query is never an
 * answer (V8.1/V8.2). An adapter that disagrees is downgraded to `lead`, which
 * is a valid, non-fabricating outcome.
 */
function aiStateOf(candidate: AiSummary, query: string): AiState {
  const declared = candidate.state;
  if (declared === "none") return "none";
  const text = collapse(candidate.text);
  if (text === "") return declared === "answer" || declared === "lead" ? "lead" : "none";
  if (text.toLowerCase() === collapse(query).toLowerCase()) return "lead";
  if (text.length < AI_ANSWER_MIN_CHARS) return "lead";
  return "answer";
}

function pickAi(serps: readonly RawSerp[], summary: number, query: string): PickedAi {
  let lead = false;
  for (const serp of serps) {
    const candidate: AiSummary | undefined = serp.ai;
    if (!candidate) continue;
    const state = aiStateOf(candidate, query);
    if (state === "none") continue;
    if (state === "lead") {
      lead = true;
      continue;
    }

    const text = truncate(collapse(candidate.text), summary);
    if (!text) {
      lead = true;
      continue;
    }

    const sources: string[] = [];
    for (const source of candidate.sources) {
      const clean = truncate(collapse(source), COMPACT_CAPS.sourceMaxChars);
      if (!clean || sources.includes(clean)) continue;
      sources.push(clean);
      if (sources.length >= COMPACT_CAPS.maxAiSources) break;
    }
    return { state: "answer", ai: { text, sources, state: "answer" } };
  }
  return lead ? { state: "lead" } : { state: "none" };
}

function renderItem(item: CompactItem, index: number): string {
  const tag = item.engine ? `[${item.engine}] ` : "";
  const name = item.title ? `${tag}${item.title}` : tag.trim();
  const heading = name ? `${name} — ${item.domain}` : item.domain;
  const marker = item.unresolved === true ? " (unresolved)" : "";
  const lines = [`${index + 1}. ${heading}`, `   ${item.url}${marker}`];
  if (item.snippet) lines.push(`   ${item.snippet}`);
  return lines.join("\n");
}

function jsonItem(item: CompactItem): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: item.title,
    url: item.url,
    domain: item.domain,
    snippet: item.snippet,
  };
  if (item.engine) out.engine = item.engine;
  if (item.unresolved === true) out.unresolved = true;
  return out;
}

/**
 * Merge, rank and cap raw SERPs into the compact contract.
 *
 * Budget policy ("AI must not starve results", PLAN V3.5 / SPEC §8 rule 1):
 *
 *   outputMaxChars = header + page marker
 *                  + AI block (≤ min(summaryMaxChars, leftover))
 *                  + results (floor reserved first, then rendered at 140)
 *
 * The results floor (n items with MIN_SNIPPET=100, titles and full URLs intact)
 * is reserved *before* the AI is capped. The old order (AI first, results
 * second) let a 1200-char overview shrink n=5 down to four results on a
 * 2500-char budget, which breaks V3.5. Now a SERP with at least n items plus an
 * AI summary still renders exactly n items whenever the floor fits; the summary
 * absorbs the loss and its own budget may collapse to 0.
 *
 * Within the results budget the order of loss is snippet width (140 → 100) →
 * whole tail results. A URL is never truncated; an item that cannot fit is
 * dropped intact. When even the floor does not fit, the AI budget is 0 and the
 * list is honestly shorter.
 *
 * Inside the AI block the order of loss is source list (trimmed from the tail to
 * at most a quarter of the line) → prose (cut with an ellipsis) → the whole
 * block, the last only when the block budget is smaller than `AI_MIN_BLOCK` = 6
 * chars (`\nAI: x`). That threshold is about the block's own shape, not about the
 * results floor, and it does not depend on the default caps.
 *
 * Measured at the defaults (cap 2500, `summaryMaxChars` 1200; evidence/P2-A):
 * medium SERP — n=5: 2482 chars with AI (aiChars 1199), 1282 without AI;
 * n=10: 2500 with AI (aiChars 368), 2131 without AI. Worst-case unit fixture
 * (140-char titles, 180-215-char URLs): 5 items + 157-char AI block = 2500.
 * Without AI there is no 1300-char ceiling: results use the whole cap.
 */
export function compactSerps(serps: readonly RawSerp[], options: CompactOptions): CompactResult {
  const opts = resolveOpts(options);
  const input = serps ?? [];

  const contributing = ENGINE_IDS.filter((id) => input.some((serp) => serp.engine === id));
  const mixed = contributing.length > 1;
  const engineLabel = contributing.length === 0 ? "none" : contributing.join("+");
  const query = collapse(input[0]?.query ?? "");
  const degraded = input.some((serp) => serp.degraded === true);

  const merged = new Map<string, MergedItem>();
  for (const serp of input) {
    for (const raw of serp.results) {
      if (raw.isAd === true) continue;
      const href = typeof raw.url === "string" ? raw.url.trim() : "";
      if (!href || !isHttpUrl(href)) continue;
      const normalized = normalizeUrl(href);
      if (!normalized) continue;

      const title = truncate(collapse(raw.title), COMPACT_CAPS.titleMaxChars);
      const snippet = truncate(collapse(raw.snippet), opts.snippetMaxChars);
      const engine = raw.engine ?? serp.engine;
      const existing = merged.get(normalized);

      if (!existing) {
        merged.set(normalized, {
          title,
          url: normalized,
          domain: domainOf(normalized),
          snippet,
          engine,
          ...(raw.unresolved === true ? { unresolved: true } : {}),
        });
        continue;
      }

      // First non-empty title wins; the longest capped snippet wins (ties keep
      // the earlier engine, so the outcome does not depend on map internals).
      if (!existing.title && title) existing.title = title;
      if (snippet.length > existing.snippet.length) existing.snippet = snippet;
      if (raw.unresolved === true) existing.unresolved = true;
    }
  }

  // Same-domain cap: the third result from one domain is deferred, not deleted.
  // It comes back only when plain results cannot fill `n`.
  const primary: MergedItem[] = [];
  const overflow: MergedItem[] = [];
  const perDomain = new Map<string, number>();
  for (const item of merged.values()) {
    const key = item.domain || item.url;
    const count = perDomain.get(key) ?? 0;
    if (count < COMPACT_CAPS.perDomainLimit) {
      primary.push(item);
      perDomain.set(key, count + 1);
    } else {
      overflow.push(item);
    }
  }

  const selected: MergedItem[] = primary.slice(0, opts.n);
  if (selected.length < opts.n) {
    selected.push(...overflow.slice(0, opts.n - selected.length));
  }

  const picked = pickAi(input, opts.summaryMaxChars, query);
  const ai = picked.ai;
  let aiState: AiState = picked.state;
  // "More on the page than we show": dedup-aware so a two-engine overlap does not
  // claim pagination that does not exist.
  const pageCarried = input.some((serp) => serp.pageCarried === true) || merged.size > opts.n;

  /** `ai:yes` is reserved for an answer; a lead says exactly that. */
  const aiLabel = (state: AiState): string => (state === "answer" ? "yes" : state === "lead" ? "lead" : "no");

  const perEngine = opts.perEngine === true;

  /** Contribution counts in canonical engine order; failed engines report `0(CODE)`. */
  const accountingFor = (items: readonly CompactItem[]): string => {
    if (!perEngine) return "";
    const parts: string[] = [];
    for (const id of ENGINE_IDS) {
      const count = items.filter((item) => item.engine === id).length;
      const code = opts.failedEngines?.[id];
      if (count > 0) parts.push(`${id}:${count}`);
      else if (code !== undefined) parts.push(`${id}:0(${code})`);
    }
    return parts.join(" ");
  };

  const headerFor = (items: readonly CompactItem[], state: AiState): string => {
    const parts = [engineLabel, `${items.length} results`, `ai:${aiLabel(state)}`];
    const accounting = accountingFor(items);
    if (accounting !== "") parts.push(accounting);
    const elapsed = formatElapsed(opts.elapsedMs);
    if (elapsed) parts.push(elapsed);
    if (opts.cached) parts.push("cached");
    if (degraded) parts.push("degraded");
    return parts.join(" · ");
  };

  const render = (items: CompactItem[], summary: CompactAi | undefined, state: AiState): string => {
    const head = [headerFor(items, state)];
    if (summary) head.push(aiLine(summary));
    let text = head.join("\n");
    if (items.length > 0) text += `\n\n${items.map(renderItem).join("\n")}`;
    if (pageCarried) text += PAGE_LINE;
    return text;
  };

  const toItem = (item: MergedItem, snippetCap: number): CompactItem => {
    const out: CompactItem = {
      title: item.title,
      url: item.url,
      domain: item.domain,
      snippet: truncate(item.snippet, snippetCap),
    };
    if (mixed || perEngine) out.engine = item.engine;
    if (item.unresolved === true) out.unresolved = true;
    return out;
  };

  const outputMaxChars = opts.outputMaxChars;
  const fallbackCap = Math.min(opts.snippetMaxChars, MIN_SNIPPET);
  const pageSuffixLen = pageCarried ? PAGE_LINE.length : 0;

  // Results floor: the exact chars needed for the selected items at MIN_SNIPPET.
  // Titles are already capped by the merge step and URLs are full, so this is an
  // honest reservation, never optimistic.
  const floorBlockLen = (items: CompactItem[]): number =>
    items.length === 0 ? 0 : `\n\n${items.map(renderItem).join("\n")}`.length;
  const resultsFloor = floorBlockLen(selected.map((item) => toItem(item, fallbackCap)));

  // `headerFor(selected.length, …)` is the widest header still possible: dropping
  // tail items only shortens the count, and `ai:lead` (7) is the widest AI label.
  const headerReserve =
    headerFor(selected.map((item) => toItem(item, fallbackCap)), "lead").length + pageSuffixLen;
  const aiBudget = Math.max(
    0,
    Math.min(opts.summaryMaxChars, outputMaxChars - headerReserve - resultsFloor),
  );

  const fitted = fitAi(ai, aiBudget);
  let aiOut = fitted.ai;
  let truncated = fitted.cut;
  // An answer that lost its space is not rendered, so the header must not claim
  // it either — a `yes` with no line under it is the original bug.
  if (aiOut === undefined) aiState = picked.state === "lead" ? "lead" : "none";

  let snippetCap = opts.snippetMaxChars;
  let shown = selected.map((item) => toItem(item, snippetCap));
  let text = render(shown, aiOut, aiState);

  // Step 1: shrink every snippet to 100 before dropping any result.
  if (text.length > outputMaxChars && snippetCap > fallbackCap) {
    snippetCap = fallbackCap;
    shown = selected.map((item) => toItem(item, snippetCap));
    text = render(shown, aiOut, aiState);
    truncated = true;
  }

  // Step 2: drop whole results from the tail. Reachable only when the floor
  // itself did not fit, in which case the AI budget was already 0.
  while (text.length > outputMaxChars && shown.length > 0) {
    shown = shown.slice(0, -1);
    text = render(shown, aiOut, aiState);
    truncated = true;
  }

  // Final safety net: only the header/page marker can still overflow (no item
  // fits), so this cuts prose — never a URL.
  if (text.length > outputMaxChars) {
    aiOut = undefined;
    aiState = "none";
    text = truncate(headerFor([], "none"), outputMaxChars);
    truncated = true;
  }

  const items = shown;
  const aiChars = aiOut ? AI_NEWLINE + aiLine(aiOut).length : 0;
  const resultsChars = items.length > 0 ? `\n\n${items.map(renderItem).join("\n")}`.length : 0;
  const data: Record<string, unknown> = {
    engine: engineLabel,
    query,
    results: items.map(jsonItem),
    pageCarried,
    chars: text.length,
    truncated,
  };
  if (perEngine) {
    const counts: Record<string, number> = {};
    for (const id of ENGINE_IDS) {
      const count = items.filter((item) => item.engine === id).length;
      if (count > 0 || opts.failedEngines?.[id] !== undefined) counts[id] = count;
    }
    data.perEngine = counts;
    const failed = opts.failedEngines;
    if (failed !== undefined && Object.keys(failed).length > 0) data.failedEngines = { ...failed };
  }
  if (aiOut) data.ai = { text: aiOut.text, sources: [...aiOut.sources], state: "answer" };
  if (aiState === "lead") data.aiState = "lead";
  if (degraded) data.degraded = true;
  if (opts.cached) data.cached = true;

  const result: CompactResult = {
    engineLabel,
    aiState,
    items,
    pageCarried,
    degraded,
    cached: opts.cached,
    text,
    data,
    chars: text.length,
    aiChars,
    resultsChars,
    truncated,
  };
  if (aiOut) result.ai = aiOut;
  return result;
}
