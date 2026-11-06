/**
 * Yandex adapter (SPEC §6.2, PLAN P3-Yandex).
 *
 * What the 2026 desktop layout actually gives us (see `tests/fixtures/yandex-*.html.gz`
 * and `research/FINDINGS.md` §3):
 *
 *  - There is **no `li.serp-item`** any more. A result is `.Organic` holding
 *    `.OrganicTitle` (an anchor inside it, or the nearest anchor) and
 *    `.OrganicTextContentSpan` for the snippet. A normal SERP carries far more
 *    `.OrganicTitle` nodes than `h3` ones (17 vs 4 in the captured page), so `h3`
 *    is a title-level marker only, never the organic key.
 *  - Ads are served through Yandex redirect/counter hosts (`/an/count`,
 *    `/clck/jsredir`, `yabs.*`) and often (not always) carry a visible
 *    `Промо`/`Реклама` label in the card header. Both signals are checked, and
 *    the path fragments only count on a Yandex host: `example.com/clck/…` is a
 *    legitimate third-party path, not an ad redirect.
 *  - The AI card is `Futuris*` (`FuturisSearch`, `FuturisSearchCard`,
 *    `FuturisContentSection`). `data-fast-name="neuro_answer"` appears in some
 *    captures only, so it is a bonus signal, never the contract.
 *  - Captcha is a normal state (`/showcaptcha`, `SmartCaptcha`, "Я не робот").
 *    The adapter reports it; the tool layer surfaces the window, waits and may
 *    retry once (`retryOnWall`). Nobody clicks the checkbox.
 *
 * Extraction is a self-contained in-page function: live code sends
 * `(${extractFromDocument})(document, arg)` through `Runtime.evaluate`, tests run
 * the *same* source through `runInPage` in a `node:vm` context. It therefore
 * imports nothing, closes over nothing and uses `document.body.textContent`
 * (linkedom has no `innerText`) with explicit whitespace normalisation.
 */

import type { CdpPage } from "../cdp/types.ts";
import { waitForMarker } from "../cdp/humanize.ts";
import { normalizeUrl } from "../extract/urls.ts";
import { systemClock } from "../runtime/clock.ts";
import { fail } from "../runtime/errors.ts";
import type { Clock } from "../runtime/types.ts";
import type {
  AiSummary,
  Engine,
  EngineInteraction,
  Query,
  RawSerp,
  SerpItem,
  Wall,
} from "./types.ts";

/** A Yandex SERP appeared in ~5.5 s in the capture; 10 s leaves room for a slow page. */
const SETTLE_DEADLINE_MS = 10_000;
const SETTLE_POLL_MS = 200;
/** After the opt-in "Показать полностью" click the card needs a moment to unfold. */
const EXPAND_WAIT_MS = 500;

/**
 * Structural readiness gate.
 *
 * A text marker cannot work here: the only strings present on *every* Yandex SERP
 * are the chrome ones (`Найти`, `Поиск`, `Алиса AI`), and the home page has them
 * too — settling on them would resolve before the results loaded. A zero-result
 * SERP has no result text at all, so it would never settle. The selector list
 * below covers the three settled states (results, "Ничего не найдено", captcha)
 * and matches none of them on the home page; the captcha branch matters because
 * `web_search` re-settles after a wall retry and must not burn E_TIMEOUT there.
 */
export const YANDEX_READY_SELECTOR = ".OrganicTitle, .Misspell, .SmartCaptcha";

const BOX_SELECTORS: readonly string[] = Object.freeze([
  "#text",
  'input[name="text"]',
  'textarea[name="text"]',
]);

const INTERACTION: EngineInteraction = Object.freeze({
  // P10-D: `yandex.ru` warm-up redirects to Dzen often enough that the typed
  // path landed on a page with no search box. `ya.ru` is the same account/region
  // warm-up without the portal redirect; `homeHosts` keeps the redirect honest
  // if it happens anyway (the SERP host is unchanged).
  homeUrl: "https://ya.ru/",
  homeHosts: Object.freeze(["ya.ru", "yandex.ru"]),
  boxSelectors: BOX_SELECTORS,
  /**
   * Empty on purpose; `waitForMarker` supports "selector only" and the selector
   * above is the honest gate (see the comment on YANDEX_READY_SELECTOR).
   */
  marker: "",
  selector: YANDEX_READY_SELECTOR,
  minCount: 1,
  // P10-C: `#text` is the live box on both ya.ru and the SERP; the delay is the
  // slowest of the three (Yandex autocompletes while you type).
  typeProfile: Object.freeze({
    box: "#text",
    maxChars: 300,
    keyDelayMs: Object.freeze([25, 60] as const),
  }),
});

/**
 * Captcha markers, exactly as recorded in `Wall.markers`. `SmartCaptcha` and the
 * Russian sentences come from the fixture/`FINDINGS.md`; the URL marker is what a
 * live wall always shows.
 *
 * Deliberately absent: "Мы заметили необычную активность" — the AI card shows that
 * robot gate on perfectly normal SERPs (both AI fixtures contain it), so it is a
 * soft gate on one block, not a page wall.
 */
const CAPTCHA_URL_MARKERS: readonly string[] = Object.freeze(["/showcaptcha", "captcha.yandex"]);
const CAPTCHA_TEXT_MARKERS: readonly string[] = Object.freeze([
  "SmartCaptcha",
  "Я не робот",
  "Подтвердите, что запросы отправляли вы",
  "подозрительный трафик",
  "похожи на автоматические",
]);
/** "нет доступа" is a legit phrase in snippets, so it only counts with zero organics. */
const BLOCKED_TEXT_MARKERS: readonly string[] = Object.freeze([
  "нет доступа",
  "Доступ ограничен",
  "Запрос заблокирован",
]);

/**
 * A captcha widget in the DOM. This is what separates a real wall from a SERP
 * whose snippet merely quotes "SmartCaptcha" or "Я не робот".
 */
const CAPTCHA_NODE_SELECTOR = '.SmartCaptcha, [class*="SmartCaptcha"]';

const ORGANIC_COUNT_EXPRESSION = 'document.querySelectorAll(".OrganicTitle").length';
const CAPTCHA_NODE_EXPRESSION = `document.querySelectorAll(${JSON.stringify(CAPTCHA_NODE_SELECTOR)}).length`;

// ---------------------------------------------------------------------------
// In-page extraction (must stay self-contained: no imports, no closures)
// ---------------------------------------------------------------------------

export interface YandexExtractedItem {
  title: string;
  url: string;
  snippet: string;
}

export interface YandexExtractedAi {
  text: string;
  sources: string[];
  state: "answer" | "lead";
}

export interface YandexExtraction {
  results: YandexExtractedItem[];
  ai?: YandexExtractedAi;
  /** Present only for an `aiOnly` call. */
  aiProbe?: { state: "answer" | "lead" | "none"; chars: number };
  pageCarried: boolean;
}

export interface YandexExtractionArg {
  n: number;
  summary: boolean;
  query: string;
  /** Probe mode (P8-A): measure the AI card, skip the result scan. */
  aiOnly?: boolean;
}

/**
 * One-off in-page extractor. THE RULE: everything it needs lives inside the
 * function body, because only its `toString()` crosses the CDP boundary.
 *
 * Tracking-parameter hygiene is re-implemented here on purpose: `extract/urls.ts`
 * cannot be imported into a document context. The allow/deny list is the same one
 * (`utm_*`, `redircnt`, `from`, …), the fragment is dropped, and the canonical
 * sort happens again on the TS side through `normalizeUrl` — so the observable
 * result matches the shared contract without pretending this copy is the source
 * of truth.
 */
export function extractFromDocument(doc: Document, arg: YandexExtractionArg): YandexExtraction {
  const WHITESPACE = /[\s\u00a0\u202f]+/g;
  const BLOCK_TAGS = [
    "P",
    "DIV",
    "LI",
    "UL",
    "OL",
    "SECTION",
    "ARTICLE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "BLOCKQUOTE",
    "TABLE",
    "TR",
    "TD",
    "TH",
    "DL",
    "DT",
    "DD",
    "HEADER",
    "FOOTER",
    "FIGURE",
    "FIGCAPTION",
    "PRE",
    "FORM",
    "MAIN",
    "ASIDE",
    "NAV",
  ];
  const TRACKING_EXACT = [
    "gclid",
    "yclid",
    "fbclid",
    "msclkid",
    "mc_eid",
    "igshid",
    "ref_src",
    "spm",
    "_openstat",
    "from",
    "redircnt",
    "si",
    "sca_esv",
    "sxsrf",
  ];
  const AD_HREF_PATHS = ["jsredir", "/clck/", "/an/count"];
  /** Yandex ad counter family: `yabs.yandex.ru`, `yabs.yandex.com`, … */
  const AD_HOST_PREFIX = "yabs.";
  const AD_LABELS = ["промо", "реклама", "sponsored", "advertisement"];
  const AI_HEADER_HINTS = ["быстрый ответ", "нейро", "алиса ai"];
  /**
   * Answer-body candidates, most specific first. `[class*="FuturisContent"]` is
   * deliberately absent: on a teaser card it matches the whole card, which used
   * to ship the promo line as an answer. `FuturisAnswer` is the newer name seen
   * in some builds; the other two are the captured ones.
   */
  const AI_CONTENT_SELECTORS = [
    '[class*="FuturisContentSection"]',
    '[class*="FuturisGPTMessage"]',
    '[class*="FuturisAnswer"]',
  ];
  const LABEL_LINES = [
    "содержимое ответа",
    "быстрый ответ алисы ai",
    "быстрый ответ",
    "ответ",
    "показать полностью",
    "показать ответ",
    "свернуть",
    "источники",
    "источник",
  ];

  const normalize = (value: string | null | undefined): string =>
    (value === null || value === undefined ? "" : value).replace(WHITESPACE, " ").trim();

  const base = doc.baseURI !== "" ? doc.baseURI : doc.URL;

  /** http(s) only, tracking parameters removed, fragment dropped; null otherwise. */
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
      const lower = key.toLowerCase();
      if (TRACKING_EXACT.indexOf(lower) !== -1) return;
      if (lower.indexOf("utm_") === 0) return;
      kept.push([key, value]);
    });
    parsed.search = "";
    for (const [key, value] of kept) parsed.searchParams.append(key, value);
    parsed.hash = "";
    return parsed.href;
  };

  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  };

  const looksLikeHost = (value: string): boolean =>
    /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/.*)?$/i.test(value) && value.indexOf(" ") === -1;

  /**
   * Yandex's own hosts. Used twice: visible domain text in the AI card is chrome
   * (share/Alice links), never a source; and the ad path fragments below only
   * mean "ad" on these hosts.
   */
  const isYandexHost = (host: string): boolean =>
    host === "ya.ru" || host === "yandex.ru" || /(^|\.)yandex\.[a-z.]{2,}$/.test(host);

  /** Host of a visible domain line like `banki.ru` or `yandex.ru/alice`. */
  const hostOfText = (text: string): string =>
    hostOf(text.indexOf("://") === -1 ? `https://${text}` : text);

  /**
   * Yandex serves ads through redirect/counter URLs on its own hosts, so the
   * path fragments are checked only after the host check. Matching them
   * anywhere would drop a legitimate `https://example.com/clck/…` result.
   */
  const isAdHref = (href: string): boolean => {
    const trimmed = href.trim();
    if (trimmed === "") return false;
    let parsed: URL;
    try {
      parsed = new URL(trimmed, base === "" ? undefined : base);
    } catch {
      return false;
    }
    const host = hostOf(parsed.href);
    if (host.indexOf(AD_HOST_PREFIX) === 0) return true;
    if (!isYandexHost(host)) return false;
    const path = (parsed.pathname + parsed.search).toLowerCase();
    for (const fragment of AD_HREF_PATHS) {
      if (path.indexOf(fragment) !== -1) return true;
    }
    return false;
  };

  /** A visible `Промо`/`Реклама` leaf in the card marks the whole card as an ad. */
  const hasAdLabel = (card: Element): boolean => {
    for (const node of Array.from(card.querySelectorAll("*"))) {
      if (node.children.length > 0) continue;
      const label = normalize(node.textContent).toLowerCase();
      if (label === "") continue;
      for (const adLabel of AD_LABELS) {
        if (label === adLabel) return true;
      }
    }
    return false;
  };

  /**
   * Text as lines. `textContent` glues block siblings together
   * ("Первый абзацВторой абзац"), which is useless for dropping label/domain
   * lines, so blocks flush the buffer and inline nodes keep accumulating.
   * `<button>` subtrees are skipped: "Показать полностью" is a control, not an answer.
   */
  const textLines = (root: Element): string[] => {
    const lines: string[] = [];
    let buffer = "";
    const flush = (): void => {
      const line = normalize(buffer);
      if (line !== "") lines.push(line);
      buffer = "";
    };
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        buffer += node.nodeValue === null ? "" : node.nodeValue;
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      const tag = element.tagName.toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "BUTTON" || tag === "TEMPLATE") {
        return;
      }
      if (tag === "BR") {
        flush();
        return;
      }
      const block = BLOCK_TAGS.indexOf(tag) !== -1;
      if (block) flush();
      for (const child of Array.from(element.childNodes)) walk(child);
      if (block) flush();
    };
    walk(root);
    flush();
    return lines;
  };

  const isLabelLine = (line: string): boolean => {
    const lower = line.toLowerCase();
    if (LABEL_LINES.indexOf(lower) !== -1) return true;
    // An inline button label that got split across nodes ("Показать" + "полностью").
    const compact = lower.replace(WHITESPACE, "");
    return compact === "показатьполностью" || compact === "показатьответ";
  };

  /** Answer text: label lines, the h3 header and bare domain lines removed. */
  const answerText = (root: Element, header: Element): string => {
    const headerText = normalize(header.textContent).toLowerCase();
    const kept: string[] = [];
    for (const rawLine of textLines(root)) {
      let line = rawLine;
      const lower = line.toLowerCase();
      if (lower === headerText || isLabelLine(line)) continue;
      // "Содержимое ответа: сам ответ" — keep the part after the colon.
      const colon = line.indexOf(":");
      if (colon !== -1) {
        const prefix = normalize(line.slice(0, colon)).toLowerCase();
        if (LABEL_LINES.indexOf(prefix) !== -1) {
          line = normalize(line.slice(colon + 1));
          if (line === "") continue;
        }
      }
      if (looksLikeHost(line)) continue;
      kept.push(line);
    }
    return kept.join(" ");
  };

  /** Visible source names/domains only; a favicon-only citation contributes its host. */
  const collectSources = (card: Element): string[] => {
    const found: string[] = [];
    const seen: { [name: string]: boolean } = {};
    const push = (value: string): void => {
      const name = normalize(value).toLowerCase();
      if (name === "" || seen[name] === true || found.length >= 8) return;
      seen[name] = true;
      found.push(name);
    };
    for (const node of Array.from(card.querySelectorAll("*"))) {
      if (node.children.length > 0) continue;
      const text = normalize(node.textContent);
      if (!looksLikeHost(text)) continue;
      // A Yandex host line is the card's own chrome, not a cited source.
      if (isYandexHost(hostOfText(text))) continue;
      push(text);
    }
    for (const anchor of Array.from(card.querySelectorAll("a[href]"))) {
      const href = anchor.getAttribute("href");
      if (href === null) continue;
      const url = toHttpUrl(href);
      if (url === null) continue;
      const host = hostOf(url);
      if (host === "" || isYandexHost(host)) continue;
      const visible = normalize(anchor.textContent);
      push(looksLikeHost(visible) ? visible : host);
    }
    return found;
  };

  const findAiHeader = (): Element | null => {
    for (const header of Array.from(doc.querySelectorAll("h3"))) {
      const text = normalize(header.textContent).toLowerCase();
      if (text === "") continue;
      let hinted = false;
      for (const hint of AI_HEADER_HINTS) {
        if (text.indexOf(hint) !== -1) {
          hinted = true;
          break;
        }
      }
      if (!hinted) continue;
      // "Нейро" also occurs in ordinary result titles; the Futuris card is what
      // makes an h3 an AI label. `data-fast-name` is a bonus signal only.
      if (header.closest('[class*="Futuris"]') === null && header.closest("[data-fast-name]") === null) continue;
      return header;
    }
    return doc.querySelector('[data-fast-name="neuro_answer"]');
  };

  const isRobotGated = (card: Element): boolean => {
    if (card.querySelector('[class*="RobotGate"]') !== null) return true;
    // Captures with the gate hidden behind a class rename still say this sentence.
    return normalize(card.textContent).toLowerCase().indexOf("мы скрыли ответ") !== -1;
  };

  /**
   * `.FuturisContentSection-Label` contains the `FuturisContentSection` prefix
   * and sits before the answer inside the card. Taking it would leave only a
   * label line, which `answerText` then drops — and a real answer would vanish.
   */
  const isLabelNode = (node: Element): boolean =>
    /-label(?:$|[\s_])/i.test(node.getAttribute("class") ?? "");

  /**
   * The answer body, or null when the card carries chrome only (header, promo
   * teaser, robot-gate controls).
   *
   * There is deliberately **no fallback to the whole card**: a teaser says
   * "Задайте вопрос Алисе…" and shipping that as `ai.text` would be a fabricated
   * answer. No answer node means `ai:no`, which is a valid A/B outcome.
   */
  const findAnswerRoot = (card: Element, header: Element): Element | null => {
    for (const selector of AI_CONTENT_SELECTORS) {
      for (const node of Array.from(card.querySelectorAll(selector))) {
        if (isLabelNode(node)) continue;
        // A wrapper that owns the heading is chrome, not the answer body.
        if (node === header || node.contains(header)) continue;
        const text = normalize(node.textContent);
        if (text === "") continue;
        // A wrapper that only holds the label/heading is not the answer.
        if (node.querySelector("h3") !== null && text.length < 60) continue;
        return node;
      }
    }
    return null;
  };

  // A body with no text is a blank/odd page: return an honest empty SERP, never throw.
  const bodyElement = doc.body;
  const bodyText = normalize(bodyElement === null ? "" : bodyElement.textContent);
  if (bodyText === "") return { results: [], pageCarried: false };

  const limit =
    typeof arg.n === "number" && Number.isFinite(arg.n) ? Math.max(0, Math.floor(arg.n)) : 0;

  // Probe mode: the streaming wait asks only about the AI card (P8-A).
  if (arg.aiOnly === true) {
    const measured = arg.summary === true ? readAi() : null;
    return {
      results: [],
      aiProbe:
        measured === null
          ? { state: "none", chars: 0 }
          : { state: measured.state, chars: measured.text.length },
      pageCarried: false,
    };
  }

  const results: YandexExtractedItem[] = [];
  const seenUrls: { [url: string]: boolean } = {};
  let organics = 0;

  for (const titleElement of Array.from(doc.querySelectorAll(".OrganicTitle"))) {
    const card = titleElement.closest(".Organic");
    const insideAnchor = titleElement.querySelector("a[href]");
    const selfAnchor = titleElement.tagName.toUpperCase() === "A" ? (titleElement as Element) : null;
    const cardAnchor = card === null ? null : card.querySelector("a.OrganicTitle-Link[href], a[href]");
    const anchor = insideAnchor ?? selfAnchor ?? cardAnchor;
    const href = anchor === null ? null : anchor.getAttribute("href");
    if (href === null || href === "") continue;
    if (isAdHref(href)) continue;
    if (card !== null && hasAdLabel(card)) continue;

    const url = toHttpUrl(href);
    if (url === null) continue;
    const titleElementSpan = titleElement.querySelector(".OrganicTitleContentSpan");
    const title = normalize(
      titleElementSpan === null ? titleElement.textContent : titleElementSpan.textContent,
    );
    if (title === "") continue;
    if (seenUrls[url] === true) continue;
    seenUrls[url] = true;
    organics += 1;

    let snippet = "";
    if (card !== null) {
      const snippetElement = card.querySelector(".OrganicTextContentSpan");
      if (snippetElement !== null) snippet = normalize(snippetElement.textContent);
    }
    if (results.length < limit) results.push({ title, url, snippet });
  }

  /**
   * The AI card as it stands, or null when there is no card / it is robot-gated.
   *
   * A card whose header exists but whose answer body does not is a `lead` (an
   * empty card, a promo teaser, a collapsed answer): the old code returned null
   * for it, and a short answer body was reported as a full summary. Only ≥200
   * chars of answer prose is an `answer` (PLAN-v2 V8.1).
   */
  function readAi(): YandexExtractedAi | null {
    const bodyLower = bodyText.toLowerCase();
    const mayHaveAi =
      bodyLower.indexOf("быстрый ответ") !== -1 ||
      bodyLower.indexOf("нейро") !== -1 ||
      bodyLower.indexOf("алиса") !== -1;
    if (!mayHaveAi || arg.summary !== true) return null;

    const header = findAiHeader();
    if (header === null) return null;
    const card = header.closest('[class*="FuturisSearchCard"]') ?? header.closest('[class*="Futuris"]') ?? header.parentElement;
    if (card === null || isRobotGated(card)) return null;

    const answerRoot = findAnswerRoot(card, header);
    const text = answerRoot === null ? "" : answerText(answerRoot, header);
    return { text, sources: collectSources(card), state: text.length >= 200 ? "answer" : "lead" };
  }

  const ai = arg.summary === true ? readAi() ?? undefined : undefined;

  return {
    results,
    ...(ai === undefined ? {} : { ai }),
    pageCarried: organics > results.length,
  };
}

// ---------------------------------------------------------------------------
// Opt-in page-level expansion
// ---------------------------------------------------------------------------

export interface YandexPoint {
  x: number;
  y: number;
}

/**
 * Centre of the visible "Показать полностью"/"Показать ответ" control inside the
 * AI card, or null. Self-contained for the same `toString()` reason as the
 * extractor. The `Futuris` ancestor check is deliberate: a page-wide
 * "Показать полностью" must never be clicked by us.
 */
export function findExpandTarget(doc: Document): YandexPoint | null {
  const WHITESPACE = /[\s\u00a0\u202f]+/g;
  const WANTED = ["показать полностью", "показать ответ"];
  const normalize = (value: string | null): string =>
    (value === null ? "" : value).replace(WHITESPACE, " ").trim().toLowerCase();

  for (const node of Array.from(doc.querySelectorAll('button, [role="button"], a'))) {
    const label = normalize(node.textContent);
    if (WANTED.indexOf(label) === -1) continue;
    if (node.closest('[class*="Futuris"]') === null) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return null;
}

export interface YandexExpandOptions {
  /**
   * OFF by default: expanding is a visible UI interaction inside the user's
   * window, so it is a caller decision (`reflex`/tool flag), never an implicit
   * part of extraction. A collapsed answer is reported as-is; nothing is invented.
   */
  enabled?: boolean;
  /** After-click grace, default 500 ms (SPEC §6.2). */
  waitMs?: number;
  clock?: Clock;
  signal?: AbortSignal;
}

/**
 * Click "Показать полностью" at most once, only when the caller opted in.
 *
 * FUTURE HOOK, not wired: nothing in `src/` calls this yet (no tool/reflex
 * option exists for it). It is kept because the click is the only way to get a
 * collapsed answer, and it is exported so a later opt-in can reuse it without
 * touching the extractor. Until then this is dead production code with a
 * default-off contract, which is why the `enabled` check is the first statement.
 *
 * The click is a point click on the real control (no DOM mutation, no generated
 * selector), and the wait is bounded. Returns `true` only when a click happened,
 * so the caller can log the extra interaction.
 */
export async function expandAiSummaryOnce(
  page: CdpPage,
  options: YandexExpandOptions = {},
): Promise<boolean> {
  if (options.enabled !== true) return false;
  if (options.signal?.aborted === true) {
    throw fail("E_CANCELLED", "extract", {
      engine: "yandex",
      message: "aborted before expanding the AI summary",
    });
  }
  const point = await page.evaluate<unknown>(`(${findExpandTarget.toString()})(document)`);
  if (!isPoint(point)) return false;
  await page.click({ x: point.x, y: point.y });
  const waitMs = options.waitMs ?? EXPAND_WAIT_MS;
  if (waitMs > 0) {
    await (options.clock ?? systemClock).sleep(waitMs, options.signal);
  }
  return true;
}

function isPoint(value: unknown): value is YandexPoint {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { x?: unknown; y?: unknown };
  return typeof record.x === "number" && Number.isFinite(record.x) && typeof record.y === "number" && Number.isFinite(record.y);
}

// ---------------------------------------------------------------------------
// Selector canaries (self-contained, same toString() rule)
// ---------------------------------------------------------------------------

export function canaryCounts(doc: Document): Record<string, number> {
  const SELECTORS = [
    ".OrganicTitle",
    ".OrganicTextContentSpan",
    "[class*='Futuris']",
    ".FuturisSearch",
    "h3",
    ".Misspell",
  ];
  const counts: Record<string, number> = {};
  for (const selector of SELECTORS) {
    counts[selector] = doc.querySelectorAll(selector).length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Result validation (TS side: the page is untrusted even when we wrote the code)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailure(message: string): Error {
  return fail("E_PARSE", "extract", {
    engine: "yandex",
    message,
    hint: "the Yandex page returned an unexpected shape; run /web-doctor and inspect the artifact",
  });
}

function asExtraction(value: unknown): { results: SerpItem[]; ai: AiSummary | undefined; pageCarried: boolean; aiProbe?: { state: "answer" | "lead" | "none"; chars: number } } {
  if (!isRecord(value)) throw parseFailure("in-page extractor returned no object");
  const rawResults = value.results;
  if (!Array.isArray(rawResults)) throw parseFailure("in-page extractor returned no results array");

  const results: SerpItem[] = [];
  const seenUrls = new Set<string>();
  for (const rawItem of rawResults) {
    if (!isRecord(rawItem)) throw parseFailure("in-page extractor returned a malformed result");
    const title = rawItem.title;
    const url = rawItem.url;
    const snippet = rawItem.snippet;
    if (typeof title !== "string" || typeof url !== "string" || typeof snippet !== "string") {
      throw parseFailure("in-page extractor returned a result with non-string fields");
    }
    if (title === "") continue;
    // Second, TS-side hygiene pass through the shared contract. The in-page code
    // cannot import `urls.ts`, so this is where the canonical form is enforced
    // (and where a non-http(s) link that slipped through is dropped).
    const normalized = normalizeUrl(url);
    if (normalized === null || seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    results.push({ title, url: normalized, snippet });
  }

  let ai: AiSummary | undefined;
  const rawAi = value.ai;
  if (isRecord(rawAi)) {
    const text = typeof rawAi.text === "string" ? rawAi.text.trim() : "";
    const sources = Array.isArray(rawAi.sources)
      ? rawAi.sources.filter((source): source is string => typeof source === "string" && source !== "")
      : [];
    const declared = rawAi.state === "answer" || rawAi.state === "lead" ? rawAi.state : undefined;
    if (text !== "" || declared === "lead") {
      ai = declared === undefined ? { text, sources } : { text, sources, state: declared };
    }
  }

  const probe = value.aiProbe;
  const aiProbe: { state: "answer" | "lead" | "none"; chars: number } | undefined =
    isRecord(probe) &&
    (probe.state === "answer" || probe.state === "lead" || probe.state === "none")
      ? {
          state: probe.state,
          chars:
            typeof probe.chars === "number" && Number.isFinite(probe.chars)
              ? Math.max(0, Math.floor(probe.chars))
              : 0,
        }
      : undefined;

  return {
    results,
    ai,
    pageCarried: value.pageCarried === true,
    ...(aiProbe === undefined ? {} : { aiProbe }),
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

export interface YandexSettleOptions {
  signal?: AbortSignal;
  /** Test/live knob; defaults to 10 s. */
  deadlineMs?: number;
  /** Test/live knob; defaults to 200 ms plus humanize jitter. */
  pollMs?: number;
  clock?: Clock;
  rng?: () => number;
}

/**
 * Bounded settle on the structural gate. Aborts propagate through
 * `waitForMarker` as `E_CANCELLED`, timeouts as `E_TIMEOUT` with the missing
 * selector in the message.
 */
export async function settleYandex(page: CdpPage, options: YandexSettleOptions = {}): Promise<void> {
  await waitForMarker(page, {
    marker: INTERACTION.marker,
    selector: INTERACTION.selector,
    minCount: INTERACTION.minCount ?? 1,
    deadlineMs: options.deadlineMs ?? SETTLE_DEADLINE_MS,
    pollMs: options.pollMs ?? SETTLE_POLL_MS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.rng === undefined ? {} : { rng: options.rng }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function organicCount(page: CdpPage): Promise<number> {
  const count = await page.evaluate<unknown>(ORGANIC_COUNT_EXPRESSION);
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

async function captchaNodeCount(page: CdpPage): Promise<number> {
  const count = await page.evaluate<unknown>(CAPTCHA_NODE_EXPRESSION);
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

/**
 * Wall detection, text-first so it survives class-name churn. Markers are the
 * exact constants that matched, for artifacts and doctor output.
 *
 * Text markers alone are **not** enough for a captcha: a normal SERP snippet can
 * quote "SmartCaptcha" or "Я не робот". The text counts only together with URL
 * evidence (`/showcaptcha`, `captcha.yandex`), a captcha widget in the DOM, or a
 * page with zero `.OrganicTitle` — the same corroboration the `blocked` rule
 * uses. Nobody clicks anything here.
 */
export async function detectYandexWall(page: CdpPage): Promise<Wall | null> {
  const url = page.url();
  const text = await page.innerText();
  const loweredUrl = url.toLowerCase();
  const loweredText = text.toLowerCase();

  const captchaUrlMarkers: string[] = [];
  for (const marker of CAPTCHA_URL_MARKERS) {
    if (loweredUrl.indexOf(marker.toLowerCase()) !== -1) captchaUrlMarkers.push(marker);
  }
  const captchaTextMarkers: string[] = [];
  for (const marker of CAPTCHA_TEXT_MARKERS) {
    if (loweredText.indexOf(marker.toLowerCase()) !== -1) captchaTextMarkers.push(marker);
  }
  const captchaMarkers = [...captchaUrlMarkers, ...captchaTextMarkers];

  // The organic count is needed by both rules; evaluate it at most once.
  let organicTotal: number | null = null;
  const organics = async (): Promise<number> => {
    if (organicTotal === null) organicTotal = await organicCount(page);
    return organicTotal;
  };

  if (captchaUrlMarkers.length > 0) {
    return { kind: "captcha", url, markers: captchaMarkers };
  }
  // A widget on the page is evidence on its own: the live card can be present
  // while the marker text sits in an iframe/shadow root the text scan cannot see.
  if ((await captchaNodeCount(page)) > 0) {
    return { kind: "captcha", url, markers: captchaMarkers.length > 0 ? captchaMarkers : ["captcha-node"] };
  }
  // Text alone still needs corroboration: a snippet can quote these words.
  if (captchaTextMarkers.length > 0 && (await organics()) === 0) {
    return { kind: "captcha", url, markers: captchaMarkers };
  }

  const blockedMarkers: string[] = [];
  for (const marker of BLOCKED_TEXT_MARKERS) {
    if (loweredText.indexOf(marker.toLowerCase()) !== -1) blockedMarkers.push(marker);
  }
  // A snippet can contain "нет доступа"; a real block page has no organics at all.
  if (blockedMarkers.length > 0 && (await organics()) === 0) {
    return { kind: "blocked", url, markers: blockedMarkers };
  }

  return null;
}

// ---------------------------------------------------------------------------
// URL builder + engine
// ---------------------------------------------------------------------------

/**
 * Pure. Documented mapping: `p = page - 1` (confirmed by the captured
 * pagination links `/search/?text=…&p=1..4`), `lr` from `Query.region` (the tool
 * layer sends `engines.yandex.lr` there; every capture carries `lr=6`).
 *
 * Freshness is intentionally **not** emitted: SPEC §6.2 says `within=…` must be
 * verified, the captures contain no freshness URLs, and a guessed mapping would
 * silently narrow results (a wrong `within=1` is a one-day window). The caller
 * still passes `freshness`; it is ignored until someone verifies the values.
 */
function buildUrl(q: Query): string {
  const parts = [`text=${encodeURIComponent(q.text)}`];
  const page = typeof q.page === "number" && Number.isFinite(q.page) ? Math.floor(q.page) : 1;
  if (page > 1) parts.push(`p=${page - 1}`);
  const region = typeof q.region === "string" ? q.region.trim() : "";
  if (region !== "") parts.push(`lr=${encodeURIComponent(region)}`);
  return `https://yandex.ru/search/?${parts.join("&")}`;
}

export const yandexEngine: Engine = {
  id: "yandex",
  /** The tool layer waits for the user to solve the captcha; nobody clicks it here. */
  retryOnWall: true,
  interaction: INTERACTION,
  buildUrl,

  async settle(page: CdpPage, signal?: AbortSignal): Promise<void> {
    await settleYandex(page, signal === undefined ? {} : { signal });
  },

  detectWall: detectYandexWall,

  async extract(page: CdpPage, q: Query): Promise<RawSerp> {
    const startedAt = Date.now();
    const arg: YandexExtractionArg = { n: q.n, summary: q.summary, query: q.text };
    const raw = await page.evaluate<unknown>(
      `(${extractFromDocument.toString()})(document, ${JSON.stringify(arg)})`,
    );
    const parsed = asExtraction(raw);
    const timings = { extractMs: Math.max(0, Date.now() - startedAt) };
    return {
      engine: "yandex",
      query: q.text,
      ...(parsed.ai === undefined ? {} : { ai: parsed.ai }),
      results: parsed.results,
      pageCarried: parsed.pageCarried,
      timings,
    };
  },

  async canaries(page: CdpPage): Promise<Record<string, number>> {
    const raw = await page.evaluate<unknown>(`(${canaryCounts.toString()})(document)`);
    return asCanaries(raw);
  },

  ai: {
    /** Same `readAi` path in probe mode (P8-A); never touches results. */
    async probe(page: CdpPage): Promise<{ state: "answer" | "lead" | "none"; chars: number }> {
      const arg: YandexExtractionArg = { n: 0, summary: true, query: "", aiOnly: true };
      const raw = await page.evaluate<unknown>(
        `(${extractFromDocument.toString()})(document, ${JSON.stringify(arg)})`,
      );
      const parsed = asExtraction(raw);
      return parsed.aiProbe ?? { state: "none", chars: 0 };
    },
    /** Called only when `search.aiExpand` is true — the tool owns the opt-in. */
    expand: (page: CdpPage, options?: { signal?: AbortSignal }) =>
      expandAiSummaryOnce(page, {
        enabled: true,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }),
  },
};
