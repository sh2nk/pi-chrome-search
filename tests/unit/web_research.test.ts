/**
 * P6-A unit tests: the `web_research` tool (SPEC §7.4, PLAN V6.1–V6.3).
 *
 * Everything is offline. The tool has two injected seams (`search`, `read`), so
 * these tests drive it from two small recorded fixtures (`research-basic.json`,
 * `research-sparse.json`) and never build a browser, a socket or a model call.
 *
 * The guarantees pinned here:
 * - budgets quick 1+2 / normal 2+4 / deep 4+8 are exact and are never exceeded;
 * - the loop stops early when coverage is enough or when the token cap cannot
 *   hold another excerpt;
 * - every claim cites a URL the search actually returned, citations are
 *   de-duplicated by normalized URL, domains are derived (never fabricated);
 * - refinement happens once per round and never repeats a tried query;
 * - an abort is `E_CANCELLED` and the connector is never touched (no page leak);
 * - reflex off = zero model calls; reflex on = the injected reflex; a throwing
 *   reflex falls back to the fixed budget.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Value } from "typebox/value";

import type { CdpConnector } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import type { Engine } from "../../src/engines/types.ts";
import type { ReadableDocument } from "../../src/extract/read.ts";
import { normalizeUrl } from "../../src/extract/urls.ts";
import type { Candidate, CoverageVerdict, Evidence, Reflex, Route } from "../../src/reflex/types.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { fail } from "../../src/runtime/errors.ts";
import type { Artifacts, Cache, Limiter, LimiterStats, Logger } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import {
  RESEARCH_BUDGETS,
  WEB_RESEARCH_DESCRIPTION,
  createWebResearchTool,
  webResearchSchema,
  type ReadSeam,
  type ResearchBudget,
  type SearchHit,
  type SearchSeam,
  type WebResearchFailure,
  type WebResearchInput,
  type WebResearchResult,
  type WebResearchSuccess,
} from "../../src/tools/web_research.ts";
import { FakeClock } from "../helpers/clock.ts";
import { FakePage } from "../helpers/fake-page.ts";

// ---------------------------------------------------------------------------
// Recorded fixtures
// ---------------------------------------------------------------------------

interface FixtureSearch {
  query: string;
  engines: Array<"google" | "duckduckgo" | "yandex">;
  hits: SearchHit[];
}

interface Fixture {
  name: string;
  query: string;
  searches: FixtureSearch[];
  reads: Record<string, { title?: string; text: string }>;
}

function loadFixture(name: string): Fixture {
  const raw = readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(raw) as Fixture;
}

const BASIC = loadFixture("research-basic");
const SPARSE = loadFixture("research-sparse");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Calls {
  search: Array<{ q: string; n: number }>;
  read: Array<{ url: string; maxChars: number }>;
}

interface HarnessOptions {
  fixture: Fixture;
  config?: (config: Config) => void;
  search?: SearchSeam;
  read?: ReadSeam;
  reflex?: Reflex;
  maxOutputChars?: number;
}

interface Harness {
  tool: ReturnType<typeof createWebResearchTool>;
  deps: ToolDeps;
  calls: Calls;
  rows: Record<string, unknown>[];
  acquiredPages: number;
  fixture: Fixture;
}

/** Serve recorded bytes by round index; reads by exact URL. */
function fixtureSeams(
  fixture: Fixture,
  calls: Calls,
  overrides: { search?: SearchSeam; read?: ReadSeam } = {},
): { search: SearchSeam; read: ReadSeam } {
  let round = 0;
  const search: SearchSeam = async (q, n, signal) => {
    calls.search.push({ q, n });
    if (signal?.aborted === true) throw new Error("aborted before the search seam ran");
    if (overrides.search !== undefined) return await overrides.search(q, n, signal);
    const entry = fixture.searches[Math.min(round, fixture.searches.length - 1)]!;
    round += 1;
    return { query: q, engines: entry.engines, hits: entry.hits.map((hit) => ({ ...hit })) };
  };
  const read: ReadSeam = async (url, maxChars, signal) => {
    calls.read.push({ url, maxChars });
    if (signal?.aborted === true) throw new Error("aborted before the read seam ran");
    if (overrides.read !== undefined) return await overrides.read(url, maxChars, signal);
    const entry = fixture.reads[url];
    if (entry === undefined) throw fail("E_UNSUPPORTED", "read", { message: `fixture has no page for ${url}` });
    return { url, title: entry.title ?? "", text: entry.text };
  };
  return { search, read };
}

function makeHarness(options: HarnessOptions): Harness {
  const config = structuredClone(DEFAULT_CONFIG);
  options.config?.(config);

  const calls: Calls = { search: [], read: [] };
  const rows: Record<string, unknown>[] = [];
  const log: Logger = {
    async write(row: Record<string, unknown>): Promise<void> {
      rows.push(row);
    },
    path: () => "/dev/null",
  };

  const limiter: Limiter = {
    async acquire(): Promise<void> {},
    stats(engine): LimiterStats {
      return { engine, lastAt: null, today: 0, dailyCap: 100 };
    },
  };

  const artifacts: Artifacts = {
    async save(): Promise<string> {
      throw new Error("web_research must not write artifacts");
    },
    async prune() {
      return { removed: 0, kept: 0, bytes: 0 };
    },
    async size() {
      return 0;
    },
    root: () => "/tmp/opencode/pi-chrome-search/artifacts",
  };

  const cache: Cache = createCache({ maxEntries: 10, clock: new FakeClock() });
  let acquiredPages = 0;
  const cdp: CdpConnector = {
    async connect() {
      throw new Error("connect() is not used by web_research unit tests");
    },
    async acquirePage() {
      acquiredPages += 1;
      throw new Error("web_research must not acquire a page itself");
    },
    async releaseAll() {},
    isConnected: () => true,
    endpoint: () => null,
  };

  const deps: ToolDeps = {
    config,
    engines: {
      get() {
        throw new Error("engine registry is not used by web_research");
      },
      has: () => false,
      enabled: () => [],
      select: () => [],
    },
    cdp,
    cache,
    limiter,
    artifacts,
    log,
    clock: new FakeClock(),
    ...(options.reflex === undefined ? {} : { reflex: options.reflex }),
  };

  const seams = fixtureSeams(options.fixture, calls, {
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.read === undefined ? {} : { read: options.read }),
  });

  return {
    tool: createWebResearchTool(
      () => deps,
      {
        search: seams.search,
        read: seams.read,
        ...(options.maxOutputChars === undefined ? {} : { maxOutputChars: options.maxOutputChars }),
      },
    ),
    deps,
    calls,
    rows,
    get acquiredPages(): number {
      return acquiredPages;
    },
    fixture: options.fixture,
  };
}

async function run(harness: Harness, input: unknown, signal?: AbortSignal): Promise<WebResearchResult> {
  return await harness.tool.execute("call-1", input as WebResearchInput, signal, undefined);
}

function isFailure(result: WebResearchResult): result is WebResearchFailure {
  return "isError" in result && result.isError === true;
}

function success(result: WebResearchResult): WebResearchSuccess {
  assert.equal(isFailure(result), false, `expected success, got ${JSON.stringify(result.details)}`);
  return result as WebResearchSuccess;
}

function failure(result: WebResearchResult): WebResearchFailure {
  assert.equal(isFailure(result), true, "expected a rendered failure");
  return result as WebResearchFailure;
}

function textOf(result: WebResearchResult): string {
  return result.content.map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// Reflex doubles
// ---------------------------------------------------------------------------

interface ReflexSpy extends Reflex {
  triageCalls: Array<{ query: string; urls: string[] }>;
  coverageCalls: Array<{ query: string; evidence: Evidence[] }>;
  beginSearchCalls: number;
}

function spyReflex(overrides: Partial<Reflex> = {}): ReflexSpy {
  const spy: ReflexSpy = {
    triageCalls: [],
    coverageCalls: [],
    beginSearchCalls: 0,
    async triage(query: string, items: Candidate[]) {
      spy.triageCalls.push({ query, urls: items.map((item) => item.url) });
      return overrides.triage !== undefined
        ? await overrides.triage(query, items)
        : { keep: items.map((_, index) => index), scores: items.map(() => 1), flags: [] };
    },
    async gateRead() {
      return true;
    },
    async coverage(query: string, evidence: Evidence[]): Promise<CoverageVerdict> {
      spy.coverageCalls.push({ query, evidence });
      return overrides.coverage !== undefined
        ? await overrides.coverage(query, evidence)
        : { enough: false, next: "read_more" };
    },
    async route(): Promise<Route> {
      return { engines: ["google"] };
    },
    beginSearch() {
      spy.beginSearchCalls += 1;
    },
  };
  return spy;
}

// ---------------------------------------------------------------------------
// Schema, exposure, budgets
// ---------------------------------------------------------------------------

test("schema accepts the documented shapes and rejects everything else", () => {
  for (const value of [{ q: "cdp" }, { q: "cdp", budget: "quick" }, { q: "cdp", budget: "normal" }, { q: "cdp", budget: "deep" }]) {
    assert.equal(Value.Check(webResearchSchema, value), true, JSON.stringify(value));
  }
  for (const value of [{}, { q: "" }, { q: 42 }, { q: "cdp", budget: "huge" }, { q: "cdp", budget: 3 }]) {
    assert.equal(Value.Check(webResearchSchema, value), false, JSON.stringify(value));
  }
});

test("the tool is deferred, read-only, open-world and cheap to declare", () => {
  const harness = makeHarness({ fixture: BASIC });
  const tool = harness.tool;
  assert.equal(tool.name, "web_research");
  assert.equal(tool.exposure, "deferred");
  assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: true, idempotentHint: true });
  assert.equal(tool.description, WEB_RESEARCH_DESCRIPTION);
  assert.equal(tool.description.includes("\n"), false);
  assert.ok(tool.description.length <= 200, `description is ${tool.description.length} chars, aim is <=200`);
});

test("budgets are exactly SPEC §7.4", () => {
  assert.deepEqual(RESEARCH_BUDGETS, {
    quick: { searches: 1, reads: 2 },
    normal: { searches: 2, reads: 4 },
    deep: { searches: 4, reads: 8 },
  });
});

// ---------------------------------------------------------------------------
// V6.1 — budget accounting
// ---------------------------------------------------------------------------

const BUDGET_CASES: Array<{ budget: ResearchBudget; searches: number; reads: number }> = [
  { budget: "quick", searches: 1, reads: 2 },
  { budget: "normal", searches: 2, reads: 4 },
  { budget: "deep", searches: 4, reads: 8 },
];

test("each budget performs exactly its search and read allowance", async () => {
  for (const entry of BUDGET_CASES) {
    const harness = makeHarness({ fixture: SPARSE });
    const result = success(await run(harness, { q: SPARSE.query, budget: entry.budget }));
    assert.equal(result.details.budget, entry.budget);
    assert.equal(result.details.searches, entry.searches, `${entry.budget}: search calls`);
    assert.equal(result.details.reads, entry.reads, `${entry.budget}: read calls`);
    assert.equal(harness.calls.search.length, entry.searches, `${entry.budget}: seam saw the same searches`);
    assert.equal(harness.calls.read.length, entry.reads, `${entry.budget}: seam saw the same reads`);
    assert.equal(harness.acquiredPages, 0, "the tool must never acquire a page itself");
  }
});

test("budgets are per call, not per tool instance", async () => {
  const harness = makeHarness({ fixture: SPARSE });
  const first = success(await run(harness, { q: SPARSE.query, budget: "quick" }));
  const second = success(await run(harness, { q: SPARSE.query, budget: "quick" }));
  assert.equal(first.details.searches, 1);
  assert.equal(first.details.reads, 2);
  assert.equal(second.details.searches, 1);
  assert.equal(second.details.reads, 2);
  assert.equal(harness.calls.search.length, 2);
  assert.equal(harness.calls.read.length, 4);
});

test("the loop stops as soon as coverage is enough", async () => {
  const harness = makeHarness({ fixture: BASIC });
  const result = success(await run(harness, { q: BASIC.query, budget: "normal" }));
  assert.equal(harness.calls.search.length, 1, "a satisfied normal budget must not refine");
  assert.equal(harness.calls.read.length, 2);
  assert.equal(result.details.coverage.enough, true);
  assert.equal(result.details.coverage.next, "stop");
});

test("the token cap cuts the read allowance before it is spent", async () => {
  const harness = makeHarness({ fixture: SPARSE, maxOutputChars: 600 });
  const result = success(await run(harness, { q: SPARSE.query, budget: "deep" }));
  assert.ok(result.details.reads <= 3, `expected <=3 reads under a 600-char cap, got ${result.details.reads}`);
  assert.ok(result.details.searches <= 4);
  assert.equal(result.details.truncated, true, "a cap-shortened bundle must say it was truncated");
  assert.ok(textOf(result).length <= 600);
});

test("every budget respects the hard cap for any cap value", async () => {
  for (const cap of [400, 600, 800, 1200, 2500]) {
    for (const entry of BUDGET_CASES) {
      const harness = makeHarness({ fixture: SPARSE, maxOutputChars: cap });
      const result = success(await run(harness, { q: SPARSE.query, budget: entry.budget }));
      const text = textOf(result);
      assert.ok(text.length <= cap, `${entry.budget} cap=${cap}: text is ${text.length} chars`);
      assert.equal(result.details.chars, text.length);
    }
  }
});

// ---------------------------------------------------------------------------
// V6.2 — evidence, citations, dedup
// ---------------------------------------------------------------------------

function fixtureUrls(fixture: Fixture): Set<string> {
  const urls = new Set<string>();
  for (const round of fixture.searches) {
    for (const hit of round.hits) {
      const normalized = normalizeUrl(hit.url);
      if (normalized !== null) urls.add(normalized);
    }
  }
  return urls;
}

test("dedup collapses tracking-parameter variants of the same URL", async () => {
  const harness = makeHarness({ fixture: BASIC });
  const result = success(await run(harness, { q: BASIC.query, budget: "quick" }));
  assert.equal(result.details.results, 3, "four hits, two of them the same page");
  assert.equal(harness.calls.read[0]?.url, "https://docs.example.test/cdp/attach");
});

test("every claim cites a URL that the search actually returned", async () => {
  const harness = makeHarness({ fixture: BASIC });
  const result = success(await run(harness, { q: BASIC.query, budget: "normal" }));
  const allowed = fixtureUrls(BASIC);
  const { claims, citations, excerpts } = result.details.evidence;

  assert.ok(claims.length > 0, "a successful read must produce at least one claim");
  for (const claim of claims) {
    assert.ok(claim.text.length >= 30, "a claim is a sentence, not a fragment");
    assert.ok(claim.citations.length >= 1, "every claim cites at least one URL");
    assert.equal(claim.citations[0], claim.sourceUrl);
    for (const url of claim.citations) {
      assert.ok(allowed.has(url), `claim cites a URL that no search returned: ${url}`);
    }
  }

  const citationUrls = citations.map((citation) => citation.url);
  assert.equal(new Set(citationUrls).size, citationUrls.length, "citations are de-duplicated by normalized URL");
  for (const citation of citations) {
    assert.ok(allowed.has(citation.url), `citation does not resolve to a search result: ${citation.url}`);
    const parsed = new URL(citation.url);
    assert.equal(citation.domain, parsed.hostname.replace(/^www\./, ""), "the domain is derived, not guessed");
  }

  for (const excerpt of excerpts) {
    assert.ok(allowed.has(excerpt.url), `excerpt URL is not a search result: ${excerpt.url}`);
    assert.ok(excerpt.excerpt.length > 0);
  }
});

test("no fabricated domain can reach the bundle", async () => {
  const harness = makeHarness({ fixture: SPARSE });
  const result = success(await run(harness, { q: SPARSE.query, budget: "normal" }));
  const allowed = fixtureUrls(SPARSE);
  const domains = new Set([...allowed].map((url) => new URL(url).hostname.replace(/^www\./, "")));
  for (const citation of result.details.evidence.citations) {
    assert.ok(domains.has(citation.domain), `fabricated domain ${citation.domain}`);
  }
});

test("refinement happens once per round and never repeats a query", async () => {
  const harness = makeHarness({ fixture: SPARSE });
  const result = success(await run(harness, { q: SPARSE.query, budget: "normal" }));
  const queries = harness.calls.search.map((call) => call.q);
  assert.equal(queries.length, 2, "normal = one initial search + one refinement");
  assert.equal(queries[0], SPARSE.query);
  assert.notEqual(queries[1], queries[0]);
  assert.ok(queries[1]!.startsWith(SPARSE.query), "the rewrite extends the original query");
  assert.equal(result.details.searches, queries.length);
});

// ---------------------------------------------------------------------------
// V6.3 — reflex off / on / throwing
// ---------------------------------------------------------------------------

test("reflex off (and localOnly) makes zero model calls and still works", async () => {
  const reflex = spyReflex();
  const harness = makeHarness({
    fixture: BASIC,
    reflex,
    config: (config) => {
      config.reflex.enabled = false;
      config.reflex.localOnly = true;
    },
  });
  const result = success(await run(harness, { q: BASIC.query, budget: "normal" }));
  assert.equal(reflex.triageCalls.length, 0, "disabled reflex must not be consulted");
  assert.equal(reflex.coverageCalls.length, 0, "disabled reflex must not be consulted");
  assert.equal(result.details.coverage.enough, true, "the fixed coverage rule still stops the loop");
});

test("reflex on uses the injected triage order and coverage verdict", async () => {
  const reflex = spyReflex({
    triage: async (_query, items) => ({
      keep: items.map((_, index) => index).reverse(),
      scores: items.map(() => 1),
      flags: [],
    }),
    coverage: async () => ({ enough: true, next: "stop" }),
  });
  const harness = makeHarness({
    fixture: BASIC,
    reflex,
    config: (config) => {
      config.reflex.enabled = true;
    },
  });
  const result = success(await run(harness, { q: BASIC.query, budget: "normal" }));

  assert.equal(reflex.triageCalls.length, 1);
  assert.equal(reflex.coverageCalls.length, 1);
  // Three unique candidates: docs, blog, reference. Reversed keep reads reference first.
  assert.equal(harness.calls.read[0]?.url, "https://reference.example.test/devtools/browser");
  assert.equal(result.details.coverage.next, "stop");
  assert.equal(result.details.reads, 2);
});

test("a throwing reflex falls back to the fixed budget instead of failing", async () => {
  const reflex = spyReflex({
    triage: async () => {
      throw new Error("model unavailable");
    },
    coverage: async () => {
      throw new Error("model unavailable");
    },
  });
  const harness = makeHarness({
    fixture: SPARSE,
    reflex,
    config: (config) => {
      config.reflex.enabled = true;
    },
  });
  const result = success(await run(harness, { q: SPARSE.query, budget: "normal" }));
  assert.equal(result.details.searches, 2);
  assert.equal(result.details.reads, 4);
  assert.equal(reflex.triageCalls.length >= 1, true);
});

// ---------------------------------------------------------------------------
// Abort — E_CANCELLED, no leak
// ---------------------------------------------------------------------------

test("abort mid-search returns E_CANCELLED and reads nothing", async () => {
  const controller = new AbortController();
  const harness = makeHarness({
    fixture: BASIC,
    search: async () => {
      controller.abort();
      throw new Error("aborted while the SERP was loading");
    },
  });

  const result = failure(await run(harness, { q: BASIC.query, budget: "normal" }, controller.signal));
  assert.equal(result.details.code, "E_CANCELLED");
  assert.match(textOf(result), /E_CANCELLED/);
  assert.equal(harness.calls.read.length, 0);
  assert.equal(harness.acquiredPages, 0);
});

test("abort mid-read returns E_CANCELLED and leaves no page behind", async () => {
  const controller = new AbortController();
  const harness = makeHarness({
    fixture: BASIC,
    read: async () => {
      controller.abort();
      throw new Error("aborted while the page was loading");
    },
  });

  const result = failure(await run(harness, { q: BASIC.query, budget: "normal" }, controller.signal));
  assert.equal(result.details.code, "E_CANCELLED");
  assert.equal(harness.calls.read.length, 1, "the aborted read is the last one attempted");
  assert.equal(harness.acquiredPages, 0);
});

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

test("a wall on the first search is rendered with its code and hint", async () => {
  const harness = makeHarness({
    fixture: BASIC,
    search: async () => {
      throw fail("E_WALL", "navigate", { engine: "yandex", wall: "captcha", message: "captcha wall" });
    },
  });
  const result = failure(await run(harness, { q: BASIC.query }));
  assert.equal(result.details.code, "E_WALL");
  assert.equal(result.details.engine, "yandex");
  assert.match(textOf(result), /hint:/);
});

test("a failed read is skipped; the rest of the budget still produces evidence", async () => {
  const harness = makeHarness({
    fixture: BASIC,
    read: async (url, _maxChars) => {
      if (url.includes("/cdp/attach")) {
        throw fail("E_PARSE", "extract", { message: "selector canary failed" });
      }
      const entry = BASIC.reads[url];
      if (entry === undefined) throw fail("E_UNSUPPORTED", "read", {});
      return { url, title: entry.title ?? "", text: entry.text };
    },
  });

  const result = success(await run(harness, { q: BASIC.query, budget: "quick" }));
  assert.equal(result.details.reads, 2, "a failed read still costs its slot");
  assert.equal(result.details.evidence.excerpts.length, 1);
  assert.equal(result.details.error?.code, "E_PARSE");
  assert.equal(result.details.evidence.excerpts[0]?.url, "https://blog.example.test/posts/cdp-session");
});

test("an empty SERP is E_EMPTY, not a silent success", async () => {
  const harness = makeHarness({
    fixture: BASIC,
    search: async (q) => ({ query: q, hits: [], engines: ["google"] }),
  });
  const result = failure(await run(harness, { q: BASIC.query }));
  assert.equal(result.details.code, "E_EMPTY");
});

test("invalid arguments are E_CONFIG with a call-site hint", async () => {
  const harness = makeHarness({ fixture: BASIC });
  for (const input of [{ q: "   " }, { q: "cdp", budget: "huge" }]) {
    const result = failure(await run(harness, input));
    assert.equal(result.details.code, "E_CONFIG");
    assert.match(textOf(result), /web_research arguments/);
  }
});

test("a thrown dependency never escapes as a bare error", async () => {
  const harness = makeHarness({
    fixture: BASIC,
    search: async () => {
      throw new TypeError("unexpected socket shape");
    },
  });
  const result = failure(await run(harness, { q: BASIC.query }));
  assert.equal(result.details.code, "E_CDP_DISCONNECTED");
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

test("one decision row is logged per call, without query text", async () => {
  const harness = makeHarness({ fixture: BASIC });
  await run(harness, { q: BASIC.query, budget: "quick" });
  const research = harness.rows.filter((row) => row.kind === "research");
  assert.equal(research.length, 1);
  assert.equal(research[0]?.budget, "quick");
  assert.equal(JSON.stringify(research[0]).includes(BASIC.query), false);
});

// ---------------------------------------------------------------------------
// Default seams — the production path, still offline
// ---------------------------------------------------------------------------

test("without injected seams the tool drives web_search and web_read end to end", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const serp: Array<{ title: string; url: string; snippet: string }> = [
    { title: "Attach over CDP", url: "https://docs.example.test/cdp/attach", snippet: "Attaching to a running browser." },
    { title: "Attaching a browser session", url: "https://blog.example.test/posts/cdp-session", snippet: "Keeping one browser session." },
  ];
  const engine: Engine = {
    id: "google",
    buildUrl: (query) => `https://google.example.test/search?q=${encodeURIComponent(query.text)}`,
    async settle() {},
    async detectWall() {
      return null;
    },
    async extract(_page, query) {
      return {
        engine: "google",
        query: query.text,
        results: serp.map((item) => ({ ...item })),
        pageCarried: false,
        timings: {},
      };
    },
    async canaries() {
      return {};
    },
  };
  const doc: ReadableDocument = {
    title: "Attach over CDP",
    blocks: [
      {
        kind: "paragraph",
        inlines: [
          {
            kind: "text",
            text: "The browser exposes a DevTools endpoint that a client can attach to without launching another instance. A flat session multiplexes tabs over one connection.",
          },
        ],
      },
    ],
  };
  const page = new FakePage({ url: "about:blank", evaluate: () => doc });
  const acquired: string[] = [];
  const cdp: CdpConnector = {
    async connect() {
      throw new Error("not used");
    },
    async acquirePage(key) {
      acquired.push(key);
      return page;
    },
    async releaseAll() {},
    isConnected: () => true,
    endpoint: () => null,
  };
  const deps: ToolDeps = {
    config,
    engines: createEngineRegistry({ google: engine }, config),
    cdp,
    cache: createCache({ maxEntries: 10, clock: new FakeClock() }),
    limiter: {
      async acquire() {},
      stats: (id) => ({ engine: id, lastAt: null, today: 0, dailyCap: 100 }),
    },
    artifacts: {
      async save() {
        throw new Error("no artifact expected");
      },
      async prune() {
        return { removed: 0, kept: 0, bytes: 0 };
      },
      async size() {
        return 0;
      },
      root: () => "/tmp/opencode/pi-chrome-search/artifacts",
    },
    log: { async write() {}, path: () => "/dev/null" },
    clock: new FakeClock(),
  };

  // No `search`/`read` overrides: the default seams call the sibling tools. The
  // resolver keeps web_read's SSRF guard offline.
  const tool = createWebResearchTool(() => deps, { resolve: async () => ["93.184.216.34"] });
  const result = success(await tool.execute("call-1", { q: "cdp attach browser", budget: "quick" }, undefined, undefined));

  assert.deepEqual(acquired, ["google", "read", "read"], "one SERP tab, then the read tab per read");
  assert.equal(result.details.searches, 1);
  assert.equal(result.details.reads, 2);
  assert.ok(page.evaluateCalls().length >= 2, "each read ran the readability pass");

  const { claims } = result.details.evidence;
  assert.ok(claims.length > 0, "the parsed SERP and the read text produced a claim");
  const allowed = new Set(serp.map((item) => normalizeUrl(item.url)));
  for (const claim of claims) {
    for (const url of claim.citations) assert.ok(allowed.has(url), `unexpected claim URL ${url}`);
  }
  assert.equal(claims[0]?.citations.length, 2, "identical read text corroborates across two domains");
});

// ---------------------------------------------------------------------------
// Honesty fixes (validator findings)
// ---------------------------------------------------------------------------

test("a renderer-shortened excerpt sets truncated", async () => {
  // The agent uses `truncated` to decide whether to fetch the page itself, so a
  // body the renderer shortened must not be reported as complete.
  const harness = makeHarness({ fixture: BASIC, maxOutputChars: 800 });
  const result = success(await run(harness, { q: BASIC.query, budget: "deep" }));
  const shortened = result.details.evidence.excerpts.some(
    (excerpt) => excerpt.excerpt.length > 0 && excerpt.excerpt.length < 100,
  );
  if (shortened) assert.equal(result.details.truncated, true);
  else assert.ok(result.details.truncated, "an 800-char cap must report a cut of some kind");
});

test("an abort that surfaces as E_TARGET_LOST is reported as E_CANCELLED", async () => {
  const controller = new AbortController();
  const harness = makeHarness({
    fixture: BASIC,
    search: async () => {
      controller.abort();
      throw fail("E_TARGET_LOST", "navigate", { message: "the target went away during the abort" });
    },
  });
  const result = await run(harness, { q: BASIC.query, budget: "normal" }, controller.signal);
  const failure = result as { isError?: boolean; details?: { code?: string } };
  assert.equal(failure.isError, true);
  assert.equal(failure.details?.code, "E_CANCELLED");
});

test("a repeated result set stops the refine loop instead of spending the budget", async () => {
  // Same SERP every round: refinement cannot add a domain, so the loop must stop
  // after the first round rather than burn deep's four searches on one page set.
  let round = 0;
  const harness = makeHarness({
    fixture: BASIC,
    search: async (q, n, signal) => {
      const entry = BASIC.searches[0]!;
      round += 1;
      return { query: `${q} #${round}`, engines: entry.engines, hits: entry.hits.map((hit) => ({ ...hit })) };
    },
  });
  const result = success(await run(harness, { q: BASIC.query, budget: "deep" }));
  assert.ok(result.details.searches <= 2, `repeated SERPs must stop the loop, saw ${result.details.searches}`);
});
