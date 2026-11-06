/**
 * P3-Google unit tests: offline, fixture-backed, no browser and no network.
 *
 * The extraction code that ships to the page is exercised through
 * `runInPage`, i.e. stringified into a `node:vm` context with the fixture
 * document — so a selector or a free variable that would fail in Chrome fails
 * here too. `extract()`/`canaries()` are tested through a `FakePage` whose
 * `evaluate` handler runs those same in-page functions, which also proves the
 * expressions they emit.
 *
 * Google hrefs in the real captures are opaque `/goto?url=<protobuf>` wrappers;
 * the fixtures keep the shape but sanitise the payload, so assertions are on the
 * wrapper form and host, never on a token value.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvaluateOptions } from "../../src/cdp/types.ts";
import {
  canaryCountsFromDocument,
  extractFromDocument,
  googleEngine,
  type ExtractedSerp,
} from "../../src/engines/google.ts";
import type { Freshness, Query } from "../../src/engines/types.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { FakeClock } from "../helpers/clock.ts";
import { fixtureDocument, runInPage } from "../helpers/dom.ts";
import { FakePage, type EvaluateHandler } from "../helpers/fake-page.ts";
import { loadFixture } from "../helpers/load-fixture.ts";

const SERP_URL = "https://www.google.com/search?q=transformer&hl=ru";
const HOME_URL = "https://www.google.com/";

function makeQuery(overrides: Partial<Query> = {}): Query {
  return { text: "rust tokio", n: 5, summary: true, ...overrides };
}

// ---------------------------------------------------------------------------
// In-page plumbing shared by the fixture tests
// ---------------------------------------------------------------------------

/**
 * `tests/helpers/dom.ts` types the second `runInPage` parameter as `unknown`
 * (the browser passes whatever JSON was embedded). The extractor is written
 * against its real argument type, so this single cast is where the two meet.
 */
type InPageExtractor = (doc: Document, arg: unknown) => ExtractedSerp;
const EXTRACT_IN_PAGE = extractFromDocument as unknown as InPageExtractor;

/** Splits `(fn)(document, {"n":…})` back into the argument it carried. */
const EXTRACT_CALL = /\(document, (\{[\s\S]*\})\)$/;

/** `document.querySelectorAll("<selector>").length`, the expression humanize emits. */
const COUNT_CALL = /document\.querySelectorAll\(("(?:[^"\\]|\\.)*")\)\.length/;

function bodyText(document: Document): string {
  return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function fixtureText(name: string, url = SERP_URL): string {
  return bodyText(fixtureDocument(loadFixture(name).html, url));
}

function countHandler(counts: Readonly<Record<string, number>>): EvaluateHandler {
  return (expression: string) => {
    const match = COUNT_CALL.exec(expression);
    if (match === null) return null;
    return counts[JSON.parse(match[1] as string) as string] ?? 0;
  };
}

interface FixturePage {
  page: FakePage;
  document: Document;
}

/**
 * A `FakePage` that really evaluates the shipped in-page functions against a
 * captured document, instead of returning a canned payload.
 */
function fixturePage(name: string, url = SERP_URL): FixturePage {
  const document = fixtureDocument(loadFixture(name).html, url);
  const page = new FakePage({ url, text: bodyText(document) });
  page.setEvaluateHandlers((expression: string, _options?: EvaluateOptions) => {
    // `humanize` polls `querySelectorAll(sel).length`; answer it from the fixture.
    const counted = COUNT_CALL.exec(expression);
    if (counted !== null) {
      return document.querySelectorAll(JSON.parse(counted[1] as string) as string).length;
    }
    if (expression.includes("canaryCountsFromDocument")) {
      assert.ok(/\(document\)$/.test(expression), "canaries must send only the document");
      return runInPage(canaryCountsFromDocument, document, null);
    }
    assert.ok(
      expression.includes("extractFromDocument"),
      `unexpected evaluate expression: ${expression.slice(0, 80)}`,
    );
    const match = EXTRACT_CALL.exec(expression);
    assert.ok(match !== null, "extract must call the in-page function with (document, arg)");
    return runInPage(EXTRACT_IN_PAGE, document, JSON.parse(match[1] as string));
  });
  return { page, document };
}

/** Same plumbing for an inline document, for the ad/link/safety cases. */
function inlinePage(html: string, url = SERP_URL): FakePage {
  const document = fixtureDocument(html, url);
  const page = new FakePage({ url, text: bodyText(document) });
  page.setEvaluateHandlers((expression: string) => {
    const match = EXTRACT_CALL.exec(expression);
    if (match === null) return null;
    return runInPage(EXTRACT_IN_PAGE, document, JSON.parse(match[1] as string));
  });
  return page;
}

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------

test("buildUrl sets q, hl and gl in a fixed order", () => {
  assert.equal(
    googleEngine.buildUrl(makeQuery({ text: "rust tokio", lang: "ru", region: "ru" })),
    "https://www.google.com/search?q=rust+tokio&hl=ru&gl=ru",
  );

  // No lang/region means no hl/gl: the engine's own locale wins, not ours.
  const bare = new URL(googleEngine.buildUrl(makeQuery({ text: "rust tokio" })));
  assert.equal(bare.searchParams.has("hl"), false);
  assert.equal(bare.searchParams.has("gl"), false);
  assert.equal(bare.searchParams.get("q"), "rust tokio");
});

test("buildUrl paginates at 10 results per page and omits start on page 1", () => {
  const pageOne = new URL(googleEngine.buildUrl(makeQuery({ page: 1 })));
  assert.equal(pageOne.searchParams.has("start"), false);

  assert.equal(new URL(googleEngine.buildUrl(makeQuery({ page: 3 }))).searchParams.get("start"), "20");
  assert.equal(new URL(googleEngine.buildUrl(makeQuery({ page: 2 }))).searchParams.get("start"), "10");
  // Hostile/invalid page numbers degrade to page 1 instead of producing start=-10.
  assert.equal(new URL(googleEngine.buildUrl(makeQuery({ page: 0 }))).searchParams.has("start"), false);
  assert.equal(new URL(googleEngine.buildUrl(makeQuery({ page: Number.NaN }))).searchParams.has("start"), false);
});

test("buildUrl encodes freshness as tbs=qdr:<unit> and drops unknown units", () => {
  for (const unit of ["d", "w", "m", "y"] as const) {
    const url = new URL(googleEngine.buildUrl(makeQuery({ freshness: unit })));
    assert.equal(url.searchParams.get("tbs"), `qdr:${unit}`);
  }
  // The parameter is encoded application/x-www-form-urlencoded, which Google accepts.
  assert.ok(googleEngine.buildUrl(makeQuery({ freshness: "w" })).includes("tbs=qdr%3Aw"));

  const bogus = new URL(googleEngine.buildUrl(makeQuery({ freshness: "q" as Freshness })));
  assert.equal(bogus.searchParams.has("tbs"), false);
});

test("buildUrl percent-encodes Cyrillic and search operators", () => {
  const url = googleEngine.buildUrl(makeQuery({ text: "что такое трансформер", lang: "ru" }));
  // Nothing non-ASCII may reach the URL string.
  assert.match(url, /^[\x21-\x7e]+$/);
  assert.ok(url.includes("%D1%87%D1%82%D0%BE"), url); // "что"
  assert.equal(new URL(url).searchParams.get("q"), "что такое трансформер");

  const site = googleEngine.buildUrl(makeQuery({ text: 'site:example.com "квантовый компьютер"' }));
  assert.ok(site.includes("site%3Aexample.com"), site);
  assert.equal(new URL(site).searchParams.get("q"), 'site:example.com "квантовый компьютер"');
});

test("buildUrl is pure: same Query in, byte-identical URL out", () => {
  const query = makeQuery({ text: "rust", lang: "ru", region: "ru", page: 2, freshness: "m" });
  const first = googleEngine.buildUrl(query);
  const second = googleEngine.buildUrl({ ...query });
  const frozen = Object.freeze({ ...query });

  // A clock or random experiment bucket would make one of these drift; the
  // builder has neither, so three calls agree byte for byte.
  assert.equal(first, second);
  assert.equal(first, googleEngine.buildUrl(frozen));
  assert.equal(first, googleEngine.buildUrl(query));
});

test("buildUrl ignores the unresolved 'auto' language instead of sending it", () => {
  const url = new URL(googleEngine.buildUrl(makeQuery({ lang: "auto", region: "auto" })));
  assert.equal(url.searchParams.has("hl"), false);
  assert.equal(url.searchParams.has("gl"), false);
});

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

test("interaction names a real home page, both search boxes and a structural gate", () => {
  const interaction = googleEngine.interaction;
  assert.ok(interaction !== undefined);

  assert.equal(interaction.homeUrl, HOME_URL);
  assert.deepEqual([...interaction.boxSelectors], ['textarea[name="q"]', 'input[name="q"]']);
  assert.equal(interaction.selector, "#rso, #search");
  assert.equal(interaction.minCount, 1);
  /**
   * Deliberately empty: an empty marker is `waitForMarker`'s documented
   * "selector only" mode. Google has no locale-neutral rendered SERP text
   * (the header chrome is `display:none`, the stats row is absent on a
   * zero-result page, and `settle()` never sees `Query.lang`), so a text
   * marker would either time out live or turn E_EMPTY into E_TIMEOUT. The
   * structural gate is language-neutral and a home page cannot satisfy it.
   */
  assert.equal(interaction.marker, "");
  // The SERP URL must never be mistaken for the typed-search home page.
  assert.notEqual(googleEngine.buildUrl(makeQuery()), interaction.homeUrl);
});

// ---------------------------------------------------------------------------
// settle (marker + structural gate, bounded deadline)
// ---------------------------------------------------------------------------

test("settle resolves at once when the SERP container is already there", async () => {
  const clock = new FakeClock();
  const page = new FakePage({
    url: SERP_URL,
    text: "Результатов: примерно 1 234",
    evaluate: countHandler({ "#rso, #search": 1 }),
  });

  await googleEngine.settle(page, undefined, { clock, deadlineMs: 5_000 });

  assert.equal(clock.totalSleptMs(), 0);
  const evaluations = page.evaluateCalls();
  assert.equal(evaluations.length, 1);
  assert.ok(evaluations[0]?.expression.includes("querySelectorAll"), evaluations[0]?.expression);
});

test("settle polls the structural gate until the container appears", async () => {
  const clock = new FakeClock();
  let evaluations = 0;
  const page = new FakePage({ url: SERP_URL, text: "skeleton" });
  page.setEvaluateHandlers(() => {
    evaluations += 1;
    // Three empty polls, then the results container mounts.
    return evaluations >= 4 ? 1 : 0;
  });

  await googleEngine.settle(page, undefined, { clock, deadlineMs: 5_000, pollMs: 100 });

  assert.equal(evaluations, 4);
  assert.ok(clock.totalSleptMs() > 0, "a single check would have failed to settle");
  assert.ok(clock.totalSleptMs() <= 400, `slept ${clock.totalSleptMs()} ms`);
});

test("settle never accepts the home page and times out inside the deadline", async () => {
  const clock = new FakeClock();
  // Home-page-shaped text, including the words a naive marker would match.
  const page = new FakePage({
    url: HOME_URL,
    text: "Google Поиск в Google Мне повезёт! Результатов: примерно 0",
    evaluate: countHandler({}),
  });

  await assert.rejects(
    googleEngine.settle(page, undefined, { clock, deadlineMs: 400, pollMs: 100 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
      assert.equal(error.details.code, "E_TIMEOUT");
      assert.equal(error.details.stage, "settle");
      assert.equal(error.details.engine, "google");
      return true;
    },
  );

  // It polled instead of settling, and stopped at the deadline it was given.
  assert.ok(clock.totalSleptMs() >= 300, `only slept ${clock.totalSleptMs()} ms`);
  assert.ok(clock.totalSleptMs() <= 800, `slept ${clock.totalSleptMs()} ms past a 400 ms deadline`);
});

test("settle accepts a zero-result SERP: the shell is not a wall and not a timeout", async () => {
  const clock = new FakeClock();
  const { page } = fixturePage("google-empty");

  await googleEngine.settle(page, undefined, { clock, deadlineMs: 1_000 });

  assert.equal(clock.totalSleptMs(), 0);
});

test("settle propagates an abort as E_CANCELLED", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  controller.abort();
  const page = new FakePage({ url: SERP_URL, text: "", evaluate: countHandler({}) });

  await assert.rejects(
    googleEngine.settle(page, controller.signal, { clock }),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CANCELLED",
  );
});

// ---------------------------------------------------------------------------
// detectWall
// ---------------------------------------------------------------------------

test("detectWall classifies /sorry and reports the fragments that fired", async () => {
  const url = "https://www.google.com/sorry/index?continue=redacted";
  const page = new FakePage({ url, text: fixtureText("google-wall", url) });

  const wall = await googleEngine.detectWall(page);

  assert.ok(wall !== null);
  assert.equal(wall.kind, "sorry");
  assert.equal(wall.url, url);
  assert.ok(wall.markers.includes("/sorry"), wall.markers.join(", "));
  assert.ok(wall.markers.includes("unusual traffic"), wall.markers.join(", "));
});

test("detectWall classifies the consent page", async () => {
  const url = "https://consent.google.com/m?continue=redacted";
  const page = new FakePage({ url, text: fixtureText("google-consent", url) });

  const wall = await googleEngine.detectWall(page);

  assert.ok(wall !== null);
  assert.equal(wall.kind, "consent");
  assert.ok(wall.markers.includes("consent.google.com"), wall.markers.join(", "));
  assert.ok(wall.markers.includes("Before you continue to Google"), wall.markers.join(", "));
});

test("detectWall reports a captcha block as captcha", async () => {
  const page = new FakePage({
    url: "https://www.google.com/search?q=redacted",
    text: "Наши системы обнаружили необычный трафик. Я не робот — поставьте галочку.",
  });

  const wall = await googleEngine.detectWall(page);

  assert.ok(wall !== null);
  assert.equal(wall.kind, "captcha");
  assert.ok(wall.markers.includes("Я не робот"), wall.markers.join(", "));
});

test("detectWall returns null on both normal SERPs", async () => {
  for (const name of ["google-ai", "google-no-ai"]) {
    const url = `https://www.google.com/search?q=${name}&hl=ru`;
    const page = new FakePage({ url, text: fixtureText(name, url) });
    assert.equal(await googleEngine.detectWall(page), null, `${name} must not look like a wall`);
  }
});

// ---------------------------------------------------------------------------
// extract: AI Overview
// ---------------------------------------------------------------------------

test("extract reads the AI Overview with sources and strips its controls", async () => {
  const { page } = fixturePage("google-ai");
  const serp = await googleEngine.extract(page, makeQuery({ n: 8, summary: true, text: "трансформер" }));

  assert.equal(serp.engine, "google");
  assert.equal(serp.query, "трансформер");
  assert.equal(serp.degraded, undefined);
  assert.ok(serp.ai !== undefined, "google-ai must expose an AI Overview");

  const ai = serp.ai;
  assert.ok(ai.text.length > 200, `AI text is only ${ai.text.length} chars`);
  assert.equal(ai.text.startsWith("Обзор от ИИ"), false);
  assert.equal(ai.text.includes("Ответ режима ИИ:"), false);
  // The feedback/share widgets and the sources carousel are not answer prose.
  assert.equal(ai.text.includes("Скопировано в буфер обмена"), false);
  assert.equal(ai.text.includes("Показать все"), false);
  assert.equal(ai.text.includes("Подробнее…"), false);

  assert.ok(ai.sources.length >= 3, `expected citation domains, got ${JSON.stringify(ai.sources)}`);
  for (const source of ai.sources) {
    // Domains only, never a fabricated title or a full URL.
    assert.match(source, /^[a-z0-9.-]+$/, source);
  }
  assert.ok(ai.sources.includes("ru.wikipedia.org"), ai.sources.join(", "));
  assert.equal(
    ai.sources.some((source) => source.endsWith("google.com")),
    false,
    "google-owned chrome links are not sources",
  );
});

test("extract returns 5+ organics with http(s) urls, titles and snippets", async () => {
  for (const name of ["google-ai", "google-no-ai"]) {
    const { page } = fixturePage(name);
    const serp = await googleEngine.extract(page, makeQuery({ n: 10, summary: true }));

    assert.ok(serp.results.length >= 5, `${name}: only ${serp.results.length} organics`);
    for (const item of serp.results) {
      assert.ok(item.title.length > 0, `${name}: empty title`);
      assert.match(item.url, /^https?:\/\//, `${name}: ${item.url}`);
      assert.ok(item.snippet.length > 0, `${name}: empty snippet for "${item.title}"`);
      assert.equal(item.isAd, undefined);
    }
  }
});

test("extract reports ai:no on a SERP without an AI Overview", async () => {
  const { page } = fixturePage("google-no-ai");
  const serp = await googleEngine.extract(page, makeQuery({ n: 5, summary: true }));

  assert.equal(serp.ai, undefined);
  assert.equal(serp.results.length, 5);
  assert.equal(serp.pageCarried, true); // the page carried 10 organics
});

test("summary:false suppresses AI extraction on the same fixture", async () => {
  const { page } = fixturePage("google-ai");
  const serp = await googleEngine.extract(page, makeQuery({ n: 5, summary: false }));

  assert.equal(serp.ai, undefined);
  assert.ok(serp.results.length >= 5);
});

// ---------------------------------------------------------------------------
// extract: limits, empty SERP, ads and link forms
// ---------------------------------------------------------------------------

test("extract limits results to n and reports pageCarried honestly", async () => {
  const { page } = fixturePage("google-ai");

  const three = await googleEngine.extract(page, makeQuery({ n: 3 }));
  assert.equal(three.results.length, 3);
  assert.equal(three.pageCarried, true);

  const all = await googleEngine.extract(page, makeQuery({ n: 10 }));
  assert.ok(all.results.length > 3);
  assert.equal(all.pageCarried, false); // 8 organics on this capture, all returned
});

test("extract returns zero results for the empty SERP without throwing", async () => {
  const { page } = fixturePage("google-empty");
  const serp = await googleEngine.extract(page, makeQuery({ n: 5 }));

  assert.deepEqual(serp.results, []);
  assert.equal(serp.ai, undefined);
  assert.equal(serp.pageCarried, false);
  assert.equal(typeof serp.timings.extractMs, "number");
});

test("extract skips every ad shape and keeps a title that merely mentions advertising", async () => {
  const page = inlinePage(`
    <div id="rso">
      <div data-hveid="ad-badge"><a href="https://ads.example/badge"><h3>Купить слона</h3></a><span>Реклама</span></div>
      <div data-hveid="ad-attr" data-text-ad="1"><a href="https://ads.example/attr"><h3>Marked ad block</h3></a></div>
      <div data-hveid="ad-uieerd"><div class="uEierd"><a href="https://ads.example/uieerd"><h3>uEierd ad</h3></a></div></div>
      <div data-hveid="organic">
        <a href="https://example.org/real"><h3>Что такое реклама</h3></a>
        <div class="VwiC3b">Настоящий сниппет про рекламу.</div>
      </div>
    </div>
  `);

  const serp = await googleEngine.extract(page, makeQuery({ n: 10 }));

  assert.equal(serp.results.length, 1, JSON.stringify(serp.results));
  assert.equal(serp.results[0]?.url, "https://example.org/real");
  assert.equal(serp.results[0]?.title, "Что такое реклама");
  assert.equal(serp.results[0]?.snippet, "Настоящий сниппет про рекламу.");
});

test("extract keeps /goto and /url wrappers wrapped instead of decoding them", async () => {
  const page = inlinePage(`
    <div id="rso">
      <div data-hveid="g1"><a href="/goto?url=CAESredacted"><h3>Goto result</h3></a><div class="VwiC3b">Snippet one</div></div>
      <div data-hveid="u1"><a href="/url?q=https%3A%2F%2Fexample.org%2Fpage"><h3>Legacy result</h3></a><div class="VwiC3b">Snippet two</div></div>
    </div>
  `);

  const serp = await googleEngine.extract(page, makeQuery({ n: 5 }));

  assert.equal(serp.results.length, 2);
  assert.equal(serp.results[0]?.url, "https://www.google.com/goto?url=CAESredacted");
  assert.ok(serp.results[0]?.url.includes("/goto?url="), serp.results[0]?.url);
  assert.ok(serp.results[1]?.url.includes("/url?q="), serp.results[1]?.url);
  // The protobuf is never decoded, and a wrapper is not a fabricated destination.
  assert.equal(serp.results[0]?.url.includes("CAESredacted"), true);
});

test("extract drops non-http hrefs and duplicate links", async () => {
  const page = inlinePage(`
    <div id="rso">
      <div data-hveid="js"><a href="javascript:void(0)"><h3>Broken link</h3></a></div>
      <div data-hveid="mail"><a href="mailto:redacted@example.test"><h3>Mail link</h3></a></div>
      <div data-hveid="d1"><a href="https://example.org/one"><h3>First</h3></a></div>
      <div data-hveid="d2"><a href="https://example.org/one"><h3>Duplicate</h3></a></div>
    </div>
  `);

  const serp = await googleEngine.extract(page, makeQuery({ n: 5 }));

  assert.equal(serp.results.length, 1);
  assert.equal(serp.results[0]?.url, "https://example.org/one");
});

test("extract rejects a non-SERP payload with E_PARSE", async () => {
  const page = new FakePage({ url: SERP_URL });
  page.setEvaluateHandlers(() => "not a serp");

  await assert.rejects(
    googleEngine.extract(page, makeQuery()),
    (error: unknown) => {
      assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
      assert.equal(error.details.code, "E_PARSE");
      assert.equal(error.details.stage, "extract");
      assert.equal(error.details.engine, "google");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// canaries
// ---------------------------------------------------------------------------

test("canaries count organics, the AI block and the result container", async () => {
  const { page } = fixturePage("google-ai");
  const counts = await googleEngine.canaries(page);

  assert.ok(counts.organics !== undefined && counts.organics >= 5, `organics=${String(counts.organics)}`);
  assert.equal(counts.aiBlock, 1);
  assert.ok(counts.resultsContainer >= 1);
});

test("canaries report zeros on the empty SERP and never throw on an empty body", async () => {
  const empty = await googleEngine.canaries(fixturePage("google-empty").page);
  assert.equal(empty.organics, 0);
  assert.equal(empty.aiBlock, 0);
  // The zero-result shell still renders the container; that is not a layout change.
  assert.ok(empty.resultsContainer >= 1);

  const document = fixtureDocument("<html></html>");
  const page = new FakePage({ url: SERP_URL });
  page.setEvaluateHandlers(() => runInPage(canaryCountsFromDocument, document, null));
  assert.deepEqual(await googleEngine.canaries(page), { organics: 0, aiBlock: 0, resultsContainer: 0 });

  const garbage = new FakePage({ url: SERP_URL });
  garbage.setEvaluateHandlers(() => null);
  assert.deepEqual(await googleEngine.canaries(garbage), { organics: 0, aiBlock: 0, resultsContainer: 0 });
});

// ---------------------------------------------------------------------------
// Architecture guard: the extractor must survive `toString()`
// ---------------------------------------------------------------------------

test("a module-scope closure fails in the page, so the extractor cannot rely on one", () => {
  const document = fixtureDocument('<div id="rso"><a href="https://example.org/one"><h3>Only</h3></a></div>');
  const capturedAtModuleScope = "Обзор от ИИ";

  function withClosure(doc: Document): string {
    return `${capturedAtModuleScope}:${doc.querySelectorAll("h3").length}`;
  }

  // Exactly how the browser would fail: the closure is not in the page context.
  assert.throws(() => runInPage(withClosure, document, null), /capturedAtModuleScope|not defined/i);

  // The shipped extractor has no such capture and runs on the same document.
  const serp = runInPage(EXTRACT_IN_PAGE, document, { n: 5, summary: true, query: "q" });
  assert.equal(serp.results.length, 1);
  assert.equal(serp.results[0]?.url, "https://example.org/one");
});
