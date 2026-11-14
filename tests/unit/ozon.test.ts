/**
 * Ozon adapter tests (SPEC S6.5, §15 D11/D14/D13). Offline: two sanitized
 * captures of a real SERP (`ozon-serp`, `ozon-no-match`), linkedom, a `node:vm`
 * page bridge and the in-memory `FakePage`. No network, no Chrome.
 *
 * The captures are the *results area* of the page (header, footer and the
 * server-rendered bootstrap JSON were dropped before commit: that JSON carries a
 * session `userToken`, which no fixture may ship).
 *
 * What this file pins:
 *  - `buildUrl` is the live-verified shape (`/search/?text=…&page=…`, 1-based,
 *    verified by a page-2 navigation that returned a different product set) and
 *    Ozon's semantic redirect to a category leaves the cards and `page` intact;
 *  - extraction reads the design-system nodes (`.tile-root`, `tsBody500Medium`
 *    title, `tsHeadline500Medium` price, `tsBodyControl300XSmall` score/count)
 *    and classifies score vs review count by *shape*, not by the word;
 *  - the product link loses every query parameter (`at=`, `avtc=`, …): that is
 *    attribution state, and the link the user clicks must be the clean one;
 *  - a card carries no description, so the snippet is empty on purpose;
 *  - the home page renders cards of its own, so the readiness gate is the
 *    results chrome and the typed warm-up can never settle on the home page;
 *  - a zero-match query is reported as a labelled fallback (`notice`), never as
 *    an answer;
 *  - the engine is *special*: registered, disabled by default, never in `auto`.
 *
 * The wall cases are the honest gap in this file: Ozon's block page could not be
 * captured without provoking the firewall, so `detectOzonWall` is exercised on
 * synthetic markup and the fixtures only prove what a *normal* page is not. No
 * test here claims the markers were ever seen on a real block page.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { createEngineRegistry, createDefaultRegistry } from "../../src/engines/index.ts";
import { DEFAULT_CONFIG } from "../../src/config/index.ts";
import {
  NO_MATCH_NOTICE,
  OZON_READY_SELECTOR,
  canaryCounts,
  detectOzonWall,
  extractFromDocument,
  ozonEngine,
  settleOzon,
  type OzonExtraction,
  type OzonExtractionArg,
} from "../../src/engines/ozon.ts";
import { ENGINE_CLASS, SPECIAL_ENGINES, SUPPORT_MATRIX, type Query } from "../../src/engines/types.ts";
import { compactSerps } from "../../src/extract/compact.ts";
import { ERROR_HINTS, isWebSearchError } from "../../src/runtime/error-codes.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { FakeClock, FakePage } from "../helpers/fake-cdp.ts";
import { fixtureDocument, loadFixture, runInPage } from "../helpers/fixtures.ts";
import { createHarness, resultText } from "../helpers/search-harness.ts";

const SERP_URL = "https://www.ozon.ru/search/?text=iphone+13";
const HOME_URL = "https://www.ozon.ru/";

function query(overrides: Partial<Query> = {}): Query {
  return { text: "iphone 13", n: 5, summary: false, ...overrides };
}

/** Run an adapter expression the way CDP does: stringified source, document only. */
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
  return new vm.Script(expression, { filename: "ozon-page.js" }).runInContext(context);
}

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

function extractFrom(html: string, url: string, arg: OzonExtractionArg): OzonExtraction {
  const doc = fixtureDocument(html, url);
  const inPage = extractFromDocument as (document: Document, arg: unknown) => OzonExtraction;
  return runInPage(inPage, doc, arg);
}

// ---------------------------------------------------------------------------
// buildUrl / interaction
// ---------------------------------------------------------------------------

test("buildUrl: query encoding and 1-based pagination, no phantom region", () => {
  assert.equal(ozonEngine.buildUrl(query()), "https://www.ozon.ru/search/?text=iphone%2013");

  const parsed = new URL(ozonEngine.buildUrl(query({ text: "кофемашина delonghi" })));
  assert.equal(parsed.origin, "https://www.ozon.ru");
  assert.equal(parsed.pathname, "/search/");
  assert.equal(parsed.searchParams.get("text"), "кофемашина delonghi", "the query round-trips");

  assert.equal(ozonEngine.buildUrl(query({ page: 1 })).includes("page="), false);
  assert.equal(ozonEngine.buildUrl(query({ page: 2 })).endsWith("&page=2"), true);
  assert.equal(ozonEngine.buildUrl(query({ page: 0 })).includes("page="), false);

  // Ozon has no URL region/language parameter: a region on the Query is not a
  // hidden key, it simply is not part of this engine's surface (S7.5).
  assert.equal(ozonEngine.buildUrl(query({ region: "kaluga" })), ozonEngine.buildUrl(query()));
});

test("the typed warm-up starts on the Ozon home page with the captured search box", () => {
  const interaction = ozonEngine.interaction;
  assert.ok(interaction !== undefined);
  assert.equal(interaction.homeUrl, HOME_URL);
  assert.deepEqual([...(interaction.homeHosts ?? [])], ["ozon.ru"]);
  assert.equal(interaction.typeProfile?.box, 'input[name="text"]');
  assert.equal(interaction.typeProfile?.maxChars, 255, "longer queries are never typed (captured maxlength)");
  assert.equal(interaction.marker, "", "settlement is selector-only: no text marker to scrape");
  assert.equal(interaction.typeOn, undefined, "the home page does render a usable input");
});

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

test("S13.4 extraction reads the captured SERP: titles, prices, links, facts", () => {
  const fixt = loadFixture("ozon-serp");
  const out = extractFrom(fixt.html, SERP_URL, { n: 3 });

  assert.equal(out.results.length, 3, "n is honoured");
  assert.equal(out.pageCarried, true, "16 cards on the page, 3 returned");
  assert.equal(out.headline, "", "a matching SERP renders no notice headline");

  const first = out.results[0];
  assert.ok(first !== undefined);
  assert.match(first.title, /^Восстановленный Apple Смартфон Apple iPhone 12 mini/, "the tile title is the title");
  assert.equal(
    first.url,
    "https://www.ozon.ru/product/vosstanovlennyy-apple-smartfon-apple-iphone-12-mini-4-64gb-podderzhivaet-odnu-fizicheskuyu-sim-kartu-3189973510/",
  );
  assert.equal(first.snippet, "", "an Ozon tile has no description, and none is invented");
  // Spread: arrays built inside the `node:vm` context have that realm's Array
  // prototype, which `assert/strict` treats as a different type.
  assert.deepEqual([...(first.facts ?? [])], ["15 481 ₽", "4.7", "353 отзыва"]);

  for (const item of out.results) {
    assert.equal(new URL(item.url).origin, "https://www.ozon.ru");
    assert.equal(item.url.includes("at="), false, "the attribution token is never a user-facing link");
    assert.ok(item.snippet === "", "every card is snippet-less, not half-filled");
  }
});

test("S7.7/D13 facts are copied per card and stay a short display line", () => {
  const fixt = loadFixture("ozon-serp");
  const out = extractFrom(fixt.html, SERP_URL, { n: 50 });
  assert.equal(out.results.length, 16);

  let priced = 0;
  for (const item of out.results) {
    const facts = [...(item.facts ?? [])];
    assert.ok(facts.length >= 1 && facts.length <= 3, `a card carries price/score/count, got ${facts.length}`);
    const [price, rating, reviews] = facts;
    assert.match(price ?? "", /^\d[\d\u00a0\u202f ]*₽$/, "the price is the page's own string");
    assert.match(rating ?? "", /^\d(?:[.,]\d)?$/, "the score is a bare number, copied");
    assert.match(reviews ?? "", /^\d[\d\u00a0\u202f ]*\s\S+$/, "the count keeps the page's words");
    if (price !== undefined) priced += 1;
  }
  assert.equal(priced, 16, "every captured card shows a price");
});

test("S7.6 a zero-match query is reported as a labelled fallback, not as an answer", async () => {
  const fixt = loadFixture("ozon-no-match");
  const out = extractFrom(fixt.html, SERP_URL, { n: 3 });

  assert.equal(out.headline, "Ничего не нашлось", "the captured headline is what the detector keys on");
  assert.equal(out.results.length, 3, "the recommendation cards are still returned…");

  const serp = await ozonEngine.extract(fixturePage("ozon-no-match"), query({ n: 2 }));
  // …and the adapter says what they are. The notice is our constant, not page
  // text, so a SERP cannot inject prose into the output through it.
  assert.equal(serp.notice, NO_MATCH_NOTICE);
  assert.match(NO_MATCH_NOTICE, /no exact match/);
  assert.equal(serp.ai, undefined, "no AI block: summary is flagged, not invented");
});

test("extraction is defensive: an empty document is an empty SERP, not a throw", () => {
  const out = extractFrom("<html><body></body></html>", SERP_URL, { n: 5 });
  assert.equal(out.results.length, 0);
  assert.equal(out.pageCarried, false);
  assert.equal(out.headline, "");
});

test("canaries count the selectors the extractor depends on", () => {
  const fixt = loadFixture("ozon-serp");
  const doc = fixtureDocument(fixt.html, SERP_URL);
  const counts = runInPage(
    canaryCounts as (document: Document, arg: unknown) => Record<string, number>,
    doc,
    undefined,
  );

  assert.equal(counts[".tile-root"], 16);
  assert.equal(counts["span.tsBody500Medium"], 16, "one title node per card");
  assert.equal(counts["span.tsHeadline500Medium"], 16, "one price node per card");
  assert.equal(counts["span.tsBodyControl300XSmall"], 32, "score + count on every card");
  assert.equal(counts['[data-widget="searchResultsSort"]'], 1, "the results chrome is the gate");
  assert.equal(counts['[data-widget="statusWidget"]'], 0, "a matching SERP renders no notice");
});

// ---------------------------------------------------------------------------
// settle / wall
// ---------------------------------------------------------------------------

test("settle resolves on a captured SERP through the structural gate", async () => {
  const page = fixturePage("ozon-serp");
  await settleOzon(page, { clock: new FakeClock(), deadlineMs: 500, pollMs: 10 });
  assert.equal(page.evaluateCalls().length, 1, "one evaluate, no text scraping");
});

test("settle cannot match the captured home page shape: cards alone are not results", async () => {
  // The live home page renders 20 `.tile-root` carousel cards and no results
  // chrome (measured on the capture), so a bare card selector would let the
  // typed warm-up settle on the home page and read a carousel as a search.
  const homeHtml = [
    "<html><body>",
    '<div data-widget="searchBarDesktop"><input name="text" placeholder="Искать на Ozon"></div>',
    '<div data-widget="tileGridDesktop"><div data-index="0" class="tile-root">',
    '<a href="/product/x-1/"><span class="tsBody500Medium">Товар</span></a>',
    '<span class="tsHeadline500Medium">1 000 ₽</span>',
    "</div></div>",
    "</body></html>",
  ].join("");
  const home = pageFor(fixtureDocument(homeHtml, HOME_URL), HOME_URL);
  assert.equal(await home.evaluate(`document.querySelectorAll(${JSON.stringify(OZON_READY_SELECTOR)}).length`), 0);
  await assert.rejects(
    settleOzon(home, { clock: new FakeClock(), deadlineMs: 80, pollMs: 10 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_TIMEOUT");
      assert.equal(error.details.stage, "settle");
      return true;
    },
  );
});

test("settle propagates abort as E_CANCELLED", async () => {
  const page = fixturePage("ozon-serp");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    settleOzon(page, { clock: new FakeClock(), signal: controller.signal, deadlineMs: 500, pollMs: 10 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CANCELLED");
      return true;
    },
  );
});

/**
 * Synthetic wall markup: Ozon's block page could not be captured without
 * provoking the firewall, which the hard rules forbid. These assertions pin the
 * *rule* (a widget is a wall on its own, a phrase needs zero cards), not the
 * claim that Ozon serves exactly this page.
 */
test("S9.3 a captcha widget or a block URL is a wall; a quoted phrase alone is not", async () => {
  const captchaUrl = new FakePage({ url: "https://www.ozon.ru/blocked?reason=captcha", text: "" });
  const byUrl = await detectOzonWall(captchaUrl);
  assert.equal(byUrl?.kind, "captcha");
  assert.ok(byUrl.markers.includes("/blocked"));

  const widget = pageFor(
    fixtureDocument('<html><body><div id="captcha"></div></body></html>', SERP_URL),
    SERP_URL,
  );
  assert.deepEqual(await detectOzonWall(widget), {
    kind: "captcha",
    url: SERP_URL,
    markers: ["captcha-node"],
  });

  // A product title that quotes the block sentence is not a wall: cards are
  // still on the page.
  const quoted = [
    "<html><body>",
    '<div data-widget="searchResultsSort"></div>',
    '<div class="tile-root"><a href="/product/x-1/"><span class="tsBody500Medium">Доступ ограничен</span></a></div>',
    "</body></html>",
  ].join("");
  assert.equal(await detectOzonWall(pageFor(fixtureDocument(quoted, SERP_URL), SERP_URL)), null);

  // Body text without any card: the block page shape.
  const blocked = pageFor(
    fixtureDocument("<html><body><h1>Доступ ограничен</h1></body></html>", SERP_URL),
    SERP_URL,
  );
  const wall = await detectOzonWall(blocked);
  assert.equal(wall?.kind, "blocked");
  assert.ok(wall.markers.includes("Доступ ограничен"));
});

test("detectWall is null on both captured normal states", async () => {
  for (const name of ["ozon-serp", "ozon-no-match"]) {
    assert.equal(await detectOzonWall(fixturePage(name)), null, `${name} is not a wall`);
  }
});

test("D5/S9.4 a wall page reaches web_search as E_WALL, not as a deadline", async () => {
  const rig = createHarness({
    engines: [ozonEngine],
    configure: (config) => {
      config.engines.ozon = { enabled: true };
    },
  });
  const wallHtml = '<html><body><div id="captcha"></div><p>Подтвердите, что вы не робот</p></body></html>';
  const wall = pageFor(fixtureDocument(wallHtml, SERP_URL), SERP_URL);
  rig.pages.set("ozon", wall);

  const result = await createWebSearchTool(async () => rig.deps).execute(
    "call-ozon-wall",
    { q: "iphone 13", engines: "ozon" },
    undefined,
    undefined,
  );

  if (!("isError" in result)) assert.fail("a wall must be a typed failure");
  assert.equal(result.details.code, "E_WALL");
  assert.equal(result.details.engine, "ozon");
  assert.equal(result.details.retryable, true);
  assert.equal(result.details.wall, "captcha");
  assert.match(result.details.artifact ?? "", /artifact/);
  assert.ok(resultText(result).includes(ERROR_HINTS.E_WALL), "the hint names the human remedy");
  assert.equal(rig.artifacts.length, 1, "one artifact for the wall the caller sees");
  assert.equal(wall.bringToFrontCount(), 1, "the window is surfaced for the human");
});

// ---------------------------------------------------------------------------
// matrix / registry / rendering
// ---------------------------------------------------------------------------

test("D11/S4.7 ozon is a special engine: registered, opt-in, never in auto", () => {
  assert.equal(ENGINE_CLASS.ozon, "special");
  assert.deepEqual([...SPECIAL_ENGINES], ["avito", "ozon"]);

  const shipped = createDefaultRegistry(DEFAULT_CONFIG);
  assert.equal(shipped.has("ozon"), true, "the adapter is wired");
  assert.equal(shipped.enabled().includes("ozon"), false, "it ships disabled (D14)");
  assert.equal(shipped.select("auto").includes("ozon"), false);

  const enabled = structuredClone(DEFAULT_CONFIG);
  enabled.engines.ozon.enabled = true;
  const registry = createDefaultRegistry(enabled);
  assert.deepEqual(registry.select(["ozon"]), ["ozon"], "an explicit request is honoured");
  assert.equal(registry.select("auto").includes("ozon"), false, "auto still never reaches it");
});

test("S4.2 summary is flagged for ozon; page and n are honoured", () => {
  assert.equal(SUPPORT_MATRIX.summary.ozon, "flag");
  assert.equal(SUPPORT_MATRIX.page.ozon, "yes");
  assert.equal(SUPPORT_MATRIX.n.ozon, "yes");
});

test("D13/S7.6 rendering: facts follow the (empty) snippet, the notice is its own line", async () => {
  const serp = await ozonEngine.extract(fixturePage("ozon-serp"), query({ n: 3 }));
  assert.equal(serp.engine, "ozon");
  assert.equal(serp.ai, undefined, "no AI block");

  const compact = compactSerps([serp], {
    n: 3,
    summaryMaxChars: 1200,
    snippetMaxChars: 140,
    outputMaxChars: 2500,
  });
  assert.match(compact.text, /15 481 ₽ · 4\.7 · 353 отзыва/, "facts render on one line");
  assert.equal(compact.data.facts, undefined, "facts live on the items, not the envelope");
  const items = compact.data.results as Array<Record<string, unknown>>;
  assert.deepEqual(items[0]?.facts, ["15 481 ₽", "4.7", "353 отзыва"]);
  assert.equal(items[0]?.snippet, "", "an empty snippet is emitted as empty, not as a blank line");
  assert.ok(compact.chars <= 2500);

  const noMatch = compactSerps([await ozonEngine.extract(fixturePage("ozon-no-match"), query({ n: 2 }))], {
    n: 2,
    summaryMaxChars: 1200,
    snippetMaxChars: 140,
    outputMaxChars: 2500,
  });
  assert.match(noMatch.text, /^note: no exact match/m);
  assert.equal(noMatch.data.notice, NO_MATCH_NOTICE);
});

test("a stale adapter map without ozon still answers auto from the primary set", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.engines.ozon.enabled = true;
  const registry = createEngineRegistry({ google: ozonEngine }, config);
  assert.deepEqual(registry.select("auto"), ["google"], "auto must not depend on a special adapter being present");
  assert.equal(registry.has("ozon"), false);
  assert.equal(registry.select("ozon").length, 0, "an unregistered id is dropped, not invented");
});
