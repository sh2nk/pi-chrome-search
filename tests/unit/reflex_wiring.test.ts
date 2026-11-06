/**
 * P5-D: reflex wiring (SPEC §9.3–§9.4, PLAN lane P5-D).
 *
 * Two layers are proven here:
 *
 * 1. `src/reflex/index.ts` — the composition root. Disabled means zero registry
 *    traffic and rules verdicts logged as `model: "rules"`; enabled with a
 *    registry means the classifier's verdict *and* its `lastOutcome()` metadata
 *    reach the policy (confidence, model, usage, cost, latency), so the guard
 *    rails — not the tool — decide whether to trust it.
 *
 * 2. The tools. `web_search` routes only an `auto` request and only when the
 *    flag is on, triages only a merged or wide request, and never lets a reflex
 *    exception change the SERP. `web_read` consults the gate only when enabled
 *    and refuses without navigating when the gate says no.
 *
 * Everything is offline: stub engines, `FakePage`, the real policy/rules/cache,
 * and fake classifier registries. No socket, no model, no wall clock.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CdpConnector, CdpPage } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import type { Engine, EngineId, Query, RawSerp, SerpItem, Wall } from "../../src/engines/types.ts";
import type { ReadableDocument } from "../../src/extract/read.ts";
import type {
  ClassifierAnswer,
  ClassifierContext,
  ClassifierRegistry,
  ClassifierResult,
} from "../../src/reflex/classifier.ts";
import { REFLEX_BACKEND_LOG_KIND, createReflex } from "../../src/reflex/index.ts";
import { RULES_MODEL } from "../../src/reflex/rules.ts";
import type { Candidate, CoverageVerdict, Reflex, Route, TriageResult } from "../../src/reflex/types.ts";
import { createCache } from "../../src/runtime/cache.ts";
import type { Artifacts, Cache, Limiter, LimiterStats, Logger } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import {
  createWebReadTool,
  type WebReadFailure,
  type WebReadInput,
  type WebReadResult,
  type WebReadSuccess,
} from "../../src/tools/web_read.ts";
import {
  createWebSearchTool,
  triageWanted,
  type WebSearchInput,
  type WebSearchResult,
  type WebSearchSuccess,
} from "../../src/tools/web_search.ts";
import { FakeClock } from "../helpers/clock.ts";
import { FakePage } from "../helpers/fake-page.ts";

const WALL: Wall = {
  kind: "captcha",
  url: "https://wall.example.test/showcaptcha",
  markers: ["Я не робот"],
};

const PUBLIC_RESOLVER = async (): Promise<string[]> => ["93.184.216.34"];

// ---------------------------------------------------------------------------
// Stub engine + search harness
// ---------------------------------------------------------------------------

const DEFAULT_RESULTS: SerpItem[] = [
  { title: "Example result", url: "https://example.test/page", snippet: "An example snippet." },
];

class StubEngine implements Engine {
  readonly id: EngineId;
  readonly queries: Query[] = [];
  readonly urls: string[] = [];
  readonly results: SerpItem[];
  wallIndex = 0;

  #walls: Array<Wall | null>;

  constructor(id: EngineId, options: { results?: SerpItem[]; walls?: Array<Wall | null> } = {}) {
    this.id = id;
    this.results = options.results ?? DEFAULT_RESULTS;
    this.#walls = options.walls ?? [];
  }

  buildUrl(query: Query): string {
    this.queries.push(query);
    const url = `https://${this.id}.example.test/search?q=${encodeURIComponent(query.text)}&n=${query.n}`;
    this.urls.push(url);
    return url;
  }

  async settle(): Promise<void> {}

  async detectWall(): Promise<Wall | null> {
    if (this.#walls.length === 0) return null;
    const index = Math.min(this.wallIndex, this.#walls.length - 1);
    this.wallIndex += 1;
    return this.#walls[index] ?? null;
  }

  async extract(_page: CdpPage, query: Query): Promise<RawSerp> {
    return {
      engine: this.id,
      query: query.text,
      results: this.results.map((item) => ({ ...item })),
      pageCarried: false,
      timings: {},
    };
  }

  async canaries(): Promise<Record<string, number>> {
    return {};
  }
}

interface SearchHarnessOptions {
  engines: readonly StubEngine[];
  config?: (config: Config) => void;
  reflex?: Reflex;
}

interface SearchHarness {
  config: Config;
  deps: ToolDeps;
  page: FakePage;
  limiterCalls: EngineId[];
  rows: Record<string, unknown>[];
}

function makeSearchHarness(options: SearchHarnessOptions): SearchHarness {
  const config = structuredClone(DEFAULT_CONFIG);
  options.config?.(config);

  const clock = new FakeClock();
  const page = new FakePage({ clock, text: "Search results for the test query" });
  const cache: Cache = createCache({ maxEntries: 50, clock });

  const limiterCalls: EngineId[] = [];
  const limiter: Limiter = {
    async acquire(engine: EngineId): Promise<void> {
      limiterCalls.push(engine);
    },
    stats(engine: EngineId): LimiterStats {
      return { engine, lastAt: null, today: 0, dailyCap: 100 };
    },
  };

  const rows: Record<string, unknown>[] = [];
  const log: Logger = {
    async write(row: Record<string, unknown>): Promise<void> {
      rows.push(structuredClone(row));
    },
    path: () => "memory",
  };

  const artifacts: Artifacts = {
    async save(): Promise<string> {
      return "/tmp/opencode/pi-chrome-search/artifacts/test";
    },
    async prune() {
      return { removed: 0, kept: 0, bytes: 0 };
    },
    async size() {
      return 0;
    },
    root: () => "/tmp/opencode/pi-chrome-search/artifacts",
  };

  const pages = new Map<EngineId, CdpPage>(options.engines.map((engine) => [engine.id, page]));
  const cdp: CdpConnector = {
    async connect() {
      throw new Error("web_search unit tests never connect");
    },
    async acquirePage(key: EngineId): Promise<CdpPage> {
      const resolved = pages.get(key);
      if (resolved === undefined) throw new Error(`no fake page for ${key}`);
      return resolved;
    },
    async releaseAll() {},
    isConnected: () => true,
    endpoint: () => null,
  };

  const engineMap = Object.fromEntries(options.engines.map((engine) => [engine.id, engine]));
  const deps: ToolDeps = {
    config,
    engines: createEngineRegistry(engineMap, config),
    cdp,
    cache,
    limiter,
    artifacts,
    log,
    clock,
    fetchImpl: async (): Promise<Response> => {
      throw new Error("offline test: /goto resolution must be stubbed");
    },
    ...(options.reflex === undefined ? {} : { reflex: options.reflex }),
  };

  return { config, deps, page, limiterCalls, rows };
}

async function search(harness: SearchHarness, input: Partial<WebSearchInput>): Promise<WebSearchResult> {
  const tool = createWebSearchTool(() => harness.deps);
  return await tool.execute("call-1", input as WebSearchInput, undefined, undefined);
}

function isFailure(result: { isError?: true } | object): boolean {
  return "isError" in result && result.isError === true;
}

function expectSearchSuccess(result: WebSearchResult): WebSearchSuccess {
  assert.equal(isFailure(result), false, `expected success, got ${JSON.stringify(result.details)}`);
  return result as WebSearchSuccess;
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// Fake `Reflex` (spy, no policy)
// ---------------------------------------------------------------------------

interface FakeReflexPlan {
  route?: (query: string) => Route | Promise<Route>;
  triage?: (items: Candidate[]) => TriageResult | Promise<TriageResult>;
  gateRead?: (item: Candidate) => boolean | Promise<boolean>;
}

class FakeReflex implements Reflex {
  readonly routeCalls: string[] = [];
  readonly triageCalls: Candidate[][] = [];
  readonly gateCalls: Candidate[] = [];
  beginCalls = 0;

  readonly #plan: FakeReflexPlan;

  constructor(plan: FakeReflexPlan = {}) {
    this.#plan = plan;
  }

  beginSearch(): void {
    this.beginCalls += 1;
  }

  async route(query: string): Promise<Route> {
    this.routeCalls.push(query);
    const plan = this.#plan.route;
    if (plan === undefined) return { engines: ["google"] };
    return await plan(query);
  }

  async triage(_query: string, items: Candidate[]): Promise<TriageResult> {
    this.triageCalls.push(items);
    const plan = this.#plan.triage;
    if (plan === undefined) return { keep: items.map((_, index) => index), scores: items.map(() => 3), flags: [] };
    return await plan(items);
  }

  async gateRead(_query: string, item: Candidate): Promise<boolean> {
    this.gateCalls.push(item);
    const plan = this.#plan.gateRead;
    if (plan === undefined) return true;
    return await plan(item);
  }

  async coverage(): Promise<CoverageVerdict> {
    return { enough: true, next: "stop" };
  }
}

function reflexOn(config: Config): void {
  config.reflex.enabled = true;
}

// ---------------------------------------------------------------------------
// `web_search`: disabled is byte-identical to today
// ---------------------------------------------------------------------------

test("disabled: zero reflex decisions and byte-identical output", async () => {
  const baselineEngines = [new StubEngine("google")];
  const baseline = makeSearchHarness({ engines: baselineEngines });
  const control = await search(baseline, { q: "same query" });

  const spy = new FakeReflex();
  const gatedEngines = [new StubEngine("google")];
  const gated = makeSearchHarness({
    engines: gatedEngines,
    reflex: spy,
    config: (config) => {
      config.reflex.enabled = false;
    },
  });
  const actual = await search(gated, { q: "same query" });

  assert.equal(textOf(actual), textOf(control), "D10 output must not change with the flag off");
  assert.deepEqual(actual.details, control.details);
  assert.deepEqual(gatedEngines[0]?.urls, baselineEngines[0]?.urls, "engine URLs must be identical");
  assert.deepEqual(spy.routeCalls, [], "route is not called when disabled");
  assert.deepEqual(spy.triageCalls, [], "triage is not called when disabled");
  assert.equal(spy.beginCalls, 1, "the per-search budget is reset exactly once");
});

test("triage trigger: merged or n>10 only", () => {
  assert.equal(triageWanted(false, 5), false, "a plain n=5 single-engine search stays cheap");
  assert.equal(triageWanted(false, 10), false);
  assert.equal(triageWanted(false, 11), true, "n above the schema ceiling still trips the rule");
  assert.equal(triageWanted(true, 5), true);
});

// ---------------------------------------------------------------------------
// `web_search`: routing
// ---------------------------------------------------------------------------

test("enabled + auto applies the routed order, locale, n and summary", async () => {
  const ddg = new StubEngine("duckduckgo", { walls: [WALL] });
  const google = new StubEngine("google");
  const spy = new FakeReflex({
    route: () => ({
      engines: ["duckduckgo", "google"],
      lang: "ru",
      region: "de",
      freshness: "w",
      n: 3,
      summary: false,
    }),
  });
  const harness = makeSearchHarness({ engines: [ddg, google], reflex: spy, config: reflexOn });

  const result = expectSearchSuccess(await search(harness, { q: "routed query" }));

  assert.deepEqual(spy.routeCalls, ["routed query"]);
  // The route's order is the try order; a wall falls back to the next engine.
  assert.deepEqual(harness.limiterCalls, ["duckduckgo", "google"]);
  assert.deepEqual(result.details.engines, ["google"]);

  assert.equal(ddg.queries[0]?.region, "de", "the routed region reaches duckduckgo's kl slot");

  const routed = google.queries.at(-1);
  assert.ok(routed !== undefined);
  assert.equal(routed.lang, "ru");
  assert.equal(routed.region, "de");
  assert.equal(routed.freshness, "w");
  assert.equal(routed.n, 3, "route.n is applied only because the caller did not pass n");
  assert.equal(routed.summary, false);
});

test("caller arguments beat a routed suggestion", async () => {
  const google = new StubEngine("google");
  const spy = new FakeReflex({ route: () => ({ engines: ["google"], n: 1, summary: false, freshness: "d" }) });
  const harness = makeSearchHarness({
    engines: [google],
    reflex: spy,
    config: (config) => {
      reflexOn(config);
      // A pinned config locale outranks the route too.
      config.engines.google.lang = "en";
      config.engines.google.gl = "us";
    },
  });

  expectSearchSuccess(await search(harness, { q: "explicit", n: 5, summary: true, freshness: "m" }));

  const query = google.queries.at(-1);
  assert.ok(query !== undefined);
  assert.equal(query.n, 5);
  assert.equal(query.summary, true);
  assert.equal(query.freshness, "m");
  assert.equal(query.lang, "en");
  assert.equal(query.region, "us");
});

test("yandex is moved last even when a route lists it first", async () => {
  const yandex = new StubEngine("yandex", { walls: [WALL] });
  const google = new StubEngine("google");
  const spy = new FakeReflex({ route: () => ({ engines: ["yandex", "google"] }) });
  const harness = makeSearchHarness({ engines: [yandex, google], reflex: spy, config: reflexOn });

  const result = expectSearchSuccess(await search(harness, { q: "captcha cost" }));

  assert.deepEqual(harness.limiterCalls, ["google", "yandex"], "google is cheaper and goes first");
  assert.deepEqual(result.details.engines, ["google"]);
});

test("a route that fails or names nothing falls back to the canonical order", async () => {
  const throwing = new FakeReflex({
    route: () => {
      throw new Error("classifier exploded");
    },
  });
  const harness = makeSearchHarness({
    engines: [new StubEngine("google"), new StubEngine("duckduckgo")],
    reflex: throwing,
    config: reflexOn,
  });
  const routed = expectSearchSuccess(await search(harness, { q: "route failure" }));
  assert.deepEqual(harness.limiterCalls, ["google"]);
  assert.deepEqual(routed.details.engines, ["google"]);
  assert.ok(
    harness.rows.some((row) => row.kind === "reflex_error" && row.decision === "route"),
    "a swallowed route error is logged",
  );

  const empty = new FakeReflex({ route: () => ({ engines: ["yandex"] }) });
  const noYandex = makeSearchHarness({
    engines: [new StubEngine("google")],
    reflex: empty,
    config: reflexOn,
  });
  const fallback = expectSearchSuccess(await search(noYandex, { q: "unavailable route" }));
  assert.deepEqual(fallback.details.engines, ["google"], "a route naming an unavailable engine is ignored");
});

test("a routed single engine keeps the auto fallback chain", async () => {
  const google = new StubEngine("google", { walls: [WALL] });
  const ddg = new StubEngine("duckduckgo");
  const spy = new FakeReflex({ route: () => ({ engines: ["google"] }) });
  const harness = makeSearchHarness({ engines: [google, ddg], reflex: spy, config: reflexOn });

  const result = expectSearchSuccess(await search(harness, { q: "single route" }));

  assert.deepEqual(harness.limiterCalls, ["google", "duckduckgo"]);
  assert.deepEqual(result.details.engines, ["duckduckgo"]);
});

// ---------------------------------------------------------------------------
// `web_search`: triage
// ---------------------------------------------------------------------------

function mergedEngines(): { google: StubEngine; ddg: StubEngine } {
  const google = new StubEngine("google", {
    results: [
      { title: "G one", url: "https://g1.example.test/a", snippet: "" },
      { title: "G two", url: "https://g2.example.test/b", snippet: "" },
      { title: "G three", url: "https://g3.example.test/c", snippet: "" },
    ],
  });
  const ddg = new StubEngine("duckduckgo", {
    results: [
      { title: "D one", url: "https://d1.example.test/d", snippet: "" },
      { title: "D two", url: "https://d2.example.test/e", snippet: "" },
    ],
  });
  return { google, ddg };
}

function mergedHarness(spy: FakeReflex): SearchHarness {
  const { google, ddg } = mergedEngines();
  return makeSearchHarness({ engines: [google, ddg], reflex: spy, config: reflexOn });
}

test("triage keeps the returned indices of a merged search", async () => {
  const spy = new FakeReflex({ triage: (items) => ({ keep: [3, 1], scores: items.map(() => 3), flags: [] }) });
  const harness = mergedHarness(spy);

  const result = expectSearchSuccess(await search(harness, { q: "merged", engines: ["google", "duckduckgo"] }));

  assert.equal(spy.triageCalls.length, 1);
  assert.deepEqual(
    spy.triageCalls[0]?.map((item) => item.url),
    [
      "https://g1.example.test/a",
      "https://g2.example.test/b",
      "https://g3.example.test/c",
      "https://d1.example.test/d",
      "https://d2.example.test/e",
    ],
    "candidates mirror the merge key: one entry per normalised URL, engine order preserved",
  );
  assert.deepEqual(spy.triageCalls[0]?.map((item) => item.engine), [
    "google",
    "google",
    "google",
    "duckduckgo",
    "duckduckgo",
  ]);

  const text = textOf(result);
  assert.match(text, /G two/);
  assert.match(text, /D one/);
  assert.doesNotMatch(text, /G one/);
  assert.doesNotMatch(text, /G three/);
  assert.doesNotMatch(text, /D two/);
  assert.equal(result.details.results, 2);
});

test("an empty triage keep list never empties the SERP", async () => {
  const spy = new FakeReflex({ triage: () => ({ keep: [], scores: [], flags: [] }) });
  const harness = mergedHarness(spy);

  const result = expectSearchSuccess(await search(harness, { q: "empty keep", engines: ["google", "duckduckgo"] }));

  assert.equal(spy.triageCalls.length, 1);
  assert.equal(result.details.results, 5, "the unrefined SERPs are returned");
  const text = textOf(result);
  for (const title of ["G one", "G two", "G three", "D one", "D two"]) assert.match(text, new RegExp(title));
});

test("a throwing triage leaves a merged SERP unchanged", async () => {
  const spy = new FakeReflex({
    triage: () => {
      throw new Error("model died");
    },
  });
  const harness = mergedHarness(spy);
  const actual = expectSearchSuccess(await search(harness, { q: "reflex throw", engines: ["google", "duckduckgo"] }));

  // Same query/engines without a reflex is the reference payload.
  const merged = mergedEngines();
  const reference = makeSearchHarness({ engines: [merged.google, merged.ddg] });
  const expected = expectSearchSuccess(
    await search(reference, { q: "reflex throw", engines: ["google", "duckduckgo"] }),
  );

  assert.equal(textOf(actual), textOf(expected));
  assert.deepEqual(actual.details, expected.details);
  assert.ok(
    harness.rows.some((row) => row.kind === "reflex_error" && row.decision === "triage"),
    "a swallowed triage error is logged",
  );
});

test("triage is skipped for a single engine and for a disabled flag", async () => {
  const single = new FakeReflex();
  const one = makeSearchHarness({ engines: [new StubEngine("google")], reflex: single, config: reflexOn });
  expectSearchSuccess(await search(one, { q: "one engine", engines: "google" }));
  assert.equal(single.triageCalls.length, 0);

  const off = new FakeReflex();
  const disabled = makeSearchHarness({
    engines: [new StubEngine("google"), new StubEngine("duckduckgo")],
    reflex: off,
    config: (config) => {
      config.reflex.enabled = false;
    },
  });
  expectSearchSuccess(await search(disabled, { q: "off", engines: ["google", "duckduckgo"] }));
  assert.equal(off.triageCalls.length, 0);
  assert.deepEqual(off.routeCalls, []);
});

// ---------------------------------------------------------------------------
// `web_read`: the gate
// ---------------------------------------------------------------------------

const READ_DOC: ReadableDocument = {
  title: "Example page",
  blocks: [{ kind: "paragraph", inlines: [{ kind: "text", text: "Hello read world." }] }],
};

interface ReadHarness {
  tool: ReturnType<typeof createWebReadTool>;
  page: FakePage;
  rows: Record<string, unknown>[];
  pagesRequested(): number;
}

function makeReadHarness(options: { config?: (config: Config) => void; reflex?: Reflex }): ReadHarness {
  const config = structuredClone(DEFAULT_CONFIG);
  options.config?.(config);

  const clock = new FakeClock();
  const page = new FakePage({ url: "about:blank", evaluate: () => READ_DOC });
  const rows: Record<string, unknown>[] = [];
  const log: Logger = {
    async write(row: Record<string, unknown>): Promise<void> {
      rows.push(structuredClone(row));
    },
    path: () => "memory",
  };
  const cache: Cache = createCache({ maxEntries: 10, clock });
  const limiter: Limiter = {
    async acquire(): Promise<void> {},
    stats(engine: EngineId): LimiterStats {
      return { engine, lastAt: null, today: 0, dailyCap: 100 };
    },
  };
  const artifacts: Artifacts = {
    async save(): Promise<string> {
      throw new Error("web_read writes no artifacts in this lane");
    },
    async prune() {
      return { removed: 0, kept: 0, bytes: 0 };
    },
    async size() {
      return 0;
    },
    root: () => "/tmp/opencode/pi-chrome-search/artifacts",
  };

  let pagesRequested = 0;
  const cdp: CdpConnector = {
    async connect() {
      throw new Error("web_read unit tests never connect");
    },
    async acquirePage(): Promise<CdpPage> {
      pagesRequested += 1;
      return page;
    },
    async releaseAll() {},
    isConnected: () => true,
    endpoint: () => null,
  };

  const deps: ToolDeps = {
    config,
    engines: {
      get() {
        throw new Error("engine registry is not used by web_read");
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
    clock,
    ...(options.reflex === undefined ? {} : { reflex: options.reflex }),
  };

  return {
    tool: createWebReadTool(() => deps, { resolve: PUBLIC_RESOLVER }),
    page,
    rows,
    pagesRequested: () => pagesRequested,
  };
}

async function read(harness: ReadHarness, url: string): Promise<WebReadResult> {
  return await harness.tool.execute("call-1", { url } as WebReadInput, undefined, undefined);
}

test("read gate false refuses the read without navigating", async () => {
  const spy = new FakeReflex({ gateRead: () => false });
  const harness = makeReadHarness({ reflex: spy, config: reflexOn });

  const result = (await read(harness, "https://example.test/article")) as WebReadFailure;

  assert.equal(result.isError, true);
  assert.equal(result.details.code, "E_UNSUPPORTED");
  assert.match(textOf(result), /stage=read/);
  assert.match(textOf(result), /hint: .*gate/i);
  assert.equal(spy.gateCalls.length, 1);
  assert.deepEqual(spy.gateCalls[0], {
    title: "https://example.test/article",
    url: "https://example.test/article",
    snippet: "",
    engine: "read",
  });
  assert.equal(harness.page.callCount("navigate"), 0, "a declined read must not open a tab");
  assert.equal(harness.pagesRequested(), 0);
});

test("read gate true reads the page normally", async () => {
  const spy = new FakeReflex({ gateRead: () => true });
  const harness = makeReadHarness({ reflex: spy, config: reflexOn });

  const result = (await read(harness, "https://example.test/article")) as WebReadSuccess;

  assert.equal(isFailure(result), false);
  assert.equal(spy.gateCalls.length, 1);
  assert.equal(harness.page.callCount("navigate"), 1);
  assert.match(textOf(result), /Hello read world/);
});

test("a disabled reflex is never consulted by web_read", async () => {
  const spy = new FakeReflex({ gateRead: () => false });
  const harness = makeReadHarness({ reflex: spy });

  const result = (await read(harness, "https://example.test/article")) as WebReadSuccess;

  assert.equal(isFailure(result), false);
  assert.equal(spy.gateCalls.length, 0);
  assert.equal(harness.page.callCount("navigate"), 1);
});

test("a throwing read gate fails open", async () => {
  const spy = new FakeReflex({
    gateRead: () => {
      throw new Error("gatekeeper exploded");
    },
  });
  const harness = makeReadHarness({ reflex: spy, config: reflexOn });

  const result = (await read(harness, "https://example.test/article")) as WebReadSuccess;

  assert.equal(isFailure(result), false, "a reflex bug must not refuse a page");
  assert.equal(harness.page.callCount("navigate"), 1);
});

// ---------------------------------------------------------------------------
// `createReflex`: composition root
// ---------------------------------------------------------------------------

interface RegistrySpy {
  registry: ClassifierRegistry;
  availability: Array<string | undefined>;
  classifyCalls: number;
}

function fakeRegistry(answers: (context: ClassifierContext) => Record<string, ClassifierAnswer>): RegistrySpy {
  const availability: Array<string | undefined> = [];
  const spy: RegistrySpy = {
    availability,
    classifyCalls: 0,
    registry: {
      async getAvailableOfType(_type, provider) {
        availability.push(provider);
        if (provider === "openrouter") {
          return [{ provider: "openrouter", id: DEFAULT_CONFIG.reflex.openrouter.primary }];
        }
        return [];
      },
      findOfType(_type, provider, modelId) {
        return provider === "openrouter" ? { provider, id: modelId } : undefined;
      },
      async classify(model, context): Promise<ClassifierResult> {
        spy.classifyCalls += 1;
        return {
          provider: model.provider,
          model: model.id,
          answers: answers(context),
          usage: { input: 12, output: 0, totalTokens: 12, cost: { total: 0.0001 } },
          stopReason: "stop",
        };
      },
    },
  };
  return spy;
}

function routeAnswers(context: ClassifierContext): Record<string, ClassifierAnswer> {
  assert.deepEqual(Object.keys(context.questions).sort(), ["engines", "freshness", "lang"]);
  return {
    engines: { type: "choice", choice: "duckduckgo", probabilities: { duckduckgo: 0.9 }, confidence: 0.9 },
    lang: { type: "choice", choice: "ru", probabilities: { ru: 0.9 }, confidence: 0.9 },
    freshness: { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 },
  };
}

/** Answers any decision, so one fake registry can serve route + gate + triage. */
function anyAnswers(context: ClassifierContext): Record<string, ClassifierAnswer> {
  const choice = (value: string): ClassifierAnswer => ({
    type: "choice",
    choice: value,
    probabilities: { [value]: 0.9 },
    confidence: 0.9,
  });
  const bool = (probability: number): ClassifierAnswer => ({ type: "bool", probability });

  const answers: Record<string, ClassifierAnswer> = {};
  for (const id of Object.keys(context.questions)) {
    if (id === "will_answer" || id === "enough") answers[id] = bool(0.95);
    else if (id === "spam" || id === "duplicate") answers[id] = bool(0.05);
    else if (id === "next") answers[id] = choice("stop");
    else if (id === "relevance") answers[id] = { type: "score", score: 4, confidence: 0.9 };
    else if (id === "engines") answers[id] = choice("duckduckgo");
    else if (id === "lang") answers[id] = choice("ru");
    else if (id === "freshness") answers[id] = choice("none");
  }
  return answers;
}

interface PolicyHarness {
  bundle: ReturnType<typeof createReflex>;
  rows: Record<string, unknown>[];
  clock: FakeClock;
}

function policyHarness(config: Config, registry?: ClassifierRegistry): PolicyHarness {
  const clock = new FakeClock();
  const cache = createCache({ maxEntries: 100, clock });
  const rows: Record<string, unknown>[] = [];
  const log: Logger = {
    async write(row: Record<string, unknown>): Promise<void> {
      rows.push(structuredClone(row));
    },
    path: () => "memory",
  };
  const bundle = createReflex({
    config,
    clock,
    cache,
    log,
    ...(registry === undefined ? {} : { registry }),
  });
  return { bundle, rows, clock };
}

function policyRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.filter((row) => row.kind === "reflex");
}

test("createReflex: disabled means zero registry traffic and rules verdicts", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const spy = fakeRegistry(routeAnswers);
  const { bundle, rows } = policyHarness(config, spy.registry);

  const route = await bundle.reflex.route("climate policy");

  assert.deepEqual(route.engines, ["google", "duckduckgo"], "rules routing for a Latin query");
  assert.equal(route.lang, "en");
  assert.deepEqual(spy.availability, [], "the registry is never listed");
  assert.equal(spy.classifyCalls, 0, "no model call when disabled");

  const logged = policyRows(rows);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.model, RULES_MODEL);
  assert.equal(logged[0]?.fallback, true);
  assert.equal(logged[0]?.reason, "disabled");
  assert.equal(bundle.stats().backendCalls, 0);
});

test("createReflex: enabled without a registry degrades to rules", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  reflexOn(config);
  const { bundle, rows } = policyHarness(config);

  await bundle.reflex.triage("climate policy", [
    { title: "One", url: "https://one.example.test/a", snippet: "climate", engine: "google" },
  ]);

  const logged = policyRows(rows);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.model, RULES_MODEL);
  assert.equal(logged[0]?.reason, "no_backend");
});

test("createReflex: backend \"rules\" never builds a classifier", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  reflexOn(config);
  config.reflex.backend = "rules";
  const spy = fakeRegistry(routeAnswers);
  const { bundle, rows } = policyHarness(config, spy.registry);

  await bundle.reflex.route("climate policy");

  assert.deepEqual(spy.availability, []);
  assert.equal(spy.classifyCalls, 0);
  const logged = policyRows(rows);
  assert.equal(logged[0]?.model, RULES_MODEL);
  assert.equal(logged[0]?.fallback, false, "an explicit rules backend is not a fallback");
});

test("createReflex: an enabled classifier verdict carries lastOutcome metadata", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  reflexOn(config);
  const spy = fakeRegistry(routeAnswers);
  const { bundle, rows } = policyHarness(config, spy.registry);

  const route = await bundle.reflex.route("climate policy");

  assert.deepEqual(route.engines, ["duckduckgo"], "the classifier's route is used");
  assert.equal(route.lang, "ru");
  assert.equal(spy.classifyCalls, 1);

  const logged = policyRows(rows);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.model, DEFAULT_CONFIG.reflex.openrouter.primary);
  assert.equal(logged[0]?.confidence, 0.9);
  assert.equal(logged[0]?.fallback, false);
  assert.deepEqual(logged[0]?.usage, { inputTokens: 12, outputTokens: 0 });
  assert.equal(logged[0]?.costUsd, 0.0001);

  const backendRows = rows.filter((row) => row.kind === REFLEX_BACKEND_LOG_KIND);
  assert.equal(backendRows.length, 1, "the classifier's own decision row is kept");
  assert.equal(backendRows[0]?.verdict, "duckduckgo");
});

test("beginSearch resets the per-search budget", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  reflexOn(config);
  config.reflex.maxCallsPerSearch = 1;
  // A vendored verdict is served from the 24 h cache before the budget check, so
  // two *different* decisions on the same query are what exercises the cap.
  const spy = fakeRegistry(anyAnswers);
  const { bundle, rows } = policyHarness(config, spy.registry);
  const item: Candidate = { title: "Page", url: "https://page.example.test/a", snippet: "", engine: "google" };

  await bundle.reflex.route("budget query");
  await bundle.reflex.gateRead("budget query", item);
  bundle.beginSearch();
  await bundle.reflex.gateRead("budget query", item);

  const logged = policyRows(rows);
  assert.deepEqual(
    logged.map((row) => row.model),
    [DEFAULT_CONFIG.reflex.openrouter.primary, RULES_MODEL, DEFAULT_CONFIG.reflex.openrouter.primary],
    "decision 2 in the same search is budget-stopped; beginSearch() re-opens it",
  );
  assert.equal(logged[1]?.reason, "max_calls_per_search");
  assert.equal(logged[1]?.fallback, true);
  assert.equal(bundle.stats().budgetStops, 1);
  assert.equal(bundle.stats().backendCalls, 2);
});

test("localOnly never probes or calls a remote classifier", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  reflexOn(config);
  config.reflex.localOnly = true;
  const spy = fakeRegistry(routeAnswers);
  const { bundle, rows } = policyHarness(config, spy.registry);

  const route = await bundle.reflex.route("climate policy");

  assert.deepEqual(route.engines, ["google", "duckduckgo"], "rules answer, not a model verdict");
  assert.equal(spy.classifyCalls, 0, "no remote classify call");
  assert.ok(!spy.availability.includes("openrouter"), "the remote provider is never even listed");
  assert.ok(!spy.availability.includes(undefined), "no provider-neutral listing that could probe remote auth");
  assert.deepEqual(spy.availability, ["llama.cpp", "ik-llama"]);

  const logged = policyRows(rows);
  assert.equal(logged.length, 1);
  // The abstain fell back to rules; P5-B labels that row's model "unknown" (its
  // telemetry override), so `fallback` + a 0 confidence is the honest assertion.
  assert.equal(logged[0]?.fallback, true);
  assert.equal(logged[0]?.confidence, 0);
  assert.equal(bundle.stats().rulesVerdicts, 1, "a rules verdict produced the answer");
});
