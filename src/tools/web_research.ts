/**
 * `web_research` — deferred multi-step evidence gathering (SPEC §7.4, PLAN P6-A).
 *
 * One call replaces a hand-written search→read→search loop. The tool owns four
 * things and nothing else:
 *
 * 1. **Budgets.** quick 1 search + 2 reads, normal 2 + 4, deep 4 + 8. They are
 *    hard ceilings: the loop stops at the budget, at `next: "stop"`, when the
 *    coverage judge says the evidence is enough, or when the token cap cannot
 *    hold another excerpt. The per-round read share (`ceil(readsLeft/roundsLeft)`)
 *    is what keeps a later search round from finding all reads already spent.
 * 2. **The loop.** search → triage → read top-k → coverage → refine/stop. Triage
 *    and coverage come from the injected `Reflex` only when
 *    `config.reflex.enabled` is true; otherwise the fixed order and the
 *    deterministic "no new domains" rule apply and no model is consulted at all
 *    (V6.3). A throwing reflex always falls back to the fixed path.
 * 3. **The evidence bundle.** Every claim cites a URL that a search actually
 *    returned; citations are de-duplicated by `normalizeUrl`; domains are derived
 *    from those URLs, never invented. Claims are extracted from the read text
 *    (the lead sentence), so the main model still writes the final answer.
 * 4. **The hard cap.** The rendered text can never exceed `outputMaxChars`
 *    (default 2500). Loss order: tail excerpts → tail sources → tail claims; a
 *    URL is never cut in half. `truncated` reports every cut.
 *
 * Side effects are behind the two injected seams (`search`, `read`). The default
 * seams call the sibling tools, which already own the browser, the cache, the
 * limiter, the SSRF guard and the reflex read gate — this module never touches
 * `deps.cdp`, so an abort cannot leak a page acquisition here. Every failure
 * leaves through `renderToolFailure` with a code, a stage and a hint; `execute`
 * never throws at the agent.
 */

import { Type, type Static } from "typebox";

import type { EngineId } from "../engines/types.ts";
import { ENGINE_IDS } from "../engines/types.ts";
import { domainOf, normalizeUrl } from "../extract/urls.ts";
import { hasExactTerm, queryTerms, tokenize } from "../reflex/rules.ts";
import type { Candidate, CoverageNext, CoverageVerdict, Evidence } from "../reflex/types.ts";
import type { ErrorCode, FailureDetails, Stage } from "../runtime/error-codes.ts";
import { isWebSearchError } from "../runtime/error-codes.ts";
import { fail, renderToolFailure, toFailure } from "../runtime/errors.ts";
import type { FailureFallback, FailureJson, ToolTextBlock } from "../runtime/errors.ts";
import type { ResolveHost } from "../runtime/ssrf.ts";
import type { ToolDeps } from "./types.ts";
import { createWebReadTool } from "./web_read.ts";
import { createWebSearchTool } from "./web_search.ts";

// ---------------------------------------------------------------------------
// Input schema + budgets
// ---------------------------------------------------------------------------

const budgetSchema = Type.Union([
  Type.Literal("quick"),
  Type.Literal("normal"),
  Type.Literal("deep"),
]);

/** SPEC §7.4 / D5. `budget` is optional and defaults to `normal`. */
export const webResearchSchema = Type.Object({
  q: Type.String({ minLength: 1 }),
  budget: Type.Optional(budgetSchema),
});

export type WebResearchInput = Static<typeof webResearchSchema>;

export const RESEARCH_BUDGETS = {
  quick: { searches: 1, reads: 2 },
  normal: { searches: 2, reads: 4 },
  deep: { searches: 4, reads: 8 },
} as const satisfies Record<string, { searches: number; reads: number }>;

export type ResearchBudget = keyof typeof RESEARCH_BUDGETS;

export interface ResearchBudgetSpec {
  /** Search calls the loop may issue. */
  searches: number;
  /** Page reads the loop may attempt (a failed read still costs a slot). */
  reads: number;
}

// ---------------------------------------------------------------------------
// Evidence bundle
// ---------------------------------------------------------------------------

export interface ResearchClaim {
  /** One extracted sentence; the tool never invents a claim. */
  text: string;
  /** Primary citation, always a URL that appeared in the search results. */
  sourceUrl: string;
  /** All URLs that support this claim (corroboration across reads). */
  citations: string[];
}

export interface ResearchCitation {
  url: string;
  title?: string;
  domain: string;
}

export interface ResearchExcerpt {
  /** The result URL the excerpt was read from (never the redirect target). */
  url: string;
  excerpt: string;
}

export interface ResearchEvidence {
  claims: ResearchClaim[];
  citations: ResearchCitation[];
  excerpts: ResearchExcerpt[];
}

export interface ResearchCoverage {
  enough: boolean;
  next: CoverageNext;
}

export interface ResearchDetails {
  budget: ResearchBudget;
  /** Search calls made (never above the budget). */
  searches: number;
  /** Reads attempted, including ones that failed (never above the budget). */
  reads: number;
  /** Unique results seen across every round, after URL de-duplication. */
  results: number;
  /** Citations present in the rendered bundle. */
  citations: number;
  chars: number;
  truncated: boolean;
  coverage: ResearchCoverage;
  /** The rendered bundle in structured form (text may show a subset). */
  evidence: ResearchEvidence;
  /** Set when a later search/read failed but earlier evidence was still returned. */
  error?: { code: ErrorCode; stage: Stage };
}

export interface WebResearchSuccess {
  content: ToolTextBlock[];
  details: ResearchDetails;
}

export interface WebResearchFailure {
  content: ToolTextBlock[];
  details: FailureJson;
  isError: true;
}

export type WebResearchResult = WebResearchSuccess | WebResearchFailure;

/** The object shape pi registers (P6 wires it into `createTools`). */
export interface WebResearchTool {
  name: "web_research";
  label: string;
  description: string;
  parameters: typeof webResearchSchema;
  exposure: "deferred";
  annotations: { readOnlyHint: true; openWorldHint: true; idempotentHint: true };
  execute(
    toolCallId: string,
    params: WebResearchInput,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx?: unknown,
  ): Promise<WebResearchResult>;
}

/**
 * Kept short on purpose: the deferred surface still shares the 900-char prompt
 * budget with the three sibling tools, so every word here costs tokens.
 */
export const WEB_RESEARCH_DESCRIPTION =
  "Research in the user's Chrome: search, triage, read top pages, return claims with citations and excerpts. Budgets quick 1+2, normal 2+4, deep 4+8.";

// ---------------------------------------------------------------------------
// Injected seams (offline tests never touch a socket)
// ---------------------------------------------------------------------------

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Set when the engine is known per item; otherwise `SearchOutcome.engines[0]` applies. */
  engine?: EngineId;
}

export interface SearchOutcome {
  query: string;
  hits: SearchHit[];
  /** Engines that produced the SERP, in try order. Used for triage labelling. */
  engines: EngineId[];
}

/** One SERP request. Tests inject a recorder; production calls `web_search`. */
export type SearchSeam = (
  q: string,
  n: number,
  signal?: AbortSignal,
  ctx?: unknown,
) => Promise<SearchOutcome>;

export interface ReadOutcome {
  /** Final URL after redirects (advisory; the citation stays on the result URL). */
  url: string;
  title?: string;
  text: string;
}

/** One page read. Tests inject a fixture; production calls `web_read`. */
export type ReadSeam = (
  url: string,
  maxChars: number,
  signal?: AbortSignal,
  ctx?: unknown,
) => Promise<ReadOutcome>;

export interface WebResearchOptions {
  search?: SearchSeam;
  read?: ReadSeam;
  /**
   * Override the hard output cap. Production reads
   * `config.search.outputMaxChars` (2500): there is deliberately no second
   * `research.*` config block, so the token budget stays in one place (SPEC §8).
   */
  maxOutputChars?: number;
  /**
   * Injectable DNS resolver for the default read seam's SSRF guard, the same
   * hook `web_read` exposes. Production leaves it unset; an offline test of the
   * default seams must set it so no socket can be opened.
   */
  resolve?: ResolveHost;
}

// ---------------------------------------------------------------------------
// Caps and constants
// ---------------------------------------------------------------------------

/** Title/snippet widths used only to label candidates, not to render them. */
const TITLE_MAX_CHARS = 200;
const SNIPPET_MAX_CHARS = 300;

/** A claim is a lead sentence: shorter is a fragment, longer is a paragraph. */
const CLAIM_MIN_CHARS = 30;
const CLAIM_MAX_CHARS = 200;
const MAX_CLAIM_CITATIONS = 3;

/** Excerpts are the bulk of the bundle; they get half of the hard cap. */
const EXCERPT_BUDGET_SHARE = 0.5;
/** Smaller than this an excerpt cannot carry a lead sentence — do not spend a read. */
const MIN_USEFUL_EXCERPT = 80;
const EXCERPT_MIN_RENDER = 40;

/** Refinement: append up to this many distinctive terms from the current SERP. */
const REFINE_TERMS = 2;
const REFINE_MAX_CHARS = 160;

const INPUT_HINT = "check the web_research arguments: q (non-empty), budget quick|normal|deep";

// ---------------------------------------------------------------------------
// Input normalization (execute is a public surface: re-validate everything)
// ---------------------------------------------------------------------------

interface NormalizedInput {
  q: string;
  budget: ResearchBudget;
}

type Validation = { ok: true; value: NormalizedInput } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBudget(value: unknown): value is ResearchBudget {
  return value === "quick" || value === "normal" || value === "deep";
}

function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

function normalizeInput(raw: unknown): Validation {
  if (!isRecord(raw)) return { ok: false, message: "arguments: expected an object" };

  const q = raw.q;
  if (typeof q !== "string") return { ok: false, message: "q: expected a string" };
  const text = q.trim();
  if (text === "") return { ok: false, message: "q: expected a non-empty query (after trimming whitespace)" };

  if (raw.budget !== undefined && !isBudget(raw.budget)) {
    return { ok: false, message: `budget: expected quick|normal|deep, got ${JSON.stringify(raw.budget)}` };
  }

  return { ok: true, value: { q: text, budget: isBudget(raw.budget) ? raw.budget : "normal" } };
}

// ---------------------------------------------------------------------------
// Small text helpers (compaction owns its own copies; these are research-only)
// ---------------------------------------------------------------------------

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function safeSlice(text: string, end: number): string {
  if (end <= 0) return "";
  const cut = text.slice(0, end);
  const last = cut.charCodeAt(cut.length - 1);
  // Do not leave half a surrogate pair behind.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${safeSlice(text, maxChars - 1).trimEnd()}…`;
}

/** Query identity for de-duplication: case and whitespace do not matter. */
function queryKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Failure mapping (same taxonomy as web_search)
// ---------------------------------------------------------------------------

function failureResult(error: unknown, fallback: FailureFallback): WebResearchFailure {
  const details: FailureDetails = isWebSearchError(error)
    ? error.details
    : toFailure(error, fallback);
  const rendered = renderToolFailure("web_research", details);
  return { content: rendered.content, details: rendered.details, isError: true };
}

/**
 * Anything a dependency throws becomes a taxonomy error. An abort wins over the
 * dependency's shape because `signal.reason` may be any value; a
 * `WebSearchError` already carries a precise code/stage.
 */
function asFailure(error: unknown, stage: Stage, signal?: AbortSignal): WebSearchErrorLike {
  if (signal?.aborted === true && !isWebSearchError(error)) {
    return fail("E_CANCELLED", stage, { message: "aborted by the caller" });
  }
  if (isWebSearchError(error)) return error;
  const details = toFailure(error, { code: "E_CDP_DISCONNECTED", stage });
  return fail(details.code, details.stage, {
    ...(details.engine === undefined ? {} : { engine: details.engine }),
    ...(details.wall === undefined ? {} : { wall: details.wall }),
    ...(details.artifact === undefined ? {} : { artifact: details.artifact }),
    ...(details.message === undefined ? {} : { message: details.message }),
    ...(details.hint === undefined ? {} : { hint: details.hint }),
  });
}

/** Alias so the module does not import the class just for a return type. */
type WebSearchErrorLike = ReturnType<typeof fail>;

function cancelled(stage: Stage): WebSearchErrorLike {
  return fail("E_CANCELLED", stage, { message: "aborted by the caller" });
}

/** Rebuild a taxonomy error from a sibling tool's JSON details (hint comes from the code). */
function rethrowSibling(details: FailureJson): WebSearchErrorLike {
  return fail(details.code, details.stage, {
    ...(details.engine === undefined ? {} : { engine: details.engine }),
    ...(details.wall === undefined ? {} : { wall: details.wall }),
    ...(details.artifact === undefined ? {} : { artifact: details.artifact }),
    ...(details.message === undefined ? {} : { message: details.message }),
  });
}

// ---------------------------------------------------------------------------
// Default seams: the sibling tools, parsed back into structured data
// ---------------------------------------------------------------------------

/**
 * `web_search`'s public result is rendered text, not objects. The `json` view is
 * a stable contract (`extract/compact.ts`), so the research seam parses exactly
 * that envelope instead of re-implementing the engine chain. A payload that no
 * longer matches is `E_PARSE`, never a silent zero-result search.
 */
function parseSearchPayload(text: string, engines: readonly EngineId[]): SearchHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail("E_PARSE", "extract", { message: "web_search returned a non-JSON payload to web_research" });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    throw fail("E_PARSE", "extract", { message: "web_search JSON payload has no results array" });
  }

  const hits: SearchHit[] = [];
  for (const raw of parsed.results) {
    if (!isRecord(raw)) continue;
    const url = typeof raw.url === "string" ? raw.url : "";
    if (normalizeUrl(url) === null) continue;
    const hit: SearchHit = {
      title: typeof raw.title === "string" ? raw.title : "",
      url,
      snippet: typeof raw.snippet === "string" ? raw.snippet : "",
    };
    const engine = isEngineId(raw.engine) ? raw.engine : engines[0];
    if (engine !== undefined) hit.engine = engine;
    hits.push(hit);
  }
  return hits;
}

function createSearchSeam(getDeps: (ctx?: unknown) => ToolDeps | Promise<ToolDeps>): SearchSeam {
  const tool = createWebSearchTool(getDeps);
  return async (q, n, signal, ctx) => {
    const result = await tool.execute(
      "web_research",
      { q, n, summary: true, format: "json" },
      signal,
      undefined,
      ctx,
    );
    // `isError` exists only on the failure shape; the success type has no such key.
    if ("isError" in result) throw rethrowSibling(result.details);
    const text = result.content.map((block) => block.text).join("\n");
    return { query: q, hits: parseSearchPayload(text, result.details.engines), engines: result.details.engines };
  };
}

function createReadSeam(
  getDeps: (ctx?: unknown) => ToolDeps | Promise<ToolDeps>,
  resolve: ResolveHost | undefined,
): ReadSeam {
  const tool = createWebReadTool(getDeps, resolve === undefined ? {} : { resolve });
  return async (url, maxChars, signal, ctx) => {
    const result = await tool.execute(
      "web_research",
      { url, maxChars, format: "md" },
      signal,
      undefined,
      ctx,
    );
    // `isError` exists only on the failure shape; the success type has no such key.
    if ("isError" in result) throw rethrowSibling(result.details);
    const text = result.content.map((block) => block.text).join("\n");
    if (text.trim() === "") {
      throw fail("E_UNSUPPORTED", "read", { message: "the page produced no readable text" });
    }
    return {
      url: result.details.finalUrl,
      title: result.details.title,
      text,
    };
  };
}

// ---------------------------------------------------------------------------
// Loop state
// ---------------------------------------------------------------------------

interface SeenResult {
  /** Normalized URL: the citation identity and the dedup key. */
  url: string;
  title: string;
  snippet: string;
  domain: string;
  engine: EngineId;
}

interface ReadRecord {
  url: string;
  title: string;
  /** Full read text, line structure preserved so claims can skip headings. */
  text: string;
  /** Bounded one-line window used in the bundle. */
  excerpt: string;
}

interface LoopState {
  seen: Map<string, SeenResult>;
  domains: Set<string>;
  /** URLs added by the current search round (read these before leftovers). */
  roundUrls: Set<string>;
  read: Set<string>;
  reads: ReadRecord[];
  searches: number;
  readCount: number;
  lastError?: { code: ErrorCode; stage: Stage };
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

function resolveCap(deps: ToolDeps, override: number | undefined): number {
  const raw = override ?? deps.config.search.outputMaxChars;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 2500;
  return Math.min(1_000_000, Math.max(1, value));
}

/** Number of reads the current round may spend, so later rounds keep their share. */
function readShare(readsLeft: number, roundsLeft: number): number {
  if (readsLeft <= 0) return 0;
  return Math.max(1, Math.ceil(readsLeft / Math.max(1, roundsLeft)));
}

/** Ask for a few more results than reads so triage has something to choose from. */
function searchN(deps: ToolDeps, share: number): number {
  const nMax = Math.min(10, Math.max(1, Math.floor(deps.config.search.nMax)));
  const configured = Number.isFinite(deps.config.search.n) ? Math.floor(deps.config.search.n) : 5;
  return Math.min(nMax, Math.max(3, configured, share));
}

// ---------------------------------------------------------------------------
// Search merge + triage
// ---------------------------------------------------------------------------

/** Merge one SERP into the pool; returns how many *new* domains it contributed. */
function mergeOutcome(state: LoopState, outcome: SearchOutcome): number {
  state.roundUrls.clear();
  const newDomains = new Set<string>();

  for (const hit of outcome.hits) {
    const url = normalizeUrl(hit.url);
    if (url === null) continue;
    const domain = domainOf(url);
    if (domain === "") continue;
    if (state.seen.has(url)) continue;

    const engine = hit.engine ?? outcome.engines[0] ?? "google";
    state.seen.set(url, {
      url,
      title: truncate(collapse(hit.title), TITLE_MAX_CHARS),
      snippet: truncate(collapse(hit.snippet), SNIPPET_MAX_CHARS),
      domain,
      engine,
    });
    state.roundUrls.add(url);
    if (!state.domains.has(domain)) {
      state.domains.add(domain);
      newDomains.add(domain);
    }
  }
  return newDomains.size;
}

function toCandidate(item: SeenResult): Candidate {
  return { title: item.title, url: item.url, snippet: item.snippet, engine: item.engine };
}

/** Integer indices that address the candidate list, de-duplicated, in caller order. */
function sanitizeKeep(keep: unknown, length: number): number[] {
  if (!Array.isArray(keep)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of keep) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 0 || value >= length || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * The candidates to read this round, best first. Current-round results come
 * before leftovers from earlier queries, because the rewritten query is the tool's
 * best guess at what is still missing.
 *
 * Triage is advisory: an exception, an empty keep list or a malformed verdict
 * falls back to the fixed order (`first k`), so a broken reflex can never turn a
 * working search into zero reads.
 */
async function pickCandidates(
  query: string,
  state: LoopState,
  k: number,
  reflexOn: boolean,
  deps: ToolDeps,
): Promise<Candidate[]> {
  if (k <= 0) return [];
  const unread = [...state.seen.values()].filter((item) => !state.read.has(item.url));
  const fresh = unread.filter((item) => state.roundUrls.has(item.url));
  const stale = unread.filter((item) => !state.roundUrls.has(item.url));
  const ordered = [...fresh, ...stale];
  if (ordered.length === 0) return [];
  const candidates = ordered.map(toCandidate);

  let keep = candidates.map((_, index) => index).slice(0, k);
  if (reflexOn && deps.reflex !== undefined) {
    try {
      const verdict = await deps.reflex.triage(query, candidates);
      const requested = sanitizeKeep(verdict?.keep, candidates.length);
      if (requested.length > 0) keep = requested.slice(0, k);
    } catch {
      // Fail-open: the fixed order is the budget, not a guess.
    }
  }
  return keep.map((index) => candidates[index]!);
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function isCoverageVerdict(value: unknown): value is CoverageVerdict {
  if (!isRecord(value) || typeof value.enough !== "boolean") return false;
  const next = value.next;
  return next === "refine" || next === "read_more" || next === "stop";
}

/**
 * Deterministic coverage judge, used when `reflex.enabled` is false (and as the
 * fail-open fallback). It is the SPEC §9.2 rule in its cheap form:
 *
 * - two independent domains plus one page that actually carries a query term is
 *   enough;
 * - no evidence at all means "read more";
 * - a round that contributed no new domain means refining would repeat the same
 *   result set, so stop (the PLAN P5-B "no new domains" rule);
 * - one domain or an off-target result set asks for a refinement.
 */
function fixedCoverage(query: string, evidence: readonly Evidence[], newDomains: number): CoverageVerdict {
  const domains = new Set<string>();
  let termHit = false;

  for (const item of evidence) {
    const domain = domainOf(item.url);
    if (domain !== "") domains.add(domain);
    if (hasExactTerm(query, `${item.title ?? ""} ${item.excerpt ?? ""}`)) termHit = true;
  }

  if (domains.size >= 2 && termHit) return { enough: true, next: "stop" };
  if (evidence.length === 0) return { enough: false, next: "read_more" };
  if (newDomains === 0) return { enough: false, next: "stop" };
  if (domains.size < 2) return { enough: false, next: "read_more" };
  return { enough: false, next: "refine" };
}

function evidenceOf(state: LoopState): Evidence[] {
  return state.reads.map((record) => ({
    url: record.url,
    ...(record.title === "" ? {} : { title: record.title }),
    excerpt: record.excerpt,
  }));
}

async function judgeCoverage(
  query: string,
  state: LoopState,
  newDomains: number,
  reflexOn: boolean,
  deps: ToolDeps,
): Promise<CoverageVerdict> {
  const evidence = evidenceOf(state);
  if (reflexOn && deps.reflex !== undefined) {
    try {
      const verdict = await deps.reflex.coverage(query, evidence);
      if (isCoverageVerdict(verdict)) return verdict;
    } catch {
      // Fail-open: the fixed rule is the floor.
    }
  }
  return fixedCoverage(query, evidence, newDomains);
}

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

/**
 * Rewrite the query once by appending up to two distinctive terms from the SERP
 * that the query does not already contain. This is honest expansion (the terms
 * come from real titles/snippets), not a model invention. Returns null when no
 * new term exists or the result was already tried, which makes the loop stop
 * instead of hammering an identical query.
 */
function refineQuery(
  original: string,
  hits: readonly SearchHit[],
  tried: ReadonlySet<string>,
): string | null {
  const known = new Set(tokenize(original));
  const terms: string[] = [];

  for (const hit of hits) {
    for (const term of queryTerms(`${hit.title} ${hit.snippet}`)) {
      if (term.length < 4 || known.has(term) || terms.includes(term)) continue;
      terms.push(term);
      if (terms.length >= REFINE_TERMS) break;
    }
    if (terms.length >= REFINE_TERMS) break;
  }
  if (terms.length === 0) return null;

  const next = `${original} ${terms.join(" ")}`.slice(0, REFINE_MAX_CHARS).trim();
  const key = queryKey(next);
  if (key === queryKey(original) || tried.has(key)) return null;
  return next;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const SKIPPED_LINE = /^[#>*|!]|^\d+[.)]\s|^[-+*]\s/;

/**
 * The lead sentence of a readable document: skip headings, lists, quotes and
 * tables, then take the first sentence long enough to say something. A page that
 * yields nothing contributes no claim — the bundle never pads with fabrication.
 */
function leadSentence(text: string): string | null {
  for (const line of text.split(/\n+/)) {
    const clean = line.trim();
    if (clean === "" || SKIPPED_LINE.test(clean)) continue;
    for (const part of clean.split(/(?<=[.!?…])\s+/u)) {
      const sentence = collapse(part);
      if (sentence.length < CLAIM_MIN_CHARS) continue;
      return truncate(sentence, CLAIM_MAX_CHARS);
    }
  }
  return null;
}

function snippetClaim(item: SeenResult): string | null {
  const text = collapse(item.snippet);
  if (text.length < CLAIM_MIN_CHARS) return null;
  return truncate(text, CLAIM_MAX_CHARS);
}

/**
 * One claim per read page, corroboration merged when two pages agree word for
 * word. When no page produced a claim (every read failed, or the text was pure
 * navigation), snippets from the SERP stand in — they are still real cited text.
 */
function buildClaims(state: LoopState, maxClaims: number): ResearchClaim[] {
  const claims: ResearchClaim[] = [];
  const byText = new Map<string, ResearchClaim>();

  for (const record of state.reads) {
    if (claims.length >= maxClaims) break;
    const text = leadSentence(record.text);
    if (text === null) continue;
    const key = queryKey(text);
    const existing = byText.get(key);
    if (existing !== undefined) {
      if (!existing.citations.includes(record.url) && existing.citations.length < MAX_CLAIM_CITATIONS) {
        existing.citations.push(record.url);
      }
      continue;
    }
    const claim: ResearchClaim = { text, sourceUrl: record.url, citations: [record.url] };
    byText.set(key, claim);
    claims.push(claim);
  }

  if (claims.length > 0) return claims;

  for (const item of state.seen.values()) {
    if (claims.length >= maxClaims) break;
    const text = snippetClaim(item);
    if (text === null) continue;
    const key = queryKey(text);
    if (byText.has(key)) continue;
    const claim: ResearchClaim = { text, sourceUrl: item.url, citations: [item.url] };
    byText.set(key, claim);
    claims.push(claim);
  }
  return claims;
}

function buildBundle(state: LoopState, maxClaims: number): ResearchEvidence {
  const claims = buildClaims(state, maxClaims);

  const cited = new Set<string>();
  for (const claim of claims) for (const url of claim.citations) cited.add(url);
  for (const record of state.reads) cited.add(record.url);

  const citations: ResearchCitation[] = [];
  for (const url of cited) {
    const item = state.seen.get(url);
    if (item === undefined) continue;
    citations.push({
      url: item.url,
      ...(item.title === "" ? {} : { title: item.title }),
      domain: item.domain,
    });
  }

  return {
    claims,
    citations,
    excerpts: state.reads.map((record) => ({ url: record.url, excerpt: record.excerpt })),
  };
}

// ---------------------------------------------------------------------------
// Hard-cap renderer
// ---------------------------------------------------------------------------

interface FittedBundle {
  text: string;
  evidence: ResearchEvidence;
  truncated: boolean;
}

/**
 * Render the bundle into `cap` characters. Priority is header → claims → sources
 * → excerpts: losing an excerpt costs raw context, losing a claim or a source
 * costs the answer. A block is only appended whole, so a URL is never cut in
 * half; the final cut can only ever apply to the header (a cap smaller than the
 * header), which carries no URL.
 */
function renderBundle(header: string, bundle: ResearchEvidence, cap: number): FittedBundle {
  const claims: ResearchClaim[] = [];
  const citations: ResearchCitation[] = [];
  const excerpts: ResearchExcerpt[] = [];
  let text = header;
  let truncated = false;

  const append = (block: string): boolean => {
    if (text.length + block.length > cap) return false;
    text += block;
    return true;
  };

  if (bundle.claims.length > 0) {
    if (!append("\nclaims:")) {
      truncated = true;
    } else {
      for (const claim of bundle.claims) {
        const line = `\n${claims.length + 1}. ${claim.text} [${claim.sourceUrl}]`;
        if (!append(line)) {
          truncated = true;
          break;
        }
        claims.push(claim);
      }
    }
  }

  if (bundle.citations.length > 0) {
    if (!append("\nsources:")) {
      truncated = true;
    } else {
      for (const citation of bundle.citations) {
        const line = `\n- ${citation.domain} — ${citation.url}`;
        if (!append(line)) {
          truncated = true;
          break;
        }
        citations.push(citation);
      }
    }
  }

  if (bundle.excerpts.length > 0) {
    if (!append("\nexcerpts:")) {
      truncated = true;
    } else {
      for (let index = 0; index < bundle.excerpts.length; index += 1) {
        const excerpt = bundle.excerpts[index]!;
        const remaining = cap - text.length;
        const left = bundle.excerpts.length - index;
        // One URL line is ~60 chars; leave room for it before sizing the body.
        const share = Math.floor(remaining / left) - 60;
        const body = truncate(excerpt.excerpt, Math.min(share, excerpt.excerpt.length));
        if (body.length < EXCERPT_MIN_RENDER || !append(`\n- ${excerpt.url}\n  ${body}`)) {
          truncated = true;
          break;
        }
        excerpts.push({ url: excerpt.url, excerpt: body });
      }
      // A shortened excerpt is still the evidence; only a dropped one is a cut.
      if (excerpts.length < bundle.excerpts.length && !truncated) truncated = true;
    }
  }

  if (text.length > cap) {
    // Reachable only when the header alone exceeds the cap: cut prose, never a URL.
    text = truncate(header, cap);
    return { text, evidence: { claims: [], citations: [], excerpts: [] }, truncated: true };
  }

  return { text, evidence: { claims, citations, excerpts }, truncated };
}

function headerOf(
  budget: ResearchBudget,
  searches: number,
  reads: number,
  results: number,
  verdict: CoverageVerdict,
): string {
  const max = RESEARCH_BUDGETS[budget];
  return `web_research · ${budget} · searches ${searches}/${max.searches} · reads ${reads}/${max.reads} · results ${results} · enough:${verdict.enough ? "yes" : "no"}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebResearchTool(
  getDeps: (ctx?: unknown) => ToolDeps | Promise<ToolDeps>,
  options: WebResearchOptions = {},
): WebResearchTool {
  let seams: { search: SearchSeam; read: ReadSeam } | undefined;
  const resolveSeams = (): { search: SearchSeam; read: ReadSeam } => {
    seams ??= {
      search: options.search ?? createSearchSeam(getDeps),
      read: options.read ?? createReadSeam(getDeps, options.resolve),
    };
    return seams;
  };

  async function execute(
    _toolCallId: string,
    params: WebResearchInput,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: unknown,
  ): Promise<WebResearchResult> {
    let deps: ToolDeps;
    try {
      deps = await getDeps(ctx);
    } catch (error) {
      return failureResult(error, { code: "E_CONFIG", stage: "config" });
    }

    // Last-resort barrier: a dependency bug still reaches the agent as a rendered
    // failure with a code and a stage, never as a bare thrown error.
    try {
      return await research(deps, params, signal, ctx);
    } catch (error) {
      return failureResult(error, { code: "E_CDP_DISCONNECTED", stage: "extract" });
    }
  }

  async function research(
    deps: ToolDeps,
    params: WebResearchInput,
    signal: AbortSignal | undefined,
    ctx: unknown,
  ): Promise<WebResearchResult> {
    const validation = normalizeInput(params);
    if (!validation.ok) {
      throw fail("E_CONFIG", "config", { hint: INPUT_HINT, message: validation.message });
    }
    const input = validation.value;
    if (signal?.aborted === true) throw cancelled("navigate");

    const spec: ResearchBudgetSpec = RESEARCH_BUDGETS[input.budget];
    const cap = resolveCap(deps, options.maxOutputChars);
    const excerptBudget = Math.floor(cap * EXCERPT_BUDGET_SHARE);
    // A read whose excerpt cannot hold a lead sentence is a wasted browser trip:
    // treat the cap as a hard read ceiling, and say so in `truncated`.
    const readLimit = Math.max(0, Math.min(spec.reads, Math.floor(excerptBudget / MIN_USEFUL_EXCERPT)));
    const capCutReads = readLimit < spec.reads;
    const excerptChars = readLimit > 0 ? Math.floor(excerptBudget / readLimit) : 0;
    const readMaxChars = Math.min(
      deps.config.read.maxCharsCeiling,
      Math.max(600, Math.max(1, excerptChars) * 3),
    );

    const { search, read } = resolveSeams();
    const reflex = deps.reflex;
    // One research call is one model budget, exactly like one `web_search`.
    reflex?.beginSearch?.();
    const reflexOn = deps.config.reflex.enabled && reflex !== undefined;
    // Read through a call: TypeScript narrows `signal?.aborted` after the first
    // guard, but the property legitimately flips while a seam is awaiting.
    const aborted = (): boolean => signal?.aborted === true;

    const state: LoopState = {
      seen: new Map(),
      domains: new Set(),
      roundUrls: new Set(),
      read: new Set(),
      reads: [],
      searches: 0,
      readCount: 0,
    };

    const tried = new Set<string>([queryKey(input.q)]);
    let query = input.q;
    let pendingSearch = true;
    let roundHits: SearchHit[] = [];
    let roundNewDomains = 0;
    let roundReadsLeft = 0;
    let verdict: CoverageVerdict = { enough: false, next: "read_more" };

    const unreadLeft = (): boolean =>
      [...state.seen.keys()].some((url) => !state.read.has(url));

    for (;;) {
      if (aborted()) throw cancelled("navigate");

      // --- search ---------------------------------------------------------
      if (pendingSearch) {
        if (state.searches >= spec.searches) break;
        const share = readShare(readLimit - state.readCount, spec.searches - state.searches);
        let outcome: SearchOutcome;
        try {
          outcome = await search(query, searchN(deps, share), signal, ctx);
        } catch (error) {
          const failure = asFailure(error, "navigate", signal);
          // The first search has no evidence to fall back on; an abort always wins.
          if (state.searches === 0 || failure.details.code === "E_CANCELLED") throw failure;
          state.lastError = { code: failure.details.code, stage: failure.details.stage };
          break;
        }
        state.searches += 1;
        roundHits = outcome.hits;
        roundNewDomains = mergeOutcome(state, outcome);
        roundReadsLeft = readShare(readLimit - state.readCount, spec.searches - state.searches + 1);
        pendingSearch = false;

        if (state.seen.size === 0) {
          throw fail("E_EMPTY", "extract", { message: "the search returned no usable results" });
        }
      }

      // --- read top-k -----------------------------------------------------
      if (readLimit > 0 && state.readCount < readLimit && roundReadsLeft > 0) {
        const k = Math.min(roundReadsLeft, readLimit - state.readCount);
        const candidates = await pickCandidates(query, state, k, reflexOn, deps);
        for (const candidate of candidates) {
          if (aborted()) throw cancelled("read");
          if (state.readCount >= readLimit) break;
          state.readCount += 1;
          roundReadsLeft -= 1;
          state.read.add(candidate.url);

          let document: ReadOutcome;
          try {
            document = await read(candidate.url, readMaxChars, signal, ctx);
          } catch (error) {
            const failure = asFailure(error, "read", signal);
            if (failure.details.code === "E_CANCELLED" || aborted()) throw failure;
            // One bad page must not fail a research call that already has evidence.
            state.lastError = { code: failure.details.code, stage: failure.details.stage };
            continue;
          }

          const raw = typeof document.text === "string" ? document.text : "";
          if (raw.trim() === "") {
            state.lastError = { code: "E_UNSUPPORTED", stage: "read" };
            continue;
          }
          const title = collapse(document.title ?? "");
          state.reads.push({
            url: candidate.url,
            title,
            text: raw,
            excerpt: truncate(collapse(raw), excerptChars),
          });
        }
      }

      // --- coverage -------------------------------------------------------
      // Judge against the user's original question, not the rewritten query:
      // a refinement borrows terms from the SERP, so scoring it would always
      // "match" the very pages that produced those terms.
      verdict = await judgeCoverage(input.q, state, roundNewDomains, reflexOn, deps);
      if (verdict.enough || verdict.next === "stop") break;
      if (state.searches >= spec.searches) break;
      if (state.readCount >= readLimit) break;
      // No new domain: refining would only re-fetch the same result set.
      if (roundNewDomains === 0) break;

      const nextQuery = refineQuery(query, roundHits, tried);
      if (nextQuery === null) {
        // The verdict may still ask for more reading from the same result set.
        if (verdict.next === "read_more" && unreadLeft()) {
          roundReadsLeft = readShare(readLimit - state.readCount, 1);
          continue;
        }
        break;
      }
      tried.add(queryKey(nextQuery));
      query = nextQuery;
      pendingSearch = true;
    }

    // --- render -----------------------------------------------------------
    const bundle = buildBundle(state, readLimit > 0 ? Math.max(1, readLimit) : 1);
    const fitted = renderBundle(
      headerOf(input.budget, state.searches, state.readCount, state.seen.size, verdict),
      bundle,
      cap,
    );

    const details: ResearchDetails = {
      budget: input.budget,
      searches: state.searches,
      reads: state.readCount,
      results: state.seen.size,
      citations: fitted.evidence.citations.length,
      chars: fitted.text.length,
      truncated: fitted.truncated || capCutReads,
      coverage: { enough: verdict.enough, next: verdict.next },
      evidence: fitted.evidence,
      ...(state.lastError === undefined ? {} : { error: state.lastError }),
    };

    // A log row is observability, not a dependency: a read-only agent dir must
    // never fail research that already answered.
    void deps.log
      .write({
        kind: "research",
        budget: details.budget,
        searches: details.searches,
        reads: details.reads,
        results: details.results,
        citations: details.citations,
        chars: details.chars,
        truncated: details.truncated,
        enough: details.coverage.enough,
      })
      .catch(() => undefined);

    return { content: [{ type: "text", text: fitted.text }], details };
  }

  return {
    name: "web_research",
    label: "Web Research",
    description: WEB_RESEARCH_DESCRIPTION,
    parameters: webResearchSchema,
    exposure: "deferred",
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    execute,
  };
}
