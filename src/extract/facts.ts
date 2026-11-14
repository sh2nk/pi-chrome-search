/**
 * Card facts (SPEC S7.7, §15 D13): the short strings a SERP card shows *outside*
 * its snippet — a price, an availability, a rating, a place, an age.
 *
 * Why one module: three adapters (avito, google, yandex) report facts, and an
 * adapter must not be able to disagree about how many a card may carry or how
 * long one may be. The display cap (one joined line, 120 chars) lives in
 * `compact.ts`; this is the *input* cap, applied to untrusted page output before
 * it becomes a `SerpItem`.
 *
 * Facts are copied from the page, never composed from numbers we found: "От
 * 4 057,00 ₽" and "Рейтинг 4,4 из 5" are the page's own words, so a fact cannot
 * claim more than the SERP did. A fact is dropped whole when it does not fit —
 * half a price is worse than no price.
 */

/** A card with more than four facts is reporting a table, not a card. */
export const FACT_MAX_ITEMS = 4;

/** Longer than this is prose that belongs in the snippet (57 + margin). */
export const FACT_MAX_CHARS = 60;

/**
 * Guard for the TS side of the page boundary: the DOM is untrusted even when we
 * wrote the extractor. Non-strings, blanks and over-long fragments are dropped;
 * the count and the length are capped.
 */
export function asFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const facts: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const fact = raw.replace(/[\s\u00a0\u202f]+/g, " ").trim();
    if (fact === "") continue;
    facts.push(fact.slice(0, FACT_MAX_CHARS));
    if (facts.length >= FACT_MAX_ITEMS) break;
  }
  return facts;
}
