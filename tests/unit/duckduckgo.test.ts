/**
 * P3-DDG unit tests: DuckDuckGo adapter (SPEC §6.3, PLAN P3-DDG).
 *
 * Everything is offline: sanitized fixtures are parsed with linkedom and the
 * extractor runs through `runInPage`, i.e. stringified into a `node:vm`
 * context exactly like `Runtime.evaluate` would. A closure or a module constant
 * referenced from `extractFromDocument` therefore fails here, not in the live
 * gate. Timing lives in `FakeClock`; no test waits on a real deadline.
 *
 * Fixture note (EVIDENCE): both live captures (`ddg-assist`, `ddg-no-assist`)
 * actually contain a real Search Assist answer — `meta.ai` is `"yes"` for both,
 * and the `duckassist-answer-content` block carries an answer paragraph plus
 * citation chips. The names describe the query class, not the A/B outcome. The
 * structural signal used by the adapter is the `duckassist-answer-content`
 * testid, not the nth "Search Assist" string: the label occurs four times and
 * a text slice would start in the nav and end on control buttons.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDuckDuckGoEngine,
  duckduckgoEngine,
  extractFromDocument,
  type ExtractFromDocumentArg,
  type ExtractedSerp,
} from "../../src/engines/duckduckgo.ts";
import type { Query } from "../../src/engines/types.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { FakeClock } from "../helpers/clock.ts";
import { fixtureDocument, runInPage } from "../helpers/dom.ts";
import { FakePage, type EvaluateHandler } from "../helpers/fake-page.ts";
import { loadFixture } from "../helpers/load-fixture.ts";

const SERP_URL = "https://duckduckgo.com/?q=example&kl=ru-ru";
const LIVE_FIXTURES = ["ddg-assist", "ddg-no-assist"] as const;
const CANARY_KEYS = ["resultTitles", "snippets", "articles", "assistBlocks"] as const;

/** `runInPage` types the second parameter as `unknown`; the runtime function is the same object. */
const inPageExtractor = extractFromDocument as unknown as (
  doc: Document,
  arg: unknown,
) => ExtractedSerp;

function extract(doc: Document, arg: ExtractFromDocumentArg): ExtractedSerp {
  return runInPage(inPageExtractor, doc, arg);
}

function query(overrides: Partial<Query> = {}): Query {
  return { text: "how does a solar panel work", n: 10, summary: false, ...overrides };
}

function fixtureDocumentFor(name: string): Document {
  const fixture = loadFixture(name);
  return fixtureDocument(fixture.html, SERP_URL);
}

/** Answers the count expressions the adapter and `waitForMarker` emit. */
const COUNT_RE = /document\.querySelectorAll\(("(?:[^"\\]|\\.)*")\)\.length/;

function countEvaluator(doc: Document): EvaluateHandler {
  return (expression) => {
    const match = COUNT_RE.exec(expression);
    if (match === null) return null;
    const selector = JSON.parse(match[1]!) as string;
    return doc.querySelectorAll(selector).length;
  };
}

function pageForFixture(name: string): { page: FakePage; doc: Document } {
  const doc = fixtureDocumentFor(name);
  const bodyText = doc.body?.textContent ?? "";
  return {
    doc,
    page: new FakePage({ url: SERP_URL, text: bodyText, evaluate: countEvaluator(doc) }),
  };
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error) => isWebSearchError(error) && error.details.code === code;
}

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------

test("buildUrl derives kl from region+lang", () => {
  const build = duckduckgoEngine.buildUrl;

  assert.equal(
    build(query({ text: "test", lang: "ru", region: "ru" })),
    "https://duckduckgo.com/?q=test&kl=ru-ru",
  );
  assert.equal(
    build(query({ text: "test", lang: "en", region: "us" })),
    "https://duckduckgo.com/?q=test&kl=us-en",
  );
  // Region only is self-paired (DDG's own form for most markets); a language
  // without a region has no valid pair, so it falls back to "no region".
  assert.equal(
    build(query({ text: "test", region: "de" })),
    "https://duckduckgo.com/?q=test&kl=de-de",
  );
  assert.equal(
    build(query({ text: "test", lang: "en" })),
    "https://duckduckgo.com/?q=test&kl=wt-wt",
  );
  assert.equal(
    build(query({ text: "test" })),
    "https://duckduckgo.com/?q=test&kl=wt-wt",
  );
  // "auto" is resolved by the caller; treating it as absent keeps this pure.
  assert.equal(
    build(query({ text: "test", lang: "auto", region: "ru" })),
    "https://duckduckgo.com/?q=test&kl=ru-ru",
  );
});

test("buildUrl passes a complete region-lang pair through verbatim (config kl lives in Query.region)", () => {
  const build = duckduckgoEngine.buildUrl;

  // The tool layer copies `engines.duckduckgo.kl` ("ru-ru") into Query.region;
  // self-pairing it would produce the invalid `kl=ru-ru-ru-ru`.
  assert.equal(
    build(query({ text: "test", region: "ru-ru" })),
    "https://duckduckgo.com/?q=test&kl=ru-ru",
  );
  assert.equal(
    build(query({ text: "test", region: "ru-ru", lang: "ru" })),
    "https://duckduckgo.com/?q=test&kl=ru-ru",
  );
  // A complete pair wins over a conflicting lang, because the pair is what the
  // user configured and DDG accepts exactly one pair.
  assert.equal(
    build(query({ text: "test", region: "ru-ru", lang: "en" })),
    "https://duckduckgo.com/?q=test&kl=ru-ru",
  );
  // "auto"/absent still means "no region preference".
  assert.equal(
    build(query({ text: "test", region: "auto" })),
    "https://duckduckgo.com/?q=test&kl=wt-wt",
  );
  assert.equal(build(query({ text: "test" })), "https://duckduckgo.com/?q=test&kl=wt-wt");
});

test("buildUrl percent-encodes the query (not form-encoded with +)", () => {
  const url = duckduckgoEngine.buildUrl(query({ text: "a b&c=d#e/ru", n: 5 }));
  assert.equal(url, "https://duckduckgo.com/?q=a%20b%26c%3Dd%23e%2Fru&kl=wt-wt");
  assert.equal(new URL(url).searchParams.get("q"), "a b&c=d#e/ru");

  const cyrillic = duckduckgoEngine.buildUrl(query({ text: "трансформер", lang: "ru", region: "ru" }));
  assert.equal(
    cyrillic,
    `https://duckduckgo.com/?q=${encodeURIComponent("трансформер")}&kl=ru-ru`,
  );
});

test("buildUrl ignores pagination until M2 (page>1 yields the same URL)", () => {
  // PLAN §5: DDG pagination is deferred; the tool reports pageIgnored instead.
  const first = duckduckgoEngine.buildUrl(query({ page: 1 }));
  const third = duckduckgoEngine.buildUrl(query({ page: 3 }));
  assert.equal(third, first);
  assert.equal(new URL(third).searchParams.has("s"), false);
});

test("buildUrl ignores freshness (df is unverified, so it is not invented)", () => {
  const plain = duckduckgoEngine.buildUrl(query());
  const requested = duckduckgoEngine.buildUrl(query({ freshness: "w" }));
  assert.equal(requested, plain);
  assert.equal(new URL(requested).searchParams.has("df"), false);
});

test("buildUrl is pure: same Query, same URL, and the Query is not mutated", () => {
  const frozen = Object.freeze(
    query({ text: "solar panel", lang: "ru", region: "ru", page: 2, freshness: "d" }),
  );
  const snapshot = JSON.stringify(frozen);
  const first = duckduckgoEngine.buildUrl(frozen);
  const second = duckduckgoEngine.buildUrl(frozen);

  assert.equal(first, second);
  assert.equal(JSON.stringify(frozen), snapshot);
  assert.equal(duckduckgoEngine.id, "duckduckgo");
});

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

test("interaction: DDG home box, and a marker that cannot settle on the home page", () => {
  const interaction = duckduckgoEngine.interaction;
  assert.ok(interaction, "an adapter without interaction never uses the typed path");
  assert.equal(interaction.homeUrl, "https://duckduckgo.com/");
  assert.deepEqual([...interaction.boxSelectors], ['input[name="q"]', "#searchbox_input"]);
  assert.ok(interaction.selector, "a bare text marker would match the home page");
  assert.ok((interaction.minCount ?? 0) >= 1);

  // The marker is proven against both live captures (and not localized).
  for (const name of LIVE_FIXTURES) {
    const doc = fixtureDocumentFor(name);
    assert.ok((doc.body?.textContent ?? "").includes(interaction.marker), `${name}: marker missing`);
    assert.ok(
      doc.querySelectorAll(interaction.selector).length >= (interaction.minCount ?? 1),
      `${name}: selector guard missing`,
    );
  }
});

// ---------------------------------------------------------------------------
// settle
// ---------------------------------------------------------------------------

test("settle resolves when the marker and result selector are present", async () => {
  const clock = new FakeClock();
  const page = new FakePage({
    url: SERP_URL,
    text: "DuckDuckGo results",
    evaluate: () => 1,
  });

  await createDuckDuckGoEngine({ clock, deadlineMs: 300, pollMs: 100 }).settle(page);
  assert.deepEqual(clock.durations(), [], "an already-ready page must not sleep");
});

test("settle fails with E_TIMEOUT within the bounded deadline when results never appear", async () => {
  const clock = new FakeClock();
  // The text marker IS present (home-page brand), but no result anchor is:
  // this is the stale/home-page case the selector+minCount pair exists for.
  const page = new FakePage({ url: "https://duckduckgo.com/", text: "DuckDuckGo", evaluate: () => 0 });

  const engine = createDuckDuckGoEngine({ clock, deadlineMs: 240, pollMs: 80 });
  await assert.rejects(engine.settle(page), rejectsWithCode("E_TIMEOUT"));

  const slept = clock.totalSleptMs();
  assert.ok(slept >= 240, `settle must poll until the deadline, slept ${slept} ms`);
  assert.ok(slept <= 400, `settle must stop at the deadline, slept ${slept} ms`);
});

test("settle fails when the text marker itself is missing", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ url: SERP_URL, text: "No results.", evaluate: () => 0 });
  const engine = createDuckDuckGoEngine({ clock, deadlineMs: 160, pollMs: 80 });

  await assert.rejects(engine.settle(page), rejectsWithCode("E_TIMEOUT"));
});

test("settle propagates an abort as E_CANCELLED without sleeping", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ url: SERP_URL, text: "", evaluate: () => 0 });
  const controller = new AbortController();
  controller.abort();

  const engine = createDuckDuckGoEngine({ clock, deadlineMs: 1_000, pollMs: 100 });
  await assert.rejects(engine.settle(page, controller.signal), rejectsWithCode("E_CANCELLED"));
  assert.equal(clock.totalSleptMs(), 0);
});

const CHALLENGE_TEXT =
  "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human.";

test("settle returns on a DDG challenge page instead of burning the deadline", async () => {
  const clock = new FakeClock();
  // First probe still looks like the brand-only home page, the second one is the
  // anomaly page. Without the wall branch this settles only at the deadline and
  // the tool reports E_TIMEOUT instead of E_WALL.
  let reads = 0;
  const page = new FakePage({
    url: SERP_URL,
    text: () => (reads++ === 0 ? "DuckDuckGo" : CHALLENGE_TEXT),
    evaluate: () => 0,
  });

  const engine = createDuckDuckGoEngine({ clock, deadlineMs: 2_400, pollMs: 80, rng: () => 0.5 });
  await engine.settle(page);

  assert.equal(clock.totalSleptMs(), 80, "one poll, not the whole deadline");
  const wall = await engine.detectWall(page);
  assert.ok(wall);
  assert.equal(wall.kind, "captcha");
  assert.deepEqual(wall.markers, [
    "Unfortunately, bots use DuckDuckGo too",
    "Please complete the following challenge",
  ]);
});

test("settle recognises the anomaly URL and the weak traffic marker too", async () => {
  const clock = new FakeClock();

  const anomalyUrl = new FakePage({
    url: "https://duckduckgo.com/anomaly/",
    text: "DuckDuckGo",
    evaluate: () => 0,
  });
  await createDuckDuckGoEngine({ clock, deadlineMs: 2_400, pollMs: 80 }).settle(anomalyUrl);
  assert.equal(clock.totalSleptMs(), 0, "a matching anomaly URL is terminal");
  const blocked = await duckduckgoEngine.detectWall(anomalyUrl);
  assert.ok(blocked);
  assert.equal(blocked.kind, "blocked");
  assert.deepEqual(blocked.markers, ["url:/anomaly/"]);

  // Weak marker + zero anchors is the same rule detectWall applies; a query
  // *about* unusual traffic has anchors and therefore settles as a normal SERP.
  const weak = new FakePage({
    url: SERP_URL,
    text: "DuckDuckGo: we detected unusual traffic from your network",
    evaluate: () => 0,
  });
  await duckduckgoEngine.settle(weak);
  const weakWall = await duckduckgoEngine.detectWall(weak);
  assert.ok(weakWall);
  assert.equal(weakWall.kind, "blocked");
  assert.deepEqual(weakWall.markers, ["unusual traffic"]);

  const normal = new FakePage({
    url: SERP_URL,
    text: "DuckDuckGo unusual traffic explained",
    evaluate: () => 1,
  });
  await duckduckgoEngine.settle(normal);
  assert.equal(await duckduckgoEngine.detectWall(normal), null);
});

// ---------------------------------------------------------------------------
// detectWall
// ---------------------------------------------------------------------------

test("detectWall returns null on every normal fixture (including the empty one)", async () => {
  for (const name of [...LIVE_FIXTURES, "ddg-empty"] as const) {
    const { page } = pageForFixture(name);
    assert.equal(await duckduckgoEngine.detectWall(page), null, `${name} must not be a wall`);
  }
});

test("detectWall reports DDG's anomaly challenge as captcha with exact markers", async () => {
  const text =
    "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human.";
  const page = new FakePage({ url: SERP_URL, text, evaluate: () => 0 });

  const wall = await duckduckgoEngine.detectWall(page);
  assert.ok(wall);
  assert.equal(wall.kind, "captcha");
  assert.equal(wall.url, SERP_URL);
  assert.deepEqual(wall.markers, [
    "Unfortunately, bots use DuckDuckGo too",
    "Please complete the following challenge",
  ]);
});

test('detectWall handles "unusual traffic" only when the page carries no results', async () => {
  const blocked = new FakePage({
    url: SERP_URL,
    text: "We detected unusual traffic from your network.",
    evaluate: () => 0,
  });
  const wall = await duckduckgoEngine.detectWall(blocked);
  assert.ok(wall);
  assert.equal(wall.kind, "blocked");
  assert.deepEqual(wall.markers, ["unusual traffic"]);

  // A query *about* unusual traffic must not be mistaken for a wall.
  const normal = new FakePage({
    url: SERP_URL,
    text: "unusual traffic DuckDuckGo explained",
    evaluate: () => 10,
  });
  assert.equal(await duckduckgoEngine.detectWall(normal), null);
});

test("detectWall never invents a wall for an empty body", async () => {
  const page = new FakePage({ url: SERP_URL, text: "", evaluate: () => 0 });
  assert.equal(await duckduckgoEngine.detectWall(page), null);
});

// ---------------------------------------------------------------------------
// extract: organics
// ---------------------------------------------------------------------------

test("extract returns organics from both live fixtures with http(s) URLs and snippets", () => {
  for (const name of LIVE_FIXTURES) {
    const doc = fixtureDocumentFor(name);
    const serp = extract(doc, { n: 10, summary: false, query: "example" });

    assert.equal(serp.results.length, 10, `${name}: expected 10 results`);
    assert.equal(serp.pageCarried, false, `${name}: n=10 covers the page`);

    for (const result of serp.results) {
      assert.match(result.url, /^https?:\/\//, `${name}: non-http url`);
      assert.ok(result.title.length > 5, `${name}: empty title`);
      assert.ok(result.snippet.length > 20, `${name}: empty snippet`);
    }
    assert.equal(serp.ai, undefined, `${name}: summary=false must not extract AI`);
  }
});

test("extract limits to n and reports pageCarried", () => {
  const doc = fixtureDocumentFor("ddg-assist");

  const three = extract(doc, { n: 3, summary: false, query: "example" });
  assert.equal(three.results.length, 3);
  assert.equal(three.pageCarried, true);

  const twenty = extract(doc, { n: 20, summary: false, query: "example" });
  assert.equal(twenty.results.length, 10);
  assert.equal(twenty.pageCarried, false);
});

test("extract skips ads, unwraps /l/?uddg links, and keeps n counting organics only", () => {
  const html = `<!doctype html><html><body>
    <article data-testid="result">
      <a data-testid="result-title-a" href="https://one.example/a">First organic</a>
      <div data-result="snippet">First snippet text, long enough to be real.</div>
    </article>
    <article data-testid="result">
      <a data-testid="result-title-a" href="https://duckduckgo.com/y.js?ad_provider=bing">Sponsored thing</a>
      <div data-result="snippet">Buy this now.</div>
    </article>
    <article data-testid="result">
      <div data-result="ad"></div>
      <a data-testid="result-title-a" href="https://ads.example/promo">Another ad</a>
      <div data-result="snippet">Buy this too.</div>
    </article>
    <article data-testid="result">
      <a data-testid="result-title-a" href="https://two.example/b">Second organic</a>
      <div data-result="snippet">Second snippet text, also long enough.</div>
    </article>
    <article data-testid="result">
      <a data-testid="result-title-a" href="/l/?uddg=https%3A%2F%2Fthree.example%2Fc">Third organic</a>
      <div data-result="snippet">Third snippet text, also long enough.</div>
    </article>
    <article data-testid="result">
      <a data-testid="result-title-a" href="javascript:alert(1)">Not a link</a>
      <div data-result="snippet">Never returned.</div>
    </article>
  </body></html>`;

  const doc = fixtureDocument(html, SERP_URL);
  const serp = extract(doc, { n: 10, summary: false, query: "example" });

  assert.equal(serp.results.length, 3);
  assert.deepEqual(
    // `serp.results` is a cross-realm array from the vm context; Array.from in
    // this realm keeps deepEqual's prototype check honest.
    Array.from(serp.results, (result) => result.title),
    ["First organic", "Second organic", "Third organic"],
  );
  assert.equal(serp.results[2]?.url, "https://three.example/c");
  // Two ads + one unusable link do not make the page "carry more" than n=10.
  assert.equal(serp.pageCarried, false);
});

test("extract skips an ad wrapper that IS the result container", () => {
  // `<div data-result="ad"><a .../></div>` has no `article` ancestor, so the
  // container is the ad wrapper itself; a descendant-only query cannot see it.
  const html = `<!doctype html><html><body>
    <div data-result="ad">
      <a data-testid="result-title-a" href="https://ads.example/wrapped">Wrapped ad</a>
    </div>
    <article data-testid="result">
      <a data-testid="result-title-a" href="https://ok.example/a">Organic result</a>
      <div data-result="snippet">A real snippet, long enough to be plausible.</div>
    </article>
  </body></html>`;

  const serp = extract(fixtureDocument(html, SERP_URL), { n: 10, summary: false, query: "x" });
  assert.deepEqual(Array.from(serp.results, (result) => result.title), ["Organic result"]);
  assert.equal(serp.pageCarried, false);
});

test("extract skips every supported result-badge label and keeps unrelated badges", () => {
  const variants = ["Ad", "Реклама", "Sponsored"];
  const articles = variants
    .map(
      (label, index) => `<article data-testid="result">
        <a data-testid="result-title-a" href="https://badge${index}.example/x">Badged ${index}</a>
        <span data-testid="result-badge">${label}</span>
        <div data-result="snippet">Paid placement, must be skipped.</div>
      </article>`,
    )
    .join("");
  const html = `<!doctype html><html><body>${articles}
    <article data-testid="result">
      <a data-testid="result-title-a" href="https://keep.example/x">Organic kept</a>
      <span data-testid="result-badge">Site</span>
      <div data-result="snippet">An organic result with an unrelated badge.</div>
    </article>
  </body></html>`;

  const serp = extract(fixtureDocument(html, SERP_URL), { n: 10, summary: false, query: "x" });
  assert.deepEqual(Array.from(serp.results, (result) => result.title), ["Organic kept"]);
});

test("extract on the empty fixture returns zero results without crashing", () => {
  const doc = fixtureDocumentFor("ddg-empty");
  const serp = extract(doc, { n: 10, summary: true, query: "example" });

  assert.equal(serp.results.length, 0);
  assert.equal(serp.pageCarried, false);
  assert.equal(serp.ai, undefined);
});

// ---------------------------------------------------------------------------
// extract: Search Assist
// ---------------------------------------------------------------------------

test("extract takes Search Assist from the structural block in both live fixtures", () => {
  const assist = extract(fixtureDocumentFor("ddg-assist"), {
    n: 5,
    summary: true,
    query: "example",
  });
  assert.ok(assist.ai, "ddg-assist carries a real answer");
  assert.match(assist.ai.text, /photovoltaic/);
  assert.ok(assist.ai.sources.includes("nationalgrid.com"));
  assert.ok(assist.ai.text.length > 100);

  const noAssist = extract(fixtureDocumentFor("ddg-no-assist"), {
    n: 5,
    summary: true,
    query: "example",
  });
  // The fixture name is the query class, not an A/B result: meta.ai is "yes"
  // and duckassist-answer-content carries the tokio answer.
  assert.ok(noAssist.ai, "ddg-no-assist also carries a real answer");
  assert.match(noAssist.ai.text, /tokio::select!/);
  assert.deepEqual([...noAssist.ai.sources], ["tokio.rs", "docs.rs"]);
});

test("extract never fabricates AI from a toggle-only assist block", () => {
  const html = `<html><body><div data-testid="duckassist-answer-content"><span> Search Assist</span></div></body></html>`;
  const doc = fixtureDocument(html, SERP_URL);
  const serp = extract(doc, { n: 5, summary: true, query: "example" });
  assert.equal(serp.ai, undefined);
});

test("extract never emits assist UI controls as the answer", () => {
  const labelsOnly = `<html><body>
    <div data-testid="duckassist-answer-content">
      <span>Search Assist</span><button>Остановить</button><button>Продолжить</button>
    </div>
  </body></html>`;
  const none = extract(fixtureDocument(labelsOnly, SERP_URL), { n: 5, summary: true, query: "x" });
  assert.equal(none.ai, undefined, "labels are not prose");

  const withProse = `<html><body>
    <div data-testid="duckassist-answer-content">
      <p>Photovoltaic cells turn sunlight into electricity.</p>
      <button>Остановить</button><button>Продолжить</button><button>More</button>
    </div>
  </body></html>`;
  const prose = extract(fixtureDocument(withProse, SERP_URL), { n: 5, summary: true, query: "x" });
  assert.ok(prose.ai);
  assert.equal(prose.ai.text, "Photovoltaic cells turn sunlight into electricity.");
});

test("extract drops a nested ad from the assist block before taking its text", () => {
  const html = `<html><body>
    <div data-testid="duckassist-answer-content">
      <p>A real answer with enough words to be prose.</p>
      <div data-result="ad"><p>Sponsored text that is not an answer.</p></div>
    </div>
  </body></html>`;
  const serp = extract(fixtureDocument(html, SERP_URL), { n: 5, summary: true, query: "x" });
  assert.ok(serp.ai);
  assert.equal(serp.ai.text, "A real answer with enough words to be prose.");
  assert.ok(!serp.ai.text.includes("Sponsored"));
});

test("extract ignores the assist block entirely when summary=false", () => {
  const doc = fixtureDocumentFor("ddg-assist");
  assert.ok(doc.querySelector('[data-testid="duckassist-answer-content"]'));
  const serp = extract(doc, { n: 5, summary: false, query: "example" });
  assert.equal(serp.ai, undefined);
});

// ---------------------------------------------------------------------------
// engine.extract wiring
// ---------------------------------------------------------------------------

test("engine.extract serializes the extractor, validates the payload and fills RawSerp", async () => {
  const doc = fixtureDocumentFor("ddg-assist");
  const expressions: string[] = [];
  const page = new FakePage({
    url: SERP_URL,
    evaluate: (expression) => {
      expressions.push(expression);
      if (!expression.includes("result-title-a")) return null;
      return runInPage(inPageExtractor, doc, { n: 7, summary: true, query: "example" });
    },
  });

  const serp = await duckduckgoEngine.extract(page, query({ n: 7, summary: true }));

  assert.equal(serp.engine, "duckduckgo");
  assert.equal(serp.query, "how does a solar panel work");
  assert.equal(serp.results.length, 7);
  assert.equal(serp.pageCarried, true);
  assert.ok(serp.ai);
  assert.deepEqual(serp.timings, {});
  assert.equal(expressions.length, 1);
  // The function value is interpolated (toString), not called by name. Node's
  // type stripping leaves the erased type slots as whitespace, hence \s*.
  assert.match(expressions[0]!, /^\s*\(function extractFromDocument\(\s*doc\s*,\s*arg\s*\)/);
  assert.match(expressions[0]!, /"summary":true/);
});

test("engine.extract fails with E_PARSE when the page returns no payload", async () => {
  const page = new FakePage({ url: SERP_URL, evaluate: () => null });
  await assert.rejects(duckduckgoEngine.extract(page, query()), rejectsWithCode("E_PARSE"));
});

// ---------------------------------------------------------------------------
// canaries
// ---------------------------------------------------------------------------

test("canaries count result/snippet/article/assist selectors on live fixtures", async () => {
  for (const name of LIVE_FIXTURES) {
    const { page } = pageForFixture(name);
    const counts = await duckduckgoEngine.canaries(page);

    assert.deepEqual(Object.keys(counts), [...CANARY_KEYS]);
    assert.equal(counts.resultTitles, 10, `${name}: resultTitles`);
    assert.equal(counts.snippets, 10, `${name}: snippets`);
    assert.equal(counts.articles, 10, `${name}: articles`);
    assert.equal(counts.assistBlocks, 1, `${name}: assistBlocks`);
  }
});

test("canaries are all zero on the empty fixture and on an empty body (no throw)", async () => {
  for (const doc of [fixtureDocumentFor("ddg-empty"), fixtureDocument("<html><body></body></html>")]) {
    const page = new FakePage({ url: SERP_URL, text: "", evaluate: countEvaluator(doc) });
    const counts = await duckduckgoEngine.canaries(page);
    for (const key of CANARY_KEYS) assert.equal(counts[key], 0, key);
  }
});

// ---------------------------------------------------------------------------
// Serialization contract
// ---------------------------------------------------------------------------

test("runInPage rejects a closure-based extractor (the reason for the contract)", () => {
  const moduleScopedSuffix = "-closed-over";

  function closureExtractor(_doc: Document): string {
    return moduleScopedSuffix;
  }

  const doc = fixtureDocument("<html><body></body></html>");
  assert.throws(
    () => runInPage(closureExtractor, doc, {}),
    /moduleScopedSuffix is not defined/,
  );
});

test("extractFromDocument itself survives stringification against a fixture", () => {
  const doc = fixtureDocumentFor("ddg-assist");
  // If the extractor captured anything from module scope this throws a
  // ReferenceError before it can return a result list.
  const serp = runInPage(inPageExtractor, doc, { n: 2, summary: true, query: "example" });
  assert.equal(serp.results.length, 2);
  assert.ok(serp.ai);
});
