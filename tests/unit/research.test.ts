/**
 * SPEC S6.2: `web_research` spends its budget, cites every claim and never calls
 * a model provider.
 *
 * Fully offline. The tool has two injected seams (`search`, `read`), so these
 * tests drive it from two recorded fixtures (`research-basic.json`,
 * `research-sparse.json`) and never build a browser, a socket or a model call.
 *
 * Pinned here:
 * - budgets quick 1+2 / normal 2+4 / deep 4+8 are exact and never exceeded;
 * - the loop stops early when coverage is enough or the token cap cannot hold
 *   another excerpt;
 * - every claim cites a URL the search actually returned, citations are
 *   de-duplicated by normalized URL, domains are derived (never fabricated);
 * - page selection is deterministic (merge order, dedupe, top-N);
 * - `details.budget` reports what was spent;
 * - no model provider is consulted: the extension never imports a model client
 *   and the fixed coverage rule is the only judge (SPEC D1/S11.5).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Value } from "typebox/value";

import type { CdpConnector } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import { normalizeUrl } from "../../src/extract/urls.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { fail } from "../../src/runtime/errors.ts";
import type { Artifacts, Cache, Limiter, Logger } from "../../src/runtime/types.ts";
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
import { FakeClock } from "../helpers/fake-cdp.ts";

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
  maxOutputChars?: number;
}

interface Harness {
  tool: ReturnType<typeof createWebResearchTool>;
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
    stats: (engine) => ({ engine, lastAt: null, today: 0 }),
  };

  // `web_research` is forbidden from writing artifacts: the two sibling tools
  // own page snapshots. A save() here would be a leaked browser page.
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
    root: () => "/tmp/pi-chrome-search-artifacts",
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
        throw new Error("engine registry is not used by web_research with injected seams");
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
  };

  const seams = fixtureSeams(options.fixture, calls, {
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.read === undefined ? {} : { read: options.read }),
  });

  const tool = createWebResearchTool(
    () => deps,
    {
      search: seams.search,
      read: seams.read,
      ...(options.maxOutputChars === undefined ? {} : { maxOutputChars: options.maxOutputChars }),
    },
  );

  return {
    tool,
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

// ---------------------------------------------------------------------------
// Schema, exposure, budgets
// ---------------------------------------------------------------------------

test("S6.2: schema accepts the documented shapes and rejects everything else", () => {
  for (const value of [{ q: "cdp" }, { q: "cdp", budget: "quick" }, { q: "cdp", budget: "normal" }, { q: "cdp", budget: "deep" }]) {
    assert.equal(Value.Check(webResearchSchema, value), true, JSON.stringify(value));
  }
  for (const value of [{}, { q: "" }, { q: 42 }, { q: "cdp", budget: "huge" }, { q: "cdp", budget: 3 }]) {
    assert.equal(Value.Check(webResearchSchema, value), false, JSON.stringify(value));
  }
});

test("S6.2: the tool is deferred, not read-only, open-world and cheap to declare", () => {
  const harness = makeHarness({ fixture: BASIC });
  const tool = harness.tool;
  assert.equal(tool.name, "web_research");
  assert.equal(tool.exposure, "deferred");
  assert.deepEqual(tool.annotations, { readOnlyHint: false, openWorldHint: true, idempotentHint: false });
  assert.equal(tool.description, WEB_RESEARCH_DESCRIPTION);
  assert.equal(tool.description.includes("\n"), false);
  assert.ok(tool.description.length <= 350, `description is ${tool.description.length} chars`);
});

test("S6.2: budgets are exactly the SPEC table", () => {
  assert.deepEqual(RESEARCH_BUDGETS, {
    quick: { searches: 1, reads: 2 },
    normal: { searches: 2, reads: 4 },
    deep: { searches: 4, reads: 8 },
  });
});

// ---------------------------------------------------------------------------
// Budget accounting
// ---------------------------------------------------------------------------

const BUDGET_CASES: Array<{ budget: ResearchBudget; searches: number; reads: number }> = [
  { budget: "quick", searches: 1, reads: 2 },
  { budget: "normal", searches: 2, reads: 4 },
  { budget: "deep", searches: 4, reads: 8 },
];

test("S6.2: each budget performs exactly its search and read allowance", async () => {
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

test("S6.2: budgets are per call, not per tool instance", async () => {
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

test("S6.2: every budget stays inside its allowance, whatever the cap", async () => {
  for (const cap of [400, 600, 800, 1200, 2500]) {
    for (const entry of BUDGET_CASES) {
      const harness = makeHarness({ fixture: SPARSE, maxOutputChars: cap });
      const result = success(await run(harness, { q: SPARSE.query, budget: entry.budget }));
      assert.ok(result.details.searches <= entry.searches, `${entry.budget} cap=${cap}: searches`);
      assert.ok(result.details.reads <= entry.reads, `${entry.budget} cap=${cap}: reads`);
      const text = textOf(result);
      assert.ok(text.length <= cap, `${entry.budget} cap=${cap}: text is ${text.length} chars`);
      assert.equal(result.details.chars, text.length);
    }
  }
});

test("S6.2: the loop stops as soon as coverage is enough", async () => {
  const harness = makeHarness({ fixture: BASIC });
  const result = success(await run(harness, { q: BASIC.query, budget: "normal" }));
  assert.equal(harness.calls.search.length, 1, "a satisfied normal budget must not refine");
  assert.equal(harness.calls.read.length, 2);
  assert.equal(result.details.coverage.enough, true);
  assert.equal(result.details.coverage.next, "stop");
});

test("S6.2: the token cap cuts the read allowance before it is spent", async () => {
  const harness = makeHarness({ fixture: SPARSE, maxOutputChars: 600 });
  const result = success(await run(harness, { q: SPARSE.query, budget: "deep" }));
  assert.ok(result.details.reads <= 3, `expected <=3 reads under a 600-char cap, got ${result.details.reads}`);
  assert.ok(result.details.searches <= 4);
  assert.equal(result.details.truncated, true, "a cap-shortened bundle must say it was truncated");
  assert.ok(textOf(result).length <= 600);
});

// ---------------------------------------------------------------------------
// Evidence, citations, determinism
// ---------------------------------------------------------------------------

test("S7.4: dedup collapses tracking-parameter variants of the same URL", async () => {
  const harness = makeHarness({ fixture: BASIC });
  const result = success(await run(harness, { q: BASIC.query, budget: "quick" }));
  assert.equal(result.details.results, 3, "four hits, two of them the same page");
  assert.equal(harness.calls.read[0]?.url, "https://docs.example.test/cdp/attach");
});

test("S6.2: every claim cites a URL that the search actually returned", async () => {
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

test("S6.2: no fabricated domain can reach the bundle", async () => {
  const harness = makeHarness({ fixture: SPARSE });
  const result = success(await run(harness, { q: SPARSE.query, budget: "normal" }));
  const allowed = fixtureUrls(SPARSE);
  const domains = new Set([...allowed].map((url) => new URL(url).hostname.replace(/^www\./, "")));
  for (const citation of result.details.evidence.citations) {
    assert.ok(domains.has(citation.domain), `fabricated domain ${citation.domain}`);
  }
});

test("S6.2: page selection is deterministic (same fixture, same reads)", async () => {
  const first = makeHarness({ fixture: SPARSE });
  const second = makeHarness({ fixture: SPARSE });
  await run(first, { q: SPARSE.query, budget: "normal" });
  await run(second, { q: SPARSE.query, budget: "normal" });
  assert.deepEqual(
    first.calls.read.map((call) => call.url),
    second.calls.read.map((call) => call.url),
  );
});

test("S6.2: refinement happens once per round and never repeats a query", async () => {
  const harness = makeHarness({ fixture: SPARSE });
  const result = success(await run(harness, { q: SPARSE.query, budget: "normal" }));
  const queries = harness.calls.search.map((call) => call.q);
  assert.equal(queries.length, 2, "normal = one initial search + one refinement");
  assert.equal(queries[0], SPARSE.query);
  assert.notEqual(queries[1], queries[0]);
  assert.ok(queries[1]!.startsWith(SPARSE.query), "the rewrite extends the original query");
  assert.equal(result.details.searches, queries.length);
});

test("S11.5: research never consults a model provider", () => {
  // The extension's only runtime dependency is `ws`; a model client would have
  // to appear here before this test could pass.
  const source = readFileSync(new URL("../../src/tools/web_research.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /reflex|classifier|openai|anthropic|api[_-]?key/i);
});

// ---------------------------------------------------------------------------
// Abort and failure mapping
// ---------------------------------------------------------------------------

test("S8.1: abort mid-search returns E_CANCELLED and reads nothing", async () => {
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

test("S8.1: abort mid-read returns E_CANCELLED and leaves no page behind", async () => {
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

test("S6.2: a wall on the first search is rendered with its code and hint", async () => {
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

test("S6.2: a failed read is skipped; the rest of the budget still produces evidence", async () => {
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

test("S6.2: an empty SERP is E_EMPTY, not a silent success", async () => {
  const harness = makeHarness({
    fixture: BASIC,
    search: async (q) => ({ query: q, hits: [], engines: ["google"] }),
  });
  const result = failure(await run(harness, { q: BASIC.query }));
  assert.equal(result.details.code, "E_EMPTY");
});

test("S9.1: invalid arguments are E_CONFIG with a call-site hint", async () => {
  const harness = makeHarness({ fixture: BASIC });
  for (const input of [{ q: "   " }, { q: "cdp", budget: "huge" }]) {
    const result = failure(await run(harness, input));
    assert.equal(result.details.code, "E_CONFIG");
    assert.match(textOf(result), /web_research arguments/);
  }
});

test("S9.1: a thrown dependency never escapes as a bare error", async () => {
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

test("S7.2: one decision row is logged per call, without query text", async () => {
  const harness = makeHarness({ fixture: BASIC });
  await run(harness, { q: BASIC.query, budget: "quick" });
  const research = harness.rows.filter((row) => row.kind === "research");
  assert.equal(research.length, 1);
  assert.equal(research[0]?.budget, "quick");
  assert.equal(JSON.stringify(research[0]).includes(BASIC.query), false);
});
