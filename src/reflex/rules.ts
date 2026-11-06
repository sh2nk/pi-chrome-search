/**
 * Deterministic System 1 fallback (SPEC §9.2, PLAN P5-B).
 *
 * `rules.ts` is the layer that always works: no model, no network, no clock, no
 * randomness. It is used when `reflex.enabled` is false (the default), when the
 * classifier abstains, and when a budget is exhausted. It is also the bench
 * baseline, so its output must be reproducible byte for byte: the same query
 * and candidates always yield the same `keep`/`scores`/`flags`.
 *
 * The heuristics are deliberately conservative. Triage never returns an empty
 * keep list for a non-empty SERP (recall loss is measured in V5.6, and losing
 * every result on a rules fallback would be a worse failure than showing one
 * weak hit). Spam and duplicate flags are advisory, never a security gate.
 */

import type { EngineId, Freshness } from "../engines/types.ts";
import { domainOf, stableQueryKey } from "../extract/urls.ts";
import type {
  Candidate,
  CoverageNext,
  CoverageVerdict,
  Evidence,
  Reflex,
  Route,
  TriageResult,
} from "./types.ts";

/** `model` value written to decisions.jsonl when rules produced the verdict. */
export const RULES_MODEL = "rules";

/** Mirrors `DEFAULT_CONFIG.reflex.triage.keep`. The caller may override it. */
export const DEFAULT_TRIAGE_KEEP = 6;

/** Evidence count at which coverage stops asking for more reads. */
export const MAX_COVERAGE_READS = 5;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * BM25 raw scores are small (≈0.05–1.5 per matched term) because idf is
 * corpus-relative. The 0–5 relevance scale is a display/bench contract, so the
 * raw score is multiplied before rounding. Tuned on `bench/` (P5-A), not by
 * feel; it only affects the reported score, never the `keep` order.
 */
const SCORE_SCALE = 2;

/** Function words that carry no topical signal in an EN/RU search query. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "can", "could", "did",
  "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into",
  "is", "it", "its", "me", "my", "of", "on", "or", "our", "should", "so", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "to",
  "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
  "а", "без", "бы", "был", "была", "были", "быть", "в", "во", "вот", "все", "всё",
  "вы", "где", "да", "для", "до", "его", "ее", "её", "если", "есть", "же", "за",
  "и", "из", "или", "им", "их", "к", "как", "ко", "когда", "кто", "ли", "мне",
  "может", "мы", "на", "над", "не", "него", "нее", "неё", "нет", "ни", "но", "о",
  "об", "он", "она", "они", "оно", "от", "по", "под", "при", "про", "с", "со",
  "так", "там", "то", "только", "у", "уже", "чего", "чем", "что", "чтобы", "это",
  "я",
]);

/**
 * Hosts worth a relevance bonus: primary sources, docs and code. Suffix match, so
 * `docs.python.org` hits `python.org` and `en.wikipedia.org` hits `wikipedia.org`.
 */
const ALLOW_HOST_SUFFIXES: readonly string[] = [
  "wikipedia.org",
  "wikidata.org",
  "wikimedia.org",
  "arxiv.org",
  "github.com",
  "gitlab.com",
  "stackoverflow.com",
  "stackexchange.com",
  "superuser.com",
  "serverfault.com",
  "nodejs.org",
  "npmjs.com",
  "python.org",
  "mozilla.org",
  "rust-lang.org",
  "go.dev",
  "kubernetes.io",
  "docker.com",
  "postgresql.org",
  "sqlite.org",
  "redis.io",
  "rfc-editor.org",
  "ietf.org",
  "w3.org",
  "unicode.org",
  "kernel.org",
  "gnu.org",
  "readthedocs.io",
];

/** Ad/affiliate/shortener hosts: a read gate must not spend a page load on them. */
const SPAM_HOST_SUFFIXES: readonly string[] = [
  "doubleclick.net",
  "googlesyndication.com",
  "taboola.com",
  "outbrain.com",
  "zergnet.com",
  "propellerads.com",
  "adf.ly",
  "bit.ly",
  "cutt.ly",
  "tinyurl.com",
];

/** Title markers of clickbait/affiliate bait. Advisory only. */
const CLICKBAIT_TITLE: readonly RegExp[] = [
  /\byou won'?t believe\b/i,
  /\bshocking\b/i,
  /\bclick here\b/i,
  /\bbuy now\b/i,
  /\bmiracle\b/i,
  /\btop \d+ (?:secrets|tricks|hacks)\b/i,
  /топ-\d+ секрет/i,
  /шок!?/i,
];

/** Paths that are never a content page worth reading. */
const BLOCKED_READ_PATH =
  /\/(?:login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|account)(?:[/?#.]|$)/i;

/** Binary payloads that cannot be returned as text by `web_read`. */
const BINARY_PATH = /\.(?:zip|exe|dmg|iso|apk|msi|tar|gz|7z|rar|pdf)$/i;

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Share of Cyrillic letters at which a mixed query is treated as Russian. A
 * Russian query usually carries a Latin product name ("купить iPhone"), so
 * requiring a pure-Cyrillic string would misroute most commercial searches.
 */
const CYRILLIC_SHARE = 0.3;

const FRESHNESS_RULES: ReadonlyArray<{ freshness: Freshness; re: RegExp }> = [
  { freshness: "d", re: /\b(?:breaking|news|today|tonight)\b|(?:новост|сегодня|срочн|только что|за сутки)/iu },
  {
    freshness: "w",
    re: /\b(?:latest|recent|this week|last week)\b|(?:последн|свеж|на этой неделе|за неделю)/iu,
  },
  { freshness: "m", re: /\b(?:this month|last month)\b|(?:в этом месяце|за месяц|за последний месяц)/iu },
  { freshness: "y", re: /\b(?:20\d{2}|this year|last year)\b|(?:в этом году|за год)/iu },
];

export interface RulesOptions {
  /** Triage top-k. Defaults to `DEFAULT_TRIAGE_KEEP` (6). */
  keep?: number;
}

// ---------------------------------------------------------------------------
// Text and URL helpers (pure, exported for tests and for policy logging)
// ---------------------------------------------------------------------------

/** Lowercase Unicode word/number tokens. Punctuation never becomes a term. */
export function tokenize(text: string): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const normalized = text.normalize("NFKC").toLowerCase();
  return normalized.match(WORD) ?? [];
}

/** Query terms: deduplicated tokens with function words removed, in first-seen order. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(query)) {
    if (STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** True when at least one query term appears as an exact token in `text`. */
export function hasExactTerm(query: string, text: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0 || text.trim() === "") return false;
  const haystack = new Set(tokenize(text));
  return terms.some((term) => haystack.has(term));
}

/**
 * BM25 scores for one query against a set of documents. `documents` are already
 * tokenized. A query term that appears in every document gets a near-zero idf,
 * which is what keeps common words from outranking a distinctive one.
 */
export function bm25Scores(terms: readonly string[], documents: readonly (readonly string[])[]): number[] {
  const n = documents.length;
  if (n === 0) return [];

  const lengths = documents.map((document) => document.length);
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const avgLength = totalLength / n;

  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const scores: number[] = [];
  for (let index = 0; index < n; index += 1) {
    const termFrequency = new Map<string, number>();
    for (const term of documents[index]) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    }

    let score = 0;
    for (const term of terms) {
      const frequency = termFrequency.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const norm = avgLength === 0 ? 1 : lengths[index] / avgLength;
      const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * norm);
      score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
    }
    scores.push(score);
  }
  return scores;
}

function hostOf(value: string): string {
  const raw = value.trim().toLowerCase();
  if (raw === "") return "";
  const host = raw.includes("/") ? domainOf(raw) : raw;
  return host.replace(/^www\./, "");
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Primary-source/docs/gov/edu host. Used by the domain prior and the read gate. */
export function isAllowHost(value: string): boolean {
  const host = hostOf(value);
  if (host === "") return false;
  if (ALLOW_HOST_SUFFIXES.some((suffix) => hostMatches(host, suffix))) return true;
  if (host.startsWith("docs.") || host.startsWith("developer.")) return true;
  return /\.(?:gov|edu|int)$/.test(host) || host.endsWith(".ac.uk") || host.endsWith(".edu.ru");
}

/** Known ad/affiliate/shortener host. Advisory in triage, a hard skip in the read gate. */
export function isSpamHost(value: string): boolean {
  const host = hostOf(value);
  if (host === "") return false;
  return SPAM_HOST_SUFFIXES.some((suffix) => hostMatches(host, suffix));
}

export function isClickbaitTitle(title: string): boolean {
  return CLICKBAIT_TITLE.some((pattern) => pattern.test(title));
}

/**
 * Domain prior added to the BM25 score. Magnitudes are small on purpose: a good
 * term match must still beat a trusted host, and a spam host must never win.
 */
export function domainPrior(url: string): number {
  const host = hostOf(url);
  if (host === "") return 0;
  if (isSpamHost(host)) return -3;
  let prior = 0;
  if (isAllowHost(host)) prior += 0.6;
  if (/\.(?:gov|edu|int)$/.test(host) || host.endsWith(".ac.uk")) prior += 0.4;
  if (host.startsWith("docs.") || host.startsWith("developer.")) prior += 0.2;
  return prior;
}

function urlKey(raw: string): string {
  return stableQueryKey(raw) ?? raw.trim().toLowerCase();
}

function isBlockedReadUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  if (BLOCKED_READ_PATH.test(parsed.pathname)) return true;
  return BINARY_PATH.test(parsed.pathname);
}

// ---------------------------------------------------------------------------
// Script and freshness detection (route)
// ---------------------------------------------------------------------------

export type Script = "cyrillic" | "latin" | "none";

/**
 * Dominant script of a query. Numbers and punctuation are ignored; a mixed
 * query goes to the Arabic/Cyrillic side once the Cyrillic share reaches
 * `CYRILLIC_SHARE`.
 */
export function detectScript(query: string): Script {
  let cyrillic = 0;
  let latin = 0;
  for (const char of query) {
    if (CYRILLIC.test(char)) cyrillic += 1;
    else if (LATIN.test(char)) latin += 1;
  }
  const total = cyrillic + latin;
  if (total === 0) return "none";
  return cyrillic / total >= CYRILLIC_SHARE ? "cyrillic" : "latin";
}

/** Freshness marker in the query, strongest (day) first. Deterministic, no clock. */
export function detectFreshness(query: string): Freshness | undefined {
  for (const rule of FRESHNESS_RULES) {
    if (rule.re.test(query)) return rule.freshness;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The four decisions
// ---------------------------------------------------------------------------

function triageSync(query: string, items: readonly Candidate[], keepLimit: number): TriageResult {
  if (items.length === 0) return { keep: [], scores: [], flags: [] };

  const terms = queryTerms(query);
  const documents = items.map((item) => tokenize(`${item.title} ${item.snippet}`));
  const overlap = bm25Scores(terms, documents);

  const raw = items.map((item, index) => {
    const penalty = isClickbaitTitle(item.title) ? -1 : 0;
    return overlap[index] + domainPrior(item.url) + penalty;
  });
  const spam = items.map((item) => isSpamHost(item.url) || isClickbaitTitle(item.title));

  // Rank before dedup so the surviving URL is the best-scored copy, not the
  // first one the engine happened to return.
  const order = items.map((_, index) => index).sort((a, b) => raw[b] - raw[a] || a - b);

  const duplicate = new Array<boolean>(items.length).fill(false);
  const seenUrls = new Set<string>();
  for (const index of order) {
    const key = urlKey(items[index].url);
    if (seenUrls.has(key)) {
      duplicate[index] = true;
      continue;
    }
    seenUrls.add(key);
  }

  const scores = raw.map((value, index) => {
    if (spam[index] || duplicate[index] || value <= 0) return 0;
    return Math.max(0, Math.min(5, Math.round(value * SCORE_SCALE)));
  });

  const keep = order.filter((index) => !spam[index] && !duplicate[index]).slice(0, keepLimit);

  // Recall safety: a rules triage never returns nothing for a non-empty SERP.
  if (keep.length === 0) keep.push(order[0]);

  const flags: string[] = [];
  if (duplicate.includes(true)) flags.push("duplicate");
  if (spam.includes(true)) flags.push("spam");

  return { keep, scores, flags };
}

function gateReadSync(query: string, item: Candidate): boolean {
  if (isSpamHost(item.url) || isClickbaitTitle(item.title)) return false;
  if (isBlockedReadUrl(item.url)) return false;

  const host = hostOf(item.url);
  if (host === "") return false;

  const terms = queryTerms(query);
  const haystack = new Set(tokenize(`${item.title} ${item.snippet}`));

  // Without usable query terms the gate cannot judge relevance; only a known
  // docs/source host is safe to open.
  if (terms.length === 0) return isAllowHost(host);

  const hits = terms.filter((term) => haystack.has(term)).length;
  if (isAllowHost(host)) return hits >= 1;
  return hits >= Math.min(2, terms.length);
}

function coverageSync(query: string, evidence: readonly Evidence[]): CoverageVerdict {
  const urls = new Set<string>();
  const domains = new Set<string>();
  let termHits = 0;

  for (const item of evidence) {
    const key = urlKey(item.url);
    if (urls.has(key)) continue;
    urls.add(key);
    const host = hostOf(item.url);
    if (host !== "") domains.add(host);
    if (hasExactTerm(query, `${item.title ?? ""} ${item.excerpt ?? ""}`)) termHits += 1;
  }

  // SPEC §9.2: corroboration from two independent domains plus at least one
  // page that actually carries a query term.
  const enough = domains.size >= 2 && termHits >= 1;
  if (enough) return { enough: true, next: "stop" };
  if (urls.size === 0) return { enough: false, next: "read_more" };

  let next: CoverageNext;
  if (urls.size >= MAX_COVERAGE_READS) next = "refine";
  else if (domains.size < 2) next = "read_more";
  // Two or more domains but no exact-term hit: the query is off-target, so more
  // reading will not help. This is the "no new domains" rule from PLAN P5-B.
  else next = "refine";
  return { enough: false, next };
}

function routeSync(query: string): Route {
  const script = detectScript(query);
  const cyrillic = script === "cyrillic";
  const freshness = detectFreshness(query);
  const terms = queryTerms(query);
  const trivial = terms.length <= 1;

  const engines: EngineId[] = cyrillic ? ["yandex", "google"] : ["google", "duckduckgo"];
  const route: Route = {
    engines,
    lang: cyrillic ? "ru" : "en",
    n: trivial ? 3 : 5,
    // A one-word navigational query rarely benefits from a native AI summary;
    // a freshness query usually does.
    summary: !trivial || freshness !== undefined,
  };
  if (freshness !== undefined) route.freshness = freshness;
  return route;
}

/** Deterministic `Reflex` implementation. The only state is the frozen `keep` option. */
export function createRules(options: RulesOptions = {}): Reflex {
  const requested = options.keep;
  const keepLimit =
    requested !== undefined && Number.isInteger(requested) && requested > 0
      ? requested
      : DEFAULT_TRIAGE_KEEP;

  return {
    triage: async (query, items) => triageSync(query, items, keepLimit),
    gateRead: async (query, item) => gateReadSync(query, item),
    coverage: async (query, evidence) => coverageSync(query, evidence),
    route: async (query) => routeSync(query),
  };
}
