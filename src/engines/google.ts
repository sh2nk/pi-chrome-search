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
import { systemClock } from "../runtime/clock.ts";
import type { Clock } from "../runtime/types.ts";
import { WebSearchError, isWebSearchError } from "../runtime/error-codes.ts";
import type { Stage } from "../runtime/error-codes.ts";
import { fail, toFailure } from "../runtime/errors.ts";
import type {
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
const SERP_CONTAINER_SELECTOR = "#rso, #search";
/**
 * Wall containers, part of the readiness gate on purpose.
 *
 * A `/sorry` page and the consent interstitial have no `#rso`/`#search`, so a
 * settle that knew only the SERP shell would burn its whole deadline there and
 * report `E_TIMEOUT` — the one verdict that hides both the cause and the remedy.
 * A wall settles in one poll and `detectWall` does the classification; the probe
 * below corroborates with the very same nodes, so settle and classify can never
 * disagree about what a wall looks like.
 *
 * `#captcha-form` is the real `/sorry` form, `#recaptcha`/`.g-recaptcha` are the
 * widget shapes (the fixture renders `#recaptcha`), and the consent form selector
 * is verified against `tests/fixtures/google-consent.html.gz`
 * (`<form action="https://consent.google.com/save">`).
 */
const WALL_CONTAINER_SELECTOR =
  '#captcha-form, #recaptcha, .g-recaptcha, form[action*="consent.google.com"]';
/** Everything `settle()` accepts as "the page rendered something we can classify". */
const READY_SELECTOR = `${SERP_CONTAINER_SELECTOR}, ${WALL_CONTAINER_SELECTOR}`;
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
/**
 * YouTube sends its viewers through the same interstitial on a different host;
 * a Google search can land there through a video result, so the host is wall
 * evidence for this adapter as well.
 */
const CONSENT_YOUTUBE_HOST_MARKER = "consent.youtube.com";
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
  /**
   * Probe mode (PLAN-v2 P8-A): measure the AI block and skip the result scan.
   * Same code path as a full extraction, so the probe can never disagree with
   * what `extract()` would report.
   */
  aiOnly?: boolean;
}

export interface ExtractedAi {
  text: string;
  sources: string[];
  state: "answer" | "lead";
}

export interface ExtractedSerp {
  results: SerpItem[];
  ai?: ExtractedAi;
  /** Present only for an `aiOnly` call. */
  aiProbe?: { state: "answer" | "lead" | "none"; chars: number };
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
  /** `section` blocks whose AI label sits in a heading leaf. */
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
  /**
   * The lead line is a query echo ("Ответ в режиме ИИ, исходный запрос: …").
   * The comma forms are the ones seen live; the colon forms cover the older
   * capture. Both are stripped so the lead text is not mistaken for prose.
   */
  const AI_LEAD_PREFIXES = [
    "Ответ режима ИИ:",
    "Ответ в режиме ИИ:",
    "Ответ режима ИИ,",
    "Ответ в режиме ИИ,",
    "AI Mode answer:",
    "AI Mode answer,",
    "AI Mode:",
  ];
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
  /**
   * PLAN-v2 V8.1: `ai:yes` means at least this much answer prose. A shorter
   * fragment is reported as `lead`, never as an answer. Literal because this
   * function is stringified (see the closure test).
   */
  const MIN_ANSWER_CHARS = 200;
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

  /**
   * `{padding:10px}` / `{margin:0}` — a declaration run, not prose with a brace
   * pair.
   *
   * `{a: 1}` used to qualify, so a sentence that opens with a JavaScript object
   * literal lost its first characters. Two properties separate the shapes: CSS
   * writes the colon with no space before it, and no CSS property is a single
   * letter (`margin`, `padding`, `display`, `--custom`). A one-letter key plus
   * `: ` is the JS-object-in-prose shape and stays in the answer.
   */
  function isDeclarationBlock(value: string): boolean {
    if (value.length < 3 || value.charAt(0) !== "{" || value.charAt(value.length - 1) !== "}") return false;
    const inner = value.slice(1, value.length - 1);
    if (inner.trim() === "" || inner.indexOf("{") !== -1 || inner.indexOf("}") !== -1) return false;
    let properties = 0;
    for (const part of inner.split(";")) {
      const piece = part.trim();
      if (piece === "") continue;
      // No whitespace before the colon; the name is at least two characters
      // (every real CSS property, vendor-prefixed or `--custom`, is), so a
      // one-letter JS key such as `{a: 1}` is not a declaration run.
      if (!/^(?:--[a-zA-Z][a-zA-Z0-9-]*|-?[a-zA-Z][a-zA-Z0-9-]+):\s*\S[^;]*$/.test(piece)) return false;
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

  /**
   * The AI Overview label must be a heading, not any prose.
   *
   * The label used to count anywhere in a section's text, so an organic result
   * whose *snippet* discusses "AI Overview" was re-labelled as the answer — the
   * snippet's own link even became a "source". Two guards make the label
   * structural: it sits in a heading leaf (`h1`–`h4` or `[role="heading"]`), and a
   * section that carries organic result anchors (`a h3`) is a result block, never
   * the answer. The live capture puts the label in
   * `<div role="heading" aria-level="2"><strong>Обзор от ИИ</strong></div>`.
   */
  function findAiSection(): Element | null {
    const HEADING_SELECTOR = 'h1, h2, h3, h4, [role="heading"]';
    for (const section of Array.from(doc.querySelectorAll("section"))) {
      if (section.querySelectorAll("a h3").length > 0) continue;
      for (const heading of Array.from(section.querySelectorAll(HEADING_SELECTOR))) {
        const text = visibleText(heading);
        if (text === "") continue;
        for (const label of AI_LABELS) {
          if (text.indexOf(label) === 0) return section;
        }
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
  function aiAnswerText(section: Element): { text: string; state: "answer" | "lead" } {
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
    text = clampText(text, MAX_AI_CHARS).trim();
    // Two guards, one meaning: only wide prose is an answer. A block that shows
    // the lead echo, a prompt or a short fragment is a `lead` — the exact shape
    // that used to be rendered as `ai:yes`.
    const state = text.length >= MIN_ANSWER_CHARS ? "answer" : "lead";
    return { text, state };
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

  // Probe mode: measure the AI block only. Same helpers as the full path, so a
  // probe can never report readiness that extraction would not honour.
  if (arg.aiOnly === true) {
    if (arg.summary !== true) return { results: [], aiProbe: { state: "none", chars: 0 }, pageCarried: false };
    const probeSection = findAiSection();
    if (probeSection === null) return { results: [], aiProbe: { state: "none", chars: 0 }, pageCarried: false };
    const measured = aiAnswerText(probeSection);
    return { results: [], aiProbe: { state: measured.state, chars: measured.text.length }, pageCarried: false };
  }

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

  let ai: ExtractedAi | undefined;
  if (arg.summary === true) {
    const section = findAiSection();
    if (section !== null) {
      const measured = aiAnswerText(section);
      // A labelled section always reports *something*: an answer when it has
      // prose, otherwise an honest `lead` (possibly with empty text). Returning
      // nothing here is what let the old code claim an answer it did not have.
      ai = { text: measured.text, sources: aiSources(section), state: measured.state };
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
 * The AI labels and the visible-text walker are duplicated on purpose: this
 * function is stringified, so it cannot share them with `extractFromDocument`.
 * Matching on `textContent` reported `aiBlock: 1` for a `<script>` that merely
 * contained the label while `extract()` honestly returned `ai:no`; the census
 * must count what extraction would see, i.e. a label in a heading leaf.
 */
export function canaryCountsFromDocument(doc: Document): CanaryCounts {
  const AI_LABELS = ["Обзор от ИИ", "AI Overview"];
  const HEADING_SELECTOR = 'h1, h2, h3, h4, [role="heading"]';
  const body = doc.body;
  if (body === null || body === undefined) return { organics: 0, aiBlock: 0, resultsContainer: 0 };

  /** Same prose rules as the extractor: <style>/<script> text is not visible. */
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
    return parts.join("").replace(/\s+/g, " ").trim();
  }

  let aiBlock = 0;
  for (const section of Array.from(doc.querySelectorAll("section"))) {
    // A result block that mentions the label in a snippet is not an AI answer.
    if (section.querySelectorAll("a h3").length > 0) continue;
    for (const heading of Array.from(section.querySelectorAll(HEADING_SELECTOR))) {
      const text = visibleText(heading);
      if (text === "") continue;
      let labelled = false;
      for (const label of AI_LABELS) {
        if (text.indexOf(label) === 0) {
          labelled = true;
          break;
        }
      }
      if (labelled) {
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
// In-page wall evidence — self-contained as well
// ---------------------------------------------------------------------------

export interface WallEvidence {
  /** `a h3` anchors: a normal SERP has them, a wall page has none. */
  organics: number;
  /** Captcha containers that matched, by selector (diagnostics, not prose). */
  captcha: string[];
  /** Consent containers that matched, by selector. */
  consent: string[];
}

/**
 * The DOM half of the wall verdict.
 *
 * Wall phrases are not safe markers on their own: a snippet may quote "unusual
 * traffic", "Я не робот" or "Before you continue to Google", and a healthy SERP
 * would become `E_WALL`. Text therefore needs corroboration — a captcha/consent
 * node, the absence of organic results, or a wall URL — and this probe supplies
 * the node part. It returns selectors rather than prose so the verdict stays
 * diagnosable in artifacts and `web_doctor`.
 *
 * Self-contained like the extractor: stringified into `Runtime.evaluate`, so no
 * imports, no closures, no module constants.
 */
export function wallEvidenceFromDocument(doc: Document): WallEvidence {
  const CAPTCHA_SELECTORS = ["#captcha-form", ".g-recaptcha", "#recaptcha"];
  const CONSENT_SELECTORS = ['form[action*="consent.google.com"]'];
  const captcha: string[] = [];
  const consent: string[] = [];
  for (const selector of CAPTCHA_SELECTORS) {
    if (doc.querySelector(selector) !== null) captcha.push(selector);
  }
  for (const selector of CONSENT_SELECTORS) {
    if (doc.querySelector(selector) !== null) consent.push(selector);
  }
  return { organics: doc.querySelectorAll("a h3").length, captcha, consent };
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
 * Wait until the page is ready to classify: the SERP shell *or* a wall container
 * (see `READY_SELECTOR`). The deadline is bounded and an abort propagates as
 * E_CANCELLED; nothing here sleeps for a fixed amount or retries.
 */
export async function settleGoogleSerp(
  page: CdpPage,
  signal?: AbortSignal,
  options: GoogleSettleOptions = {},
): Promise<void> {
  try {
    await waitForMarker(page, {
      marker: SERP_MARKER,
      selector: READY_SELECTOR,
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

/** Text markers present in the haystack, reported verbatim (original casing). */
function textMarkers(haystack: string, markers: readonly string[]): string[] {
  const found: string[] = [];
  for (const marker of markers) {
    if (haystack.indexOf(marker.toLowerCase()) !== -1) found.push(marker);
  }
  return found;
}

/** Which consent host the page is on, as the reported marker (or null). */
function consentHostMarker(host: string): string | null {
  for (const marker of [CONSENT_HOST_MARKER, CONSENT_YOUTUBE_HOST_MARKER]) {
    if (host === marker || host.endsWith(`.${marker}`)) return marker;
  }
  return null;
}

/**
 * Classify a wall from the URL, the visible text and the DOM evidence.
 *
 * A text phrase alone is never enough: a snippet can quote every wall slogan
 * without the page being a wall, so a text marker must be corroborated by zero
 * organic results. URL evidence (`/sorry`, a consent host, `/recaptcha`) and a
 * captcha/consent DOM node stand on their own — they are what the page *is*,
 * not what it talks about.
 *
 * Order matters: Google's `/sorry` page also renders a reCAPTCHA widget and the
 * words "not a robot", so a `captcha` verdict would lose the actionable fact
 * (rate-limited) and send the user to the wrong remedy. The returned markers are
 * the exact fragments that fired, for artifacts and `web_doctor`.
 *
 * `evidence === null` means the probe could not run: no DOM corroboration, and
 * "zero organic results" is unknown rather than assumed.
 */
function detectWallFromPage(url: string, text: string, evidence: WallEvidence | null): Wall | null {
  const parsed = parseUrl(url);
  const host = parsed === null ? "" : parsed.hostname.toLowerCase();
  const path = parsed === null ? "" : parsed.pathname.toLowerCase();
  const haystack = text.toLowerCase();
  const organics = evidence === null ? null : evidence.organics;
  const emptySerp = organics === 0;
  const captchaNodes = evidence === null ? [] : evidence.captcha;
  const consentNodes = evidence === null ? [] : evidence.consent;

  const sorryUrl = path.indexOf(SORRY_URL_MARKER) === 0;
  const sorryText = textMarkers(haystack, SORRY_TEXT_MARKERS);
  if (sorryUrl || (emptySerp && sorryText.length > 0)) {
    return {
      kind: "sorry",
      url,
      markers: sorryUrl ? [SORRY_URL_MARKER, ...sorryText] : sorryText,
    };
  }

  const consentHost = consentHostMarker(host);
  const consentText = textMarkers(haystack, CONSENT_TEXT_MARKERS);
  if (consentHost !== null || consentNodes.length > 0 || (emptySerp && consentText.length > 0)) {
    return {
      kind: "consent",
      url,
      markers: [...(consentHost === null ? [] : [consentHost]), ...consentNodes, ...consentText],
    };
  }

  const captchaUrl = path.indexOf(CAPTCHA_URL_MARKER) !== -1;
  const captchaText = textMarkers(haystack, CAPTCHA_TEXT_MARKERS);
  if (captchaUrl || captchaNodes.length > 0 || (emptySerp && captchaText.length > 0)) {
    return {
      kind: "captcha",
      url,
      markers: [...(captchaUrl ? [CAPTCHA_URL_MARKER] : []), ...captchaNodes, ...captchaText],
    };
  }

  return null;
}

/** The probe payload crosses a CDP boundary, so it is validated as plain JSON. */
function asWallEvidence(value: unknown): WallEvidence | null {
  if (!isRecord(value)) return null;
  const organics = value.organics;
  if (typeof organics !== "number" || !Number.isFinite(organics)) return null;
  const selectorList = (input: unknown): string[] | null => {
    if (!Array.isArray(input)) return null;
    return input.filter((entry): entry is string => typeof entry === "string");
  };
  const captcha = selectorList(value.captcha);
  const consent = selectorList(value.consent);
  if (captcha === null || consent === null) return null;
  return { organics: Math.max(0, Math.floor(organics)), captcha, consent };
}

async function detectGoogleWall(page: CdpPage): Promise<Wall | null> {
  const url = page.url();
  let text = "";
  try {
    text = await page.innerText();
  } catch (error) {
    throw asEngineFailure(error, "extract");
  }
  let evidence: WallEvidence | null;
  try {
    const raw = await page.evaluate<unknown>(`(${wallEvidenceFromDocument})(document)`);
    evidence = asWallEvidence(raw);
  } catch (error) {
    throw asEngineFailure(error, "extract");
  }
  return detectWallFromPage(url, text, evidence);
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

function asAiState(value: unknown): "answer" | "lead" | undefined {
  return value === "answer" || value === "lead" ? value : undefined;
}

/**
 * The AI payload is untrusted JSON. `answer` requires prose; `lead` may be
 * empty (a labelled block with nothing in it yet), which is exactly what the
 * old code turned into a fabricated answer.
 */
function asAiSummary(value: unknown): ExtractedAi | undefined {
  if (!isRecord(value)) return undefined;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const declared = asAiState(value.state);
  if (declared === undefined) {
    // An older payload with no state: only non-empty text is reportable, and
    // compaction re-derives its state (so a short fragment becomes `lead`).
    if (text === "") return undefined;
  } else if (declared === "answer" && text === "") {
    return undefined;
  }
  const sources = Array.isArray(value.sources)
    ? value.sources.filter((source): source is string => typeof source === "string" && source !== "")
    : [];
  return declared === undefined ? { text, sources, state: "lead" } : { text, sources, state: declared };
}

function asAiProbe(value: unknown): { state: "answer" | "lead" | "none"; chars: number } | null {
  if (!isRecord(value)) return null;
  const state = value.state === "answer" || value.state === "lead" ? value.state : value.state === "none" ? "none" : null;
  if (state === null) return null;
  const chars = typeof value.chars === "number" && Number.isFinite(value.chars) ? Math.max(0, Math.floor(value.chars)) : 0;
  return { state, chars };
}

function asExtractedSerp(value: unknown): ExtractedSerp | null {
  if (!isRecord(value) || !Array.isArray(value.results)) return null;
  const results: SerpItem[] = [];
  for (const item of value.results) {
    const parsed = asSerpItem(item);
    if (parsed !== null) results.push(parsed);
  }
  const ai = asAiSummary(value.ai);
  const probe = asAiProbe(value.aiProbe);
  return {
    results,
    ...(ai === undefined ? {} : { ai }),
    ...(probe === null ? {} : { aiProbe: probe }),
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

/**
 * Cheap "what does the AI block show right now?" call for the streaming wait
 * (PLAN-v2 P8-A). It runs the *same* in-page extractor in `aiOnly` mode, so the
 * probe and the authoritative extraction can never disagree about state/width.
 */
async function probeGoogleAi(page: CdpPage): Promise<{ state: "answer" | "lead" | "none"; chars: number }> {
  const arg: ExtractArgument = { n: 0, summary: true, query: "", aiOnly: true };
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
      message: "google AI probe returned no usable payload",
    });
  }
  return payload.aiProbe ?? { state: "none", chars: 0 };
}

// ---------------------------------------------------------------------------
// Opt-in AI Overview expansion (visible click, default off)
// ---------------------------------------------------------------------------

/**
 * Centre of the AI Overview's own "Show more" control, or null.
 *
 * Self-contained for the same `toString()` reason as the extractor. The section
 * must carry an AI label: a page-wide "Показать все" belongs to the result list,
 * and clicking it would be a search interaction the caller never asked for.
 */
export function findAiExpandTarget(doc: Document): { x: number; y: number } | null {
  const WHITESPACE = /[\s\u00a0\u202f]+/g;
  const WANTED = ["показать все", "показать ещё", "показать полностью", "show more"];
  const AI_LABELS = ["Обзор от ИИ", "AI Overview"];
  const normalize = (value: string | null): string =>
    (value === null ? "" : value).replace(WHITESPACE, " ").trim().toLowerCase();

  for (const node of Array.from(doc.querySelectorAll('button, [role="button"], a'))) {
    const label = normalize(node.textContent);
    if (WANTED.indexOf(label) === -1) continue;
    const section = node.closest("section");
    if (section === null) continue;
    let labelled = false;
    for (const heading of Array.from(section.querySelectorAll('h1, h2, h3, h4, [role="heading"]'))) {
      const text = normalize(heading.textContent);
      if (text === "") continue;
      for (const aiLabel of AI_LABELS) {
        if (text.indexOf(aiLabel.toLowerCase()) === 0) {
          labelled = true;
          break;
        }
      }
      if (labelled) break;
    }
    if (!labelled) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return null;
}

export interface GoogleAiExpandOptions {
  /** Explicit opt-in: the caller decides, never extraction itself. */
  enabled?: boolean;
  /** After-click grace, default 500 ms. */
  waitMs?: number;
  clock?: Clock;
  signal?: AbortSignal;
}

const AI_EXPAND_WAIT_MS = 500;

function isPoint(value: unknown): value is { x: number; y: number } {
  if (!isRecord(value)) return false;
  return typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
}

/** One point click on the AI Overview's expand control; bounded, opt-in, never retried. */
export async function expandGoogleAiOnce(
  page: CdpPage,
  options: GoogleAiExpandOptions = {},
): Promise<boolean> {
  if (options.enabled !== true) return false;
  if (options.signal?.aborted === true) {
    throw fail("E_CANCELLED", "extract", {
      engine: ENGINE_ID,
      message: "aborted before expanding the AI Overview",
    });
  }
  const point = await page.evaluate<unknown>(`(${findAiExpandTarget.toString()})(document)`);
  if (!isPoint(point)) return false;
  await page.click({ x: point.x, y: point.y });
  const waitMs = options.waitMs ?? AI_EXPAND_WAIT_MS;
  if (waitMs > 0) await (options.clock ?? systemClock).sleep(waitMs, options.signal);
  return true;
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
  selector: READY_SELECTOR,
  minCount: SERP_MIN_COUNT,
  // P10-C: the box accepts long queries, but 200 code points is where the URL
  // length starts to be rewritten by Google; above it the pinned SERP is safer
  // than typing a query the engine silently edits.
  typeProfile: Object.freeze({
    box: 'textarea[name="q"]',
    maxChars: 200,
    keyDelayMs: Object.freeze([25, 55] as const),
  }),
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
  ai: {
    probe: probeGoogleAi,
    // The tool layer only calls this when `search.aiExpand` is true, which is
    // the opt-in; the wrapper keeps the adapter's explicit `enabled` guard.
    expand: (page: CdpPage, options?: { signal?: AbortSignal }) =>
      expandGoogleAiOnce(page, {
        enabled: true,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }),
  },
} satisfies Engine;
