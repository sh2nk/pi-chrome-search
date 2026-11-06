/**
 * DuckDuckGo adapter (SPEC §6.3, PLAN P3-DDG).
 *
 * A DuckDuckGo SERP is mostly plain HTML: organic results are `<article>`s whose
 * title anchor carries a stable `data-testid`, snippets carry `data-result`, and
 * Search Assist renders into its own `duckassist-answer-content` container. The
 * layout was measured on the sanitized fixtures `ddg-assist` and
 * `ddg-no-assist`; every selector below has a canary.
 *
 * The extractor is a *self-contained* function because live code stringifies it
 * into `Runtime.evaluate` (SPEC §5.4). It may not close over module constants or
 * helpers: `extractFromDocument` therefore repeats the three small literals it
 * needs (`results`, `snippets`, the assist testid) on purpose.
 *
 * Pagination and freshness are deliberately absent. `Query.page` is
 * google/yandex-only (PLAN §5 "DDG pagination deferred"); the tool layer reports
 * `pageIgnored` for `page > 1` instead of us inventing `&s=`. `&df=` was never
 * verified against a live capture, so a `freshness` request is ignored rather
 * than guessed (see the lane handoff); inventing it would silently narrow a
 * search.
 */

import type { CdpPage } from "../cdp/types.ts";
import { systemClock } from "../runtime/clock.ts";
import { WebSearchError } from "../runtime/error-codes.ts";
import type { Clock } from "../runtime/types.ts";
import { fail, toFailure } from "../runtime/errors.ts";
import type {
  AiSummary,
  Engine,
  EngineId,
  EngineInteraction,
  Query,
  RawSerp,
  SerpItem,
  Wall,
  WallKind,
} from "./types.ts";

const ENGINE_ID: EngineId = "duckduckgo";

const HOME_URL = "https://duckduckgo.com/";
/** DDG home box is `input[name="q"]`; some builds use the `#searchbox_input` id. */
const BOX_SELECTORS: readonly string[] = ['input[name="q"]', "#searchbox_input"];
/**
 * Text marker measured on both live fixtures: the word "DuckDuckGo" is in the
 * SERP footer and is NOT localized. It is only half the check — the home page
 * can contain the same brand word, so `selector` + `minCount` is what actually
 * proves a result list exists (waitForMarker ANDs the two).
 */
const SETTLE_MARKER = "DuckDuckGo";
const RESULT_TITLE_SELECTOR = 'a[data-testid="result-title-a"]';
const SETTLE_MIN_RESULTS = 1;
const SETTLE_DEADLINE_MS = 8_000;
const SETTLE_POLL_MS = 150;

const SNIPPET_SELECTOR = '[data-result="snippet"]';
const ARTICLE_SELECTOR = 'article[data-testid="result"]';
const ASSIST_SELECTOR = '[data-testid="duckassist-answer-content"]';

/** Canary names are the doctor's vocabulary; selectors live here only. */
const CANARY_SELECTORS: Readonly<Record<string, string>> = Object.freeze({
  resultTitles: RESULT_TITLE_SELECTOR,
  snippets: SNIPPET_SELECTOR,
  articles: ARTICLE_SELECTOR,
  assistBlocks: ASSIST_SELECTOR,
});

/**
 * Exact visible strings from DDG's anomaly page. The weak marker ("unusual
 * traffic") is not DDG-specific — a *search for that phrase* would hit it — so
 * it only counts when the document also has zero result anchors.
 */
const ANOMALY_MARKER = "Unfortunately, bots use DuckDuckGo too";
const CAPTCHA_MARKER = "Please complete the following challenge";
const WEAK_BLOCK_MARKER = "unusual traffic";
const ANOMALY_PATH_RE = /(?:^|\/)anomaly(?:\/|$)/i;

/**
 * The strong text markers `detectSerpWall` reacts to. `settle` needs them too:
 * a challenge page carries the brand word but no result anchors, so waiting for
 * anchors alone would burn the full deadline and the tool would report
 * `E_TIMEOUT` instead of reaching `detectWall`. The weak "unusual traffic"
 * marker is handled separately because it also occurs in ordinary results.
 */
const WALL_TEXT_MARKERS: readonly string[] = [ANOMALY_MARKER, CAPTCHA_MARKER];

/** SPEC §5.4: ±25% on the settle poll, mirroring `waitForMarker`. */
const SETTLE_JITTER_RATIO = 0.25;
const SETTLE_MIN_POLL_MS = 1;
/** Keeps `[0, 1)` semantics for an rng that returns exactly 1. */
const SETTLE_RNG_CEILING = 0.999_999;

export const DUCKDUCKGO_INTERACTION: EngineInteraction = Object.freeze({
  homeUrl: HOME_URL,
  boxSelectors: BOX_SELECTORS,
  marker: SETTLE_MARKER,
  selector: RESULT_TITLE_SELECTOR,
  minCount: SETTLE_MIN_RESULTS,
});

// ---------------------------------------------------------------------------
// In-page extraction (serialized into Runtime.evaluate — no closures!)
// ---------------------------------------------------------------------------

export interface ExtractFromDocumentArg {
  n: number;
  summary: boolean;
  /** Echoed for debuggability/logs; extraction never rewrites results from it. */
  query: string;
}

export interface ExtractedResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ExtractedAi {
  text: string;
  sources: string[];
}

export interface ExtractedSerp {
  results: ExtractedResult[];
  ai?: ExtractedAi;
  pageCarried: boolean;
}

/**
 * Extract one DuckDuckGo SERP. Self-contained by contract: live code stringifies
 * this function, so it must not reference imports, module constants, `this`, or
 * any closure. `document.body.textContent`/`textContent` is used instead of
 * `innerText` because the offline fixture DOM (linkedom) has no `innerText`.
 *
 * Search Assist is located structurally, not by the nth occurrence of the
 * label: on a live SERP that label appears in the top nav, in the assist card's
 * own button, and in two `aria-label`s, so a text slice would start inside
 * chrome and end on "Больше"/"Остановить" buttons. The answer body lives in
 * `[data-testid="duckassist-answer-content"]`; the RU disclaimer ("Ответ
 * составлен автоматически") and its EN twin sit *outside* that container, so
 * the container text is already the answer. We still trim at a disclaimer if a
 * future layout moves it inside. Sources are the visible citation chips (an
 * `<a>` wrapping the site icon); an empty list is honest.
 */
export function extractFromDocument(doc: Document, arg: ExtractFromDocumentArg): ExtractedSerp {
  const normalize = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  /**
   * An answer is prose, not chrome. A container that survived cleaning with only
   * a label ("Search Assist", a button caption) is not a summary: require the
   * 12-char floor AND at least two letter-bearing words. Inlined on purpose —
   * this function is stringified into the page and cannot see module scope.
   */
  const isProse = (value: string): boolean => {
    if (value.length < 12) return false;
    const words = value.split(/\s+/).filter((word) => /[A-Za-z\u0400-\u04FF]/.test(word));
    return words.length >= 2;
  };

  const limit = Number.isFinite(arg.n) && arg.n >= 0 ? Math.floor(arg.n) : 10;

  const resolve = (raw: string): { href: string; ad: boolean } | null => {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    let url: URL;
    try {
      url = new URL(raw.trim(), doc.baseURI);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const onDdg = host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
    if (onDdg && (url.pathname === "/y.js" || url.pathname === "/y.js/")) {
      return { href: url.href, ad: true };
    }
    // Some builds wrap organic links in `/l/?uddg=<enc>`; unwrap it so the
    // result is a real destination instead of a redirector.
    if (onDdg && (url.pathname === "/l/" || url.pathname === "/l")) {
      const target = url.searchParams.get("uddg");
      if (target !== null && target !== "") {
        try {
          const inner = new URL(target);
          if (inner.protocol === "http:" || inner.protocol === "https:") {
            return { href: inner.href, ad: false };
          }
        } catch {
          // A malformed uddg is still a link the browser can follow; keep it.
        }
      }
    }
    return { href: url.href, ad: false };
  };

  const results: ExtractedResult[] = [];
  let carried = 0;
  // Literal on purpose: a module constant would be a free variable in the page.
  const anchors = doc.querySelectorAll('a[data-testid="result-title-a"]');

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const title = normalize(anchor.textContent);
    if (title === "") continue;
    const href = anchor.getAttribute("href");
    if (href === null) continue;
    const parsed = resolve(href);
    if (parsed === null) continue;

    const container = anchor.closest("article") ?? anchor.parentElement;
    let ad = parsed.ad;
    // The ad wrapper can BE the result container (`<div data-result="ad">` around
    // the title anchor), which a descendant-only query on the container misses.
    if (!ad && anchor.closest('[data-result="ad"]') !== null) ad = true;
    if (!ad && container !== null) {
      if (container.querySelector('[data-result="ad"]') !== null) ad = true;
      const badge = container.querySelector('[data-testid="result-badge"]');
      if (badge !== null) {
        const label = normalize(badge.textContent).toLowerCase();
        if (label === "ad" || label === "реклама" || label === "sponsored") ad = true;
      }
    }
    if (ad) continue;

    let snippet = "";
    if (container !== null) {
      const node = container.querySelector('[data-result="snippet"]');
      if (node !== null) snippet = normalize(node.textContent);
    }

    carried += 1;
    if (results.length < limit) results.push({ title, url: parsed.href, snippet });
  }

  let ai: ExtractedAi | undefined;
  if (arg.summary) {
    const block = doc.querySelector('[data-testid="duckassist-answer-content"]');
    if (block !== null) {
      const sources: string[] = [];
      const sourceNodes = block.querySelectorAll("a[href]");
      for (let index = 0; index < sourceNodes.length; index += 1) {
        const node = sourceNodes[index];
        // Citation chips wrap the site icon; inline links inside an answer do not.
        if (node.querySelector("img") === null) continue;
        let name = normalize(node.textContent);
        if (name === "") {
          try {
            name = new URL(node.getAttribute("href") ?? "", doc.baseURI).hostname.replace(/^www\./, "");
          } catch {
            name = "";
          }
        }
        if (name === "") continue;
        const key = name.toLowerCase();
        if (sources.some((entry) => entry.toLowerCase() === key)) continue;
        sources.push(name);
      }

      const clone = block.cloneNode(true) as Element;
      const cloneSources = clone.querySelectorAll("a[href]");
      for (let index = 0; index < cloneSources.length; index += 1) {
        const node = cloneSources[index];
        if (node.querySelector("img") === null) continue;
        if (node.parentNode !== null) node.parentNode.removeChild(node);
      }

      // A sponsored card can be nested inside the assist block; its copy is not
      // part of the answer.
      const cloneAds = clone.querySelectorAll('[data-result="ad"]');
      for (let index = 0; index < cloneAds.length; index += 1) {
        const node = cloneAds[index];
        if (node.parentNode !== null) node.parentNode.removeChild(node);
      }

      // Some builds render the expand/stop controls inside the same container.
      // The comparison is on a whole element's own text, so a paragraph that
      // merely mentions "more" survives while a button labelled "More" does not.
      const controlLabels = ["больше", "остановить", "продолжить", "stop", "more", "continue"];
      const cloneNodes = clone.querySelectorAll("*");
      for (let index = 0; index < cloneNodes.length; index += 1) {
        const node = cloneNodes[index];
        const label = normalize(node.textContent).toLowerCase();
        if (!controlLabels.includes(label)) continue;
        if (node.parentNode !== null) node.parentNode.removeChild(node);
      }

      let text = normalize(clone.textContent);
      const endings = [
        "Ответ составлен автоматически",
        "Answer generated automatically",
        "Создано с помощью ИИ",
        "AI-generated",
      ];
      for (const ending of endings) {
        const at = text.indexOf(ending);
        if (at !== -1) text = text.slice(0, at).trim();
      }
      // A toggle-only block carries the label and nothing else: not a summary.
      if (text.indexOf("Search Assist") === 0) text = text.slice("Search Assist".length).trim();
      // Belt and braces: a label left as a bare text node has no element to
      // remove, so the prose *check* also drops label tokens. The emitted answer
      // keeps its own wording — this filter never rewrites what the user reads.
      const proseCandidate = normalize(
        text
          .split(" ")
          .filter((word) => !controlLabels.includes(word.toLowerCase().replace(/[.,;:!?«»"'()]/g, "")))
          .join(" "),
      );
      if (isProse(proseCandidate)) ai = { text, sources };
    }
  }

  const pageCarried = carried > results.length;
  return ai === undefined ? { results, pageCarried } : { results, ai, pageCarried };
}

// ---------------------------------------------------------------------------
// Page-side helpers (module code, never serialized)
// ---------------------------------------------------------------------------

function countExpression(selector: string): string {
  return `document.querySelectorAll(${JSON.stringify(selector)}).length`;
}

function countOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensive re-validation of the JSON that crossed the CDP boundary. */
function parseExtracted(value: unknown): ExtractedSerp {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw fail("E_PARSE", "extract", {
      engine: ENGINE_ID,
      message: "the in-page extractor returned no result list",
      hint: "the page expression returned an unexpected shape; open the artifact and check the canaries",
    });
  }

  const results: ExtractedResult[] = [];
  for (const item of value.results) {
    if (!isRecord(item)) continue;
    if (typeof item.title !== "string" || typeof item.url !== "string") continue;
    const title = item.title.trim();
    const url = item.url.trim();
    if (title === "" || url === "" || !/^https?:\/\//i.test(url)) continue;
    results.push({
      title,
      url,
      snippet: typeof item.snippet === "string" ? item.snippet.trim() : "",
    });
  }

  let ai: AiSummary | undefined;
  if (isRecord(value.ai) && typeof value.ai.text === "string") {
    const text = value.ai.text.trim();
    if (text !== "") {
      const sources = Array.isArray(value.ai.sources)
        ? value.ai.sources
            .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
            .map((entry) => entry.trim())
        : [];
      ai = { text, sources };
    }
  }

  const pageCarried = value.pageCarried === true;
  return ai === undefined ? { results, pageCarried } : { results, ai, pageCarried };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

function normalized(value: string | undefined): string {
  const text = (value ?? "").trim().toLowerCase();
  // The caller resolves "auto" before the adapter sees it (frozen contract);
  // treating it as absent here keeps buildUrl pure even if that promise slips.
  return text === "auto" ? "" : text;
}

/**
 * `kl` is DDG's `<region>-<lang>` pair. The tool layer puts config
 * `engines.duckduckgo.kl` (already a complete pair such as `ru-ru`) into
 * `Query.region`, so a pair must pass through verbatim instead of being
 * self-paired into `ru-ru-ru-ru`. DDG has no language-only value, so a lang
 * without a region falls back to `wt-wt` (no region preference) instead of
 * guessing a country. A bare region without a lang is self-paired (`de-de`),
 * which is the form DDG itself uses for most markets.
 */
const REGION_LANG_PAIR_RE = /^[a-z]{2}-[a-z]{2}$/i;

function klFor(q: Query): string {
  const region = normalized(q.region);
  const lang = normalized(q.lang);
  if (REGION_LANG_PAIR_RE.test(region)) return region;
  if (region !== "" && lang !== "") return `${region}-${lang}`;
  if (region !== "") return `${region}-${region}`;
  return "wt-wt";
}

export function buildDuckDuckGoUrl(q: Query): string {
  // Pagination (`&s=`) and freshness (`&df=`) are intentionally absent: see the
  // module header. Same Query -> same URL, always.
  return `https://duckduckgo.com/?q=${encodeURIComponent(q.text)}&kl=${klFor(q)}`;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface DuckDuckGoEngineOptions {
  /** Injected clock for settle polling (tests use a virtual clock). */
  clock?: Clock;
  /** Bounded settle deadline; default 8000 ms. */
  deadlineMs?: number;
  /** Base poll interval before jitter; default 150 ms. */
  pollMs?: number;
  /** Jitter source for the settle poll; default `Math.random`. */
  rng?: () => number;
}

type SettleState = "ready" | "wall" | "waiting";

function normalizeDeadline(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SETTLE_DEADLINE_MS;
  return Math.max(0, Math.floor(value));
}

function normalizePoll(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SETTLE_POLL_MS;
  return Math.max(SETTLE_MIN_POLL_MS, Math.floor(value));
}

function pollDelay(pollMs: number, rng: () => number): number {
  const raw = rng();
  const unit = Number.isFinite(raw) ? Math.min(SETTLE_RNG_CEILING, Math.max(0, raw)) : 0.5;
  const jittered = Math.round(pollMs * (1 + (unit * 2 - 1) * SETTLE_JITTER_RATIO));
  const low = Math.max(SETTLE_MIN_POLL_MS, Math.floor(pollMs * (1 - SETTLE_JITTER_RATIO)));
  const high = Math.max(low, Math.ceil(pollMs * (1 + SETTLE_JITTER_RATIO)));
  return Math.min(high, Math.max(low, jittered));
}

/**
 * One settle probe. `ready` keeps the marker+selector AND from
 * `DUCKDUCKGO_INTERACTION`: the brand word also sits on the DDG home page, so
 * only an actual result anchor proves a SERP. `wall` uses the same markers as
 * `detectSerpWall`; "unusual traffic" is weak and counts only with zero
 * anchors, exactly as `detectSerpWall` decides it.
 */
async function settleState(page: CdpPage): Promise<SettleState> {
  const text = await page.innerText();
  if (WALL_TEXT_MARKERS.some((marker) => text.includes(marker))) return "wall";
  if (ANOMALY_PATH_RE.test(pathOf(page.url()))) return "wall";

  const anchors = countOf(await page.evaluate<unknown>(countExpression(RESULT_TITLE_SELECTOR)));
  if (anchors >= SETTLE_MIN_RESULTS) {
    return text.includes(SETTLE_MARKER) ? "ready" : "waiting";
  }
  if (text.includes(WEAK_BLOCK_MARKER)) return "wall";
  return "waiting";
}

/**
 * Wait (bounded) for a DDG SERP or for the page to prove it is a wall.
 *
 * This deliberately does not call `waitForMarker`: that helper can only express
 * "marker AND selector", and a challenge page satisfies neither even though it
 * is a terminal state. Returning on a wall marker lets the orchestrator reach
 * `detectWall` and answer `E_WALL` instead of spending the whole deadline and
 * reporting `E_TIMEOUT`. Poll jitter is local because the helper's is private.
 */
async function settleSerp(
  page: CdpPage,
  options: DuckDuckGoEngineOptions,
  signal: AbortSignal | undefined,
): Promise<void> {
  const clock = options.clock ?? systemClock;
  const deadlineMs = normalizeDeadline(options.deadlineMs);
  const pollMs = normalizePoll(options.pollMs);
  const rng = options.rng ?? Math.random;
  const start = clock.now();

  try {
    for (;;) {
      if (signal?.aborted === true) {
        throw fail("E_CANCELLED", "settle", { engine: ENGINE_ID, message: "aborted by the caller" });
      }
      const state = await settleState(page);
      if (state === "ready" || state === "wall") return;

      const elapsed = clock.now() - start;
      if (elapsed >= deadlineMs) {
        throw fail("E_TIMEOUT", "settle", {
          engine: ENGINE_ID,
          hint: "the engine layout may have changed; run /web-doctor",
          message:
            `marker "${SETTLE_MARKER}" not found after ${elapsed} ms; ` +
            `selector ${RESULT_TITLE_SELECTOR} matched fewer than ${SETTLE_MIN_RESULTS} element(s) ` +
            "and no wall marker was present",
        });
      }
      await clock.sleep(pollDelay(pollMs, rng), signal);
    }
  } catch (error) {
    throw new WebSearchError(toFailure(error, { code: "E_CDP_DISCONNECTED", stage: "settle" }));
  }
}

async function detectSerpWall(page: CdpPage): Promise<Wall | null> {
  const url = page.url();
  const text = await page.innerText();
  const markers: string[] = [];
  let blocked = false;
  let captcha = false;

  const path = pathOf(url);
  if (ANOMALY_PATH_RE.test(path)) {
    markers.push(`url:${path}`);
    blocked = true;
  }
  if (text.includes(ANOMALY_MARKER)) {
    markers.push(ANOMALY_MARKER);
    blocked = true;
  }
  if (text.includes(CAPTCHA_MARKER)) {
    markers.push(CAPTCHA_MARKER);
    captcha = true;
  }
  // "unusual traffic" also appears in normal result text for a query about
  // network anomalies, so it only counts when the page carries no results.
  if (!blocked && !captcha && text.includes(WEAK_BLOCK_MARKER)) {
    const results = countOf(await page.evaluate<unknown>(countExpression(RESULT_TITLE_SELECTOR)));
    if (results === 0) {
      markers.push(WEAK_BLOCK_MARKER);
      blocked = true;
    }
  }

  if (!blocked && !captcha) return null;
  const kind: WallKind = captcha ? "captcha" : "blocked";
  return { kind, url, markers };
}

async function countCanaries(page: CdpPage): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [name, selector] of Object.entries(CANARY_SELECTORS)) {
    counts[name] = countOf(await page.evaluate<unknown>(countExpression(selector)));
  }
  return counts;
}

async function extractSerp(page: CdpPage, q: Query): Promise<RawSerp> {
  const arg: ExtractFromDocumentArg = { n: q.n, summary: q.summary, query: q.text };
  const raw = await page.evaluate<unknown>(`(${extractFromDocument})(document, ${JSON.stringify(arg)})`);
  const extracted = parseExtracted(raw);

  const results: SerpItem[] = extracted.results.map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
  }));

  return {
    engine: ENGINE_ID,
    query: q.text,
    ...(extracted.ai === undefined ? {} : { ai: extracted.ai }),
    results,
    pageCarried: extracted.pageCarried,
    timings: {},
  };
}

/**
 * Build one adapter. Production uses the shared `duckduckgoEngine`; tests build
 * a copy with a virtual clock and a short deadline so a settle timeout is
 * proven without spending real seconds.
 */
export function createDuckDuckGoEngine(options: DuckDuckGoEngineOptions = {}): Engine {
  return {
    id: ENGINE_ID,
    interaction: DUCKDUCKGO_INTERACTION,
    buildUrl: buildDuckDuckGoUrl,
    settle: (page, signal) => settleSerp(page, options, signal),
    detectWall: detectSerpWall,
    extract: extractSerp,
    canaries: countCanaries,
  };
}

export const duckduckgoEngine: Engine = createDuckDuckGoEngine();
