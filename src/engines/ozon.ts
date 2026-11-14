/**
 * Ozon adapter (SPEC S6.5, §15 D14) — the second *special* engine: marketplace
 * goods for one site, reachable only by naming it (`engines: "ozon"`).
 *
 * What the live SERP actually gives us (captured 2026-11-16 on the owner's
 * profile; fixtures `tests/fixtures/ozon-serp.html.gz` and
 * `ozon-no-match.html.gz` are the results area of those pages):
 *
 *  - `https://www.ozon.ru/search/?text=…` answers with a *semantic redirect* to
 *    `/<category-slug>/?text=…` when Ozon predicts a catalog. Both shapes render
 *    the same grid, so one URL builder covers them and the landed URL is not
 *    evidence of a failed search. `page=N` survives the redirect (verified on a
 *    `page=2` navigation: a different product set came back).
 *  - A card is `.tile-root[data-index]`. The product link is the anchor that
 *    wraps the title; the image anchor carries the same href, so the title
 *    anchor is resolved from the title node instead of by position.
 *  - `span.tsBody500Medium` is the title, `span.tsHeadline500Medium` the visible
 *    price ("31 209 ₽"), `span.tsBodyControl300XSmall` the score-then-count pair
 *    ("4.7", "65 отзывов"). Those `ts*` tokens are Ozon's design-system
 *    typography, not hashed CSS-module names (`q4b1_6_0-a`), which is what makes
 *    them usable as markers at all.
 *  - A card carries no description, so `snippet` is empty on purpose: an Ozon
 *    tile has price and rating, not prose, and inventing a snippet from badges
 *    ("Чёрная пятница", "Стало дешевле") would be a lie with formatting.
 *  - A no-match query is answered with recommendations under the headline
 *    "Ничего не нашлось" (statusWidget). The cards are real, they just do not
 *    answer the query, so they are returned under an authored `notice` (S7.6).
 *  - The home page renders 20 `.tile-root` cards of its own, so a bare card
 *    selector would let the typed warm-up settle on the home page and read a
 *    carousel as results. The gate is therefore the *results* chrome
 *    (`searchResultsV2`/`searchResultsSort`/`statusWidget`), which the home page
 *    does not have (measured on the capture).
 *
 * Extraction is a self-contained in-page function (same `toString()` rule as the
 * other adapters): live code sends `(${extractFromDocument})(document, arg)`
 * through `Runtime.evaluate`, tests run the *same* source through `runInPage` in
 * a `node:vm` context.
 */

import type { CdpPage } from "../cdp/types.ts";
import { waitForMarker } from "../cdp/humanize.ts";
import { asFacts } from "../extract/facts.ts";
import { normalizeUrl } from "../extract/urls.ts";
import { fail } from "../runtime/errors.ts";
import type { Clock } from "../runtime/types.ts";
import type {
  Engine,
  EngineInteraction,
  Query,
  RawSerp,
  SerpItem,
  Wall,
} from "./types.ts";

/** A server-rendered page that hydrates a large client bundle; 12 s is generous. */
export const OZON_SETTLE_DEADLINE_MS = 12_000;
const SETTLE_POLL_MS = 200;

/**
 * Readiness gate. The two observed markers are the results chrome:
 *
 *  - `searchResultsSort` — the sort/filter bar of a catalog-shaped result page
 *    (every captured search landed on one of these);
 *  - `statusWidget` — the notice slot a zero-match search renders instead of a
 *    list, so "no exact match" settles too and is reported as a notice instead of
 *    burning the deadline.
 *
 * `searchResultsV2` is *anticipated, never observed*: it is the widget name of the
 * plain `/search/?text=` result list, and every capture of 2026-11-16 was
 * redirected to a category page. It costs one alternation to keep, and without it
 * a non-redirected search list would time out instead of extracting. The canaries
 * report its count, so a layout that uses it says so.
 *
 * The captcha half exists for the same reason Google keeps `#captcha-form` next
 * to `#rso`: a wall page has no results chrome, so without it the settle would
 * spend its whole deadline *before* `detectWall()` can report the wall it is
 * looking at (S8.5).
 */
export const OZON_CAPTCHA_SELECTOR =
  '#captcha, .h-captcha, #h-captcha, iframe[src*="captcha"], form[action*="captcha"], [class*="captcha"]';
export const OZON_READY_SELECTOR = `[data-widget="searchResultsV2"], [data-widget="searchResultsSort"], [data-widget="statusWidget"], ${OZON_CAPTCHA_SELECTOR}`;
export const OZON_TILE_SELECTOR = ".tile-root";

const BOX_SELECTOR = 'input[name="text"]';

/**
 * Typed-search profile. The box is `maxlength="255"` (captured), so a longer
 * query is never typed — a truncated query would search for something the user
 * did not ask for (the caller falls back to the pinned SERP URL instead).
 */
const TYPE_PROFILE = Object.freeze({
  box: BOX_SELECTOR,
  maxChars: 255,
  keyDelayMs: Object.freeze([30, 70] as const),
});

const INTERACTION: EngineInteraction = Object.freeze({
  homeUrl: "https://www.ozon.ru/",
  homeHosts: Object.freeze(["ozon.ru"]),
  boxSelectors: Object.freeze([BOX_SELECTOR, '[data-widget="searchBarDesktop"] input']),
  marker: "",
  selector: OZON_READY_SELECTOR,
  minCount: 1,
  typeProfile: TYPE_PROFILE,
});

/**
 * Wall markers (S9.3). Ozon's block page could not be captured: reaching it
 * means provoking the firewall, which the hard rules forbid, and a fixture
 * written from memory would be a claim, not evidence. So this list is
 * *defensive* and text-first, corroborated exactly like the other adapters (a
 * phrase alone is not a wall — a product title may quote it, but a wall has no
 * cards). `docs/engines.md` says so in the same words.
 */
const CAPTCHA_URL_MARKERS: readonly string[] = Object.freeze(["/captcha", "/blocked"]);
const CAPTCHA_TITLE_MARKERS: readonly string[] = Object.freeze([
  "Доступ ограничен",
  "Access denied",
  "Request blocked",
]);
const CAPTCHA_TEXT_MARKERS: readonly string[] = Object.freeze([
  "Подтвердите, что вы не робот",
  "проверка на робота",
  "Доступ ограничен",
  "Ограниченный доступ",
  "Access denied",
  "Too many requests",
]);
const TILE_COUNT_EXPRESSION = `document.querySelectorAll(${JSON.stringify(OZON_TILE_SELECTOR)}).length`;
// ---------------------------------------------------------------------------
// In-page extraction (self-contained: no imports, no closures)
// ---------------------------------------------------------------------------

export interface OzonExtractedItem {
  title: string;
  url: string;
  snippet: string;
  facts: string[];
}

export interface OzonExtraction {
  results: OzonExtractedItem[];
  /** True when the page carried more cards than were returned. */
  pageCarried: boolean;
  /**
   * Text of the notice headline the page rendered instead of a result list
   * ("Ничего не нашлось" on the capture). Empty on a normal SERP.
   *
   * The adapter reports its *presence* as a no-match notice; it never keys on the
   * words, because a locale or an A/B test may change them and a wrong-match is
   * worse than a missing one.
   */
  headline: string;
}

export interface OzonExtractionArg {
  n: number;
}

/**
 * One-off in-page extractor. Everything it needs lives inside the body, because
 * only its `toString()` crosses the CDP boundary.
 */
export function extractFromDocument(doc: Document, arg: OzonExtractionArg): OzonExtraction {
  const WHITESPACE = /[\s\u00a0\u202f]+/g;
  const normalize = (value: string | null | undefined): string =>
    (value === null || value === undefined ? "" : value).replace(WHITESPACE, " ").trim();

  const base = doc.baseURI !== "" ? doc.baseURI : doc.URL;

  /**
   * http(s) only. A product link is its *path*: every query parameter Ozon
   * attaches (`at`, `avtc`, `avts`, …) is attribution or session state, and the
   * link the user clicks is the clean one (S7.4). Other links keep their query,
   * because there the parameters may be the destination.
   */
  const toHttpUrl = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    let parsed: URL;
    try {
      parsed = new URL(trimmed, base === "" ? undefined : base);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.pathname.indexOf("/product/") === 0) parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  };

  const textOf = (node: Element | null): string => (node === null ? "" : normalize(node.textContent));

  const limit =
    typeof arg.n === "number" && Number.isFinite(arg.n) ? Math.max(0, Math.floor(arg.n)) : 0;

  const bodyText = normalize(doc.body === null ? "" : doc.body.textContent);
  if (bodyText === "") return { results: [], pageCarried: false, headline: "" };

  /**
   * A zero-match search keeps its result chrome and replaces the grid with a
   * status notice. The headline is only *reported* here; the meaning is the
   * adapter's own constant (S7.6).
   */
  const headline = textOf(doc.querySelector('[data-widget="statusWidget"] .tsHeadline800XxLarge'));

  const results: OzonExtractedItem[] = [];
  const seenUrls: { [url: string]: boolean } = {};
  let cards = 0;

  for (const card of Array.from(doc.querySelectorAll(".tile-root"))) {
    const titleNode = card.querySelector("span.tsBody500Medium");
    const title = textOf(titleNode);
    if (title === "") continue;
    const anchor = titleNode === null ? null : titleNode.closest("a[href]");
    const href = anchor === null ? null : anchor.getAttribute("href");
    if (href === null || href === "") continue;
    const url = toHttpUrl(href);
    if (url === null) continue;
    cards += 1;
    if (seenUrls[url] === true) continue;
    seenUrls[url] = true;
    if (results.length >= limit) continue;

    const facts: string[] = [];
    const price = textOf(card.querySelector("span.tsHeadline500Medium"));
    if (price !== "") facts.push(price);
    /**
     * Score then review count, both `tsBodyControl300XSmall`. Which one is which
     * is decided by *shape* (a leaf that is only a number is the score; the
     * other node is copied whole, whatever language it is in), never by the
     * word for "reviews" (S7.7).
     */
    let rating = "";
    let reviews = "";
    for (const node of Array.from(card.querySelectorAll("span.tsBodyControl300XSmall"))) {
      const text = textOf(node);
      if (text === "") continue;
      if (rating === "" && /^\d+(?:[.,]\d+)?$/.test(text)) {
        rating = text;
        continue;
      }
      if (reviews === "") reviews = text;
    }
    if (rating !== "") facts.push(rating);
    if (reviews !== "") facts.push(reviews);

    results.push({ title, url, snippet: "", facts });
  }

  return { results, pageCarried: cards > results.length, headline };
}

// ---------------------------------------------------------------------------
// Selector canaries (self-contained, same toString() rule)
// ---------------------------------------------------------------------------

export function canaryCounts(doc: Document): Record<string, number> {
  const SELECTORS = [
    ".tile-root",
    '[data-widget="tileGridDesktop"]',
    '[data-widget="searchResultsV2"]',
    '[data-widget="searchResultsSort"]',
    '[data-widget="statusWidget"]',
    "span.tsBody500Medium",
    "span.tsHeadline500Medium",
    "span.tsBodyControl300XSmall",
  ];
  const counts: Record<string, number> = {};
  for (const selector of SELECTORS) {
    counts[selector] = doc.querySelectorAll(selector).length;
  }
  return counts;
}

/**
 * 1 when the document carries a captcha widget, 0 otherwise. A JS scan instead
 * of a CSS selector because the class test must be case-insensitive and
 * `[attr*="captcha" i]` is not portable across the DOM implementations the
 * offline harness uses.
 */
export function captchaNodeCount(doc: Document): number {
  if (doc.querySelector('#captcha, #h-captcha, iframe[src*="captcha"], form[action*="captcha"]') !== null) {
    return 1;
  }
  for (const node of Array.from(doc.querySelectorAll("[class]"))) {
    const className = node.getAttribute("class") ?? "";
    if (className.toLowerCase().indexOf("captcha") !== -1) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Result validation (TS side: the page is untrusted even when we wrote the code)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailure(message: string): Error {
  return fail("E_PARSE", "extract", {
    engine: "ozon",
    message,
    hint: "the Ozon page returned an unexpected shape; run /web-doctor and inspect the artifact",
  });
}

function asExtraction(value: unknown): OzonExtraction {
  if (!isRecord(value)) throw parseFailure("in-page extractor returned no object");
  const rawResults = value.results;
  if (!Array.isArray(rawResults)) throw parseFailure("in-page extractor returned no results array");

  const results: OzonExtractedItem[] = [];
  const seenUrls = new Set<string>();
  for (const rawItem of rawResults) {
    if (!isRecord(rawItem)) throw parseFailure("in-page extractor returned a malformed result");
    const { title, url, snippet } = rawItem;
    if (typeof title !== "string" || typeof url !== "string" || typeof snippet !== "string") {
      throw parseFailure("in-page extractor returned a result with non-string fields");
    }
    if (title === "") continue;
    // Second, TS-side hygiene pass: the in-page copy cannot import `urls.ts`.
    const normalized = normalizeUrl(url);
    if (normalized === null || seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    results.push({
      title,
      url: normalized,
      snippet,
      facts: asFacts(rawItem.facts),
    });
  }

  return {
    results,
    pageCarried: value.pageCarried === true,
    headline: typeof value.headline === "string" ? value.headline : "",
  };
}

function asCanaries(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!isRecord(value)) return counts;
  for (const [selector, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count)) counts[selector] = count;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Settle / wall
// ---------------------------------------------------------------------------

export interface OzonSettleOptions {
  signal?: AbortSignal;
  /** Test/live knob; defaults to 12 s. */
  deadlineMs?: number;
  /** Test/live knob; defaults to 200 ms plus humanize jitter. */
  pollMs?: number;
  clock?: Clock;
  rng?: () => number;
}

/** Bounded settle on the structural gate; abort/timeout use the shared taxonomy. */
export async function settleOzon(page: CdpPage, options: OzonSettleOptions = {}): Promise<void> {
  await waitForMarker(page, {
    marker: INTERACTION.marker,
    selector: INTERACTION.selector,
    minCount: INTERACTION.minCount ?? 1,
    deadlineMs: options.deadlineMs ?? OZON_SETTLE_DEADLINE_MS,
    pollMs: options.pollMs ?? SETTLE_POLL_MS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.rng === undefined ? {} : { rng: options.rng }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function tileCount(page: CdpPage): Promise<number> {
  const count = await page.evaluate<unknown>(TILE_COUNT_EXPRESSION);
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

async function captchaNodes(page: CdpPage): Promise<number> {
  const count = await page.evaluate<unknown>(`(${captchaNodeCount.toString()})(document)`);
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

/** Markers present in a lowercased haystack, in list order. */
function markersIn(haystack: string, markers: readonly string[]): string[] {
  const found: string[] = [];
  for (const marker of markers) {
    if (haystack.indexOf(marker.toLowerCase()) !== -1) found.push(marker);
  }
  return found;
}

/**
 * Wall detection. Nobody clicks anything here: the tool surfaces the window, the
 * human solves it and retries (D5). The markers are defensive (see the top of
 * this file): the one thing we can honestly say is that a wall has no product
 * cards, so a phrase needs zero cards as corroboration.
 */
export async function detectOzonWall(page: CdpPage): Promise<Wall | null> {
  const url = page.url();
  const urlMarkers = markersIn(url.toLowerCase(), CAPTCHA_URL_MARKERS);
  if (urlMarkers.length > 0) return { kind: "captcha", url, markers: urlMarkers };

  const title = await page.title().catch((): string => "");
  const text = await page.innerText();
  const markers = [
    ...markersIn(title.toLowerCase(), CAPTCHA_TITLE_MARKERS),
    ...markersIn(text.toLowerCase(), CAPTCHA_TEXT_MARKERS),
  ];

  // A captcha widget is evidence on its own: its label lives in an iframe the
  // page-text scan cannot see.
  if ((await captchaNodes(page)) > 0) {
    return { kind: "captcha", url, markers: markers.length > 0 ? markers : ["captcha-node"] };
  }
  // A phrase can be quoted by a product title; a wall has no cards.
  if (markers.length > 0 && (await tileCount(page)) === 0) {
    return { kind: "blocked", url, markers };
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL builder + engine
// ---------------------------------------------------------------------------

/**
 * Pure: `https://www.ozon.ru/search/?text=<query>[&page=<page>]`.
 *
 * Verified live (2026-11-16): Ozon answers `?text=` either with the search grid
 * or with a `307`-style redirect to a predicted catalog
 * (`/category/<slug>/?…&text=<query>`), and both carry the same cards. `page` is
 * 1-based and survives the redirect. Page 1 is the bare URL, because `page=1` is
 * a parameter the SERP does not need.
 */
function buildUrl(q: Query): string {
  const parts = [`text=${encodeURIComponent(q.text)}`];
  const page = typeof q.page === "number" && Number.isFinite(q.page) ? Math.floor(q.page) : 1;
  if (page > 1) parts.push(`page=${page}`);
  return `https://www.ozon.ru/search/?${parts.join("&")}`;
}

export const ozonEngine: Engine = {
  id: "ozon",
  interaction: INTERACTION,
  buildUrl,

  async settle(page: CdpPage, signal?: AbortSignal): Promise<void> {
    await settleOzon(page, signal === undefined ? {} : { signal });
  },

  detectWall: detectOzonWall,

  async extract(page: CdpPage, q: Query): Promise<RawSerp> {
    const startedAt = Date.now();
    const arg: OzonExtractionArg = { n: q.n };
    const raw = await page.evaluate<unknown>(
      `(${extractFromDocument.toString()})(document, ${JSON.stringify(arg)})`,
    );
    const parsed = asExtraction(raw);
    const results: SerpItem[] = parsed.results.map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      ...(item.facts.length === 0 ? {} : { facts: item.facts }),
    }));
    const timings = { extractMs: Math.max(0, Date.now() - startedAt) };
    return {
      engine: "ozon",
      query: q.text,
      results,
      pageCarried: parsed.pageCarried,
      ...(parsed.headline === "" ? {} : { notice: NO_MATCH_NOTICE }),
      timings,
    };
  },

  async canaries(page: CdpPage): Promise<Record<string, number>> {
    const raw = await page.evaluate<unknown>(`(${canaryCounts.toString()})(document)`);
    return asCanaries(raw);
  },
};

/**
 * Adapter-authored (never page text): the caller must not read a page of
 * recommendations as an answer to its query (S7.6).
 */
export const NO_MATCH_NOTICE = "no exact match: Ozon answered with recommendations";
