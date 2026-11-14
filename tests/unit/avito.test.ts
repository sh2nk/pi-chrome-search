/**
 * Avito adapter tests (SPEC S6.4, §15 D11/D12/D13). Offline: two sanitized
 * captures of a real SERP (`avito-serp`, `avito-no-match`), linkedom, a
 * `node:vm` page bridge and the in-memory `FakePage`. No network, no Chrome.
 *
 * `avito-wall` is the one fixture that is not our own capture: Avito's firewall
 * markup was obtained out of band and pasted into a tab, so its markup is
 * evidence and its page URL is not (see the adapter's marker comment). No test
 * here asserts anything about where Avito serves that page.
 *
 * What this file pins:
 *  - `buildUrl` is the live-verified shape (`/<location>?q=…&p=…`), and a region
 *    that is not a slug degrades to `all` instead of becoming a 404 path;
 *  - the typed warm-up starts on the configured region's home (`homeUrlFor`);
 *  - extraction reads the `data-marker` contract (item/title/price/params/
 *    location), strips Avito's tracking blob from the link, and puts price,
 *    location and age into `facts` (D13) instead of the snippet;
 *  - a no-match query is reported as a fallback (`notice`), never as an answer;
 *  - a wall is `E_WALL` material, and a phrase alone is not a wall;
 *  - the engine is *special*: registered, disabled by default, never in `auto`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { createEngineRegistry, createDefaultRegistry } from "../../src/engines/index.ts";
import { DEFAULT_CONFIG } from "../../src/config/index.ts";
import {
  AVITO_READY_SELECTOR,
  SIMILAR_NOTICE,
  avitoEngine,
  canaryCounts,
  detectAvitoWall,
  extractFromDocument,
  locationSlug,
  settleAvito,
  type AvitoExtraction,
  type AvitoExtractionArg,
} from "../../src/engines/avito.ts";
import { ENGINE_CLASS, SUPPORT_MATRIX, type Query } from "../../src/engines/types.ts";
import { compactSerps } from "../../src/extract/compact.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { ERROR_HINTS } from "../../src/runtime/error-codes.ts";
import { FakeClock, FakePage } from "../helpers/fake-cdp.ts";
import { fixtureDocument, loadFixture, runInPage } from "../helpers/fixtures.ts";
import { createHarness, resultText } from "../helpers/search-harness.ts";

const SERP_URL = "https://www.avito.ru/all?q=iphone+13";
const HOME_URL = "https://www.avito.ru/";

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
  return new vm.Script(expression, { filename: "avito-page.js" }).runInContext(context);
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

function extractFrom(html: string, url: string, arg: AvitoExtractionArg): AvitoExtraction {
  const doc = fixtureDocument(html, url);
  const inPage = extractFromDocument as (document: Document, arg: unknown) => AvitoExtraction;
  return runInPage(inPage, doc, arg);
}

// ---------------------------------------------------------------------------
// buildUrl / interaction
// ---------------------------------------------------------------------------

test("buildUrl: query encoding, region slug and 1-based pagination", () => {
  assert.equal(avitoEngine.buildUrl(query()), `https://www.avito.ru/all?q=iphone%2013`);

  const parsed = new URL(avitoEngine.buildUrl(query({ text: "кофемашина delonghi" })));
  assert.equal(parsed.origin, "https://www.avito.ru");
  assert.equal(parsed.pathname, "/all");
  assert.equal(parsed.searchParams.get("q"), "кофемашина delonghi", "q round-trips, not just encoded");

  assert.equal(avitoEngine.buildUrl(query({ page: 1 })).includes("p="), false);
  assert.equal(avitoEngine.buildUrl(query({ page: 2 })).endsWith("&p=2"), true);
  assert.equal(avitoEngine.buildUrl(query({ page: 0 })).includes("p="), false);

  assert.equal(avitoEngine.buildUrl(query({ region: "kaluga" })), "https://www.avito.ru/kaluga?q=iphone%2013");
  assert.equal(avitoEngine.buildUrl(query({ region: "  Kaluga " })), "https://www.avito.ru/kaluga?q=iphone%2013");
  // A display name or a hostile value is not a path segment: `all` is the honest
  // default instead of a percent-encoded 404 (S7.5).
  for (const region of ["Калуга", "../../x", "a/b", "  "]) {
    assert.equal(locationSlug(region), "all", `${JSON.stringify(region)} must degrade to all`);
  }
});

test("the typed warm-up starts on the configured region's home page", () => {
  const interaction = avitoEngine.interaction;
  assert.ok(interaction !== undefined);
  assert.equal(interaction.homeUrlFor?.(query({ region: "kaluga" })), "https://www.avito.ru/kaluga/");
  assert.equal(interaction.homeUrlFor?.(query({ region: undefined })), "https://www.avito.ru/all/");
  assert.deepEqual([...(interaction.homeHosts ?? [])], ["avito.ru"]);
  // The box the capture proved: `input[data-marker="search-form/suggest/input"]`.
  assert.equal(interaction.typeProfile?.box, 'input[data-marker="search-form/suggest/input"]');
  assert.equal(interaction.typeProfile?.maxChars, 100, "longer queries are never typed (captured maxlength)");
  assert.equal(interaction.marker, "", "settlement is selector-only: the home page has no ready node");
});

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

test("S13.4 extraction reads the captured SERP: titles, prices, places, links", () => {
  const fixt = loadFixture("avito-serp");
  const out = extractFrom(fixt.html, SERP_URL, { n: 3 });

  assert.equal(out.results.length, 3, "n is honoured");
  assert.equal(out.pageCarried, true, "50 cards on the page, 3 returned");
  assert.equal(out.similar, false, "a matching SERP is not a fallback page");

  const first = out.results[0];
  assert.ok(first !== undefined);
  assert.equal(first.title, "iPhone 13, 128 ГБ, SIM + eSIM");
  assert.equal(first.url, "https://www.avito.ru/samara/telefony/iphone_13_128_gb_sim_esim_8176011385");
  assert.equal(first.snippet, "Новый, 6.1″", "the listing params are the closest thing to a snippet");
  // Spread: arrays built inside the `node:vm` context have that realm's Array
  // prototype, which `assert/strict` treats as a different type.
  assert.deepEqual([...(first.facts ?? [])], ["23 990 ₽", "Самарская обл., Самара"]);

  for (const item of out.results) {
    assert.equal(new URL(item.url).origin, "https://www.avito.ru");
    assert.equal(item.url.includes("context="), false, "the ranking blob is never a user-facing link");
    assert.equal(item.url.includes("cd="), false);
    assert.ok(item.facts !== undefined && item.facts.length > 0, "every real card carries a price and a place");
  }
});

test("D13 facts carry the listing age when the card shows it", () => {
  const fixt = loadFixture("avito-serp");
  const out = extractFrom(fixt.html, SERP_URL, { n: 50 });
  const dated = out.results.filter((item) => item.facts.includes("Вчера") || item.facts.some((fact) => /дн|недел|месяц/.test(fact)));
  assert.ok(dated.length > 0, "the capture carries item-date cards");
  for (const item of out.results) assert.ok((item.facts.length ?? 0) <= 4, "facts stay a short display line");
});

test("S7.6 a no-match query is reported as a labelled fallback, not as an answer", () => {
  const fixt = loadFixture("avito-no-match");
  const out = extractFrom(fixt.html, "https://www.avito.ru/all?q=zzzzqqqq", { n: 3 });

  assert.equal(out.similar, true);
  assert.equal(out.results.length, 3, "the similar cards are still returned…");
  const serp = avitoEngine.extract as unknown as (
    page: unknown,
    q: Query,
  ) => Promise<{ notice?: string }>;
  assert.equal(typeof serp, "function");
  // …and the adapter says what they are (the notice is our constant, not page text).
  assert.match(SIMILAR_NOTICE, /no exact match/);
});

test("extraction is defensive: an empty document is an empty SERP, not a throw", () => {
  const out = extractFrom("<html><body></body></html>", SERP_URL, { n: 5 });
  assert.equal(out.results.length, 0);
  assert.equal(out.pageCarried, false);
  assert.equal(out.similar, false);
});

test("canaries count the selectors the extractor depends on", () => {
  const fixt = loadFixture("avito-serp");
  const doc = fixtureDocument(fixt.html, SERP_URL);
  const counts = runInPage(
    canaryCounts as (document: Document, arg: unknown) => Record<string, number>,
    doc,
    undefined,
  );

  assert.equal(counts['[data-marker="item"]'], 50);
  assert.equal(counts['[data-marker="item-title"]'], 50);
  assert.equal(counts['[data-marker="item-price-value"]'], 50);
  assert.equal(counts['[data-marker="item-location"]'], 50);
  assert.equal(counts['[data-marker="page-title"]'], 1);
  assert.ok((counts['[data-marker="item-date"]'] ?? 0) > 0, "dated cards exist in the capture");
});

// ---------------------------------------------------------------------------
// settle / wall
// ---------------------------------------------------------------------------

test("settle resolves on a captured SERP through the structural gate", async () => {
  const page = fixturePage("avito-serp");
  await settleAvito(page, { clock: new FakeClock(), deadlineMs: 500, pollMs: 10 });
  assert.equal(page.evaluateCalls().length, 1, "one evaluate, no text scraping");
});

test("settle cannot match the captured Avito home page", async () => {
  // The home page has the search box and no card/page-title nodes (verified on
  // the capture), so the warm-up page can never be mistaken for a settled SERP.
  const homeHtml = [
    "<html><body>",
    '<form><input data-marker="search-form/suggest/input" placeholder="Поиск по объявлениям"></form>',
    "<div>Во всех регионах</div><div>Электроника</div>",
    "</body></html>",
  ].join("");
  const home = pageFor(fixtureDocument(homeHtml, HOME_URL), HOME_URL);
  assert.equal(await home.evaluate(`document.querySelectorAll(${JSON.stringify(AVITO_READY_SELECTOR)}).length`), 0);
  await assert.rejects(
    settleAvito(home, { clock: new FakeClock(), deadlineMs: 80, pollMs: 10 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_TIMEOUT");
      assert.equal(error.details.stage, "settle");
      return true;
    },
  );
});

test("settle propagates abort as E_CANCELLED", async () => {
  const page = fixturePage("avito-serp");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    settleAvito(page, { clock: new FakeClock(), signal: controller.signal, deadlineMs: 500, pollMs: 10 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CANCELLED");
      return true;
    },
  );
});

test("a captcha URL or widget is a wall; a phrase alone is not", async () => {
  const captchaUrl = new FakePage({ url: "https://www.avito.ru/blocked?reason=captcha", text: "" });
  const byUrl = await detectAvitoWall(captchaUrl);
  assert.equal(byUrl?.kind, "captcha");
  assert.ok(byUrl.markers.includes("/blocked"));

  const widgetHtml = '<html><body><div id="captcha"></div></body></html>';
  const widget = pageFor(fixtureDocument(widgetHtml, SERP_URL), SERP_URL);
  const byWidget = await detectAvitoWall(widget);
  assert.equal(byWidget?.kind, "captcha");
  assert.deepEqual(byWidget.markers, ["captcha-node"]);

  // A listing title that quotes the firewall sentence is not a wall: the page
  // still carries cards.
  const quotedHtml = [
    "<html><body><div data-marker=\"page-title\"><h1 data-marker=\"page-title/text\">Доступ ограничен</h1></div>",
    "<div data-marker=\"item\">",
    '<a data-marker="item-title" href="/samara/x_1">Объявление</a>',
    "</div></body></html>",
  ].join("");
  const quoted = pageFor(fixtureDocument(quotedHtml, SERP_URL), SERP_URL);
  assert.equal(await detectAvitoWall(quoted), null);

  // Body text without cards is the real block page.
  const blockedHtml = "<html><body><h1>Страница не загрузилась из-за проблем с IP</h1></body></html>";
  const blocked = pageFor(fixtureDocument(blockedHtml, SERP_URL), SERP_URL);
  const wall = await detectAvitoWall(blocked);
  assert.equal(wall?.kind, "blocked");
  assert.ok(wall.markers.includes("Страница не загрузилась из-за проблем с"));
});

/**
 * The firewall markup (`avito-wall`): "Доступ ограничен: проблема с IP" and an
 * hCaptcha checkbox. The sentence is only in `<title>`, and the page has neither
 * readiness node a SERP has — so the gate names the widget itself and the wall is
 * reported at once instead of after a 12 s deadline (D5). Its URL is ours, not
 * evidence: the fixture was pasted into a tab (see the file header).
 */
test("S9.3/S8.5 the captured firewall is reported at once, not as a timeout", async () => {
  const page = fixturePage("avito-wall");
  page.setTitle("Доступ ограничен: проблема с IP");

  const wall = await detectAvitoWall(page);
  assert.equal(wall?.kind, "captcha", "an hCaptcha widget is on the page");
  assert.equal(wall.url, SERP_URL);
  assert.ok(wall.markers.includes("Доступ ограничен"), "the title names the firewall");
  assert.ok(
    wall.markers.includes("Страница не загрузилась из-за проблем с"),
    "the body says what to do",
  );

  // No card and no result header: only the widget can satisfy the gate, and the
  // settle still has to succeed on it in one poll (the deadline is not burned).
  const counts = await page.evaluate<Record<string, number>>(
    `(() => { const out = {}; for (const s of ['[data-marker="item"]', '[data-marker="page-title"]', '#h-captcha']) out[s] = document.querySelectorAll(s).length; return out; })()`,
  );
  // JSON round-trip: the counts object comes from the `node:vm` realm.
  assert.deepEqual(JSON.parse(JSON.stringify(counts)) as unknown, {
    '[data-marker="item"]': 0,
    '[data-marker="page-title"]': 0,
    "#h-captcha": 1,
  });
  const clock = new FakeClock();
  await settleAvito(page, { clock, deadlineMs: 5_000, pollMs: 10 });
  assert.equal(clock.totalSleptMs(), 0, "the gate matched on the first probe");

  // The same page with no `<title>` at all is still a captcha: the body sentence
  // and the widget markup (both server-rendered, unlike the invisible iframe
  // label) carry it, so a failed title read loses nothing.
  const untitled = fixturePage("avito-wall");
  const byBody = await detectAvitoWall(untitled);
  assert.equal(byBody?.kind, "captcha");
  assert.deepEqual(byBody.markers, [
    "Страница не загрузилась из-за проблем с",
    "поставьте галочку",
  ]);
});

/**
 * The whole path on the firewall markup: the typed warm-up cannot find a box (a
 * wall has none), the pinned SERP URL renders the wall, the gate matches and the
 * caller gets `E_WALL` with an artifact — never a timeout, never a retry. The
 * navigation and its URL are the tool's, the markup is Avito's.
 */
test("D5/S9.4 the captured firewall reaches web_search as E_WALL", async () => {
  const rig = createHarness({
    engines: [avitoEngine],
    configure: (config) => {
      config.engines.avito = { ...config.engines.avito, enabled: true };
    },
  });
  const wall = fixturePage("avito-wall");
  wall.setTitle("Доступ ограничен: проблема с IP");
  rig.pages.set("avito", wall);

  const result = await createWebSearchTool(async () => rig.deps).execute(
    "call-avito-wall",
    { q: "iphone 13", engines: "avito" },
    undefined,
    undefined,
  );

  if (!("isError" in result)) assert.fail("a wall must be a typed failure");
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "E_WALL");
  assert.equal(result.details.engine, "avito");
  assert.equal(result.details.retryable, true);
  assert.equal(result.details.wall, "captcha");
  assert.match(result.details.artifact ?? "", /artifact/);
  assert.ok(resultText(result).includes(ERROR_HINTS.E_WALL), "the hint names the human remedy");

  assert.equal(rig.artifacts.length, 1, "one artifact for the wall the caller sees");
  assert.equal(rig.artifacts[0]?.code, "E_WALL");
  // The warm-up failed first (no box on a wall page); the SERP navigation is the
  // last one, and nothing navigates again after the wall is reported.
  assert.equal(wall.lastNavigation(), avitoEngine.buildUrl(query()), "the tab keeps the wall page");
  assert.equal(wall.bringToFrontCount(), 1, "the window is surfaced for the human");
});

test("detectWall is null on both captured normal states", async () => {
  for (const name of ["avito-serp", "avito-no-match"]) {
    const page = fixturePage(name);
    assert.equal(await detectAvitoWall(page), null, `${name} is not a wall`);
  }
});

// ---------------------------------------------------------------------------
// matrix / registry / rendering
// ---------------------------------------------------------------------------

test("D11/S4.7 avito is a special engine: registered, opt-in, never in auto", () => {
  assert.equal(ENGINE_CLASS.avito, "special");

  const shipped = createDefaultRegistry(DEFAULT_CONFIG);
  assert.equal(shipped.has("avito"), true, "the adapter is wired");
  assert.equal(shipped.enabled().includes("avito"), false, "it ships disabled (D12)");
  assert.equal(shipped.select("auto").includes("avito"), false);

  const enabled = structuredClone(DEFAULT_CONFIG);
  enabled.engines.avito.enabled = true;
  const registry = createDefaultRegistry(enabled);
  assert.deepEqual(registry.select(["avito"]), ["avito"], "an explicit request is honoured");
  assert.equal(registry.select("auto").includes("avito"), false, "auto still never reaches it");
});

test("S4.2 summary is flagged for avito, page and n are honoured", () => {
  assert.equal(SUPPORT_MATRIX.summary.avito, "flag");
  assert.equal(SUPPORT_MATRIX.page.avito, "yes");
  assert.equal(SUPPORT_MATRIX.n.avito, "yes");
});

test("D13 rendering: facts follow the snippet, the notice is its own line, caps hold", async () => {
  const page = fixturePage("avito-serp");
  const fixture = loadFixture("avito-serp");
  const out = extractFrom(fixture.html, SERP_URL, { n: 3 });
  const serp = await avitoEngine.extract(page, query({ n: 3 }));
  assert.equal(serp.engine, "avito");
  assert.equal(serp.ai, undefined, "no AI block: summary is flagged, not invented");

  const compact = compactSerps([serp], {
    n: 3,
    summaryMaxChars: 1200,
    snippetMaxChars: 140,
    outputMaxChars: 2500,
  });
  assert.match(compact.text, /23 990 ₽ · Самарская обл\., Самара/, "facts render on one line");
  assert.equal(compact.data.facts, undefined, "facts live on the items, not the envelope");
  const items = compact.data.results as Array<Record<string, unknown>>;
  assert.deepEqual(items[0]?.facts, [...(out.results[0]?.facts ?? [])]);
  assert.ok(compact.chars <= 2500);

  // The fallback notice is rendered as a `note:` line and reported in JSON.
  const fallback = extractFrom(loadFixture("avito-no-match").html, SERP_URL, { n: 2 });
  assert.equal(fallback.similar, true);
  const noMatchSerp = await avitoEngine.extract(fixturePage("avito-no-match"), query({ n: 2 }));
  assert.equal(noMatchSerp.notice, SIMILAR_NOTICE);
  const compactFallback = compactSerps([noMatchSerp], {
    n: 2,
    summaryMaxChars: 1200,
    snippetMaxChars: 140,
    outputMaxChars: 2500,
  });
  assert.match(compactFallback.text, /^note: no exact match/m);
  assert.equal(compactFallback.data.notice, SIMILAR_NOTICE);
});

test("a stale adapter map without avito still answers auto from the primary set", () => {
  // The registry is append-only, but a caller may build a partial map (tests, a
  // future embedding): `auto` must not depend on avito being present.
  const registry = createEngineRegistry({ google: avitoEngine }, structuredClone(DEFAULT_CONFIG));
  assert.deepEqual(registry.select("auto"), ["google"]);
});
