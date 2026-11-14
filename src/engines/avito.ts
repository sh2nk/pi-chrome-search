/**
 * Avito adapter (SPEC S6.4, §15 D11/D12) — a *special* engine: marketplace
 * listings for one site, reachable only by naming it (`engines: "avito"`).
 *
 * What the live SERP actually gives us (captured 2026-11-15, `all` region,
 * fixture `tests/fixtures/avito-serp.html.gz`):
 *
 *  - Every listing is `[data-marker="item"]` and carries `data-item-id`. Titles
 *    are `a[data-marker="item-title"]` with a relative `href`; the card is
 *    server-rendered, so a settled SERP has the items in the first HTML byte —
 *    no AI block, no client-side hydration to wait for.
 *  - Price is visible text (`[data-marker="item-price-value"]`, "23 990 ₽") and
 *    also machine-readable (`meta[itemprop="price"]` + `priceCurrency`). The
 *    visible string wins: it is what the user sees, formatted by Avito itself.
 *  - Location (`item-location`) and listing age (`item-date`, on some cards)
 *    are card facts, not prose. They go into `SerpItem.facts` (D13) instead of
 *    being glued into the snippet, because a price is not a sentence.
 *  - `Продвинуто` is a paid boost of the *same* listing, not an ad slot: it is
 *    neither `isAd` (that would drop the item, which the page does not do) nor a
 *    fact (it would sit on most cards).
 *  - A query with no exact match is answered with *similar* listings under the
 *    visible heading "Похожие объявления рядом и в других городах" and a quoted
 *    `h1` («запрос»: объявления). That state is reported as `RawSerp.notice`
 *    (S7.6): the items are real, but they do not answer the query.
 *
 * Extraction is a self-contained in-page function (same `toString()` rule as the
 * other adapters): live code sends `(${extractFromDocument})(document, arg)`
 * through `Runtime.evaluate`, tests run the *same* source through `runInPage` in
 * a `node:vm` context.
 */

import type { CdpPage } from "../cdp/types.ts";
import { waitForMarker } from "../cdp/humanize.ts";
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

/** A server-rendered page that still hydrates ~1 MB of JS; 12 s is generous. */
export const AVITO_SETTLE_DEADLINE_MS = 12_000;
const SETTLE_POLL_MS = 200;

/**
 * Readiness gate. Both branches exist on a search page and on neither the home
 * page nor a wall: `item` cards are the results, `page-title` is the result
 * header (present when the list is empty or when Avito answers with
 * "similar listings"). The home page renders none of them, so the typed path
 * cannot settle on the warm-up page (verified on the capture of
 * `https://www.avito.ru/`).
 */
export const AVITO_READY_SELECTOR = '[data-marker="item"], [data-marker="page-title"]';
export const AVITO_ITEM_SELECTOR = '[data-marker="item"]';

const BOX_SELECTOR = 'input[data-marker="search-form/suggest/input"]';

/**
 * Typed-search profile. The box is `maxlength="100"` (captured), so a longer
 * query is never typed — a truncated query would search for something the user
 * did not ask for (the caller falls back to the pinned SERP URL instead).
 */
const TYPE_PROFILE = Object.freeze({
  box: BOX_SELECTOR,
  maxChars: 100,
  keyDelayMs: Object.freeze([30, 70] as const),
});

/**
 * Region slugs are path segments (`/kaluga`, `/moskva`, `/all`). The SERP URL is
 * built from a slug, so anything that is not one falls back to `all` instead of
 * becoming an encoded path that 404s (S7.5: no key that cannot work).
 */
export const AVITO_DEFAULT_LOCATION = "all";

/**
 * The home page is parameterized by region (`https://www.avito.ru/<location>/`),
 * and `all` redirects to the root (`https://www.avito.ru/`), which is the
 * "во всех регионах" home. Both hosts are legitimate landings for the warm-up.
 */
function homeUrlFor(q: Query): string {
  return `https://www.avito.ru/${locationSlug(q.region)}/`;
}

const INTERACTION: EngineInteraction = Object.freeze({
  homeUrl: "https://www.avito.ru/all/",
  homeHosts: Object.freeze(["avito.ru"]),
  boxSelectors: Object.freeze([BOX_SELECTOR, 'input[data-marker*="search-form"]']),
  marker: "",
  selector: AVITO_READY_SELECTOR,
  minCount: 1,
  typeProfile: TYPE_PROFILE,
  homeUrlFor,
});

/**
 * Wall markers. Text-first so class-name churn does not blind us, with the same
 * corroboration rule as the other adapters: a phrase alone is not a wall (a
 * listing title may quote it), but a phrase plus zero `item` cards is.
 *
 * `Доступ ограничен` is Avito's own firewall sentence; the rest cover the
 * captcha/interstitial variants seen across its brands.
 */
const CAPTCHA_URL_MARKERS: readonly string[] = Object.freeze(["/captcha", "/blocked"]);
const CAPTCHA_TEXT_MARKERS: readonly string[] = Object.freeze([
  "Подтвердите, что вы не робот",
  "проверка на робота",
  "Доступ ограничен",
  "доступ к сайту ограничен",
  "Ограниченный доступ",
  "Request blocked",
  "Access denied",
]);
const ITEM_COUNT_EXPRESSION = `document.querySelectorAll(${JSON.stringify(AVITO_ITEM_SELECTOR)}).length`;
// ---------------------------------------------------------------------------
// In-page extraction (self-contained: no imports, no closures)
// ---------------------------------------------------------------------------

export interface AvitoExtractedItem {
  title: string;
  url: string;
  snippet: string;
  facts: string[];
}

export interface AvitoExtraction {
  results: AvitoExtractedItem[];
  /** True when the page carried more cards than were returned. */
  pageCarried: boolean;
  /** True when Avito answered with "similar listings" instead of matches. */
  similar: boolean;
}

export interface AvitoExtractionArg {
  n: number;
}

/**
 * One-off in-page extractor. Everything it needs lives inside the body, because
 * only its `toString()` crosses the CDP boundary.
 */
export function extractFromDocument(doc: Document, arg: AvitoExtractionArg): AvitoExtraction {
  const WHITESPACE = /[\s\u00a0\u202f]+/g;
  /**
   * Tracking parameters Avito appends to item links (`?context=<blob>&cd=1`,
   * `?slocation=…`). They are ranking/session state, never part of the listing,
   * so the link the user clicks is the clean one (S7.4).
   */
  const TRACKING = ["context", "cd", "slocation", "searchfrom"];
  const normalize = (value: string | null | undefined): string =>
    (value === null || value === undefined ? "" : value).replace(WHITESPACE, " ").trim();

  const base = doc.baseURI !== "" ? doc.baseURI : doc.URL;

  /** http(s) only, Avito tracking parameters removed, fragment dropped. */
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
    const kept: Array<[string, string]> = [];
    parsed.searchParams.forEach((value: string, key: string) => {
      if (TRACKING.indexOf(key.toLowerCase()) !== -1) return;
      kept.push([key, value]);
    });
    parsed.search = "";
    for (const [key, value] of kept) parsed.searchParams.append(key, value);
    parsed.hash = "";
    return parsed.href;
  };

  /** Card text of one marker, or "" when the card does not show it. */
  const cardText = (card: Element, selector: string): string => {
    const node = card.querySelector(selector);
    return node === null ? "" : normalize(node.textContent);
  };

  /**
   * Leading text of an element, stopping at the first child element. Avito puts
   * the date as a bare text node followed by the seller link ("Вчера <a>…</a>"),
   * so `textContent` would report the seller name as the date.
   */
  const leadingText = (node: Element): string => {
    let out = "";
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) break;
      if (child.nodeType === 3) out += child.nodeValue === null ? "" : child.nodeValue;
    }
    return normalize(out);
  };

  /**
   * Visible price first (Avito formats "23 990 ₽" itself), machine-readable meta
   * as the fallback. A card with neither contributes no price fact.
   */
  const priceText = (card: Element): string => {
    const visible = cardText(card, '[data-marker="item-price-value"]');
    if (visible !== "") return visible;
    const holder = card.querySelector('[data-marker="item-price"]');
    if (holder === null) return "";
    const amount = normalize(holder.querySelector('meta[itemprop="price"]')?.getAttribute("content"));
    const currency = normalize(holder.querySelector('meta[itemprop="priceCurrency"]')?.getAttribute("content"));
    if (amount === "") return "";
    return currency === "" ? amount : `${amount} ${currency}`;
  };

  const limit =
    typeof arg.n === "number" && Number.isFinite(arg.n) ? Math.max(0, Math.floor(arg.n)) : 0;

  const bodyText = normalize(doc.body === null ? "" : doc.body.textContent);
  if (bodyText === "") return { results: [], pageCarried: false, similar: false };

  /**
   * "No exact match" state: the result header quotes the query («…»: объявления)
   * *and* the page says "Похожие объявления рядом и в других городах". Both are
   * required — on a matching SERP the header is a catalog name ("Apple iPhone
   * 13") and the phrase is absent (verified on both captures), so a phrase query
   * that does find real listings is not mislabelled.
   */
  const titleNode = doc.querySelector('[data-marker="page-title/text"]');
  const titleText = titleNode === null ? "" : normalize(titleNode.textContent);
  const quotedTitle = titleText.charAt(0) === "«" && titleText.indexOf("»") !== -1;
  const similar = quotedTitle && bodyText.toLowerCase().indexOf("похожие объявления рядом") !== -1;

  const results: AvitoExtractedItem[] = [];
  const seenUrls: { [url: string]: boolean } = {};
  let cards = 0;

  for (const card of Array.from(doc.querySelectorAll('[data-marker="item"]'))) {
    const anchor = card.querySelector('a[data-marker="item-title"][href]');
    const href = anchor === null ? null : anchor.getAttribute("href");
    if (href === null || href === "") continue;
    const url = toHttpUrl(href);
    if (url === null) continue;
    const title = normalize(anchor === null ? "" : anchor.textContent);
    if (title === "") continue;
    cards += 1;
    if (seenUrls[url] === true) continue;
    seenUrls[url] = true;
    if (results.length >= limit) continue;

    const facts: string[] = [];
    const price = priceText(card);
    if (price !== "") facts.push(price);
    // "Саратов· выезжает по городу" — the travel note is a separate badge glued
    // on with a middot; keep the place, not the service blurb.
    const location = cardText(card, '[data-marker="item-location"]').split("·")[0] ?? "";
    if (location !== "") facts.push(location.trim());
    const dateNode = card.querySelector('[data-marker="item-date"]');
    const date = dateNode === null ? "" : leadingText(dateNode);
    if (date !== "") facts.push(date);

    results.push({
      title,
      url,
      // `item-specific-params` ("Новый, 6.1″", "128 ГБ") is the closest thing a
      // listing card has to a snippet; Avito ships no description in the list.
      snippet: cardText(card, '[data-marker="item-specific-params"]'),
      facts,
    });
  }

  return { results, pageCarried: cards > results.length, similar };
}

// ---------------------------------------------------------------------------
// Selector canaries (self-contained, same toString() rule)
// ---------------------------------------------------------------------------

export function canaryCounts(doc: Document): Record<string, number> {
  const SELECTORS = [
    '[data-marker="item"]',
    '[data-marker="item-title"]',
    '[data-marker="item-price-value"]',
    '[data-marker="item-specific-params"]',
    '[data-marker="item-location"]',
    '[data-marker="item-date"]',
    '[data-marker="page-title"]',
    '[data-marker="pagination-button/nextPage"]',
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
  if (doc.querySelector('#captcha, .captcha, iframe[src*="captcha"], form[action*="checkcaptcha"]') !== null) {
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

/** Facts are display sugar, not a payload: a hostile page cannot flood the line. */
const MAX_FACTS = 4;
const MAX_FACT_CHARS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailure(message: string): Error {
  return fail("E_PARSE", "extract", {
    engine: "avito",
    message,
    hint: "the Avito page returned an unexpected shape; run /web-doctor and inspect the artifact",
  });
}

function asFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const facts: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const fact = raw.replace(/[\s\u00a0]+/g, " ").trim();
    if (fact === "") continue;
    facts.push(fact.slice(0, MAX_FACT_CHARS));
    if (facts.length >= MAX_FACTS) break;
  }
  return facts;
}

function asExtraction(value: unknown): AvitoExtraction {
  if (!isRecord(value)) throw parseFailure("in-page extractor returned no object");
  const rawResults = value.results;
  if (!Array.isArray(rawResults)) throw parseFailure("in-page extractor returned no results array");

  const results: AvitoExtractedItem[] = [];
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
    similar: value.similar === true,
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

export interface AvitoSettleOptions {
  signal?: AbortSignal;
  /** Test/live knob; defaults to 12 s. */
  deadlineMs?: number;
  /** Test/live knob; defaults to 200 ms plus humanize jitter. */
  pollMs?: number;
  clock?: Clock;
  rng?: () => number;
}

/** Bounded settle on the structural gate; abort/timeout use the shared taxonomy. */
export async function settleAvito(page: CdpPage, options: AvitoSettleOptions = {}): Promise<void> {
  await waitForMarker(page, {
    marker: INTERACTION.marker,
    selector: INTERACTION.selector,
    minCount: INTERACTION.minCount ?? 1,
    deadlineMs: options.deadlineMs ?? AVITO_SETTLE_DEADLINE_MS,
    pollMs: options.pollMs ?? SETTLE_POLL_MS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.rng === undefined ? {} : { rng: options.rng }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function itemCount(page: CdpPage): Promise<number> {
  const count = await page.evaluate<unknown>(ITEM_COUNT_EXPRESSION);
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

async function captchaNodes(page: CdpPage): Promise<number> {
  const count = await page.evaluate<unknown>(`(${captchaNodeCount.toString()})(document)`);
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

/**
 * Wall detection. Nobody clicks anything here: the tool surfaces the window, the
 * human solves it and retries (D5).
 */
export async function detectAvitoWall(page: CdpPage): Promise<Wall | null> {
  const url = page.url();
  const text = await page.innerText();
  const loweredUrl = url.toLowerCase();
  const loweredText = text.toLowerCase();

  const urlMarkers: string[] = [];
  for (const marker of CAPTCHA_URL_MARKERS) {
    if (loweredUrl.indexOf(marker) !== -1) urlMarkers.push(marker);
  }
  const textMarkers: string[] = [];
  for (const marker of CAPTCHA_TEXT_MARKERS) {
    if (loweredText.indexOf(marker.toLowerCase()) !== -1) textMarkers.push(marker);
  }
  const markers = [...urlMarkers, ...textMarkers];

  if (urlMarkers.length > 0) return { kind: "captcha", url, markers };
  // A captcha widget is evidence on its own: the iframe text is invisible to the
  // page-text scan.
  if ((await captchaNodes(page)) > 0) {
    return { kind: "captcha", url, markers: markers.length > 0 ? markers : ["captcha-node"] };
  }
  // A listing title can quote "Доступ ограничен"; a real wall has no cards.
  if (textMarkers.length > 0 && (await itemCount(page)) === 0) {
    return { kind: "blocked", url, markers };
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL builder + engine
// ---------------------------------------------------------------------------

/**
 * Region path segment. `all` is Avito's all-Russia slug (`rossiya` redirects to
 * it), and the config value is that slug, not a display name: a slug is what the
 * URL needs, and a wrong one is a 404 the caller cannot debug.
 */
export function locationSlug(region: string | undefined): string {
  const trimmed = typeof region === "string" ? region.trim() : "";
  if (trimmed === "") return AVITO_DEFAULT_LOCATION;
  return /^[a-z0-9_-]+$/i.test(trimmed) ? trimmed.toLowerCase() : AVITO_DEFAULT_LOCATION;
}

/**
 * Pure: `https://www.avito.ru/<location>?q=<query>[&p=<page>]`.
 *
 * Verified live (2026-11-15): Avito resolves `?q=` into its catalog, `p` is the
 * 1-based page number (the page-2 link carries `p=2`), and the search box on the
 * resulting page holds the query. There is no `lr`-style region parameter: the
 * region is the first path segment.
 */
function buildUrl(q: Query): string {
  const parts = [`q=${encodeURIComponent(q.text)}`];
  const page = typeof q.page === "number" && Number.isFinite(q.page) ? Math.floor(q.page) : 1;
  if (page > 1) parts.push(`p=${page}`);
  return `https://www.avito.ru/${locationSlug(q.region)}?${parts.join("&")}`;
}

export const avitoEngine: Engine = {
  id: "avito",
  interaction: INTERACTION,
  buildUrl,

  async settle(page: CdpPage, signal?: AbortSignal): Promise<void> {
    await settleAvito(page, signal === undefined ? {} : { signal });
  },

  detectWall: detectAvitoWall,

  async extract(page: CdpPage, q: Query): Promise<RawSerp> {
    const startedAt = Date.now();
    const arg: AvitoExtractionArg = { n: q.n };
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
      engine: "avito",
      query: q.text,
      results,
      pageCarried: parsed.pageCarried,
      ...(parsed.similar ? { notice: SIMILAR_NOTICE } : {}),
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
export const SIMILAR_NOTICE = "no exact match: Avito returned similar listings";
