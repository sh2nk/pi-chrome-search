/**
 * Yandex adapter tests (P3-Yandex). Offline: sanitized fixtures, linkedom, a
 * `node:vm` page bridge and the in-memory `FakePage`. No network, no Chrome.
 *
 * The important property here is that `extractFromDocument`/`canaryCounts`/
 * `findExpandTarget` are executed the way the browser executes them — as
 * stringified source — so a module-scope capture fails here, not in production.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import type { Query } from "../../src/engines/types.ts";
import {
  canaryCounts,
  expandAiSummaryOnce,
  extractFromDocument,
  findExpandTarget,
  settleYandex,
  yandexEngine,
  YANDEX_READY_SELECTOR,
  type YandexExtraction,
  type YandexExtractionArg,
} from "../../src/engines/yandex.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { FakeClock } from "../helpers/clock.ts";
import { fixtureDocument, runInPage } from "../helpers/dom.ts";
import { FakePage } from "../helpers/fake-page.ts";
import { loadFixture } from "../helpers/load-fixture.ts";

const SERP_URL = "https://yandex.ru/search/?text=example";
const CAPTCHA_URL = "https://yandex.ru/showcaptcha?text=example";

function query(overrides: Partial<Query> = {}): Query {
  return { text: "пример запроса", n: 10, summary: true, ...overrides };
}

/**
 * Run an adapter expression the way CDP does: stringified source in a fresh
 * context that only knows the document. This keeps `canaries()`, `settle()` and
 * `extract()` honest end-to-end instead of stubbing their internals in the test.
 */
function evaluateInDocument(expression: string, doc: Document): unknown {
  const view = doc.defaultView as unknown as
    | { Node?: unknown; Element?: unknown; HTMLElement?: unknown }
    | null;
  const context = vm.createContext({
    document: doc,
    window: doc.defaultView,
    location: (doc as unknown as { location?: unknown }).location,
    Node: view?.Node,
    Element: view?.Element,
    HTMLElement: view?.HTMLElement,
    URL,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    decodeURIComponent,
    encodeURIComponent,
  });
  return new vm.Script(expression, { filename: "yandex-page.js" }).runInContext(context);
}

/** A `FakePage` whose document is a parsed fixture (text and evaluate agree). */
function pageFor(doc: Document, url: string): FakePage {
  const bodyText = doc.body === null ? "" : (doc.body.textContent ?? "");
  const page = new FakePage({ url, text: bodyText.replace(/[\s\u00a0]+/g, " ").trim() });
  page.setEvaluateHandlers((expression) => evaluateInDocument(expression, doc));
  return page;
}

function fixturePage(name: string, url = SERP_URL): FakePage {
  const fixture = loadFixture(name);
  return pageFor(fixtureDocument(fixture.html, url), url);
}

function extractFrom(html: string, url: string, arg: YandexExtractionArg): YandexExtraction {
  const doc = fixtureDocument(html, url);
  // The cast only relaxes the harness' `arg: unknown`; the function source is untouched.
  const inPage = extractFromDocument as (document: Document, arg: unknown) => YandexExtraction;
  return runInPage(inPage, doc, arg);
}

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------

test("buildUrl: text encoding, page mapping and region", () => {
  assert.equal(
    yandexEngine.buildUrl(query({ text: "кот", n: 5 })),
    `https://yandex.ru/search/?text=${encodeURIComponent("кот")}`,
  );

  const spaced = yandexEngine.buildUrl(query({ text: "стоит ли покупать электромобиль" }));
  const parsed = new URL(spaced);
  assert.equal(parsed.origin, "https://yandex.ru");
  assert.equal(parsed.pathname, "/search/");
  // Round-trip proves the encoding, not just the presence of percent signs.
  assert.equal(parsed.searchParams.get("text"), "стоит ли покупать электромобиль");

  assert.equal(yandexEngine.buildUrl(query({ page: 1 })).includes("p="), false);
  assert.equal(yandexEngine.buildUrl(query({ page: 2 })).endsWith("&p=1"), true);
  assert.equal(yandexEngine.buildUrl(query({ page: 4 })).endsWith("&p=3"), true);
  assert.equal(yandexEngine.buildUrl(query({ page: 0 })).includes("p="), false);
  assert.equal(yandexEngine.buildUrl(query({ page: -3 })).includes("p="), false);

  assert.equal(yandexEngine.buildUrl(query({ region: "6" })).endsWith("&lr=6"), true);
  assert.equal(yandexEngine.buildUrl(query({ region: "  " })).includes("lr="), false);
  assert.equal(yandexEngine.buildUrl(query({ region: undefined })).includes("lr="), false);
});

test("buildUrl: freshness is unverified, so it is omitted; the builder stays pure", () => {
  const base = yandexEngine.buildUrl(query({ page: 2 }));
  for (const freshness of ["d", "w", "m", "y"] as const) {
    assert.equal(
      yandexEngine.buildUrl(query({ page: 2, freshness })),
      base,
      "an unverified within= mapping must not be guessed",
    );
    assert.equal(base.includes("within="), false);
  }

  const input = query({ page: 3, freshness: "w", region: "6" });
  const snapshot = { ...input };
  const first = yandexEngine.buildUrl(input);
  const second = yandexEngine.buildUrl(input);
  assert.equal(first, second);
  assert.deepEqual(input, snapshot);
  // summary only changes extraction effort, never the URL.
  assert.equal(yandexEngine.buildUrl(query({ summary: false })), yandexEngine.buildUrl(query({ summary: true })));
});

// ---------------------------------------------------------------------------
// settle
// ---------------------------------------------------------------------------

test("settle resolves on a real SERP through the structural gate", async () => {
  const page = fixturePage("yandex-neuro");
  await settleYandex(page, { clock: new FakeClock(), deadlineMs: 500, pollMs: 10 });
  // Resolved on the first check: one evaluate, no innerText scraping of a text marker.
  assert.equal(page.evaluateCalls().length, 1);
});

test("settle fails within the deadline when the SERP never appears", async () => {
  const page = new FakePage({ url: SERP_URL, text: "Яндекс" });
  page.setEvaluateHandlers(() => 0);
  const clock = new FakeClock();
  await assert.rejects(
    settleYandex(page, { clock, deadlineMs: 120, pollMs: 10 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_TIMEOUT");
      assert.equal(error.details.stage, "settle");
      assert.match(error.details.message ?? "", /OrganicTitle/);
      return true;
    },
  );
  assert.ok(clock.now() > 0);
});

test("settle cannot match the Yandex home page, even though its text says Найти/Алиса AI", async () => {
  const homeHtml = [
    "<html><body>",
    '<form><input id="text" name="text"><button>Найти</button></form>',
    "<div>Поиск</div><div>Алиса AI</div><p>Картинки Видео Карты</p>",
    "</body></html>",
  ].join("");
  const home = pageFor(fixtureDocument(homeHtml, "https://yandex.ru/"), "https://yandex.ru/");
  const text = await home.innerText();
  assert.match(text, /Найти/);
  assert.match(text, /Алиса AI/);

  await assert.rejects(
    settleYandex(home, { clock: new FakeClock(), deadlineMs: 80, pollMs: 10 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_TIMEOUT");
      return true;
    },
  );
});

test("settle propagates abort as E_CANCELLED", async () => {
  const page = fixturePage("yandex-neuro");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    settleYandex(page, { clock: new FakeClock(), signal: controller.signal, deadlineMs: 500, pollMs: 10 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CANCELLED");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// detectWall
// ---------------------------------------------------------------------------

test("detectWall reports the SmartCaptcha fixture with its exact markers", async () => {
  const page = fixturePage("yandex-captcha", CAPTCHA_URL);
  const wall = await yandexEngine.detectWall(page);
  assert.ok(wall !== null);
  assert.equal(wall.kind, "captcha");
  assert.equal(wall.url, CAPTCHA_URL);
  assert.ok(wall.markers.includes("/showcaptcha"));
  assert.ok(wall.markers.includes("Я не робот"));
  assert.ok(wall.markers.includes("Подтвердите, что запросы отправляли вы"));
  assert.ok(wall.markers.includes("похожи на автоматические"));
  // A soft AI-block gate is not a page wall.
  assert.equal(wall.markers.includes("Мы заметили необычную активность"), false);
});

test("detectWall returns null on normal and empty SERPs", async () => {
  for (const name of ["yandex-neuro", "yandex-no-neuro", "yandex-empty"]) {
    const page = fixturePage(name);
    assert.equal(await yandexEngine.detectWall(page), null, `${name} must not look like a wall`);
  }
});

test("detectWall reports a blocked page only when no organics are present", async () => {
  const blockedHtml =
    "<html><body><h1>Доступ ограничен</h1><p>Запрос заблокирован, нет доступа к странице</p></body></html>";
  const blocked = pageFor(fixtureDocument(blockedHtml, SERP_URL), SERP_URL);
  const wall = await yandexEngine.detectWall(blocked);
  assert.ok(wall !== null);
  assert.equal(wall.kind, "blocked");
  assert.ok(wall.markers.includes("нет доступа"));

  // The same phrase inside a normal SERP is a snippet, not a wall.
  const serpHtml = [
    "<html><body><p>нет доступа к архиву — обсуждение</p>",
    '<div class="Organic"><div class="OrganicTitle"><a href="https://example.com/a">A</a></div></div>',
    "</body></html>",
  ].join("");
  const serp = pageFor(fixtureDocument(serpHtml, SERP_URL), SERP_URL);
  assert.equal(await yandexEngine.detectWall(serp), null);
});

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

test("extract: yandex-neuro returns organics, drops ads, and does not invent a gated AI answer", () => {
  const fixture = loadFixture("yandex-neuro");
  const out = extractFrom(fixture.html, SERP_URL, { n: 10, summary: true, query: "q" });

  assert.ok(out.results.length >= 5, `expected organics, got ${out.results.length}`);
  for (const item of out.results) {
    assert.match(item.url, /^https:\/\//);
    assert.equal(item.url.includes("redircnt"), false);
    assert.equal(item.url.includes("jsredir"), false);
    // Ads in the capture are Yandex redirects; the sanitizer leaves this shape.
    assert.equal(item.url.startsWith("https://yandex."), false);
    assert.ok(item.title.length > 0);
    assert.equal(typeof item.snippet, "string");
  }
  // The card exists (17 OrganicTitle, an h3 "Быстрый ответ Алисы AI") but its
  // answer is behind the robot gate ("Показать ответ"), so there is nothing to
  // report. Absence is a valid A/B outcome; fabricating one is not.
  assert.equal(out.ai, undefined);
  assert.equal(out.pageCarried, false);
});

test("extract: yandex-no-neuro returns organics without an AI block", () => {
  const fixture = loadFixture("yandex-no-neuro");
  const out = extractFrom(fixture.html, SERP_URL, { n: 10, summary: true, query: "q" });
  assert.ok(out.results.length >= 5);
  assert.equal(out.ai, undefined);
  for (const item of out.results) {
    assert.match(item.url, /^https:\/\//);
    assert.equal(item.title.length > 0, true);
  }
  // Both fixtures carry the same robot-gated AI card; the answer is not in the DOM.
  assert.equal(out.pageCarried, true, "n=10 against 12 organics leaves more on the page");
});

test("extract: yandex-empty is an honest zero-result SERP", () => {
  const fixture = loadFixture("yandex-empty");
  const out = extractFrom(fixture.html, SERP_URL, { n: 10, summary: true, query: "q" });
  // In-page arrays come from another realm, so compare the length, not the prototype chain.
  assert.equal(out.results.length, 0);
  assert.equal(out.ai, undefined);
  assert.equal(out.pageCarried, false);
});

test("extract: n limits results and pageCarried reports what was left", () => {
  const fixture = loadFixture("yandex-neuro");
  const all = extractFrom(fixture.html, SERP_URL, { n: 20, summary: false, query: "q" });
  assert.equal(all.results.length, 10);
  assert.equal(all.pageCarried, false);

  const three = extractFrom(fixture.html, SERP_URL, { n: 3, summary: false, query: "q" });
  assert.equal(three.results.length, 3);
  assert.equal(three.pageCarried, true);
  assert.deepEqual(
    Array.from(three.results, (item) => item.url),
    Array.from(all.results.slice(0, 3), (item) => item.url),
  );

  const none = extractFrom(fixture.html, SERP_URL, { n: 0, summary: false, query: "q" });
  assert.equal(none.results.length, 0);
  assert.equal(none.pageCarried, true);
});

test("extract: jsredir, Yandex ad redirects, promo labels and tracking params", () => {
  const html = [
    "<html><body>",
    '<div class="Organic"><div class="OrganicTitle">',
    '<a class="OrganicTitle-Link" href="https://yandex.ru/clck/jsredir?from=x&amp;text=y">Ad one</a>',
    '</div><span class="OrganicTextContentSpan">ad snippet</span></div>',
    '<div class="Organic"><div class="OrganicTitle">',
    '<a href="https://yandex.ru/an/count/abc">Ad two</a>',
    "</div></div>",
    '<div class="Organic"><div class="OrganicTitle">',
    '<a href="https://example.org/labelled">Labelled promo</a>',
    '</div><div class="OrganicHeader-Subtitle"><span>Промо</span></div></div>',
    '<div class="Organic"><div class="OrganicTitle">',
    '<a href="https://example.net/page?redircnt=123&amp;id=7#frag">',
    '<span class="OrganicTitleContentSpan">Real result</span></a>',
    '</div><span class="OrganicTextContentSpan">real snippet</span></div>',
    '<div class="Organic"><div class="OrganicTitle">',
    '<a href="https://example.info/doc?utm_source=ya&amp;from=serp&amp;q=rust">',
    '<span class="OrganicTitleContentSpan">Tracked result</span></a>',
    "</div></div>",
    "</body></html>",
  ].join("");
  const out = extractFrom(html, SERP_URL, { n: 10, summary: false, query: "q" });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].title, "Real result");
  assert.equal(out.results[0].url, "https://example.net/page?id=7");
  assert.equal(out.results[0].snippet, "real snippet");
  assert.equal(out.results[1].url, "https://example.info/doc?q=rust");
});

test("extract: a real Futuris answer is cleaned (label, button, bare domains) with sources", () => {
  const html = [
    "<html><body>",
    '<div class="Organic"><div class="OrganicTitle">',
    '<a href="https://example.com/one">Органический результат</a>',
    '</div><span class="OrganicTextContentSpan">сниппет</span></div>',
    '<div class="FuturisSearch FuturisSearchCard">',
    '<div class="FuturisSearchCard-Content">',
    '<h3 class="FuturisInlineHeader-Title">Быстрый ответ Алисы AI</h3>',
    '<div class="FuturisContentSection">',
    '<div class="FuturisContentSection-Label">Содержимое ответа</div>',
    "<p>Первое предложение ответа.</p>",
    "<p>Второе предложение ответа.</p>",
    "<p>banki.ru</p>",
    '<div class="FuturisContentSection-Sources">',
    '<a href="https://example.com/a">example.com</a>',
    '<a href="https://docs.example.org/b">docs.example.org</a>',
    "</div>",
    "<button type=\"button\"><span>Показать полностью</span></button>",
    "</div></div></div>",
    "</body></html>",
  ].join("");

  const out = extractFrom(html, SERP_URL, { n: 5, summary: true, query: "q" });
  assert.ok(out.ai !== undefined, "an answer body must be reported");
  assert.equal(out.ai.text, "Первое предложение ответа. Второе предложение ответа.");
  assert.equal(out.ai.text.includes("Содержимое ответа"), false);
  assert.equal(out.ai.text.includes("Показать полностью"), false);
  assert.equal(out.ai.text.includes("banki.ru"), false, "bare domain lines are not answer text");
  assert.ok(out.ai.sources.includes("example.com"));
  assert.ok(out.ai.sources.includes("docs.example.org"));
  for (const source of out.ai.sources) assert.equal(source.includes(" "), false);
});

test("extract: summary=false never runs the AI path; a gated card stays gated", () => {
  const answerHtml = [
    "<html><body>",
    '<div class="FuturisSearch FuturisSearchCard">',
    '<h3 class="FuturisInlineHeader-Title">Быстрый ответ Алисы AI</h3>',
    '<div class="FuturisContentSection"><p>Ответ.</p>',
    '<a href="https://example.com/a">example.com</a></div>',
    "</div></body></html>",
  ].join("");
  const withoutSummary = extractFrom(answerHtml, SERP_URL, { n: 5, summary: false, query: "q" });
  assert.equal(withoutSummary.ai, undefined);
  assert.ok(extractFrom(answerHtml, SERP_URL, { n: 5, summary: true, query: "q" }).ai !== undefined);

  const gatedHtml = [
    "<html><body>",
    '<div class="FuturisSearch FuturisSearchCard">',
    '<h3 class="FuturisInlineHeader-Title">Быстрый ответ Алисы AI</h3>',
    '<div class="FuturisRobotGateContent">',
    "<p>Мы заметили необычную активность. Запрос мог быть отправлен роботом автоматически, поэтому мы скрыли ответ</p>",
    "<button>Показать ответ</button>",
    "</div></div></body></html>",
  ].join("");
  assert.equal(extractFrom(gatedHtml, SERP_URL, { n: 5, summary: true, query: "q" }).ai, undefined);
});

test("extract: an unrelated Показать полностью elsewhere does not become an answer", () => {
  const html = [
    "<html><body>",
    '<div class="Something"><h3>Как это работает</h3><button>Показать полностью</button></div>',
    "</body></html>",
  ].join("");
  const out = extractFrom(html, SERP_URL, { n: 5, summary: true, query: "q" });
  assert.equal(out.ai, undefined);
  assert.equal(out.results.length, 0);
});

// ---------------------------------------------------------------------------
// Expansion helper (opt-in only)
// ---------------------------------------------------------------------------

test("findExpandTarget only targets a visible AI-card control", () => {
  const html = [
    "<html><body>",
    '<div class="FuturisSearch"><div class="FactFold">',
    "<p>Ответ…</p>",
    '<button class="ExpandButton">Показать полностью</button>',
    "</div></div>",
    '<div class="Other"><button>Показать полностью</button></div>',
    "</body></html>",
  ].join("");
  const doc = fixtureDocument(html, SERP_URL);
  const button = doc.querySelector('button[class="ExpandButton"]');
  assert.ok(button !== null);
  Object.defineProperty(button, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 120, height: 24, left: 10, top: 40, right: 130, bottom: 64 }),
  });
  const point = runInPage(findExpandTarget, doc, null);
  assert.ok(point !== null);
  // Cross-realm objects: read the numbers instead of comparing prototypes.
  assert.equal(point.x, 70);
  assert.equal(point.y, 52);

  // No AI card → no click target, even with the same label.
  const other = fixtureDocument('<html><body><div class="Other"><button>Показать полностью</button></div></body></html>');
  assert.equal(runInPage(findExpandTarget, other, null), null);
});

test("expandAiSummaryOnce does nothing unless explicitly enabled", async () => {
  const page = fixturePage("yandex-neuro");
  assert.equal(await expandAiSummaryOnce(page), false);
  assert.equal(page.callCount("click"), 0);
  assert.equal(page.evaluateCalls().length, 0, "a disabled step must not even look");

  const noTarget = fixturePage("yandex-empty");
  assert.equal(await expandAiSummaryOnce(noTarget, { enabled: true }), false);
  assert.equal(noTarget.callCount("click"), 0);
});

// ---------------------------------------------------------------------------
// canaries + engine metadata
// ---------------------------------------------------------------------------

test("canaries are >0 on live captures and 0 on the empty shell", async () => {
  const neuro = await yandexEngine.canaries(fixturePage("yandex-neuro"));
  assert.ok(neuro[".OrganicTitle"] > 0);
  assert.ok(neuro[".OrganicTextContentSpan"] > 0);
  assert.ok(neuro["[class*='Futuris']"] > 0);
  assert.ok(neuro[".FuturisSearch"] > 0);
  assert.ok(neuro.h3 > 0);

  const noNeuro = await yandexEngine.canaries(fixturePage("yandex-no-neuro"));
  assert.ok(noNeuro[".OrganicTitle"] > 0);
  assert.ok(noNeuro["[class*='Futuris']"] > 0);

  const empty = await yandexEngine.canaries(fixturePage("yandex-empty"));
  assert.equal(empty[".OrganicTitle"], 0);
  assert.equal(empty[".OrganicTextContentSpan"], 0);
  assert.equal(empty["[class*='Futuris']"], 0);
  assert.equal(empty[".FuturisSearch"], 0);
  assert.equal(empty.h3, 0);
  // The zero-result shell is a settled state, not a broken layout.
  assert.equal(empty[".Misspell"], 1);
});

test("canaries do not throw on an empty body", async () => {
  const doc = fixtureDocument("<html></html>");
  assert.deepEqual(Object.values(canaryCounts(doc)), [0, 0, 0, 0, 0, 0]);
  const page = pageFor(doc, "about:blank");
  assert.deepEqual(Object.values(await yandexEngine.canaries(page)), [0, 0, 0, 0, 0, 0]);
});

test("engine metadata: id, retryOnWall and the interaction contract", () => {
  assert.equal(yandexEngine.id, "yandex");
  assert.equal(yandexEngine.retryOnWall, true);
  const interaction = yandexEngine.interaction;
  assert.ok(interaction !== undefined);
  assert.equal(interaction.homeUrl, "https://yandex.ru/");
  assert.deepEqual([...interaction.boxSelectors], ["#text", 'input[name="text"]', 'textarea[name="text"]']);
  // Deliberate: see the YANDEX_READY_SELECTOR comment — no text is unique to a
  // settled SERP, so the structural gate carries settle and minCount protects it.
  assert.equal(interaction.marker, "");
  assert.equal(interaction.selector, YANDEX_READY_SELECTOR);
  assert.equal(interaction.minCount, 1);
});

test("a closure-based extractor fails through runInPage, exactly like in the browser", () => {
  const suffix = "captured-from-module-scope";
  function leaky(doc: Document): string {
    return (doc.body === null ? "" : (doc.body.textContent ?? "")) + suffix;
  }
  assert.throws(() => runInPage(leaky, fixtureDocument("<p>a</p>"), null), /suffix|not defined/i);
});
