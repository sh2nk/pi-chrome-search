/**
 * Claim selection for `web_research` (SPEC §7.4, PLAN-v2 P13-A/B).
 *
 * The shipped rule was "the first sentence of the first read page", which made
 * the bundle a quote generator: a licence banner, a cookie notice or a
 * "this chapter covers…" intro outranked the sentence that answers the query.
 * This module ranks sentences instead:
 *
 *   - every readable sentence of every read page is a candidate (headings,
 *     lists, tables, quotes and code fences are structural noise, not claims);
 *   - the score is query-term coverage (dominant), numeric/date/named-entity
 *     presence (the shape of a fact), sentence position and length fit;
 *   - boilerplate, lone date stamps, fenced/inline code and link-only lines are
 *     dropped outright; navigational sentences and questions are penalised;
 *   - a sentence that shares no term with the query is not an answer: when any
 *     candidate is on-topic, off-topic sentences stay out of the claims (the
 *     excerpt still carries the page);
 *   - the best sentence wins globally, so a strong second page beats a weak
 *     first page — the exact failure V13.1 measured (2/10 baseline);
 *   - one claim per source by default, a second only when it is clearly
 *     distinct, and identical text from two sources is merged into one claim
 *     with two citations (corroboration is evidence, not duplication);
 *   - links inside a claim lose their tracking parameters (`stripTrackingFromText`),
 *     and a page whose only content is a table of contents contributes nothing.
 *
 * Everything here is pure and deterministic: no clock, no network, no imports
 * from the runtime. That is what makes the baseline/target comparison in
 * `research/probes/13-claims.mjs` reproducible.
 */

import { queryTerms, tokenize } from "./text.ts";
import { domainOf, sourceKey, stripTrackingFromText } from "./urls.ts";

/** A claim shorter than this is a fragment, not a statement. */
export const CLAIM_MIN_CHARS = 30;
/** A claim longer than this is a paragraph; the bundle is not a page cache. */
export const CLAIM_MAX_CHARS = 200;
/** Hard ceiling on claims per bundle (one per read, plus a distinct second). */
export const CLAIM_MAX_PER_BUNDLE = 8;
/**
 * `enough:yes` requires the claims to cover at least this share of the query
 * terms (V13.3). Two domains alone is not evidence that the *question* was
 * answered; coverage of what the user asked is.
 */
export const MIN_CLAIM_COVERAGE = 0.6;

/** What the caller knows about one read page. */
export interface ClaimSource {
  /** Result URL the text was read from; the citation identity. */
  url: string;
  title?: string;
  /** Full read text, line structure preserved (headings/lists are skipped). */
  text: string;
}

export interface ClaimOptions {
  query: string;
  /** Defaults to `CLAIM_MAX_PER_BUNDLE`. */
  maxClaims?: number;
  /** Per-claim character cap. Defaults to `CLAIM_MAX_CHARS`. */
  maxChars?: number;
}

export interface ClaimPick {
  text: string;
  /** Primary citation (the page the sentence came from). */
  sourceUrl: string;
  /** Every page that stated this same sentence; `sourceUrl` is always first. */
  citations: string[];
  /** Deterministic score, useful for the probe and for tests. */
  score: number;
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

/** Markdown structure that never carries a claim: headings, lists, tables, code. */
const STRUCTURAL_LINE = /^(?:[#>*|!`]|[-+*]\s|\d+[.)]\s)/;

/**
 * A period that ends an abbreviation, not a sentence. Kept short on purpose —
 * an over-eager list would glue real sentences together, which costs coverage.
 */
const ABBREVIATION_END =
  /(?:(?<![\p{L}])(?:e\.g|i\.e|etc|vs|approx|ca|cf|no|fig|vol|al|dr|mr|mrs|ms|st|inc|ltd|prof|т\.д|т\.п|т\.е|др|тыс|млн|млрд|руб|стр|рис|гл|см)\.|(?<![\p{L}])[А-ЯЁA-Z]\.)$/iu;

/** Sentence boundary: punctuation, whitespace, then a capital/digit/quote. */
const SENTENCE_BREAK = /(?<=[.!?…])\s+(?=[\p{Lu}\p{N}«"„(])/u;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function safeSlice(text: string, end: number): string {
  if (end <= 0) return "";
  const cut = text.slice(0, end);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${safeSlice(text, maxChars - 1).trimEnd()}…`;
}

/** Clean a sentence: tracking parameters out of any link, whitespace collapsed. */
function sanitize(text: string): string {
  return collapse(stripTrackingFromText(text));
}

function splitLine(line: string): string[] {
  const parts = line.split(SENTENCE_BREAK);
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    // Glue an abbreviation or an initial back onto the sentence it belongs to.
    if (previous !== undefined && ABBREVIATION_END.test(previous)) {
      merged[merged.length - 1] = `${previous} ${part}`;
      continue;
    }
    merged.push(part);
  }
  return merged;
}

/**
 * Sentences of a read document, in page order. Line breaks are boundaries (the
 * read renderer emits one block per line), fenced code is skipped whole,
 * structural lines are skipped, and an abbreviation never ends a sentence.
 */
export function splitSentences(text: string): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split(/\n+/)) {
    const clean = line.trim();
    if (clean.startsWith("```") || clean.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (clean === "" || STRUCTURAL_LINE.test(clean)) continue;
    for (const part of splitLine(clean)) {
      const sentence = sanitize(part);
      if (sentence !== "") out.push(sentence);
    }
  }
  return out;
}

/**
 * A code fragment that the read renderer did not put in a fence (some sites
 * keep code in a plain `<p>`). Quoting `port = ENV["PORT"].to_i || 4000` as a
 * research answer is worse than saying nothing, so it is never a claim.
 */
export function looksLikeCode(sentence: string): boolean {
  // A bare `x = y` is deliberately not enough: prose legitimately quotes config
  // values (`scope="session"`). Brackets, arrows, semicolons and a symbol-heavy
  // line are the signals that survive that test.
  if (/(?:=>|->|::=|#include|<\/|\bENV\[|\b[a-zA-Z_]\w*\[[^\]]*\])/.test(sentence)) return true;
  if (/;\s*$/.test(sentence.trim())) return true;
  const chars = [...sentence];
  if (chars.length < 20) return false;
  const symbols = chars.filter((char) => /[{}[\]()=;<>|$\\]/.test(char)).length;
  return symbols / chars.length > 0.12;
}

// ---------------------------------------------------------------------------
// Filters: boilerplate, lone dates, tables of contents
// ---------------------------------------------------------------------------

/** Navigational lead-ins that read like content but answer nothing. */
const NAVIGATIONAL =
  /^(?:read|learn|see|view|open|go|download|buy|shop|subscribe|sign|log|register|share|tweet|print|email|next|previous|back|home|menu|search|skip|table of|contents|содержание|оглавление|читать|смотрите|перейти|скачать|купить|подписаться|войти|зарегистрироваться|поделиться|наверх|главная|меню|поиск)(?![\p{L}\p{N}])/iu;

const BOILERPLATE: readonly RegExp[] = [
  /\b(?:cookie|cookies)\b.*\b(?:accept|consent|policy|settings)\b/i,
  /\b(?:all rights reserved|licensed under|licen[cs]e|privacy policy|terms of (?:service|use)|copyright)\b/i,
  /(?:все права защищены|политика конфиденциальности|пользовательское соглашение|лицензи)/i,
  /\bthis (?:[a-z-]+ ){0,2}(?:page|article|site|documentation|section|chapter|guide)\b.{0,60}\b(?:is|was|describes|covers|lists)\b/i,
  /\b(?:we|this site|this website) (?:use|uses) cookies\b/i,
  /(?:эта|данная) (?:страница|статья|инструкция)(?![\p{L}])/iu,
  /\b(?:click|tap) (?:here|to|the)\b|нажмите (?:здесь|чтобы)/i,
  /\b(?:read|learn|see) more\b|читать далее|читайте также|смотрите также/i,
  /\bshare (?:this|on)\b|поделиться/i,
  /\b(?:sign in|log in|sign up|create (?:an )?account)\b|войти|зарегистрироваться/i,
  /\byour browser (?:is|does not|will)\b|ваш браузер/i,
  /^\s*(?:https?:\/\/|www\.)\S+\s*$/i,
];

const DATE_SOURCE =
  "(?:\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|(?<![\\p{L}\\p{N}])\\d{1,2}\\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\\s+\\d{4}(?![\\p{L}\\p{N}])|\\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\\s+\\d{1,2},?\\s+\\d{4}\\b|\\b\\d{1,2}\\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\\s+\\d{4}\\b|(?<![\\p{L}\\p{N}])(?:19|20)\\d{2}(?![\\p{L}\\p{N}]))";
/** Non-global: safe for `.test()` (a global regex would carry `lastIndex`). */
const DATE_TEXT = new RegExp(DATE_SOURCE, "iu");
/** Global: used only to remove every date token from a lone-date candidate. */
const DATE_TEXT_ALL = new RegExp(DATE_SOURCE, "giu");

const DATE_LEAD =
  /^(?:актуально|обновлено|опубликовано|дата|updated|last updated|published|posted|modified|created)(?![\p{L}])/iu;

/** Tokens that a date stamp leaves behind and that carry no topic. */
const DATE_NOISE: ReadonlySet<string> = new Set([
  "g", "г", "гг", "год", "года", "году", "лет", "at", "on", "in", "of", "the", "в", "на", "от",
]);

/** True for "Актуально на 14 июля 2026 года." / "Updated July 14, 2026." */
export function isLoneDate(sentence: string): boolean {
  if (!DATE_TEXT.test(sentence)) return false;
  const stripped = sentence.replace(DATE_TEXT_ALL, " ").replace(DATE_LEAD, " ");
  return queryTerms(stripped).every((term) => DATE_NOISE.has(term));
}

/** True for a licence banner, cookie notice, nav lead-in or a bare link. */
export function isBoilerplateSentence(sentence: string): boolean {
  const clean = sentence.trim();
  if (clean === "") return true;
  if (NAVIGATIONAL.test(clean)) return true;
  if (BOILERPLATE.some((pattern) => pattern.test(clean))) return true;
  // A sentence that is only links/URLs carries no statement.
  const withoutLinks = clean.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/https?:\/\/\S+/gi, " ");
  return tokenize(withoutLinks).length < 3;
}

/**
 * A page that is only a table of contents: enough lines, almost all of them
 * short, many of them list/link entries, and no prose block. A Yandex
 * "Содержание" page used to contribute a nav heading as the top claim.
 */
export function isTocPage(text: string): boolean {
  if (typeof text !== "string") return false;
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 5) return false;

  const marker = lines.some((line) =>
    /^(?:#+\s*)?(?:содержание|оглавление|table of contents|contents|index)$/i.test(
      line.replace(/[*_`]/g, "").trim(),
    ),
  );

  const listLike = lines.filter(
    (line) => /\[[^\]]+\]\([^)]+\)/.test(line) || /^(?:[-+*]\s|\d+[.)]\s)/.test(line),
  ).length;
  const shortLines = lines.filter((line) => line.length <= 80).length;
  const prose = lines.filter(
    (line) => line.length >= 120 && !/^(?:[-+*]\s|\d+[.)]\s)/.test(line),
  ).length;

  if (marker) return listLike / lines.length >= 0.25;
  return lines.length >= 8 && shortLines / lines.length >= 0.8 && listLike / lines.length >= 0.4 && prose === 0;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const HAS_NUMBER = /\p{N}/u;
const POSITION_BONUS = 0.8;
const FULL_COVERAGE_BONUS = 1.5;

/**
 * A named entity is a capitalised word that is not the sentence opener, an
 * acronym, or a `Foo::bar` / camelCase identifier. Heuristic on purpose: it is a
 * tie-breaker between two sentences that match the query equally well.
 */
export function hasNamedEntity(sentence: string): boolean {
  const words = sentence.split(/\s+/);
  for (let index = 0; index < words.length; index += 1) {
    const word = (words[index] ?? "").replace(/^[«"„'([{]+|[»"“')\]}.,;:!?]+$/g, "");
    if (word.length < 2) continue;
    if (index > 0 && /^[\p{Lu}][\p{Ll}\p{N}]/u.test(word) && !/^[\p{Lu}]+$/u.test(word)) return true;
    if (/^[\p{Lu}\p{N}]{2,}$/u.test(word) && /\p{L}/u.test(word)) return true;
    if (/::|[a-z][A-Z]/.test(word)) return true;
  }
  return false;
}

/**
 * Score one sentence against the query. Higher is a better claim.
 *
 * The weights are deliberately lopsided: covering the user's terms matters more
 * than sounding like a fact, because a number in an unrelated sentence is still
 * an unrelated sentence. `-100` marks a sentence that must never be quoted.
 */
export function scoreSentence(query: string, sentence: string, position = 0): number {
  if (isBoilerplateSentence(sentence) || isLoneDate(sentence) || looksLikeCode(sentence)) return -100;

  const terms = queryTerms(query);
  const tokens = new Set(tokenize(sentence));
  let matched = 0;
  for (const term of terms) if (tokens.has(term)) matched += 1;

  const overlap = terms.length === 0 ? 0 : matched / terms.length;
  let score = overlap * 6;
  if (terms.length > 0 && matched === terms.length) score += FULL_COVERAGE_BONUS;
  if (matched === 0) score -= 2;

  if (HAS_NUMBER.test(sentence)) score += 1;
  if (DATE_TEXT.test(sentence)) score += 1;
  if (hasNamedEntity(sentence)) score += 0.6;

  score += POSITION_BONUS / (1 + Math.max(0, position));
  if (sentence.length >= 60 && sentence.length <= 180) score += 0.4;
  if (NAVIGATIONAL.test(sentence)) score -= 1.5;
  if (/:$/.test(sentence)) score -= 1; // a lead-in, not a statement
  if (/\?\s*$/.test(sentence)) score -= 0.5; // a question is a promise, not an answer
  return score;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

interface Ranked {
  text: string;
  url: string;
  score: number;
  matched: number;
  sourceIndex: number;
  sentenceIndex: number;
  tokens: ReadonlySet<string>;
}

/**
 * Rank every sentence of every source and return the claims worth quoting, best
 * first. Sources are de-duplicated by `sourceKey` (canonical host + path), so a
 * tracking-parameter variant can never supply a second citation.
 */
export function selectClaims(sources: readonly ClaimSource[], options: ClaimOptions): ClaimPick[] {
  const query = typeof options.query === "string" ? options.query : "";
  const maxClaims = clamp(options.maxClaims ?? CLAIM_MAX_PER_BUNDLE, 1, CLAIM_MAX_PER_BUNDLE);
  const maxChars = clamp(options.maxChars ?? CLAIM_MAX_CHARS, 40, 1_000);

  const ranked: Ranked[] = [];
  const seenSources = new Set<string>();

  sources.forEach((source, sourceIndex) => {
    const key = sourceKey(source.url) ?? (domainOf(source.url) || source.url);
    if (seenSources.has(key)) return;
    seenSources.add(key);

    const sentences = splitSentences(source.text);
    sentences.forEach((sentence, sentenceIndex) => {
      if (sentence.length < CLAIM_MIN_CHARS) return;
      const text = truncate(sentence, maxChars);
      const score = scoreSentence(query, text, sentenceIndex);
      if (score <= -50) return;
      const tokens = new Set(tokenize(text));
      let matched = 0;
      for (const term of queryTerms(query)) if (tokens.has(term)) matched += 1;
      ranked.push({
        text,
        url: source.url,
        score,
        matched,
        sourceIndex,
        sentenceIndex,
        tokens,
      });
    });
  });

  // Stable and deterministic: score, then read order, then sentence order.
  ranked.sort(
    (a, b) =>
      b.score - a.score || a.sourceIndex - b.sourceIndex || a.sentenceIndex - b.sentenceIndex,
  );

  // A claim that shares no term with the query is not an answer, it is a quote.
  // When at least one candidate is on-topic, off-topic sentences stay out of the
  // claims (the excerpt still carries the page). Cross-language SERPs can then
  // honestly return no claims instead of a confident-looking unrelated line.
  const relevant = ranked.filter((item) => item.matched > 0);
  const pool = relevant.length > 0 ? relevant : ranked;

  const picks: ClaimPick[] = [];
  const byText = new Map<string, ClaimPick>();
  const chosen: Array<{ pick: ClaimPick; tokens: ReadonlySet<string> }> = [];
  const perSource = new Map<string, number>();

  for (const item of pool) {
    if (picks.length >= maxClaims) break;

    const textKey = item.text.toLowerCase();
    const existing = byText.get(textKey);
    if (existing !== undefined) {
      // Same sentence from a second source: corroboration, not a new claim.
      if (existing.citations.length < 3 && !existing.citations.includes(item.url)) {
        existing.citations.push(item.url);
      }
      continue;
    }

    const used = perSource.get(item.url) ?? 0;
    if (used >= 1) {
      const best = chosen.find((entry) => entry.pick.sourceUrl === item.url);
      if (best === undefined) continue;
      // A second claim from one page must be clearly distinct and nearly as good.
      if (jaccard(best.tokens, item.tokens) >= 0.2 || item.score < best.pick.score * 0.8) continue;
    }

    const pick: ClaimPick = {
      text: item.text,
      sourceUrl: item.url,
      citations: [item.url],
      score: Math.round(item.score * 100) / 100,
    };
    picks.push(pick);
    byText.set(textKey, pick);
    chosen.push({ pick, tokens: item.tokens });
    perSource.set(item.url, used + 1);
  }

  return picks;
}

/**
 * Share of the query's terms that appear in at least one claim (0..1). This is
 * the V13.3 gate: an answer that ignores half the question is not `enough`.
 */
export function claimsCoverage(query: string, texts: readonly string[]): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 1;
  const haystack = new Set<string>();
  for (const text of texts) for (const token of tokenize(text)) haystack.add(token);
  let hit = 0;
  for (const term of terms) if (haystack.has(term)) hit += 1;
  return hit / terms.length;
}
