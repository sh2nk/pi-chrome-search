/**
 * P4-B unit tests: image search (SPEC §6.4/§7.3, PLAN V4.2).
 *
 * Fully offline. The in-page extractor, canaries and wall probe are executed the
 * way Chrome executes them — stringified through `runInPage` into a `node:vm`
 * context with the captured fixture document — so a selector or a free variable
 * fails here, not in production. The tool runs over `FakePage` + in-memory deps:
 * no socket, no Chrome, no wall-clock sleep.
 *
 * Fixtures (selector census in `src/engines/images.ts`):
 *  - `images-google`: 100 `[data-attrid="images universal"]` cards, 27 with a
 *    real `encrypted-tbn` thumb; the rest are `data:` placeholders.
 *  - `images-yandex`: 30 `.SerpItem`, 0 `.serp-item`, `img_url` as the only
 *    source-image URL.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Value } from "typebox/value";

import type { CdpConnector } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import { googleEngine } from "../../src/engines/google.ts";
import {
  IMAGES_READY_SELECTORS,
  buildImagesUrl,
  detectImagesWall,
  extractImagesFromDocument,
  imageCanaryCountsFromDocument,
  imagesCanaries,
  imagesWallEvidenceFromDocument,
  settleImages,
  type ImageEngineId,
  type ImagesExtraction,
} from "../../src/engines/images.ts";
import { yandexEngine } from "../../src/engines/yandex.ts";
import type { EngineId } from "../../src/engines/types.ts";
import { domainOf } from "../../src/extract/urls.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { WebSearchError, isWebSearchError } from "../../src/runtime/error-codes.ts";
import type { ArtifactInput, Artifacts, Limiter, LimiterStats, Logger } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import {
  IMAGE_SEARCH_DESCRIPTION,
  createImageSearchTool,
  imageSearchSchema,
  type ImageSearchFailure,
  type ImageSearchInput,
  type ImageSearchResult,
  type ImageSearchSuccess,
} from "../../src/tools/image_search.ts";
import { FakeClock } from "../helpers/clock.ts";
import { fixtureDocument, runInPage } from "../helpers/dom.ts";
import { FakePage } from "../helpers/fake-page.ts";
import { loadFixture } from "../helpers/load-fixture.ts";

const GOOGLE_URL = "https://www.google.com/search?q=red+panda&tbm=isch&hl=ru";
const YANDEX_URL = "https://yandex.ru/images/search?text=red+panda";
const CAPTCHA_URL = "https://yandex.ru/showcaptcha?text=red+panda";
const ARTIFACT_ROOT = "/tmp/opencode/pi-chrome-search/artifacts";

/** `document.querySelectorAll("<selector>").length`, the expression settle emits. */
const COUNT_CALL = /document\.querySelectorAll\(("(?:[^"\\]|\\.)*")\)\.length/;
/** `(fn)(document, {"engine":…,"n":…})` — the extraction call shape. */
const EXTRACT_CALL = /\(document, (\{[\s\S]*\})\)$/;
/** `(fn)(document, "google")` — the canary call shape. */
const CANARY_CALL = /\(document, ("(?:[^"\\]|\\.)*")\)$/;

type InPageExtractor = (doc: Document, arg: unknown) => ImagesExtraction;
const EXTRACT_IN_PAGE = extractImagesFromDocument as unknown as InPageExtractor;
type InPageCanaries = (doc: Document, arg: unknown) => Record<string, number>;
const CANARIES_IN_PAGE = imageCanaryCountsFromDocument as unknown as InPageCanaries;
type InPageWall = (doc: Document, arg: unknown) => unknown;

interface Fixture {
  doc: Document;
  page: FakePage;
}

function bodyText(doc: Document): string {
  return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * A `FakePage` that really evaluates the shipped in-page functions against the
 * document, instead of returning a canned payload. `extractPayload` injects a
 * malformed extraction response for the `E_PARSE` path only.
 */
function pageFor(doc: Document, url: string, extractPayload?: unknown): FakePage {
  const page = new FakePage({ url, text: bodyText(doc) });
  page.setEvaluateHandlers((expression: string) => {
    const counted = COUNT_CALL.exec(expression);
    if (counted !== null) {
      return doc.querySelectorAll(JSON.parse(counted[1] as string) as string).length;
    }
    if (expression.includes("imagesWallEvidenceFromDocument")) {
      return runInPage(imagesWallEvidenceFromDocument as unknown as InPageWall, doc, null);
    }
    if (expression.includes("imageCanaryCountsFromDocument")) {
      const match = CANARY_CALL.exec(expression);
      assert.ok(match !== null, "canaries must send only the engine argument");
      return runInPage(CANARIES_IN_PAGE, doc, JSON.parse(match[1] as string));
    }
    assert.ok(
      expression.includes("extractImagesFromDocument"),
      `unexpected evaluate expression: ${expression.slice(0, 80)}`,
    );
    if (extractPayload !== undefined) return extractPayload;
    const match = EXTRACT_CALL.exec(expression);
    assert.ok(match !== null, "extract must call the in-page function with (document, arg)");
    return runInPage(EXTRACT_IN_PAGE, doc, JSON.parse(match[1] as string));
  });
  return page;
}

function fixturePage(name: string, engine: ImageEngineId, url: string): Fixture {
  const fixture = loadFixture(name);
  const doc = fixtureDocument(fixture.html, url);
  return { doc, page: pageFor(doc, url) };
}

function extractFrom(doc: Document, arg: { engine: ImageEngineId; n: number }): ImagesExtraction {
  return runInPage(EXTRACT_IN_PAGE, doc, arg);
}

// ---------------------------------------------------------------------------
// Tool harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  page: FakePage;
  /** Mutate the cloned config before dependencies are built. */
  config?: (config: Config) => void;
}

interface Harness {
  deps: ToolDeps;
  page: FakePage;
  limiterCalls: EngineId[];
  pageRequests: EngineId[];
  saved: ArtifactInput[];
}

function makeHarness(options: HarnessOptions): Harness {
  const config = structuredClone(DEFAULT_CONFIG);
  options.config?.(config);
  const clock = new FakeClock();
  const page = options.page;

  const limiterCalls: EngineId[] = [];
  const limiter: Limiter = {
    async acquire(engine): Promise<void> {
      limiterCalls.push(engine);
    },
    stats(engine): LimiterStats {
      return { engine, lastAt: null, today: 0, dailyCap: 100 };
    },
  };

  const saved: ArtifactInput[] = [];
  const artifacts: Artifacts = {
    async save(input): Promise<string> {
      saved.push(input);
      return `${ARTIFACT_ROOT}/test-${saved.length}`;
    },
    async prune() {
      return { removed: 0, kept: 0, bytes: 0 };
    },
    async size() {
      return 0;
    },
    root(): string {
      return ARTIFACT_ROOT;
    },
  };

  const log: Logger = { async write() {}, path: () => "/dev/null" };
  const pageRequests: EngineId[] = [];
  const cdp: CdpConnector = {
    async connect() {
      throw new Error("connect() is not used by image_search unit tests");
    },
    async acquirePage(engine) {
      pageRequests.push(engine);
      return page;
    },
    async releaseAll() {},
    isConnected: () => true,
    endpoint: () => null,
  };

  const deps: ToolDeps = {
    config,
    engines: createEngineRegistry({ google: googleEngine, yandex: yandexEngine }, config),
    cdp,
    cache: createCache({ maxEntries: 20, clock }),
    limiter,
    artifacts,
    log,
    clock,
  };

  return { deps, page, limiterCalls, pageRequests, saved };
}

async function run(
  harness: Harness,
  input: Partial<ImageSearchInput>,
): Promise<ImageSearchResult> {
  const tool = createImageSearchTool(() => harness.deps);
  return await tool.execute("call-1", input as ImageSearchInput, undefined, undefined);
}

function isFailure(result: ImageSearchResult): result is ImageSearchFailure {
  return "isError" in result && result.isError === true;
}

function expectSuccess(result: ImageSearchResult): ImageSearchSuccess {
  assert.equal(isFailure(result), false, `expected success, got ${JSON.stringify(result.details)}`);
  return result as ImageSearchSuccess;
}

function expectFailure(result: ImageSearchResult): ImageSearchFailure {
  assert.equal(isFailure(result), true, "expected a rendered failure");
  return result as ImageSearchFailure;
}

function textOf(result: ImageSearchResult): string {
  return result.content.map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// buildImagesUrl
// ---------------------------------------------------------------------------

test("buildImagesUrl: Google vertical, language and fixed parameter order", () => {
  assert.equal(
    buildImagesUrl("google", { text: "red panda", lang: "ru" }),
    "https://www.google.com/search?q=red+panda&tbm=isch&hl=ru",
  );

  const parsed = new URL(buildImagesUrl("google", { text: "кот & пёс", lang: "RU" }));
  assert.equal(parsed.origin, "https://www.google.com");
  assert.equal(parsed.pathname, "/search");
  assert.equal(parsed.searchParams.get("q"), "кот & пёс");
  assert.equal(parsed.searchParams.get("tbm"), "isch");
  assert.equal(parsed.searchParams.get("hl"), "ru");

  assert.equal(buildImagesUrl("google", { text: "x", lang: "auto" }).includes("hl="), false);
  assert.equal(buildImagesUrl("google", { text: "x", lang: "" }).includes("hl="), false);
});

test("buildImagesUrl: Yandex text/lr and no invented pagination", () => {
  const parsed = new URL(buildImagesUrl("yandex", { text: "красная панда", region: "6" }));
  assert.equal(parsed.origin, "https://yandex.ru");
  assert.equal(parsed.pathname, "/images/search");
  assert.equal(parsed.searchParams.get("text"), "красная панда");
  assert.equal(parsed.searchParams.get("lr"), "6");
  assert.equal(parsed.searchParams.has("p"), false);

  assert.equal(buildImagesUrl("yandex", { text: "x", region: " " }).includes("lr="), false);
  assert.equal(buildImagesUrl("yandex", { text: "x" }).includes("lr="), false);
});

test("buildImagesUrl: page is accepted but omitted (no verified mapping) and the builder is pure", () => {
  for (const engine of ["google", "yandex"] as const) {
    const first = buildImagesUrl(engine, { text: "x", page: 1 });
    assert.equal(buildImagesUrl(engine, { text: "x", page: 2 }), first);
    assert.equal(buildImagesUrl(engine, { text: "x", page: 999 }), first);
    assert.equal(first.includes("start="), false);
    assert.equal(first.includes("p="), false);
    assert.equal(buildImagesUrl(engine, { text: "x" }), first);
  }
});

// ---------------------------------------------------------------------------
// In-page extraction — fixtures
// ---------------------------------------------------------------------------

test("Google fixture: n=4 usable tiles with all four fields, no data URIs, no duplicates", () => {
  const { doc } = fixturePage("images-google", "google", GOOGLE_URL);
  const extraction = extractFrom(doc, { engine: "google", n: 4 });

  assert.equal(extraction.items.length, 4);
  assert.equal(extraction.pageCarried, true);
  const identity = new Set<string>();
  for (const item of extraction.items) {
    assert.ok(item.alt.length > 0, "alt must be visible text");
    assert.match(item.pageUrl, /^https?:\/\//);
    assert.match(item.thumbUrl, /^https?:\/\//);
    assert.equal(item.thumbUrl.startsWith("data:"), false, "data: placeholders are not renderable");
    assert.equal(item.domain, domainOf(item.pageUrl));
    assert.equal(item.domain.startsWith("www."), false);
    const key = `${item.pageUrl}\n${item.thumbUrl}`;
    assert.equal(identity.has(key), false, `duplicate item ${key}`);
    identity.add(key);
  }
  // At least one real encrypted-tbn thumb proves the 27 usable cards were found,
  // not the 64 lazy `data:` placeholders.
  assert.ok(extraction.items.some((item) => item.thumbUrl.includes("encrypted-tbn")));
});

test("Yandex fixture: n=4 usable tiles with all four fields, no legacy selector", () => {
  const { doc } = fixturePage("images-yandex", "yandex", YANDEX_URL);
  const extraction = extractFrom(doc, { engine: "yandex", n: 4 });

  assert.equal(extraction.items.length, 4);
  assert.equal(extraction.pageCarried, true);
  const identity = new Set<string>();
  for (const item of extraction.items) {
    assert.ok(item.alt.length > 0);
    assert.match(item.pageUrl, /^https?:\/\//);
    assert.match(item.thumbUrl, /^https:\/\/avatars\.mds\.yandex\.net\//);
    assert.equal(item.domain, domainOf(item.pageUrl));
    const key = `${item.pageUrl}\n${item.thumbUrl}`;
    assert.equal(identity.has(key), false, `duplicate item ${key}`);
    identity.add(key);
  }
  // The source image, not the Yandex preview URL, is the disclosed page URL.
  assert.ok(extraction.items.some((item) => item.pageUrl.includes("wikimedia.org")));
});

test("extractor respects n and clamps hostile values to 1..12", () => {
  const { doc } = fixturePage("images-google", "google", GOOGLE_URL);
  assert.equal(extractFrom(doc, { engine: "google", n: 2 }).items.length, 2);
  assert.equal(extractFrom(doc, { engine: "google", n: 12 }).items.length, 12);
  assert.equal(extractFrom(doc, { engine: "google", n: 0 }).items.length, 1);
  assert.equal(extractFrom(doc, { engine: "google", n: -5 }).items.length, 1);
  assert.equal(extractFrom(doc, { engine: "google", n: 999 }).items.length, 12);
  assert.equal(extractFrom(doc, { engine: "google", n: Number.NaN }).items.length, 4);
});

test("extractor skips data: placeholders, tiny icons, ads and duplicate cards", () => {
  const html = `
    <div data-attrid="images universal" data-lpage="https://example.test/a">
      <a href="https://example.test/a"><img src="https://cdn.example.test/a.jpg" alt="Alpha"></a>
    </div>
    <div data-attrid="images universal" data-lpage="https://example.test/a">
      <a href="https://example.test/a"><img src="https://cdn.example.test/a.jpg" alt="Alpha again"></a>
    </div>
    <div data-attrid="images universal" data-lpage="https://example.test/lazy">
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP" alt="Lazy">
    </div>
    <div data-attrid="images universal" data-lpage="https://example.test/icon">
      <img src="https://cdn.example.test/icon.png" alt="Icon" width="16" height="16">
    </div>
    <div data-attrid="images universal" data-text-ad data-lpage="https://ads.example.test/promo">
      <img src="https://cdn.example.test/ad.jpg" alt="Promoted">
    </div>
    <div data-attrid="images universal" data-lpage="https://example.test/b">
      <img src="https://cdn.example.test/b.jpg" alt="Beta">
    </div>`;
  const doc = fixtureDocument(html, GOOGLE_URL);
  const extraction = extractFrom(doc, { engine: "google", n: 10 });

  assert.deepEqual(
    [...extraction.items.map((item) => item.alt)],
    ["Alpha", "Beta"],
  );
  assert.equal(extraction.pageCarried, false);
  assert.equal(extraction.items.some((item) => item.thumbUrl.startsWith("data:")), false);
  assert.equal(extraction.items.some((item) => item.thumbUrl.includes("/ad.jpg")), false);
});

test("canaries separate the live layout from the dead Yandex selector", () => {
  const google = fixturePage("images-google", "google", GOOGLE_URL).doc;
  assert.deepEqual(
    { ...runInPage(CANARIES_IN_PAGE, google, "google") },
    { images: 252, cards: 100, lpage: 100 },
  );

  const yandex = fixturePage("images-yandex", "yandex", YANDEX_URL).doc;
  const counts = runInPage(CANARIES_IN_PAGE, yandex, "yandex");
  assert.equal(counts.cards, 30);
  assert.equal(counts.thumbs, 30);
  assert.equal(counts.legacySerpItem, 0);
});

test("page-side canaries evaluate the same source through CdpPage", async () => {
  const { page } = fixturePage("images-yandex", "yandex", YANDEX_URL);
  const counts = await imagesCanaries(page, "yandex");
  assert.equal(counts.cards, 30);
  assert.equal(counts.thumbs, 30);
  assert.equal(counts.legacySerpItem, 0);
});

// ---------------------------------------------------------------------------
// Wall detection
// ---------------------------------------------------------------------------

test("normal and empty image SERPs are not walls", () => {
  assert.equal(detectImagesWall({ url: GOOGLE_URL, text: "red panda images", tiles: 100 }), null);
  assert.equal(detectImagesWall({ url: YANDEX_URL, text: "Ничего не найдено", tiles: 0 }), null);
  // A caption may quote the captcha phrase on a healthy SERP; tiles contradict it.
  assert.equal(detectImagesWall({ url: YANDEX_URL, text: "Я не робот в подписи", tiles: 30 }), null);
  assert.equal(detectImagesWall(fixturePage("images-google", "google", GOOGLE_URL).doc), null);
  assert.equal(detectImagesWall(fixturePage("images-yandex", "yandex", YANDEX_URL).doc), null);
});

test("wall markers classify sorry/captcha, with URL evidence standing alone", () => {
  const sorry = detectImagesWall("https://www.google.com/sorry/index?continue=x");
  assert.equal(sorry?.kind, "sorry");
  assert.ok(sorry?.markers.includes("/sorry"));

  const captchaUrl = detectImagesWall({ url: CAPTCHA_URL, text: "", tiles: 30 });
  assert.equal(captchaUrl?.kind, "captcha");
  assert.ok(captchaUrl?.markers.includes("/showcaptcha"));

  const captchaText = detectImagesWall({ url: YANDEX_URL, text: "Я не робот", tiles: 0 });
  assert.equal(captchaText?.kind, "captcha");

  const captchaDoc = fixtureDocument(
    '<div class="SmartCaptcha"></div><div>Подтвердите, что запросы отправляли вы</div>',
    CAPTCHA_URL,
  );
  assert.equal(detectImagesWall(captchaDoc)?.kind, "captcha");

  const consent = detectImagesWall({
    url: "https://consent.google.com/m?continue=x",
    text: "",
    tiles: 0,
  });
  assert.equal(consent?.kind, "consent");
});

// ---------------------------------------------------------------------------
// Self-containment
// ---------------------------------------------------------------------------

test("a closure-based extractor fails through runInPage", () => {
  const suffix = " captured-at-module-scope";
  function closureExtractor(doc: Document): string {
    return `${doc.body?.textContent ?? ""}${suffix}`;
  }
  const doc = fixtureDocument("<p>hello</p>", GOOGLE_URL);
  assert.throws(
    () => runInPage(closureExtractor, doc, null),
    /suffix is not defined/,
    "the harness must stringify the function, not call it in this module",
  );
});

// ---------------------------------------------------------------------------
// Tool: schema/description
// ---------------------------------------------------------------------------

test("image_search schema accepts the documented shape and rejects out-of-range n", () => {
  const valid: unknown[] = [
    { q: "red panda" },
    { q: "red panda", n: 1 },
    { q: "red panda", n: 12, engine: "google", attach: false },
    { q: "red panda", n: 4, engine: "yandex", attach: true },
  ];
  for (const value of valid) assert.equal(Value.Check(imageSearchSchema, value), true, JSON.stringify(value));

  const invalid: unknown[] = [
    {},
    { q: "" },
    { q: "x", n: 0 },
    { q: "x", n: 13 },
    { q: "x", n: 2.5 },
    { q: "x", engine: "bing" },
    { q: "x", attach: "yes" },
  ];
  for (const value of invalid) assert.equal(Value.Check(imageSearchSchema, value), false, JSON.stringify(value));
});

test("image_search description stays inside the 350-char budget", () => {
  assert.ok(IMAGE_SEARCH_DESCRIPTION.length > 0);
  assert.ok(IMAGE_SEARCH_DESCRIPTION.length <= 350, `${IMAGE_SEARCH_DESCRIPTION.length} chars`);
  assert.equal(IMAGE_SEARCH_DESCRIPTION.includes("\n"), false);
});

// ---------------------------------------------------------------------------
// Tool: happy path
// ---------------------------------------------------------------------------

test("happy path: Google fixture returns exactly n lines and the deferred tool shape", async () => {
  const harness = makeHarness({ page: fixturePage("images-google", "google", GOOGLE_URL).page });
  const result = await run(harness, { q: "red panda" });
  const success = expectSuccess(result);

  assert.equal(success.details.engine, "google");
  assert.equal(success.details.items, 4);
  assert.equal(success.details.pageCarried, true);
  assert.equal(success.details.attach, false);
  assert.ok(success.details.chars > 0);
  assert.deepEqual(harness.limiterCalls, ["google"]);
  assert.deepEqual(harness.pageRequests, ["google"]);
  assert.equal(harness.page.lastNavigation(), buildImagesUrl("google", { text: "red panda" }));
  assert.equal(harness.page.callCount("bringToFront"), 0);

  const text = textOf(result);
  const lines = text.split("\n");
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.match(line, /^.+ — https?:\/\/\S+ \(https?:\/\/\S+\)$/);
  }
  assert.equal(text.includes("attach ("), false);
  assert.doesNotMatch(text, /<[a-z][^>]*>/i, "compact output must not contain raw HTML");
  assert.equal(text.includes("data:"), false);
});

test("happy path: Yandex fixture uses the engine and config locale", async () => {
  const harness = makeHarness({
    page: fixturePage("images-yandex", "yandex", YANDEX_URL).page,
    config: (config) => {
      config.engines.yandex.lr = "6";
    },
  });
  const result = await run(harness, { q: "красная панда", engine: "yandex" });
  const success = expectSuccess(result);

  assert.equal(success.details.engine, "yandex");
  assert.equal(success.details.items, 4);
  assert.deepEqual(harness.limiterCalls, ["yandex"]);
  assert.equal(
    harness.page.lastNavigation(),
    buildImagesUrl("yandex", { text: "красная панда", region: "6" }),
  );
  assert.match(textOf(result), /avatars\.mds\.yandex\.net/);
});

test("n above 12 is clamped, not rejected, for a codemode caller", async () => {
  // Short, unique URLs keep all 12 lines inside the output budget, so the
  // assertion measures the clamp rather than the renderer's tail drop.
  const cards = Array.from({ length: 12 }, (_, index) =>
    `<div data-attrid="images universal" data-lpage="https://example.test/p${index}">
       <img src="https://cdn.example.test/t${index}.jpg" alt="Tile ${index}">
     </div>`,
  ).join("");
  const doc = fixtureDocument(cards, GOOGLE_URL);
  const harness = makeHarness({ page: pageFor(doc, GOOGLE_URL) });
  const result = await run(harness, { q: "red panda", n: 20 });
  const success = expectSuccess(result);

  assert.equal(success.details.items, 12);
  assert.equal(textOf(result).split("\n").length, 12);
});

test("attach is off by default and emits up to 4 text thumbnail URLs when asked", async () => {
  const harness = makeHarness({ page: fixturePage("images-google", "google", GOOGLE_URL).page });
  const off = expectSuccess(await run(harness, { q: "red panda" }));
  assert.equal(off.details.attach, false);
  assert.equal(textOf(off).includes("attach ("), false);

  const on = expectSuccess(await run(harness, { q: "red panda", attach: true }));
  const text = textOf(on);
  assert.equal(on.details.attach, true);
  assert.ok(text.includes("attach (text URLs only"));
  const attachLines = text.split("\n").slice(text.split("\n").indexOf("attach (text URLs only — this result type has no image blocks):") + 1);
  assert.equal(attachLines.length, 4);
  for (const url of attachLines) assert.match(url, /^https:\/\/encrypted-tbn/);
});

// ---------------------------------------------------------------------------
// Tool: failures
// ---------------------------------------------------------------------------

test("unknown engine is E_UNSUPPORTED before any limiter/page/navigation work", async () => {
  const harness = makeHarness({ page: fixturePage("images-google", "google", GOOGLE_URL).page });
  const result = expectFailure(await run(harness, { q: "x", engine: "bing" as never }));

  assert.equal(result.details.code, "E_UNSUPPORTED");
  assert.equal(result.details.stage, "resolve");
  assert.match(textOf(result), /image_search failed \[E_UNSUPPORTED\]/);
  assert.deepEqual(harness.limiterCalls, []);
  assert.deepEqual(harness.pageRequests, []);
  assert.equal(harness.page.callCount("navigate"), 0);
});

test("an engine disabled in config is E_UNSUPPORTED before any side effect", async () => {
  const harness = makeHarness({
    page: fixturePage("images-google", "google", GOOGLE_URL).page,
    config: (config) => {
      config.engines.google.enabled = false;
    },
  });
  const result = expectFailure(await run(harness, { q: "x" }));

  assert.equal(result.details.code, "E_UNSUPPORTED");
  assert.equal(result.details.engine, "google");
  assert.deepEqual(harness.limiterCalls, []);
  assert.equal(harness.page.callCount("navigate"), 0);
});

test("empty Yandex image SERP renders E_EMPTY", async () => {
  const doc = fixtureDocument('<div class="Misspell">Ничего не найдено</div>', YANDEX_URL);
  const harness = makeHarness({ page: pageFor(doc, YANDEX_URL) });
  const result = expectFailure(await run(harness, { q: "nothing", engine: "yandex" }));

  assert.equal(result.details.code, "E_EMPTY");
  assert.equal(result.details.engine, "yandex");
  assert.equal(result.details.message, "the image search returned no usable tiles");
  assert.equal(harness.saved.length, 0);
});

test("captcha wall renders E_WALL, surfaces the window and saves one artifact", async () => {
  const doc = fixtureDocument(
    '<div class="SmartCaptcha"></div><div>Подтвердите, что запросы отправляли вы</div>',
    CAPTCHA_URL,
  );
  const harness = makeHarness({ page: pageFor(doc, CAPTCHA_URL) });
  const result = expectFailure(await run(harness, { q: "red panda", engine: "yandex" }));

  assert.equal(result.details.code, "E_WALL");
  assert.equal(result.details.wall, "captcha");
  assert.equal(result.details.engine, "yandex");
  assert.match(textOf(result), /wall: captcha/);
  assert.equal(harness.page.callCount("bringToFront"), 1);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0]?.code, "E_WALL");
});

test("a malformed extraction payload renders E_PARSE with an artifact", async () => {
  const doc = fixtureDocument('<div class="Misspell">skeleton</div>', YANDEX_URL);
  const harness = makeHarness({ page: pageFor(doc, YANDEX_URL, null) });
  const result = expectFailure(await run(harness, { q: "broken", engine: "yandex" }));

  assert.equal(result.details.code, "E_PARSE");
  assert.match(textOf(result), /image_search failed \[E_PARSE\]/);
  assert.ok(result.details.artifact !== undefined);
  assert.equal(harness.saved.length, 1);
});

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

test("settle uses a selector-only gate and times out honestly under a fake clock", async () => {
  assert.ok(IMAGES_READY_SELECTORS.google.includes('[data-attrid="images universal"]'));
  assert.ok(IMAGES_READY_SELECTORS.yandex.includes(".SerpItem"));

  const clock = new FakeClock();
  const page = new FakePage({ evaluate: () => 0 });
  await assert.rejects(
    () => settleImages(page, "google", { clock, deadlineMs: 100, pollMs: 10 }),
    (error: unknown) => {
      assert.equal(error instanceof WebSearchError, true);
      assert.equal(isWebSearchError(error) && error.details.code, "E_TIMEOUT");
      return true;
    },
  );
});
