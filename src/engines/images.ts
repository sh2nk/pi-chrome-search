/**
 * Image-search adapter (SPEC §6.4, PLAN P4-B / V4.2).
 *
 * The vertical is "best-effort" by contract: Google Images and Yandex Images do
 * not expose a stable public schema, so this module is deliberately smaller than
 * the text engines. It is still split the same way:
 *
 *  - Module side: a pure URL builder, a selector-only settle, a wall classifier
 *    and JSON validators for what crosses the CDP boundary.
 *  - In-page side: `extractImagesFromDocument`, `imageCanaryCountsFromDocument`
 *    and `imagesWallEvidenceFromDocument`. They are serialised with
 *    `toString()` into one `Runtime.evaluate`, so they may not import, capture a
 *    module constant or touch `this`. `tests/unit/images.test.ts` runs the same
 *    source through `runInPage`, so a free variable fails offline.
 *
 * Selector census (2026-11-06, `tests/fixtures/images-*.html.gz`):
 *
 *  - Google: 252 `<img>`; 100 `[data-attrid="images universal"]` cards. Every
 *    card carries `data-lpage` (the source page) and an `img[alt]`. Only 27
 *    cards have a real `https://encrypted-tbn*.gstatic.com` thumb in the
 *    post-render DOM: 64 keep a 1x1 `data:image/gif` placeholder and 9 a small
 *    `data:image/jpeg`, so a data URI is a normal "not loaded" state and is
 *    skipped, never followed. There are **no** `/imgres?` anchors.
 *  - Yandex: 30 `.SerpItem` blocks, **0** `.serp-item` (the old selector is
 *    gone). Each has `.SerpItem-Thumb` / `.ImagesContentImage` with a
 *    protocol-relative `//avatars.mds.yandex.net/...` thumb and alt text. The
 *    tile does not expose a source page: the cover anchor is
 *    `/images/search?...&img_url=<encoded source image>`, so the decoded
 *    `img_url` is what this adapter reports as `pageUrl` (the only real source
 *    URL the 2026 page discloses) and its host is the `domain`.
 *
 * Pagination is not emitted. The Google capture has one `&start=10` link on a
 * different vertical (the image grid itself uses 100 tiles per batch in the
 * rendered DOM), and the Yandex capture has no page links at all; guessing a
 * step would silently return the wrong page, so `page` is accepted for
 * signature symmetry and ignored. `image_search` does not expose `page`.
 *
 * Google's `region` is likewise ignored: the capture carries `hl=ru` but no
 * `gl`, and SPEC §6.4 gives no mapping. Yandex `region` maps to `lr`, the same
 * parameter the text adapter uses and the capture's own config carries
 * (`"lr":6`).
 */

import type { CdpPage } from "../cdp/types.ts";
import { waitForMarker } from "../cdp/humanize.ts";
import { domainOf, isHttpUrl } from "../extract/urls.ts";
import type { Clock } from "../runtime/types.ts";
import { fail } from "../runtime/errors.ts";
import type { Wall } from "./types.ts";

export type ImageEngineId = "google" | "yandex";

/** Canonical order; the tool defaults to Google and never fans out automatically. */
export const IMAGE_ENGINE_IDS = ["google", "yandex"] as const satisfies readonly ImageEngineId[];

export interface ImagesQuery {
  text: string;
  /** Engine UI language, e.g. "ru"; "auto" is resolved by the caller. */
  lang?: string;
  /** Engine region; Yandex `lr`, ignored by Google (see the module comment). */
  region?: string;
  /** 1-based, accepted for symmetry and deliberately not emitted (no verified mapping). */
  page?: number;
}

export interface ImageItem {
  alt: string;
  pageUrl: string;
  /**
   * What `pageUrl` actually points at. Google tiles disclose the containing
   * page; Yandex 2026 tiles disclose only the source *image* file, and calling
   * that a page would be a small lie (P9-E).
   */
  pageUrlKind: "page" | "image";
  thumbUrl: string;
  domain: string;
}

export interface ImagesExtraction {
  items: ImageItem[];
  /** True when the page carried more usable tiles than were returned. */
  pageCarried: boolean;
}

export interface ImagesExtractionArg {
  engine: ImageEngineId;
  /** Requested items; clamped to 1..12 inside the page (the tool also clamps). */
  n: number;
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

const GOOGLE_IMAGES_URL = "https://www.google.com/search";
const YANDEX_IMAGES_URL = "https://yandex.ru/images/search";
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;

function languageCode(value: string | undefined): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "" || !LANGUAGE_CODE.test(trimmed)) return "";
  return trimmed.toLowerCase();
}

/** `region` is free-form in the config (`6`, `ru`, …); only emptiness is rejected. */
function regionCode(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Pure and deterministic: same input → same URL. Parameter insertion order is
 * fixed, so two equal queries cannot differ byte-wise.
 *
 * `page` is read only to keep the contract explicit; no verified image-vertical
 * pagination parameter exists (see the module comment), so it is not emitted.
 * `void` documents that this is intentional rather than a forgotten field.
 */
export function buildImagesUrl(engine: ImageEngineId, q: ImagesQuery): string {
  const text = typeof q.text === "string" ? q.text : "";
  // Accepted for contract symmetry; no verified image-vertical pagination
  // parameter exists (see the module comment), so it is intentionally unused.
  void q.page;

  if (engine === "google") {
    const params = new URLSearchParams();
    params.set("q", text);
    params.set("tbm", "isch");
    const language = languageCode(q.lang);
    if (language !== "") params.set("hl", language);
    return `${GOOGLE_IMAGES_URL}?${params.toString()}`;
  }

  const params = new URLSearchParams();
  params.set("text", text);
  const region = regionCode(q.region);
  if (region !== "") params.set("lr", region);
  return `${YANDEX_IMAGES_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// In-page extraction — self-contained, serialised into the page
// ---------------------------------------------------------------------------

/**
 * Read one image SERP out of `document`.
 *
 * Self-containment rules (enforced by tests): no imports, no closures, no
 * module constants. Everything below is a literal inside the function.
 *
 * A tile is usable only when it has all four fields. That is stricter than the
 * text adapters on purpose: a thumbnail with no alt is usually an icon, and a
 * card whose thumb is still a `data:` placeholder has nothing renderable. Both
 * are skipped, and `pageCarried` counts only usable tiles.
 */
export function extractImagesFromDocument(doc: Document, arg: ImagesExtractionArg): ImagesExtraction {
  const DEFAULT_N = 4;
  const MAX_N = 12;
  const MIN_THUMB_PX = 100;
  const MAX_ALT_CHARS = 200;
  /** Same tracking set as the text adapters; a URL is never cut, only cleaned. */
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
    "sa",
    "ved",
    "usg",
    "ei",
    "gs_lcp",
  ];
  /**
   * Asset URLs that are chrome, not content. The host is deliberately not
   * matched: Yandex serves every legitimate thumbnail from
   * `avatars.mds.yandex.net`, so an `avatar` match there would delete the whole
   * vertical. Only the path and the class attribute are inspected.
   */
  const BAD_ASSET_PATH = /(?:^|\/)(?:favicon|sprite|spacer|pixel|1x1)(?:[\/._-]|$)|blank\.gif|transparent\.gif/i;
  const BAD_ASSET_CLASS = /(?:^|[\s_-])(?:avatar|userpic|sprite|icon|logo)(?:$|[\s_-])/i;
  const AD_SELECTOR = "[data-text-ad], .uEierd, [data-ad], [data-ad-slot]";
  const AD_LABELS = ["реклама", "промо", "sponsored", "advertisement", "ads", "ad"];
  const TILE_SELECTOR_GOOGLE = '[data-attrid="images universal"]';
  const TILE_SELECTOR_YANDEX = ".SerpItem";

  const base = doc.baseURI || (doc.location ? doc.location.href : "") || "";

  function normalize(value: string | null): string {
    return (value === null ? "" : value).replace(/[\s\u00a0\u202f]+/g, " ").trim();
  }

  function clampText(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
  }

  function toAbsolute(raw: string | null): URL | null {
    const trimmed = (raw === null ? "" : raw).trim();
    if (trimmed === "") return null;
    const candidate = trimmed.indexOf("//") === 0 ? `https:${trimmed}` : trimmed;
    try {
      return base === "" ? new URL(candidate) : new URL(candidate, base);
    } catch {
      return null;
    }
  }

  function isHttp(url: URL): boolean {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  /**
   * Source page URL: tracking parameters removed, fragment dropped, else `""`.
   * Re-implemented here because the in-page function cannot import
   * `extract/urls.ts`; the TS-side validator runs `domainOf` again.
   */
  function cleanPageUrl(raw: string | null): string {
    const parsed = toAbsolute(raw);
    if (parsed === null || !isHttp(parsed)) return "";
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
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  /**
   * A 1x1/hidden placeholder is a loaded tile that has not decoded yet. Yandex
   * writes fractional CSS pixels (125.8×153.4), so the check parses floats and
   * only rejects a *positive* value below the threshold; a missing attribute is
   * not evidence of a small image (Google's cards omit width/height entirely).
   */
  function isTooSmall(img: Element): boolean {
    const width = Number.parseFloat(img.getAttribute("width") ?? "");
    const height = Number.parseFloat(img.getAttribute("height") ?? "");
    if (Number.isFinite(width) && width > 0 && width < MIN_THUMB_PX) return true;
    if (Number.isFinite(height) && height > 0 && height < MIN_THUMB_PX) return true;
    return false;
  }

  /**
   * First renderable thumb URL. `src` is normally the real tile; the `data-*`
   * and `srcset` fallbacks cover a lazy variant without inventing a URL. A
   * `data:`/`blob:` candidate is skipped and the next one is tried, so a lazy
   * image with a usable `data-src` still yields an item.
   */
  function pickThumb(img: Element): string {
    const candidates: string[] = [];
    for (const attribute of ["src", "data-src", "data-lazy-src", "data-original", "data-iurl"]) {
      const value = img.getAttribute(attribute);
      if (value !== null && value.trim() !== "") candidates.push(value);
    }
    const srcset = img.getAttribute("srcset");
    if (srcset !== null) {
      const first = srcset.split(",")[0];
      if (first !== undefined && first.trim() !== "") candidates.push(first.trim().split(/\s+/)[0] ?? "");
    }

    const className = img.getAttribute("class") ?? "";
    if (BAD_ASSET_CLASS.test(className)) return "";

    for (const raw of candidates) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      if (trimmed.indexOf("data:") === 0 || trimmed.indexOf("blob:") === 0) continue;
      const parsed = toAbsolute(trimmed);
      if (parsed === null || !isHttp(parsed)) continue;
      if (BAD_ASSET_PATH.test(parsed.pathname)) continue;
      return parsed.href;
    }
    return "";
  }

  function cleanAlt(value: string | null): string {
    // An alt is text, but a page is untrusted: strip tag-shaped fragments so a
    // caption cannot smuggle markup into the compact output.
    return clampText(normalize(normalize(value).replace(/<[^>]*>/g, " ")), MAX_ALT_CHARS);
  }

  /** A visible leaf that is exactly an ad label marks the whole card as an ad. */
  function hasAdLabel(card: Element): boolean {
    for (const node of Array.from(card.querySelectorAll("span, div, b"))) {
      if (node.children.length > 0) continue;
      const label = normalize(node.textContent).toLowerCase();
      if (label === "") continue;
      if (AD_LABELS.indexOf(label) !== -1) return true;
    }
    return false;
  }

  function isAd(card: Element): boolean {
    if (card.closest(AD_SELECTOR) !== null) return true;
    if (card.getAttribute("data-ad") !== null) return true;
    return hasAdLabel(card);
  }

  function googlePageUrl(card: Element): string {
    const lpage = card.getAttribute("data-lpage");
    if (lpage !== null && lpage.trim() !== "") {
      const cleaned = cleanPageUrl(lpage);
      if (cleaned !== "") return cleaned;
    }
    const anchor = card.querySelector("a[href]");
    if (anchor === null) return "";
    const raw = anchor.getAttribute("href");
    if (raw === null) return "";
    const parsed = toAbsolute(raw);
    // A legacy/redirect anchor can be `/url?q=<target>`; resolve the target
    // rather than reporting a Google wrapper as the source page.
    if (parsed !== null && parsed.pathname === "/url") {
      const target = parsed.searchParams.get("q");
      if (target !== null) {
        const cleaned = cleanPageUrl(target);
        if (cleaned !== "") return cleaned;
      }
    }
    return cleanPageUrl(raw);
  }

  /**
   * Yandex tiles carry no source page in 2026. The cover anchor is a Yandex
   * preview URL whose `img_url` query holds the *source image* URL; that is the
   * only non-Yandex URL the tile discloses, so it becomes `pageUrl`. The cover
   * href is the fallback for a layout that drops `img_url`.
   *
   * The two selectors are queried separately on purpose: a comma-joined
   * `"a.ImagesContentImage-Cover[href], a[href]"` resolves in tree order, so an
   * unrelated earlier anchor (title, source badge) would win and report the
   * wrong `pageUrl`. The cover query is independent of tree position; the
   * generic anchor is only consulted when no cover anchor exists at all.
   */
  function yandexPageUrl(card: Element): string {
    const cover = card.querySelector("a.ImagesContentImage-Cover[href]");
    const anchor = cover === null ? card.querySelector("a[href]") : cover;
    if (anchor === null) return "";
    const raw = anchor.getAttribute("href");
    if (raw === null) return "";
    const parsed = toAbsolute(raw);
    if (parsed !== null) {
      const imageUrl = parsed.searchParams.get("img_url");
      if (imageUrl !== null && imageUrl.trim() !== "") {
        // The captured markup double-encodes the `&` separator once
        // (`%26amp%3B`), so the decoded value still contains an HTML entity.
        const cleaned = cleanPageUrl(imageUrl.replace(/&amp;/g, "&"));
        if (cleaned !== "") return cleaned;
      }
    }
    return cleanPageUrl(raw);
  }

  const requested = typeof arg.n === "number" && Number.isFinite(arg.n) ? Math.floor(arg.n) : DEFAULT_N;
  const limit = requested < 1 ? 1 : requested > MAX_N ? MAX_N : requested;
  const cards =
    arg.engine === "yandex"
      ? Array.from(doc.querySelectorAll(TILE_SELECTOR_YANDEX))
      : Array.from(doc.querySelectorAll(TILE_SELECTOR_GOOGLE));

  const items: ImageItem[] = [];
  const seen: { [key: string]: boolean } = {};
  let usable = 0;

  for (const card of cards) {
    if (isAd(card)) continue;
    const img = card.querySelector("img");
    if (img === null || isTooSmall(img)) continue;
    const alt = cleanAlt(img.getAttribute("alt"));
    if (alt === "") continue;
    const thumbUrl = pickThumb(img);
    if (thumbUrl === "") continue;
    const pageUrl = arg.engine === "yandex" ? yandexPageUrl(card) : googlePageUrl(card);
    if (pageUrl === "") continue;
    const domain = hostOf(pageUrl);
    if (domain === "") continue;

    // Two cards can legitimately share a thumbnail (Yandex returned 22 unique
    // thumbs for 30 tiles), while the page URL is the real identity. Dedupe on
    // the pair so a repeated card disappears without collapsing distinct pages.
    const key = `${pageUrl}\n${thumbUrl}`;
    if (seen[key] === true) continue;
    seen[key] = true;
    usable += 1;
    const pageUrlKind = arg.engine === "yandex" ? "image" : "page";
    if (items.length < limit) items.push({ alt, pageUrl, pageUrlKind, thumbUrl, domain });
  }

  return { items, pageCarried: usable > items.length };
}

// ---------------------------------------------------------------------------
// In-page canaries — self-contained as well
// ---------------------------------------------------------------------------

/**
 * Selector census for the doctor. A zero is a `layout_changed` signal, not an
 * error. `legacySerpItem` is Yandex-only and exists because the 2026 layout
 * dropped `.serp-item`; a non-zero value there would mean a rollback, not a fix.
 */
export function imageCanaryCountsFromDocument(
  doc: Document,
  engine: ImageEngineId,
): Record<string, number> {
  const counts: Record<string, number> = {
    images: doc.querySelectorAll("img").length,
  };
  if (engine === "yandex") {
    counts.cards = doc.querySelectorAll(".SerpItem").length;
    counts.thumbs = doc.querySelectorAll(".SerpItem-Thumb").length;
    counts.legacySerpItem = doc.querySelectorAll(".serp-item").length;
  } else {
    counts.cards = doc.querySelectorAll('[data-attrid="images universal"]').length;
    counts.lpage = doc.querySelectorAll("[data-lpage]").length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// In-page wall evidence + classifier
// ---------------------------------------------------------------------------

export interface ImagesWallEvidence {
  url: string;
  text: string;
  /** Usable-ish tile containers; zero corroborates a text marker. */
  tiles: number;
  /** Captcha/consent widgets in the DOM. */
  captchaNodes: number;
}

/**
 * The DOM half of the wall verdict, self-contained for `toString()`.
 *
 * The tile selector is the union of both verticals because the probe does not
 * know which engine produced the document; the counts only ever corroborate a
 * text marker, so a mixed selector cannot create a wall by itself.
 */
export function imagesWallEvidenceFromDocument(doc: Document): ImagesWallEvidence {
  const TILE_SELECTOR = '[data-attrid="images universal"], .SerpItem';
  const CAPTCHA_SELECTOR =
    '#captcha-form, #recaptcha, .g-recaptcha, .SmartCaptcha, [class*="SmartCaptcha"], form[action*="consent.google.com"]';
  const body = doc.body;
  // A live page has `innerText` (visible prose only, scripts/styles excluded).
  // linkedom does not implement it, so the fixture path falls back to
  // `textContent`; the marker still needs tiles===0 or a captcha node.
  const visible = body === null || body === undefined ? "" : (body as HTMLElement).innerText;
  const rawText = typeof visible === "string" && visible !== "" ? visible : body?.textContent;
  return {
    url: doc.URL || doc.baseURI || "",
    text: (rawText === null || rawText === undefined ? "" : rawText)
      .replace(/[\s\u00a0\u202f]+/g, " ")
      .trim()
      .slice(0, 20_000),
    tiles: doc.querySelectorAll(TILE_SELECTOR).length,
    captchaNodes: doc.querySelectorAll(CAPTCHA_SELECTOR).length,
  };
}

export interface ImagesWallInput {
  url: string;
  text?: string;
  /** Omit when unknown; a text marker then needs a captcha node or a URL marker. */
  tiles?: number;
  captchaNodes?: number;
}

export type ImagesWallTarget = string | Document | ImagesWallInput;

const SORRY_URL_MARKER = "/sorry";
const SORRY_TEXT_MARKERS: readonly string[] = ["unusual traffic", "подозрительный трафик"];
const CONSENT_HOSTS: readonly string[] = ["consent.google.com", "consent.youtube.com"];
const CONSENT_TEXT_MARKERS: readonly string[] = [
  "Before you continue to Google",
  "Прежде чем перейти в Google",
];
const CAPTCHA_URL_MARKERS: readonly string[] = [
  "/showcaptcha",
  "captcha.yandex",
  "/recaptcha",
];
const CAPTCHA_TEXT_MARKERS: readonly string[] = [
  "Я не робот",
  "I'm not a robot",
  "SmartCaptcha",
  "Подтвердите, что запросы отправляли вы",
  "unusual traffic",
  "подозрительный трафик",
];
const BLOCKED_TEXT_MARKERS: readonly string[] = [
  "нет доступа",
  "Доступ ограничен",
  "Запрос заблокирован",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDocument(value: unknown): Document | null {
  if (!isRecord(value)) return null;
  return typeof value.querySelectorAll === "function" ? (value as unknown as Document) : null;
}

function wallTargetInput(target: ImagesWallTarget): ImagesWallInput {
  if (typeof target === "string") return { url: target };
  const doc = asDocument(target);
  if (doc !== null) return imagesWallEvidenceFromDocument(doc);
  return target as ImagesWallInput;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Text markers present in the lower-cased haystack, reported in original casing. */
function textMarkers(haystack: string, markers: readonly string[]): string[] {
  const found: string[] = [];
  for (const marker of markers) {
    if (haystack.indexOf(marker.toLowerCase()) !== -1) found.push(marker);
  }
  return found;
}

/**
 * Classify an image SERP as a wall, or `null` for a normal *and* an empty page.
 *
 * A phrase alone is never enough: an alt/caption can quote "Я не робот" or
 * "unusual traffic". Text therefore needs corroboration — zero tiles or a
 * captcha widget. URL evidence (`/sorry`, `/showcaptcha`, `/recaptcha`, a
 * consent host) stands on its own because it is what the page *is*.
 *
 * Order matters: a Google `/sorry` page also renders a reCAPTCHA widget, so the
 * `sorry` rule runs before `captcha`, preserving the actionable cause
 * (rate-limited) instead of sending the user to the wrong remedy.
 */
export function detectImagesWall(target: ImagesWallTarget): Wall | null {
  const input = wallTargetInput(target);
  const url = typeof input.url === "string" ? input.url : "";
  const text = typeof input.text === "string" ? input.text.toLowerCase() : "";
  const tiles = typeof input.tiles === "number" && Number.isFinite(input.tiles) ? input.tiles : null;
  const captchaNodes =
    typeof input.captchaNodes === "number" && Number.isFinite(input.captchaNodes)
      ? input.captchaNodes
      : 0;
  const emptySerp = tiles !== null && tiles <= 0;
  const parsed = parseUrl(url);
  const host = parsed === null ? "" : parsed.hostname.toLowerCase();
  const path = parsed === null ? "" : parsed.pathname.toLowerCase();
  const loweredUrl = url.toLowerCase();

  const sorryUrl = path.indexOf(SORRY_URL_MARKER) === 0;
  const sorryText = textMarkers(text, SORRY_TEXT_MARKERS);
  if (sorryUrl) {
    return { kind: "sorry", url, markers: [SORRY_URL_MARKER, ...sorryText] };
  }

  const consentHost = CONSENT_HOSTS.find(
    (marker) => host === marker || host.endsWith(`.${marker}`),
  );
  const consentText = textMarkers(text, CONSENT_TEXT_MARKERS);
  if (consentHost !== undefined || (emptySerp && consentText.length > 0)) {
    return {
      kind: "consent",
      url,
      markers: [...(consentHost === undefined ? [] : [consentHost]), ...consentText],
    };
  }

  const captchaUrlMarkers = CAPTCHA_URL_MARKERS.filter((marker) =>
    loweredUrl.indexOf(marker) !== -1,
  );
  const captchaText = textMarkers(text, CAPTCHA_TEXT_MARKERS);
  if (
    captchaUrlMarkers.length > 0 ||
    (captchaText.length > 0 && (emptySerp || captchaNodes > 0))
  ) {
    return { kind: "captcha", url, markers: [...captchaUrlMarkers, ...captchaText] };
  }

  const blockedText = textMarkers(text, BLOCKED_TEXT_MARKERS);
  if (blockedText.length > 0 && emptySerp) {
    return { kind: "blocked", url, markers: blockedText };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Page-side settle / extract / canaries
// ---------------------------------------------------------------------------

/**
 * Readiness gates. Wall containers are part of the gate on purpose: a wall page
 * usually has no tile grid, and a settle that knew only the grid would burn its
 * deadline and report `E_TIMEOUT` instead of the honest `E_WALL`. An empty
 * Yandex page is covered by `.Misspell`.
 *
 * Google has no captured zero-result image SERP, so there is no verified empty
 * marker to put here. A zero-result Google page therefore settles only after
 * the bounded deadline and surfaces as `E_TIMEOUT` (not a fabricated
 * `E_EMPTY`); adding a marker needs a fixture, not a guess. The Yandex empty
 * path is exercised offline in `tests/unit/images.test.ts`.
 */
export const IMAGES_READY_SELECTORS = Object.freeze({
  google:
    '[data-attrid="images universal"], #captcha-form, #recaptcha, .g-recaptcha, form[action*="consent.google.com"]',
  yandex: '.SerpItem, .SmartCaptcha, [class*="SmartCaptcha"], .Misspell',
} satisfies Record<ImageEngineId, string>);

const IMAGES_SETTLE_DEADLINE_MS: Record<ImageEngineId, number> = {
  google: 8_000,
  yandex: 10_000,
};

export interface ImagesSettleOptions {
  /** Test/live knob; defaults per engine (Google 8 s, Yandex 10 s). */
  deadlineMs?: number;
  /** Base poll before jitter; default 150 ms from `waitForMarker`. */
  pollMs?: number;
  clock?: Clock;
  signal?: AbortSignal;
}

/** Bounded selector-only settle; aborts/timeouts propagate from `waitForMarker`. */
export async function settleImages(
  page: CdpPage,
  engine: ImageEngineId,
  options: ImagesSettleOptions = {},
): Promise<void> {
  await waitForMarker(page, {
    marker: "",
    selector: IMAGES_READY_SELECTORS[engine],
    minCount: 1,
    deadlineMs: options.deadlineMs ?? IMAGES_SETTLE_DEADLINE_MS[engine],
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function asImageItem(value: unknown): ImageItem | null {
  if (!isRecord(value)) return null;
  const alt = typeof value.alt === "string" ? value.alt.trim() : "";
  const pageUrl = typeof value.pageUrl === "string" ? value.pageUrl : "";
  const thumbUrl = typeof value.thumbUrl === "string" ? value.thumbUrl : "";
  if (alt === "" || !isHttpUrl(pageUrl) || !isHttpUrl(thumbUrl)) return null;
  const domain = domainOf(pageUrl);
  if (domain === "") return null;
  // The payload crosses the browser boundary: trust the declared kind only when
  // it is one of the two words, and never invent "page" from a bare image URL.
  const declared = value.pageUrlKind;
  const pageUrlKind: ImageItem["pageUrlKind"] =
    declared === "image" || declared === "page" ? declared : imageUrlLooksLikeFile(pageUrl) ? "image" : "page";
  return { alt, pageUrl, pageUrlKind, thumbUrl, domain };
}

/** Fallback inference for a payload without `pageUrlKind` (older capture tests). */
function imageUrlLooksLikeFile(url: string): boolean {
  try {
    return /\.(?:jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function asImagesExtraction(value: unknown): ImagesExtraction | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items: ImageItem[] = [];
  for (const raw of value.items) {
    const item = asImageItem(raw);
    if (item !== null) items.push(item);
  }
  return { items, pageCarried: value.pageCarried === true };
}

function asWallEvidence(value: unknown): ImagesWallEvidence | null {
  if (!isRecord(value)) return null;
  const url = typeof value.url === "string" ? value.url : "";
  const text = typeof value.text === "string" ? value.text : "";
  const tiles = value.tiles;
  const captchaNodes = value.captchaNodes;
  if (typeof tiles !== "number" || !Number.isFinite(tiles)) return null;
  if (typeof captchaNodes !== "number" || !Number.isFinite(captchaNodes)) return null;
  return {
    url,
    text,
    tiles: Math.max(0, Math.floor(tiles)),
    captchaNodes: Math.max(0, Math.floor(captchaNodes)),
  };
}

/** Extract through one `Runtime.evaluate`; a non-payload is `E_PARSE`. */
export async function extractImages(
  page: CdpPage,
  arg: ImagesExtractionArg,
): Promise<ImagesExtraction> {
  const raw = await page.evaluate<unknown>(
    `(${extractImagesFromDocument})(document, ${JSON.stringify(arg)})`,
  );
  const parsed = asImagesExtraction(raw);
  if (parsed === null) {
    throw fail("E_PARSE", "extract", {
      engine: arg.engine,
      message: "image extractor returned no usable payload",
    });
  }
  return parsed;
}

/** One evaluate, then the pure classifier; a malformed probe is "no wall". */
export async function detectImagesWallOnPage(page: CdpPage): Promise<Wall | null> {
  const raw = await page.evaluate<unknown>(`(${imagesWallEvidenceFromDocument})(document)`);
  const evidence = asWallEvidence(raw);
  if (evidence === null) return null;
  return detectImagesWall(evidence);
}

export async function imagesCanaries(
  page: CdpPage,
  engine: ImageEngineId,
): Promise<Record<string, number>> {
  const raw = await page.evaluate<unknown>(
    `(${imageCanaryCountsFromDocument})(document, ${JSON.stringify(engine)})`,
  );
  const counts: Record<string, number> = {};
  if (!isRecord(raw)) return counts;
  for (const [selector, count] of Object.entries(raw)) {
    if (typeof count === "number" && Number.isFinite(count)) counts[selector] = count;
  }
  return counts;
}
