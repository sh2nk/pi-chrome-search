/**
 * Google SERP adapter (SPEC §6.1, PLAN P3-Google).
 *
 * The file has two halves that must not blur:
 *
 *  - Module side: a pure URL builder, a deadline-bounded settle and a wall
 *    detector. They read the page only through the frozen `CdpPage` surface and
 *    never navigate, screenshot or cache.
 *  - In-page side: `extractFromDocument` / `canaryCountsFromDocument`. They are
 *    serialised with `toString()` into one `Runtime.evaluate`, so they may not
 *    import, capture a module constant or touch `this` — everything they need
 *    is a literal inside the function body. That is also why the AI labels and
 *    the ad-badge words are spelled out in both in-page functions: sharing them
 *    through a module constant would work in Node and fail in the browser.
 *    `tests/unit/google.test.ts` runs the same functions through `runInPage`,
 *    so a free variable fails offline instead of in production.
 *
 * `innerText` does not exist in the fixture DOM (linkedom), which is why the
 * in-page code walks `childNodes` through `visibleText` (skipping <style>,
 * <script> and other non-prose elements) and normalises whitespace explicitly.
 * `textContent` is never the prose source: a live AI Overview nests a
 * stylesheet inside the answer wrapper, and raw text length let CSS win.
 *
 * Link policy (SPEC §6.1): hrefs leave this adapter exactly as the page offers
 * them. A `/goto?url=<protobuf>` wrapper stays wrapped — resolving it needs a
 * request carrying the browser's cookies, which is the tool layer's job
 * (`extract/goto.ts`), not an adapter's. Nothing here fabricates a destination.
 */

import type { CdpPage } from "../cdp/types.ts";
import { waitForMarker } from "../cdp/humanize.ts";
import { isHttpUrl } from "../extract/urls.ts";
import type { Clock } from "../runtime/types.ts";
import { WebSearchError, isWebSearchError } from "../runtime/error-codes.ts";
import type { Stage } from "../runtime/error-codes.ts";
import { fail, toFailure } from "../runtime/errors.ts";
import type {
  AiSummary,
  Engine,
  EngineId,
  EngineInteraction,
  Freshness,
  Query,
  RawSerp,
  SerpItem,
  Wall,
} from "./types.ts";

const ENGINE_ID: EngineId = "google";
const SEARCH_URL = "https://www.google.com/search";
const HOME_URL = "https://www.google.com/";

/**
 * The readiness gate: one structural check, no text marker.
 *
 * A text marker was the preferred shape, but Google offers no locale-neutral
 * *rendered* string for it: `hl` is the caller's choice, `settle()` never sees
 * `Query.lang`, and every always-present SERP string is localised
 * ("Результатов: примерно…", "About … results", the "Search Results" h1).
 * The verified capture shows the trap directly — `body.innerText` excludes the
 * header/account chrome, so even the brand word "Google" is not rendered text on
 * a SERP (it lives in `<title>` and in hidden menus), and the result-stats row is
 * absent on a legitimate zero-result SERP, which would turn a normal `E_EMPTY`
 * into a bogus `E_TIMEOUT`.
 *
 * `#rso`/`#search` + `minCount` is language-neutral, exists on both a normal and
 * a zero-result SERP, and does not exist on the home page — the exact
 * "stale marker vs home page" trap `cdp/humanize.ts` warns about. An empty marker
 * is that module's documented "selector only" mode.
 */
const SERP_MARKER = "";
const SERP_SELECTOR = "#rso, #search";
const SERP_MIN_COUNT = 1;
/** Bounded wait; a page that is not ready in 8 s is a layout change or a wall. */
const SETTLE_DEADLINE_MS = 8_000;

/** Google pages on a desktop SERP: 10 organics per `start` step. */
const RESULTS_PER_PAGE = 10;
/** `n` on the tool is capped at 10 (SPEC §7.1); the adapter clamps defensively. */
const MAX_RESULTS = 10;
const DEFAULT_N = 5;
/** A page number that is not a positive integer means page 1. */
const FIRST_PAGE = 1;

/** `hl`/`gl` accept a BCP-47-ish code; anything else (including "auto") is dropped. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;
const FRESHNESS_VALUES: readonly Freshness[] = ["d", "w", "m", "y"];

// ---------------------------------------------------------------------------
// Wall markers (exact fragments, reported verbatim in `Wall.markers`)
// ---------------------------------------------------------------------------

const SORRY_URL_MARKER = "/sorry";
const SORRY_TEXT_MARKERS: readonly string[] = ["unusual traffic", "подозрительный трафик"];
const CONSENT_HOST_MARKER = "consent.google.com";
const CONSENT_TEXT_MARKERS: readonly string[] = [
  "Before you continue to Google",
  "Прежде чем перейти в Google",
];
/**
 * Only exact captcha phrases and the captcha URL. Broader fragments ("не
 * робот", "recaptcha") would fire on a SERP whose snippets *discuss* robots or
 * reCAPTCHA, turning a normal search into a false E_WALL.
 */
const CAPTCHA_TEXT_MARKERS: readonly string[] = ["Я не робот", "I'm not a robot"];
const CAPTCHA_URL_MARKER = "/recaptcha";

// ---------------------------------------------------------------------------
// In-page contracts (types only; the functions are plain browser JS)
// ---------------------------------------------------------------------------

export interface ExtractArgument {
  /** Max organics to return; the page may have carried more. */
  n: number;
  /** Extract the native AI Overview when the page has one. */
  summary: boolean;
  /** Echoed back by the wrapper; extraction itself does not depend on it. */
  query: string;
}

export interface ExtractedSerp {
  results: SerpItem[];
  ai?: AiSummary;
  pageCarried: boolean;
}

/**
 * Named keys so the doctor output is self-describing, plus an index signature
 * because `Engine.canaries()` returns an open-ended `Record<string, number>`
 * (other engines add their own keys).
 */
export interface CanaryCounts {
  /** `a h3` anchors: one per organic result on a normal SERP. */
  organics: number;
  /** `section` blocks whose text carries the AI Overview label. */
  aiBlock: number;
  /** `#rso`/`#search` containers: present on a real SERP, including an empty one. */
  resultsContainer: number;
  [canary: string]: number;
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function languageCode(value: string | undefined): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "" || !LANGUAGE_CODE.test(trimmed)) return "";
  return trimmed.toLowerCase();
}

/** Page 1 is the default and is not encoded; a hostile value degrades to 1. */
function pageNumber(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return FIRST_PAGE;
  return Math.max(FIRST_PAGE, Math.floor(value));
}

function freshnessOf(value: Freshness | undefined): Freshness | undefined {
  return value !== undefined && FRESHNESS_VALUES.includes(value) ? value : undefined;
}

/**
 * Pure and deterministic: the same `Query` always yields the same string (no
 * clock, no config, no random experiment bucket). Parameter order is fixed by
 * insertion so two equal queries cannot differ byte-wise.
 */
function buildSearchUrl(q: Query): string {
  const params = new URLSearchParams();
  params.set("q", typeof q.text === "string" ? q.text : "");

  const language = languageCode(q.lang);
  if (language !== "") params.set("hl", language);
  const region = languageCode(q.region);
  if (region !== "") params.set("gl", region);

  const page = pageNumber(q.page);
  if (page > FIRST_PAGE) params.set("start", String(RESULTS_PER_PAGE * (page - FIRST_PAGE)));

  const freshness = freshnessOf(q.freshness);
  if (freshness !== undefined) params.set("tbs", `qdr:${freshness}`);

  return `${SEARCH_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Attach the engine to a failure so `/web-doctor` and the artifact directory
 * can name it. A `WebSearchError` already has a precise code + stage (the
 * humanize layer produces E_TIMEOUT/E_CANCELLED); anything else from the CDP
 * surface is a dropped socket, never a parse verdict.
 */
function asEngineFailure(error: unknown, stage: Stage): WebSearchError {
  if (isWebSearchError(error)) {
    if (error.details.engine !== undefined) return error;
    return new WebSearchError({ ...error.details, engine: ENGINE_ID });
  }
  const details = toFailure(error, { code: "E_CDP_DISCONNECTED", stage });
  return new WebSearchError({ ...details, engine: ENGINE_ID });
}

// ---------------------------------------------------------------------------
// In-page extractor — self-contained, serialised into the page
// ---------------------------------------------------------------------------

/**
 * Read one Google SERP out of `document`.
 *
 * Self-containment rules (enforced by tests): no imports, no closures, no
 * module constants, no `innerText`. Only the two parameters and literals.
 */
export function extractFromDocument(doc: Document, arg: ExtractArgument): ExtractedSerp {
  const AI_LABELS = ["Обзор от ИИ", "AI Overview"];
  const AI_LEAD_PREFIXES = ["Ответ режима ИИ:", "Ответ в режиме ИИ:", "AI Mode answer:", "AI Mode:"];
  /**
   * Trailing control block of the AI Overview. "Подробнее…" carries the ellipsis
   * on purpose: the answer prose legitimately contains "Подробнее об истории…",
   * so a bare "Подробнее" would cut the answer mid-sentence.
   */
  const AI_TRAILING_MARKERS = [
    "Подробнее…",
    "Подробнее...",
    "Скопировано в буфер обмена",
    "About this result",
    "Show more",
  ];
  const AD_LABELS = ["Реклама", "Sponsored", "Ads", "Ad"];
  /**
   * Not the module constants: this function runs in the page, where `DEFAULT_N`
   * and `MAX_RESULTS` above do not exist. Repeating the numbers here is the cost
   * of `toString()`-based evaluation, and the closure test fails loudly if this
   * is ever forgotten.
   */
  const DEFAULT_N = 5;
  const MAX_RESULTS = 10;
  const MIN_AI_CHARS = 40;
  /** Megabyte guard only: the 1200-char display cap belongs to extract/compact.ts. */
  const MAX_AI_CHARS = 20_000;
  const MAX_TITLE_CHARS = 300;
  const MAX_SNIPPET_CHARS = 1_000;
  const MAX_SOURCES = 8;
  const MIN_BODY_CHARS = 80;

  const base = doc.baseURI || (doc.location ? doc.location.href : "") || "";

  function normalize(value: string | null): string {
    return (value === null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function clampText(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
  }

  /**
   * Prose-only text of a node.
   *
   * `textContent` includes the text of <style>/<script> children, and a live
   * AI Overview nests its answer right next to an inline <style> block. Ranking
   * descendants by `textContent.length` therefore picked the stylesheet
   * (".A3ySSe{padding:10px}…") over the answer and shipped CSS to the model.
   * `innerText` is not available in the fixture DOM (linkedom) and would apply
   * CSS visibility rules an adapter must not interpret, so the skip list is
   * explicit. A skipped element leaves whitespace behind, so two neighbouring
   * prose nodes are never glued into one word.
   */
  function visibleText(node: Node | null): string {
    const SKIP_TAGS = ["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "SVG", "LINK", "META"];
    const parts: string[] = [];
    function walk(current: Node | null): void {
      if (current === null) return;
      if (current.nodeType === 3) {
        parts.push(current.nodeValue === null ? "" : current.nodeValue);
        return;
      }
      if (current.nodeType !== 1) return;
      const element = current as Element;
      if (SKIP_TAGS.indexOf(element.tagName.toUpperCase()) !== -1) {
        parts.push(" ");
        return;
      }
      const children = current.childNodes;
      for (let index = 0; index < children.length; index += 1) walk(children[index]);
    }
    walk(node);
    return normalize(parts.join(""));
  }

  /** `{padding:10px}` / `{a:1}` — a declaration run, not prose with a brace pair. */
  function isDeclarationBlock(value: string): boolean {
    if (value.length < 3 || value.charAt(0) !== "{" || value.charAt(value.length - 1) !== "}") return false;
    const inner = value.slice(1, value.length - 1);
    if (inner.trim() === "" || inner.indexOf("{") !== -1 || inner.indexOf("}") !== -1) return false;
    let properties = 0;
    for (const part of inner.split(";")) {
      const piece = part.trim();
      if (piece === "") continue;
      if (!/^-{0,2}[a-zA-Z][a-zA-Z0-9-]*\s*:\s*\S/.test(piece)) return false;
      properties += 1;
    }
    return properties > 0;
  }

  /**
   * Cut a CSS/JS declaration prefix that survived `visibleText` (rules shipped
   * as bare text, or a wrapper the extractor cannot classify). Only a *prefix*
   * is cut: normal prose that merely contains a brace pair mid-sentence is left
   * exactly as it is.
   */
  function stripDeclarationResidue(value: string): string {
    let out = value;
    let cut = 0;
    const RULE = /^[.#][^{}]{0,80}\{[^{}]*\}/;
    for (let guard = 0; guard < 64; guard += 1) {
      const rest = out.slice(cut).replace(/^\s+/, "");
      // `out.length - rest.length` is the offset of `rest` inside `out`.
      const offset = out.length - rest.length;
      const rule = RULE.exec(rest);
      if (rule !== null) {
        cut = offset + rule[0].length;
        continue;
      }
      const block = /^\{[^{}]*\}/.exec(rest);
      if (block !== null && isDeclarationBlock(block[0])) {
        cut = offset + block[0].length;
        continue;
      }
      break;
    }
    out = cut > 0 ? out.slice(cut).trim() : out;
    if (out === "") return "";

    // A tag/attribute selector in front of the first declaration block ("div{margin:0}")
    // is still residue; anything containing whitespace is prose and is kept.
    const head = out.slice(0, 200);
    const open = head.indexOf("{");
    if (open > 0) {
      const selector = head.slice(0, open).trim();
      if (/^[.#*[\]a-zA-Z][^{}\s]{0,40}$/.test(selector)) {
        let lastEnd = -1;
        const blocks = /\{[^{}]*\}/g;
        let match = blocks.exec(head);
        while (match !== null) {
          if (isDeclarationBlock(match[0])) lastEnd = match.index + match[0].length;
          match = blocks.exec(head);
        }
        if (lastEnd > 0) out = out.slice(lastEnd).trim();
      }
    }
    return out.replace(/^[;,}\s]+/, "").trim();
  }

  function absoluteUrl(href: string | null): URL | null {
    const raw = (href === null ? "" : href).trim();
    // A fragment-only href points at the SERP itself, not at a result.
    if (raw === "" || raw.charAt(0) === "#") return null;
    try {
      return base === "" ? new URL(raw) : new URL(raw, base);
    } catch {
      return null;
    }
  }

  function isWebUrl(url: URL): boolean {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  function isGoogleOwned(host: string): boolean {
    return (
      host === "google.com" ||
      host.endsWith(".google.com") ||
      /^google\.[a-z]{2,3}(\.[a-z]{2,3})?$/.test(host) ||
      host === "gstatic.com" ||
      host.endsWith(".gstatic.com") ||
      host.endsWith(".googleusercontent.com")
    );
  }

  /**
   * The ad badge is a leaf element whose *whole* text is the badge. Matching a
   * snippet that merely mentions "реклама" would drop a legitimate result, so
   * only exact labels count.
   */
  function hasAdBadge(scope: Element): boolean {
    for (const node of Array.from(scope.querySelectorAll("span, div, b"))) {
      if (node.children.length > 0) continue;
      if (AD_LABELS.indexOf(visibleText(node)) !== -1) return true;
    }
    return false;
  }

  function isSponsored(anchor: Element, heading: Element, container: Element | null): boolean {
    const scope = container === null ? anchor : container;
    // Google marks an ad block with data-text-ad or the uEierd class; either one
    // makes the whole subtree an ad, including sitelinks with their own h3s.
    if (scope.closest("[data-text-ad]") !== null) return true;
    if (anchor.closest(".uEierd") !== null || heading.closest(".uEierd") !== null) return true;
    return hasAdBadge(scope);
  }

  function findAiSection(): Element | null {
    for (const section of Array.from(doc.querySelectorAll("section"))) {
      const text = visibleText(section);
      if (text === "") continue;
      for (const label of AI_LABELS) {
        if (text.indexOf(label) !== -1) return section;
      }
    }
    return null;
  }

  function stripAiLead(text: string): string {
    let out = text;
    for (const label of AI_LABELS) {
      if (out.indexOf(label) === 0) {
        out = out.slice(label.length);
        break;
      }
    }
    out = out.trim();
    for (const prefix of AI_LEAD_PREFIXES) {
      if (out.indexOf(prefix) === 0) {
        out = out.slice(prefix.length);
        break;
      }
    }
    return out.trim();
  }

  function cutTrailingControls(text: string): string {
    let out = text;
    for (const marker of AI_TRAILING_MARKERS) {
      const index = out.indexOf(marker);
      if (index !== -1 && index < out.length) out = out.slice(0, index);
    }
    return out;
  }

  /**
   * True when `scope` holds its own label/lead heading ("Обзор от ИИ",
   * "Ответ режима ИИ:"). The label sits in a leaf element next to the prose, so
   * a wrapper that contains it also contains the sources carousel and the
   * feedback footer — exactly the blocks that must not reach the model.
   */
  function hasControlHeading(scope: Element): boolean {
    for (const node of Array.from(scope.querySelectorAll("h1, h2, h3, h4, div, span"))) {
      if (node.children.length > 0) continue;
      const text = visibleText(node);
      if (text === "") continue;
      if (AI_LABELS.indexOf(text) !== -1) return true;
      for (const prefix of AI_LEAD_PREFIXES) {
        if (text === prefix) return true;
      }
    }
    return false;
  }

  /**
   * The answer prose is the biggest descendant of the AI block that carries
   * neither the trailing controls nor the label heading. Taking the section text
   * verbatim would ship the sources carousel, the like/dislike footer and the
   * share dialog to the model; the structural pick keeps the answer only.
   *
   * Ranking is by `visibleText`, not `textContent`: a live Overview nests an
   * inline <style> block inside the wrapper, and raw text length would make
   * that stylesheet win. Falls back to a text cut when no such chunk exists (a
   * layout that nests the controls inside the prose wrapper).
   */
  function aiAnswerText(section: Element): string {
    const full = visibleText(section);
    let body = "";
    for (const node of Array.from(section.querySelectorAll("div, section, article"))) {
      const text = visibleText(node);
      if (text.length <= body.length) continue;
      let carriesControls = false;
      for (const marker of AI_TRAILING_MARKERS) {
        if (text.indexOf(marker) !== -1) {
          carriesControls = true;
          break;
        }
      }
      if (carriesControls || hasControlHeading(node)) continue;
      body = text;
    }
    let text = body.length >= MIN_BODY_CHARS ? body : stripAiLead(cutTrailingControls(full));
    text = stripDeclarationResidue(text);
    text = stripAiLead(text);
    return clampText(text, MAX_AI_CHARS).trim();
  }

  /** Visible citation domains; never fabricated, Google-owned chrome excluded. */
  function aiSources(section: Element): string[] {
    const sources: string[] = [];
    const seen = new Set<string>();
    for (const anchor of Array.from(section.querySelectorAll("a"))) {
      const url = absoluteUrl(anchor.getAttribute("href"));
      if (url === null || !isWebUrl(url)) continue;
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "" || isGoogleOwned(host) || seen.has(host)) continue;
      seen.add(host);
      sources.push(host);
      if (sources.length >= MAX_SOURCES) break;
    }
    return sources;
  }

  const requested = Number.isFinite(arg.n) ? Math.floor(arg.n) : DEFAULT_N;
  const limit = requested < 1 ? 1 : requested > MAX_RESULTS ? MAX_RESULTS : requested;

  const results: SerpItem[] = [];
  const seenUrls = new Set<string>();
  let organics = 0;

  for (const heading of Array.from(doc.querySelectorAll("a h3"))) {
    const anchor = heading.closest("a");
    if (anchor === null) continue;
    const container =
      anchor.closest("div[data-hveid]") ?? heading.closest("div[data-hveid]") ?? anchor.parentElement;
    if (isSponsored(anchor, heading, container)) continue;

    const title = clampText(visibleText(heading), MAX_TITLE_CHARS);
    if (title === "") continue;

    const url = absoluteUrl(anchor.getAttribute("href"));
    if (url === null || !isWebUrl(url)) continue;
    const href = url.href;
    if (seenUrls.has(href)) continue;
    seenUrls.add(href);

    const snippetNode = container === null ? null : container.querySelector(".VwiC3b, [data-sncf]");
    const snippet = clampText(snippetNode === null ? "" : visibleText(snippetNode), MAX_SNIPPET_CHARS);

    organics += 1;
    if (results.length < limit) results.push({ title, url: href, snippet });
  }

  let ai: AiSummary | undefined;
  if (arg.summary === true) {
    const section = findAiSection();
    if (section !== null) {
      const text = aiAnswerText(section);
      // A label with no prose is not a summary; returning it would invent one.
      if (text.length >= MIN_AI_CHARS) ai = { text, sources: aiSources(section) };
    }
  }

  const pageCarried = organics > results.length;
  return ai === undefined ? { results, pageCarried } : { results, ai, pageCarried };
}

// ---------------------------------------------------------------------------
// In-page canaries — self-contained as well
// ---------------------------------------------------------------------------

/**
 * Selector census for the doctor. A zero is a `layout_changed` signal, not an
 * error: an empty SERP and a broken selector look the same here and the doctor
 * exists to show the difference next to a live result.
 *
 * The AI labels are literals again on purpose: this function is stringified,
 * so it cannot share them with `extractFromDocument`.
 */
export function canaryCountsFromDocument(doc: Document): CanaryCounts {
  const AI_LABELS = ["Обзор от ИИ", "AI Overview"];
  const body = doc.body;
  if (body === null || body === undefined) return { organics: 0, aiBlock: 0, resultsContainer: 0 };

  let aiBlock = 0;
  for (const section of Array.from(doc.querySelectorAll("section"))) {
    const text = (section.textContent === null ? "" : section.textContent).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    for (const label of AI_LABELS) {
      if (text.indexOf(label) !== -1) {
        aiBlock += 1;
        break;
      }
    }
  }

  return {
    organics: doc.querySelectorAll("a h3").length,
    aiBlock,
    resultsContainer: doc.querySelectorAll("#rso, #search").length,
  };
}

// ---------------------------------------------------------------------------
// Module-side adapters
// ---------------------------------------------------------------------------

export interface GoogleSettleOptions {
  /**
   * Clock seam for offline tests (the same pattern `cdp/humanize.ts` uses).
   * Production passes only the signal: the system clock, i.e. real deadlines.
   */
  clock?: Clock;
  /** Override the bounded deadline; defaults to 8 s. */
  deadlineMs?: number;
  /** Override the base poll before jitter. */
  pollMs?: number;
}

/**
 * Wait until the SERP is ready: the text marker plus `minCount` of the results
 * containers. The deadline is bounded and an abort propagates as E_CANCELLED;
 * nothing here sleeps for a fixed amount or retries.
 */
export async function settleGoogleSerp(
  page: CdpPage,
  signal?: AbortSignal,
  options: GoogleSettleOptions = {},
): Promise<void> {
  try {
    await waitForMarker(page, {
      marker: SERP_MARKER,
      selector: SERP_SELECTOR,
      minCount: SERP_MIN_COUNT,
      deadlineMs: options.deadlineMs ?? SETTLE_DEADLINE_MS,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw asEngineFailure(error, "settle");
  }
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Classify a wall from the current URL and visible text.
 *
 * Order matters: Google's `/sorry` page also renders a reCAPTCHA widget and the
 * words "not a robot", so a `captcha` verdict would lose the actionable fact
 * (rate-limited) and send the user to the wrong remedy. The returned markers are
 * the exact fragments that fired, for artifacts and `web_doctor`.
 */
function detectWallFromPage(url: string, text: string): Wall | null {
  const parsed = parseUrl(url);
  const host = parsed === null ? "" : parsed.hostname.toLowerCase();
  const path = parsed === null ? "" : parsed.pathname.toLowerCase();
  const haystack = text.toLowerCase();

  const sorryMarkers: string[] = [];
  if (path.indexOf(SORRY_URL_MARKER) === 0) sorryMarkers.push(SORRY_URL_MARKER);
  for (const marker of SORRY_TEXT_MARKERS) {
    if (haystack.indexOf(marker.toLowerCase()) !== -1) sorryMarkers.push(marker);
  }
  if (sorryMarkers.length > 0) return { kind: "sorry", url, markers: sorryMarkers };

  const consentMarkers: string[] = [];
  if (host === CONSENT_HOST_MARKER || host.endsWith(`.${CONSENT_HOST_MARKER}`)) {
    consentMarkers.push(CONSENT_HOST_MARKER);
  }
  for (const marker of CONSENT_TEXT_MARKERS) {
    if (haystack.indexOf(marker.toLowerCase()) !== -1) consentMarkers.push(marker);
  }
  if (consentMarkers.length > 0) return { kind: "consent", url, markers: consentMarkers };

  const captchaMarkers: string[] = [];
  if (path.indexOf(CAPTCHA_URL_MARKER) !== -1) captchaMarkers.push(CAPTCHA_URL_MARKER);
  for (const marker of CAPTCHA_TEXT_MARKERS) {
    if (haystack.indexOf(marker.toLowerCase()) !== -1) captchaMarkers.push(marker);
  }
  if (captchaMarkers.length > 0) return { kind: "captcha", url, markers: captchaMarkers };

  return null;
}

async function detectGoogleWall(page: CdpPage): Promise<Wall | null> {
  const url = page.url();
  let text = "";
  try {
    text = await page.innerText();
  } catch (error) {
    throw asEngineFailure(error, "extract");
  }
  return detectWallFromPage(url, text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The payload crosses a CDP boundary, so it is validated as plain JSON, never cast. */
function asSerpItem(value: unknown): SerpItem | null {
  if (!isRecord(value)) return null;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const url = typeof value.url === "string" ? value.url : "";
  const snippet = typeof value.snippet === "string" ? value.snippet.trim() : "";
  if (title === "" || !isHttpUrl(url)) return null;
  return { title, url, snippet };
}

function asAiSummary(value: unknown): AiSummary | undefined {
  if (!isRecord(value)) return undefined;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (text === "") return undefined;
  const sources = Array.isArray(value.sources)
    ? value.sources.filter((source): source is string => typeof source === "string" && source !== "")
    : [];
  return { text, sources };
}

function asExtractedSerp(value: unknown): ExtractedSerp | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null;
  const results: SerpItem[] = [];
  for (const item of value.results) {
    const parsed = asSerpItem(item);
    if (parsed !== null) results.push(parsed);
  }
  const ai = asAiSummary(value.ai);
  return {
    results,
    ...(ai === undefined ? {} : { ai }),
    pageCarried: value.pageCarried === true,
  };
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_N;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value)));
}

async function extractGoogleSerp(page: CdpPage, q: Query): Promise<RawSerp> {
  const started = Date.now();
  const arg: ExtractArgument = {
    n: normalizeLimit(q.n),
    summary: q.summary === true,
    query: typeof q.text === "string" ? q.text : "",
  };

  let raw: unknown;
  try {
    raw = await page.evaluate<unknown>(`(${extractFromDocument})(document, ${JSON.stringify(arg)})`);
  } catch (error) {
    throw asEngineFailure(error, "extract");
  }

  const payload = asExtractedSerp(raw);
  if (payload === null) {
    throw fail("E_PARSE", "extract", {
      engine: ENGINE_ID,
      message: "google extractor returned no usable payload",
    });
  }

  return {
    engine: ENGINE_ID,
    query: arg.query,
    ...(payload.ai === undefined ? {} : { ai: payload.ai }),
    results: payload.results,
    pageCarried: payload.pageCarried,
    timings: { extractMs: Date.now() - started },
  };
}

function asCanaryCounts(value: unknown): CanaryCounts | null {
  if (!isRecord(value)) return null;
  const organics = value.organics;
  const aiBlock = value.aiBlock;
  const resultsContainer = value.resultsContainer;
  if (typeof organics !== "number" || typeof aiBlock !== "number" || typeof resultsContainer !== "number") {
    return null;
  }
  return { organics, aiBlock, resultsContainer };
}

/**
 * Selector census for the doctor. A payload the page cannot produce is reported
 * as zeros (a `layout_changed` signal) instead of throwing: canaries are a
 * diagnostic, and a diagnostic that throws hides the very state it measures.
 * A transport failure still propagates — that is not a layout question.
 */
async function googleCanaries(page: CdpPage): Promise<Record<string, number>> {
  let raw: unknown;
  try {
    raw = await page.evaluate<unknown>(`(${canaryCountsFromDocument})(document)`);
  } catch (error) {
    throw asEngineFailure(error, "extract");
  }
  const counts = asCanaryCounts(raw) ?? { organics: 0, aiBlock: 0, resultsContainer: 0 };
  return counts;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const GOOGLE_INTERACTION: EngineInteraction = Object.freeze({
  homeUrl: HOME_URL,
  // The SERP box is a <textarea> since the 2023 layout; the legacy <input> is
  // kept second so a partial rollout still types instead of falling back to the
  // direct SERP URL.
  boxSelectors: Object.freeze(['textarea[name="q"]', 'input[name="q"]']),
  marker: SERP_MARKER,
  selector: SERP_SELECTOR,
  minCount: SERP_MIN_COUNT,
});

/**
 * `satisfies` (not `: Engine`) keeps the concrete types, so tests can call
 * `settleGoogleSerp`'s clock options through `googleEngine.settle`; the object
 * still satisfies the frozen contract and drops into `DEFAULT_ENGINES` as is.
 */
export const googleEngine = {
  id: ENGINE_ID,
  interaction: GOOGLE_INTERACTION,
  buildUrl: buildSearchUrl,
  settle: settleGoogleSerp,
  detectWall: detectGoogleWall,
  extract: extractGoogleSerp,
  canaries: googleCanaries,
} satisfies Engine;
