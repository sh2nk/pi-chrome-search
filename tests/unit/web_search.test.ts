/**
 * P2-D unit tests: `web_search` orchestration (SPEC §7.1, PLAN V2.5).
 *
 * Fully offline. `ToolDeps` is assembled from in-memory fakes: a stub engine per
 * id, `FakePage`, `FakeClock`, the real LRU cache, and spy limiter/artifacts.
 * Nothing here opens a socket, launches a browser or spends real milliseconds —
 * a test that needed Wall-clock time would show up in the virtual clock log.
 *
 * The assertions target the behaviours P2-E and P3 cannot re-derive cheaply:
 * rejection before any side effect, cache-before-limiter, engine order and
 * fallback, the single yandex retry, human-first-search state, and honest
 * failure rendering with an artifact path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Value } from "typebox/value";

import type { CdpConnector, CdpPage } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import type {
  AiProbe,
  AiSummary,
  Engine,
  EngineAi,
  EngineId,
  EngineInteraction,
  Query,
  RawSerp,
  SerpItem,
  Wall,
} from "../../src/engines/types.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import { createCache, serpKey } from "../../src/runtime/cache.ts";
import { fail } from "../../src/runtime/errors.ts";
import type { ArtifactInput, Artifacts, Cache, Limiter, LimiterStats, Logger } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import {
  JSON_MIN_ENVELOPE,
  WEB_SEARCH_DESCRIPTION,
  createWebSearchTool,
  webSearchSchema,
  type WebSearchFailure,
  type WebSearchInput,
  type WebSearchResult,
  type WebSearchSuccess,
} from "../../src/tools/web_search.ts";
import { FakeClock } from "../helpers/clock.ts";
import { FakePage, type EvaluateHandler } from "../helpers/fake-page.ts";

const MARKER_TEXT = "Search results for the test query";
const BOX = "#search-box";
const RESULT_CONTAINER = "#rso";
const RESULT_EXTRA = "#extra-results";
const ARTIFACT_ROOT = "/tmp/opencode/pi-chrome-search/artifacts";
const ARTIFACT_PATH = (index: number): string => `${ARTIFACT_ROOT}/test-${index}`;

const WALL: Wall = {
  kind: "captcha",
  url: "https://yandex.example.test/showcaptcha",
  markers: ["Я не робот", "SmartCaptcha"],
};

// ---------------------------------------------------------------------------
// DOM model for the humanize path
// ---------------------------------------------------------------------------

const COUNT_RE = /document\.querySelectorAll\(("(?:[^"\\]|\\.)*")\)\.length/;
const EXISTS_RE = /document\.querySelector\(("(?:[^"\\]|\\.)*")\)/;

/** Answers the two expressions `humanize` emits; anything else is "not found". */
function domHandlers(boxes: readonly string[], counts: Readonly<Record<string, number>>): EvaluateHandler {
  return (expression) => {
    const counted = COUNT_RE.exec(expression);
    if (counted !== null) return counts[JSON.parse(counted[1]!) as string] ?? 0;
    const exists = EXISTS_RE.exec(expression);
    if (exists !== null) return boxes.includes(JSON.parse(exists[1]!) as string);
    return null;
  };
}

// ---------------------------------------------------------------------------
// Stub engine
// ---------------------------------------------------------------------------

interface StubEngineOptions {
  id: EngineId;
  results?: SerpItem[];
  ai?: AiSummary;
  /** P8: attach a probe/expand hook to the stub engine. */
  aiHooks?: EngineAi;
  pageCarried?: boolean;
  interaction?: EngineInteraction;
  retryOnWall?: boolean;
  /** Consumed per `detectWall` call; the last entry repeats when exhausted. */
  walls?: Array<Wall | null>;
  extractError?: unknown;
  settleError?: unknown;
}

const DEFAULT_RESULTS: SerpItem[] = [
  { title: "Example result", url: "https://example.test/page", snippet: "An example snippet." },
];

class StubEngine implements Engine {
  readonly id: EngineId;
  readonly retryOnWall?: boolean;
  readonly interaction?: EngineInteraction;
  readonly ai?: EngineAi;

  readonly queries: Query[] = [];
  readonly urls: string[] = [];
  settles = 0;
  wallsChecked = 0;
  /** Forced wall for the settle-failure path; undefined means "use #walls". */
  wallOnDetect?: Wall;
  extracts = 0;

  readonly #results: SerpItem[];
  readonly #ai: AiSummary | undefined;
  readonly #pageCarried: boolean;
  readonly #walls: Array<Wall | null>;
  readonly #extractError: unknown;
  readonly #settleError: unknown;

  constructor(options: StubEngineOptions) {
    this.id = options.id;
    this.#results = options.results ?? DEFAULT_RESULTS;
    this.#ai = options.ai;
    this.#pageCarried = options.pageCarried ?? false;
    this.#walls = options.walls ?? [];
    this.#extractError = options.extractError;
    this.#settleError = options.settleError;
    if (options.retryOnWall !== undefined) this.retryOnWall = options.retryOnWall;
    if (options.interaction !== undefined) this.interaction = options.interaction;
    if (options.aiHooks !== undefined) this.ai = options.aiHooks;
  }

  buildUrl(query: Query): string {
    this.queries.push(query);
    const url = `https://${this.id}.example.test/search?q=${encodeURIComponent(query.text)}&n=${query.n}`;
    this.urls.push(url);
    return url;
  }

  async settle(_page: CdpPage, _signal?: AbortSignal): Promise<void> {
    this.settles += 1;
    if (this.#settleError !== undefined) throw this.#settleError;
  }

  async detectWall(_page: CdpPage): Promise<Wall | null> {
    if (this.wallOnDetect !== undefined) return this.wallOnDetect;
    if (this.#walls.length === 0) {
      this.wallsChecked += 1;
      return null;
    }
    const index = Math.min(this.wallsChecked, this.#walls.length - 1);
    this.wallsChecked += 1;
    return this.#walls[index] ?? null;
  }

  async extract(_page: CdpPage, query: Query): Promise<RawSerp> {
    this.extracts += 1;
    if (this.#extractError !== undefined) throw this.#extractError;
    const serp: RawSerp = {
      engine: this.id,
      query: query.text,
      results: this.#results.map((item) => ({ ...item })),
      pageCarried: this.#pageCarried,
      timings: {},
    };
    if (this.#ai !== undefined) {
      serp.ai = {
        text: this.#ai.text,
        sources: [...this.#ai.sources],
        ...(this.#ai.state === undefined ? {} : { state: this.#ai.state }),
      };
    }
    return serp;
  }

  async canaries(_page: CdpPage): Promise<Record<string, number>> {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  engines: readonly Engine[];
  /** Mutate the cloned default config before dependencies are built. */
  config?: (config: Config) => void;
  clock?: FakeClock;
  page?: FakePage;
  limiter?: Limiter;
  artifacts?: Artifacts;
  cache?: Cache;
  /** Transport for the /goto resolver; offline tests must always stub it. */
  fetchImpl?: typeof fetch;
}

interface Harness {
  config: Config;
  clock: FakeClock;
  page: FakePage;
  deps: ToolDeps;
  cache: Cache;
  limiterCalls: EngineId[];
  saved: ArtifactInput[];
  pageRequests: EngineId[];
}

function makeHarness(options: HarnessOptions): Harness {
  const config = structuredClone(DEFAULT_CONFIG);
  options.config?.(config);

  const clock = options.clock ?? new FakeClock();
  const page =
    options.page ??
    new FakePage({
      clock,
      text: MARKER_TEXT,
      evaluate: domHandlers([BOX], { [RESULT_CONTAINER]: 1, [RESULT_EXTRA]: 1 }),
    });

  const cache = options.cache ?? createCache({ maxEntries: 200, clock });
  const limiterCalls: EngineId[] = [];
  const limiter: Limiter =
    options.limiter ?? {
      async acquire(engine: EngineId): Promise<void> {
        limiterCalls.push(engine);
      },
      stats(engine: EngineId): LimiterStats {
        return { engine, lastAt: null, today: 0, dailyCap: 100 };
      },
    };

  const saved: ArtifactInput[] = [];
  const artifacts: Artifacts =
    options.artifacts ?? {
      async save(input: ArtifactInput): Promise<string> {
        saved.push(input);
        return ARTIFACT_PATH(saved.length);
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
  const pages = new Map<EngineId, CdpPage>(options.engines.map((engine) => [engine.id, page]));
  const pageRequests: EngineId[] = [];
  const cdp: CdpConnector = {
    async connect() {
      throw new Error("connect() is not used by web_search unit tests");
    },
    async acquirePage(engine: EngineId): Promise<CdpPage> {
      pageRequests.push(engine);
      const resolved = pages.get(engine);
      if (resolved === undefined) throw new Error(`no fake page for ${engine}`);
      return resolved;
    },
    async releaseAll() {},
    isConnected: () => true,
    endpoint: () => null,
  };

  const engineMap = Object.fromEntries(options.engines.map((engine) => [engine.id, engine]));
  const fetchImpl =
    options.fetchImpl ??
    (async (): Promise<Response> => {
      throw new Error("offline test: /goto resolution must be stubbed through fetchImpl");
    });
  const deps: ToolDeps = {
    config,
    engines: createEngineRegistry(engineMap, config),
    cdp,
    cache,
    limiter,
    artifacts,
    log,
    clock,
    fetchImpl,
  };

  return { config, clock, page, deps, cache, limiterCalls, saved, pageRequests };
}

function makeTool(harness: Harness) {
  return createWebSearchTool(() => harness.deps);
}

async function run(
  harness: Harness,
  input: Partial<WebSearchInput>,
  signal?: AbortSignal,
  onUpdate?: unknown,
): Promise<WebSearchResult> {
  const tool = makeTool(harness);
  return await tool.execute("call-1", input as WebSearchInput, signal, onUpdate);
}

function isFailure(result: WebSearchResult): result is WebSearchFailure {
  return "isError" in result && result.isError === true;
}

function expectSuccess(result: WebSearchResult): WebSearchSuccess {
  assert.equal(isFailure(result), false, `expected success, got ${JSON.stringify(result.details)}`);
  return result as WebSearchSuccess;
}

function expectFailure(result: WebSearchResult): WebSearchFailure {
  assert.equal(isFailure(result), true, "expected a rendered failure");
  return result as WebSearchFailure;
}

function textOf(result: WebSearchResult): string {
  return result.content.map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("schema accepts every documented shape", () => {
  const valid: unknown[] = [
    { q: "hello" },
    { q: "hello", n: 1 },
    { q: "hello", n: 10, engines: "auto", summary: true, freshness: "d", page: 1, format: "md" },
    { q: "hello", engines: "google" },
    { q: "hello", engines: "duckduckgo" },
    { q: "hello", engines: "yandex" },
    { q: "hello", engines: ["google", "duckduckgo", "yandex"], format: "json" },
    { q: "site:example.test filetype:pdf \"exact phrase\"", freshness: "y", page: 3 },
  ];
  for (const value of valid) {
    assert.equal(Value.Check(webSearchSchema, value), true, JSON.stringify(value));
  }
});

test("schema rejects out-of-range and unknown values", () => {
  const invalid: unknown[] = [
    {},
    { q: "" },
    { q: "x", n: 0 },
    { q: "x", n: 11 },
    { q: "x", n: 2.5 },
    { q: "x", page: 0 },
    { q: "x", engines: "bing" },
    { q: "x", engines: [] },
    { q: "x", engines: ["google", "bing"] },
    { q: "x", freshness: "z" },
    { q: "x", format: "xml" },
  ];
  for (const value of invalid) {
    assert.equal(Value.Check(webSearchSchema, value), false, JSON.stringify(value));
  }
});

test("description stays inside the 350-char budget", () => {
  assert.ok(WEB_SEARCH_DESCRIPTION.length > 0);
  assert.ok(WEB_SEARCH_DESCRIPTION.length <= 350, `${WEB_SEARCH_DESCRIPTION.length} chars`);
});

// ---------------------------------------------------------------------------
// Defensive validation
// ---------------------------------------------------------------------------

test("invalid arguments render E_CONFIG before any navigation or limiter call", async () => {
  const invalid: Array<Partial<WebSearchInput>> = [
    { q: "   " },
    { q: "x", n: 0 },
    { q: "x", n: 11 },
    { q: "x", n: 2.5 },
    { q: "x", page: 0 },
    { q: "x", engines: "bing" as never },
    { q: "x", engines: [] },
    { q: "x", freshness: "z" as never },
    { q: "x", format: "xml" as never },
    {},
  ];

  for (const input of invalid) {
    const harness = makeHarness({ engines: [new StubEngine({ id: "google" })] });
    const result = expectFailure(await run(harness, input));
    assert.equal(result.details.code, "E_CONFIG", JSON.stringify(input));
    assert.match(textOf(result), /web_search failed \[E_CONFIG\]/);
    assert.match(textOf(result), /stage=config/);
    assert.equal(harness.page.callCount("navigate"), 0);
    assert.deepEqual(harness.limiterCalls, []);
    assert.deepEqual(harness.pageRequests, []);
    assert.equal(harness.saved.length, 0);
  }
});

test("a cached SERP is served without the limiter or a navigation", async () => {
  const harness = makeHarness({ engines: [new StubEngine({ id: "google" })] });
  const text = "cached query";
  // Default config: n=5, page=1, summary=true, locale auto → undefined.
  const key = serpKey({ engine: "google", text, n: 5, page: 1, summary: true });
  const cached: RawSerp = {
    engine: "google",
    query: text,
    results: [{ title: "Cached result", url: "https://cached.example.test/1", snippet: "from cache" }],
    pageCarried: false,
    timings: {},
  };
  harness.cache.set(key, cached, harness.config.cache.serpTtlMs);

  const result = expectSuccess(await run(harness, { q: `  ${text}  ` }));

  assert.equal(harness.page.callCount("navigate"), 0);
  assert.deepEqual(harness.limiterCalls, []);
  assert.deepEqual(harness.pageRequests, []);
  assert.equal(result.details.cached, true);
  assert.equal(result.details.engines.length, 1);
  assert.equal(result.details.engines[0], "google");
  assert.match(textOf(result), /cached/);
  assert.match(textOf(result), /Cached result/);
});

// ---------------------------------------------------------------------------
// Selection, order, fallback
// ---------------------------------------------------------------------------

test("auto stops at the first success; an explicit list keeps caller order and merges", async () => {
  const engines = [
    new StubEngine({ id: "google", results: [{ title: "G", url: "https://g.example.test/1", snippet: "" }] }),
    new StubEngine({ id: "duckduckgo", results: [{ title: "D", url: "https://d.example.test/1", snippet: "" }] }),
    new StubEngine({ id: "yandex", results: [{ title: "Y", url: "https://y.example.test/1", snippet: "" }] }),
  ];
  const harness = makeHarness({ engines });
  const result = expectSuccess(await run(harness, { q: "order", engines: "auto" }));

  // D10: `auto` is not a merge — google succeeds, so ddg/yandex are never touched.
  assert.deepEqual(harness.limiterCalls, ["google"]);
  assert.equal(harness.page.callCount("navigate"), 1);
  assert.deepEqual(result.details.engines, ["google"]);
  assert.match(textOf(result), /^google · /);
  assert.equal(engines[1]?.queries.length, 0);
  assert.equal(engines[2]?.queries.length, 0);

  const explicit = makeHarness({
    engines: [
      new StubEngine({ id: "google" }),
      new StubEngine({ id: "duckduckgo" }),
      new StubEngine({ id: "yandex" }),
    ],
  });
  expectSuccess(await run(explicit, { q: "order", engines: ["yandex", "google"] }));
  assert.deepEqual(explicit.limiterCalls, ["yandex", "google"]);
});

test("auto falls back on a wall and stops after the fallback succeeds", async () => {
  const google = new StubEngine({ id: "google", walls: [WALL] });
  const ddg = new StubEngine({
    id: "duckduckgo",
    results: [{ title: "Fallback", url: "https://d.example.test/1", snippet: "" }],
  });
  const yandex = new StubEngine({ id: "yandex" });
  const harness = makeHarness({ engines: [google, ddg, yandex] });

  const result = expectSuccess(await run(harness, { q: "auto fallback", engines: "auto" }));

  assert.deepEqual(harness.limiterCalls, ["google", "duckduckgo"]);
  assert.deepEqual(result.details.engines, ["duckduckgo"]);
  assert.equal(harness.page.navigations().length, 2, "google + one fallback, never yandex");
  assert.equal(yandex.queries.length, 0, "yandex stays untouched after the fallback succeeds");
  assert.equal(yandex.settles, 0);
  assert.match(textOf(result), /Fallback/);
});

test("E_WALL and E_EMPTY fall through to the next engine", async () => {
  const walled = makeHarness({
    engines: [
      new StubEngine({ id: "google", walls: [WALL] }),
      new StubEngine({ id: "duckduckgo", results: [{ title: "Fallback", url: "https://d.example.test/1", snippet: "" }] }),
    ],
  });
  const afterWall = expectSuccess(await run(walled, { q: "fallback wall" }));
  assert.deepEqual(walled.limiterCalls, ["google", "duckduckgo"]);
  assert.deepEqual(afterWall.details.engines, ["duckduckgo"]);
  assert.match(textOf(afterWall), /Fallback/);
  assert.equal(walled.saved.length, 1, "the wall must leave an artifact");
  assert.equal(walled.saved[0]?.code, "E_WALL");

  const empty = makeHarness({
    engines: [
      new StubEngine({ id: "google", extractError: fail("E_EMPTY", "extract") }),
      new StubEngine({ id: "duckduckgo", results: [{ title: "Second", url: "https://d.example.test/2", snippet: "" }] }),
    ],
  });
  const afterEmpty = expectSuccess(await run(empty, { q: "fallback empty" }));
  assert.deepEqual(empty.limiterCalls, ["google", "duckduckgo"]);
  assert.deepEqual(afterEmpty.details.engines, ["duckduckgo"]);
});

test("a SERP with zero results is E_EMPTY and falls through (never cached)", async () => {
  const google = new StubEngine({ id: "google", results: [] });
  const ddg = new StubEngine({
    id: "duckduckgo",
    results: [{ title: "Second", url: "https://d.example.test/2", snippet: "" }],
  });
  const harness = makeHarness({ engines: [google, ddg] });

  const result = expectSuccess(await run(harness, { q: "empty google" }));

  assert.deepEqual(harness.limiterCalls, ["google", "duckduckgo"]);
  assert.deepEqual(result.details.engines, ["duckduckgo"]);
  assert.equal(google.extracts, 1);
  assert.equal(harness.cache.size(), 1, "only the successful SERP is cached");
  assert.match(textOf(result), /Second/);
});

test("when every engine fails, the first failure is rendered with code + stage + hint", async () => {
  const harness = makeHarness({
    engines: [
      new StubEngine({ id: "google", walls: [WALL] }),
      new StubEngine({ id: "duckduckgo", extractError: fail("E_EMPTY", "extract") }),
      new StubEngine({ id: "yandex", extractError: fail("E_EMPTY", "extract") }),
    ],
  });

  const result = expectFailure(await run(harness, { q: "all fail" }));
  const text = textOf(result);

  assert.deepEqual(harness.limiterCalls, ["google", "duckduckgo", "yandex"]);
  assert.equal(result.details.code, "E_WALL");
  assert.equal(result.details.engine, "google");
  assert.equal(result.details.stage, "navigate");
  assert.equal(result.details.wall, "captcha");
  assert.match(text, /web_search failed \[E_WALL\] engine=google stage=navigate/);
  assert.match(text, /hint: .*captcha/);
  assert.ok(result.details.artifact !== undefined);
  assert.match(text, /artifact: /);
});

test("an empty selection is E_UNSUPPORTED with a doctor hint", async () => {
  // Only google is registered, so an explicit yandex request selects nothing.
  const harness = makeHarness({ engines: [new StubEngine({ id: "google" })] });
  const result = expectFailure(await run(harness, { q: "no engines", engines: "yandex" }));
  assert.equal(result.details.code, "E_UNSUPPORTED");
  assert.match(textOf(result), /web-doctor/);
  assert.deepEqual(harness.limiterCalls, []);
});

// ---------------------------------------------------------------------------
// Yandex wall retry
// ---------------------------------------------------------------------------

test("yandex retries a wall exactly once after 3 s and succeeds when it clears", async () => {
  const engine = new StubEngine({ id: "yandex", retryOnWall: true, walls: [WALL, null] });
  const harness = makeHarness({ engines: [engine] });

  const result = expectSuccess(await run(harness, { q: "retry me", engines: "yandex" }));

  assert.equal(engine.wallsChecked, 2);
  assert.equal(engine.extracts, 1);
  assert.equal(harness.page.navigations().length, 2, "initial SERP + one retry");
  assert.ok(harness.clock.durations().includes(3000), `slept ${harness.clock.durations().join(",")}`);
  assert.ok(harness.page.bringToFrontCount() >= 1, "the window is surfaced for the user");
  assert.equal(harness.saved.length, 0, "a cleared retry leaves no orphan artifact");
  assert.deepEqual(result.details.engines, ["yandex"]);
});

test("a persistent yandex wall returns E_WALL after one retry, never a third attempt", async () => {
  const engine = new StubEngine({ id: "yandex", retryOnWall: true, walls: [WALL] });
  const harness = makeHarness({ engines: [engine] });

  const result = expectFailure(await run(harness, { q: "still walled", engines: "yandex" }));
  const text = textOf(result);

  assert.equal(result.details.code, "E_WALL");
  assert.equal(result.details.wall, "captcha");
  assert.equal(result.details.engine, "yandex");
  assert.equal(engine.wallsChecked, 2, "detectWall ran before and after the single retry");
  assert.equal(harness.page.navigations().length, 2);
  assert.deepEqual(harness.clock.durations().filter((ms) => ms === 3000), [3000]);
  assert.equal(harness.saved.length, 1, "only the returned wall is captured");
  assert.equal(harness.saved[0]?.extra?.retried, true);
  assert.match(text, /hint: .*captcha/);
  assert.ok(result.details.artifact !== undefined);
  assert.match(text, new RegExp(`artifact: ${ARTIFACT_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a non-retrying engine surfaces the wall but never sleeps or re-navigates", async () => {
  const engine = new StubEngine({ id: "google", walls: [WALL] });
  const harness = makeHarness({ engines: [engine] });

  const result = expectFailure(await run(harness, { q: "google wall", engines: "google" }));

  assert.equal(result.details.code, "E_WALL");
  assert.equal(engine.wallsChecked, 1);
  assert.equal(harness.page.navigations().length, 1);
  assert.deepEqual(harness.clock.durations(), []);
  assert.ok(harness.page.bringToFrontCount() >= 1);
});

test("retryYandexOnce:false returns E_WALL immediately with no sleep", async () => {
  const engine = new StubEngine({ id: "yandex", retryOnWall: true, walls: [WALL] });
  const harness = makeHarness({
    engines: [engine],
    config: (config) => {
      config.captcha.retryYandexOnce = false;
    },
  });

  const result = expectFailure(await run(harness, { q: "no retry", engines: "yandex" }));

  assert.equal(result.details.code, "E_WALL");
  assert.equal(engine.wallsChecked, 1);
  assert.equal(harness.page.navigations().length, 1);
  assert.deepEqual(harness.clock.durations(), []);
  assert.equal(harness.saved.length, 1);
});

test("captcha.waitMs adds one grace detection after the 3 s retry", async () => {
  const engine = new StubEngine({ id: "yandex", retryOnWall: true, walls: [WALL] });
  const harness = makeHarness({
    engines: [engine],
    config: (config) => {
      config.captcha.waitMs = 2500;
    },
  });

  const result = expectFailure(await run(harness, { q: "wait for human", engines: "yandex" }));

  assert.equal(result.details.code, "E_WALL");
  assert.equal(engine.wallsChecked, 3, "initial + after 3 s + after waitMs");
  assert.deepEqual(harness.clock.durations(), [3000, 2500]);
  assert.equal(harness.page.navigations().length, 2, "waitMs re-detects, it does not navigate again");
  assert.equal(harness.saved.length, 1);
});

test("captcha.waitMs clears a persistent-looking wall without a second artifact", async () => {
  const engine = new StubEngine({ id: "yandex", retryOnWall: true, walls: [WALL, WALL, null] });
  const harness = makeHarness({
    engines: [engine],
    config: (config) => {
      config.captcha.waitMs = 4000;
    },
  });

  const result = expectSuccess(await run(harness, { q: "solved late", engines: "yandex" }));

  assert.equal(engine.wallsChecked, 3);
  assert.equal(engine.extracts, 1);
  assert.deepEqual(harness.clock.durations(), [3000, 4000]);
  assert.equal(harness.saved.length, 0);
  assert.deepEqual(result.details.engines, ["yandex"]);
});

// ---------------------------------------------------------------------------
// Human first search
// ---------------------------------------------------------------------------

const INTERACTION: EngineInteraction = {
  homeUrl: "https://google.example.test/",
  boxSelectors: [BOX],
  marker: MARKER_TEXT,
  selector: RESULT_CONTAINER,
  minCount: 1,
};

test("first search types into the engine box; the second navigates the SERP directly", async () => {
  const engine = new StubEngine({ id: "google", interaction: INTERACTION });
  const harness = makeHarness({ engines: [engine] });
  const tool = makeTool(harness);

  const first = await tool.execute("call-1", { q: "first query" } as WebSearchInput, undefined, undefined);
  expectSuccess(first);
  assert.equal(harness.page.navigations()[0], INTERACTION.homeUrl);
  assert.deepEqual(
    harness.page.clicks().filter((click): click is string => typeof click === "string"),
    [BOX],
  );
  assert.deepEqual(harness.page.typedTexts(), ["first query"]);
  assert.deepEqual(harness.page.presses(), ["Enter"]);
  assert.equal(engine.settles, 0, "humanSearch owns settle on the typed path");

  const second = await tool.execute("call-2", { q: "second query" } as WebSearchInput, undefined, undefined);
  expectSuccess(second);
  assert.deepEqual(harness.page.typedTexts(), ["first query"], "the box is not typed twice");
  assert.equal(engine.settles, 1, "the fast path uses the adapter's settle");
  assert.equal(harness.page.lastNavigation(), engine.urls.at(-1));
});

test("a failed engine does not consume first use: the next call still types", async () => {
  const engine = new StubEngine({ id: "google", interaction: INTERACTION, walls: [WALL, null] });
  const harness = makeHarness({ engines: [engine] });
  const tool = makeTool(harness);

  const first = expectFailure(await tool.execute("call-1", { q: "walled" } as WebSearchInput, undefined, undefined));
  assert.equal(first.details.code, "E_WALL");
  assert.deepEqual(harness.page.typedTexts(), ["walled"]);

  const second = await tool.execute("call-2", { q: "second try" } as WebSearchInput, undefined, undefined);
  expectSuccess(second);
  assert.deepEqual(harness.page.typedTexts(), ["walled", "second try"], "still human-shaped after a failure");
});

test("humanize:\"always\" types every search, not just the first", async () => {
  const engine = new StubEngine({ id: "google", interaction: INTERACTION });
  const harness = makeHarness({
    engines: [engine],
    config: (config) => {
      config.humanize = "always";
    },
  });
  const tool = makeTool(harness);

  expectSuccess(await tool.execute("call-1", { q: "one" } as WebSearchInput, undefined, undefined));
  expectSuccess(await tool.execute("call-2", { q: "two" } as WebSearchInput, undefined, undefined));

  assert.deepEqual(harness.page.typedTexts(), ["one", "two"]);
  assert.equal(engine.settles, 0);
});

test("an abort during the humanized search renders E_CANCELLED with no extraction", async () => {
  const controller = new AbortController();
  const clock = new FakeClock();
  // Abort on the first evaluate (the search-box lookup): the next loop iteration
  // is where humanize notices the signal.
  const page = new FakePage({
    clock,
    text: MARKER_TEXT,
    evaluate: (expression) => {
      controller.abort();
      return expression.includes("querySelectorAll") ? 1 : false;
    },
  });
  const engine = new StubEngine({ id: "google", interaction: INTERACTION });
  const harness = makeHarness({ engines: [engine], clock, page });

  const result = expectFailure(await run(harness, { q: "abort human" }, controller.signal));

  assert.equal(result.details.code, "E_CANCELLED");
  assert.deepEqual(harness.page.typedTexts(), []);
  assert.equal(engine.extracts, 0);
});

test("engines without interaction always take the direct SERP path", async () => {
  const engine = new StubEngine({ id: "duckduckgo" });
  const harness = makeHarness({
    engines: [engine],
    config: (config) => {
      config.humanize = "always";
    },
  });

  expectSuccess(await run(harness, { q: "direct" }));

  assert.deepEqual(harness.page.typedTexts(), []);
  assert.equal(engine.settles, 1);
  assert.equal(harness.page.lastNavigation(), engine.urls.at(-1));
});

// ---------------------------------------------------------------------------
// Locales and query mapping
// ---------------------------------------------------------------------------

test("locale plumbing maps google hl/gl, ddg kl and yandex lr onto Query", async () => {
  const google = new StubEngine({ id: "google" });
  const ddg = new StubEngine({ id: "duckduckgo" });
  const yandex = new StubEngine({ id: "yandex" });
  const harness = makeHarness({
    engines: [google, ddg, yandex],
    config: (config) => {
      config.engines.google.lang = "ru";
      config.engines.google.gl = "ru";
      config.engines.duckduckgo.kl = "ru-ru";
      config.engines.yandex.lr = "213";
    },
  });

  expectSuccess(
    await run(harness, { q: "locales", engines: ["google", "duckduckgo", "yandex"], page: 2, freshness: "w", summary: false }),
  );

  const g = google.queries.at(-1)!;
  assert.equal(g.lang, "ru");
  assert.equal(g.region, "ru");
  assert.equal(g.page, 2);
  assert.equal(g.freshness, "w");
  assert.equal(g.summary, false);

  const d = ddg.queries.at(-1)!;
  assert.equal(d.region, "ru-ru");
  assert.equal(d.lang, undefined, "kl carries the language, not a separate hl");
  assert.equal(d.page, undefined, "page is google/yandex only");

  const y = yandex.queries.at(-1)!;
  assert.equal(y.region, "213");
  assert.equal(y.page, 2);
});

test("\"auto\" locale values become undefined, never a literal sentinel", async () => {
  const google = new StubEngine({ id: "google" });
  const harness = makeHarness({
    engines: [google],
    config: (config) => {
      config.engines.google.lang = "AUTO";
      config.engines.google.gl = " auto ";
    },
  });

  expectSuccess(await run(harness, { q: "auto locale" }));
  const query = google.queries.at(-1)!;
  assert.equal(query.lang, undefined);
  assert.equal(query.region, undefined);
});

test("duckduckgo page>1 is served as page 1 and flagged pageIgnored", async () => {
  const ddg = new StubEngine({ id: "duckduckgo" });
  const harness = makeHarness({ engines: [ddg] });

  const result = expectSuccess(await run(harness, { q: "paged", engines: "duckduckgo", page: 2 }));

  assert.equal(ddg.queries.at(-1)?.page, undefined, "the adapter cannot build a page-2 URL");
  assert.equal(result.details.pageIgnored, true);

  const google = new StubEngine({ id: "google" });
  const paginated = makeHarness({ engines: [google] });
  const honoured = expectSuccess(await run(paginated, { q: "paged", engines: "google", page: 2 }));
  assert.equal(google.queries.at(-1)?.page, 2);
  assert.equal(honoured.details.pageIgnored, undefined, "google pagination is real");
});

// ---------------------------------------------------------------------------
// Merge, caps, formats
// ---------------------------------------------------------------------------

test("mixed engines dedupe by URL, tag engines and stay under 2500 chars", async () => {
  const google = new StubEngine({
    id: "google",
    results: [
      { title: "Shared page", url: "https://shared.example.test/a?utm_source=google", snippet: "short" },
      { title: "Google only", url: "https://g.example.test/1", snippet: "g snippet" },
    ],
  });
  const ddg = new StubEngine({
    id: "duckduckgo",
    results: [
      {
        title: "Shared page (ddg)",
        url: "https://shared.example.test/a",
        snippet: "a considerably longer duckduckgo snippet that should win the merge",
      },
      { title: "DDG only", url: "https://d.example.test/1", snippet: "d snippet" },
    ],
  });
  const harness = makeHarness({ engines: [google, ddg] });

  const result = expectSuccess(await run(harness, { q: "merge", engines: ["google", "duckduckgo"] }));
  const text = textOf(result);

  assert.equal(text.split("https://shared.example.test/a").length - 1, 1, "URL appears once");
  assert.match(text, /\[google\] Shared page/);
  assert.match(text, /\[duckduckgo\] DDG only/);
  assert.match(text, /a considerably longer duckduckgo snippet/);
  assert.ok(text.length <= 2500, `${text.length} chars`);
  assert.deepEqual(result.details.engines, ["google", "duckduckgo"]);
  assert.ok(result.details.results <= 5);
});

test("format:\"json\" parses, respects n and the string caps; md stays ≤2500", async () => {
  const many: SerpItem[] = Array.from({ length: 12 }, (_, index) => ({
    title: `Result ${index} ${"x".repeat(120)}`,
    url: `https://example.test/result/${index}`,
    snippet: "s".repeat(300),
  }));
  const mdHarness = makeHarness({ engines: [new StubEngine({ id: "google", results: many })] });
  const md = expectSuccess(await run(mdHarness, { q: "many results" }));
  assert.ok(textOf(md).length <= 2500, `${textOf(md).length} chars`);

  const jsonHarness = makeHarness({ engines: [new StubEngine({ id: "google", results: many })] });
  const json = expectSuccess(await run(jsonHarness, { q: "many results", n: 5, format: "json" }));
  const text = textOf(json);
  const parsed = JSON.parse(text) as {
    engine: string;
    results: Array<{ snippet: string; url: string }>;
    chars: number;
    truncated: boolean;
  };

  assert.equal(parsed.engine, "google");
  assert.ok(parsed.results.length <= 5);
  assert.ok(text.length <= 2500, `json text ${text.length}`);
  assert.equal(typeof parsed.chars, "number");
  assert.ok(parsed.chars <= 2500, `json chars ${parsed.chars}`);
  assert.equal(typeof parsed.truncated, "boolean");
  for (const item of parsed.results) {
    assert.ok(item.snippet.length <= jsonHarness.config.search.snippetMaxChars);
    assert.match(item.url, /^https:\/\//);
  }
  assert.equal(json.details.chars, text.length);
});

test("format:\"json\" is trimmed to outputMaxChars while staying parseable", async () => {
  const five: SerpItem[] = Array.from({ length: 5 }, (_, index) => ({
    title: "t".repeat(200),
    url: `https://example.test/json-cap/${index}`,
    snippet: "s".repeat(140),
  }));
  const harness = makeHarness({
    engines: [new StubEngine({ id: "google", results: five })],
    config: (config) => {
      config.search.outputMaxChars = 1200;
    },
  });

  const result = expectSuccess(await run(harness, { q: "json cap", engines: "google", format: "json", n: 5 }));
  const text = textOf(result);
  const parsed = JSON.parse(text) as {
    chars: number;
    truncated: boolean;
    results: Array<{ title: string; url: string; snippet: string }>;
  };

  assert.ok(text.length <= 1200, `${text.length} chars`);
  assert.equal(result.details.chars, text.length);
  assert.equal(parsed.chars, text.length, "data.chars matches the returned JSON");
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.results.length < 5, "tail items were dropped, not a URL cut");
  for (const item of parsed.results) {
    assert.match(item.url, /^https:\/\/example\.test\/json-cap\//);
  }
});

test("json details report the fitted payload, not the pre-fit data", async () => {
  const results: SerpItem[] = Array.from({ length: 5 }, (_, index) => ({
    title: `"Quoted ${index}" ${'q "x" '.repeat(8)}`,
    url: `https://example.test/details/${index}`,
    snippet: `"${"quoted snippet ".repeat(12)}"`,
  }));
  const harness = makeHarness({
    engines: [
      new StubEngine({
        id: "google",
        results,
        ai: { text: '"short"', sources: [] },
      }),
    ],
    config: (config) => {
      config.search.outputMaxChars = 700;
    },
  });

  const result = expectSuccess(await run(harness, { q: "details", format: "json", n: 5 }));
  const text = textOf(result);
  const parsed = JSON.parse(text) as {
    results: unknown[];
    ai?: { text: string };
    truncated: boolean;
  };

  assert.ok(text.length <= 700, `${text.length} chars`);
  assert.ok(parsed.results.length < 5, "the fitter dropped at least one result");
  assert.equal(parsed.ai, undefined, "the AI was dropped rather than the whole list");
  // The old code read these from compact.data (5 results, ai:true) — a payload
  // that no longer existed after fitting.
  assert.equal(result.details.results, parsed.results.length);
  assert.equal(result.details.ai, Boolean(parsed.ai));
  assert.equal(result.details.truncated, true);
  assert.doesNotMatch(text, /"ai":/);
});

test("a quote-heavy AI is trimmed before any result is dropped (D13 order)", async () => {
  const aiText = '"'.repeat(1000);
  const results: SerpItem[] = Array.from({ length: 5 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example.test/ai-order/${index}`,
    snippet: "short",
  }));
  const harness = makeHarness({
    engines: [
      new StubEngine({
        id: "google",
        results,
        ai: { text: aiText, sources: ["a.example.test", "b.example.test", "c.example.test"] },
      }),
    ],
    config: (config) => {
      config.search.outputMaxChars = 1200;
    },
  });

  const result = expectSuccess(await run(harness, { q: "ai order", format: "json", n: 5 }));
  const text = textOf(result);
  const parsed = JSON.parse(text) as {
    results: unknown[];
    ai?: { text: string; sources: string[] };
  };

  assert.ok(text.length <= 1200, `${text.length} chars`);
  assert.equal(parsed.results.length, 5, "the result list survives a quote-heavy AI");
  assert.ok(parsed.ai !== undefined, "the AI is kept in reduced form, not dropped");
  assert.ok(parsed.ai.text.length < aiText.length, "prose was cut, not the results");
  assert.ok(parsed.ai.sources.length < 3, "sources are trimmed before the prose");
  assert.equal(result.details.results, parsed.results.length);
  assert.equal(result.details.ai, Boolean(parsed.ai));
});

test("a cap below the JSON envelope returns the documented floor, not invalid JSON", async () => {
  const harness = makeHarness({
    engines: [new StubEngine({ id: "google" })],
    config: (config) => {
      config.search.outputMaxChars = 40;
    },
  });

  const result = expectSuccess(await run(harness, { q: "tiny cap", format: "json" }));
  const text = textOf(result);
  const parsed = JSON.parse(text) as {
    engine: string;
    query: string;
    results: unknown[];
    pageCarried: boolean;
    chars: number;
    truncated: boolean;
  };

  // `outputMaxChars` allows 1, but valid JSON cannot shrink below the envelope;
  // the floor is documented and honest (`truncated: true`), not an E_CONFIG.
  assert.ok(40 < JSON_MIN_ENVELOPE, `floor ${JSON_MIN_ENVELOPE}`);
  assert.equal(text.length, JSON_MIN_ENVELOPE);
  assert.equal(parsed.engine, "");
  assert.equal(parsed.query, "");
  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.pageCarried, false);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.chars, text.length);
  assert.equal(result.details.results, 0);
  assert.equal(result.details.ai, false);
  assert.equal(result.details.chars, text.length);
  assert.equal(result.details.truncated, true);
});

test("quote-heavy json at the default cap fits and reports the fitted payload", async () => {
  const results: SerpItem[] = Array.from({ length: 5 }, (_, index) => ({
    title: `"Result ${index}" ${'quote "heavy" '.repeat(10)}`,
    url: `https://example.test/escaped/${index}`,
    snippet: '"'.repeat(140),
  }));
  const harness = makeHarness({ engines: [new StubEngine({ id: "google", results })] });

  const result = expectSuccess(await run(harness, { q: "escaped", format: "json", n: 5 }));
  const text = textOf(result);
  const parsed = JSON.parse(text) as {
    results: Array<{ snippet: string }>;
    ai?: unknown;
    truncated: boolean;
    chars: number;
  };

  assert.ok(text.length <= 2500, `${text.length} chars`);
  assert.equal(parsed.results.length, 5, "escaping alone never costs a result");
  // Every quote doubles in JSON, so the Markdown-sized render exceeds 2500 —
  // this only passes when the JSON fitter actually runs.
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.chars, text.length);
  assert.equal(result.details.results, parsed.results.length);
  assert.equal(result.details.ai, Boolean(parsed.ai));
  for (const item of parsed.results) assert.ok(item.snippet.length <= 100);
});

test("the Markdown header carries pageCarried and elapsed", async () => {
  const engine = new StubEngine({ id: "google", pageCarried: true });
  const harness = makeHarness({ engines: [engine] });

  const result = expectSuccess(await run(harness, { q: "header" }));
  const text = textOf(result);

  assert.equal(result.details.pageCarried, true);
  assert.match(text, / · 0\.0s/);
  assert.match(text, /page: more results available$/);
});

test("n is clamped to config.search.nMax", async () => {
  const engine = new StubEngine({
    id: "google",
    results: Array.from({ length: 6 }, (_, index) => ({
      title: `Clamped ${index}`,
      url: `https://example.test/clamped/${index}`,
      snippet: "",
    })),
  });
  const harness = makeHarness({
    engines: [engine],
    config: (config) => {
      config.search.nMax = 3;
    },
  });

  const result = expectSuccess(await run(harness, { q: "clamp", n: 9 }));

  assert.equal(engine.queries.at(-1)?.n, 3);
  assert.ok(result.details.results <= 3);
  assert.match(textOf(result), /\b3 results\b/);
});

// ---------------------------------------------------------------------------
// Failures, aborts, progress
// ---------------------------------------------------------------------------

test("E_PARSE saves an artifact and the rendered text names the path", async () => {
  const engine = new StubEngine({
    id: "google",
    extractError: fail("E_PARSE", "extract", { message: "selector canary failed (results=0)" }),
  });
  const harness = makeHarness({ engines: [engine] });

  const result = expectFailure(await run(harness, { q: "parse failure", engines: "google" }));
  const text = textOf(result);

  assert.equal(result.details.code, "E_PARSE");
  assert.equal(result.details.stage, "extract");
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0]?.code, "E_PARSE");
  assert.equal(harness.saved[0]?.page, harness.page);
  assert.equal(result.details.artifact, ARTIFACT_PATH(1));
  assert.match(text, /\[E_PARSE\]/);
  assert.match(text, /artifact: \/tmp\/opencode\/pi-chrome-search\/artifacts\/test-1/);
  assert.match(text, /hint: /);
});

test("an abort during the limiter renders E_CANCELLED and never navigates", async () => {
  const controller = new AbortController();
  const harness = makeHarness({
    engines: [new StubEngine({ id: "google" })],
    limiter: {
      async acquire(engine: EngineId): Promise<void> {
        controller.abort();
        throw fail("E_CANCELLED", "navigate", { engine, message: "aborted by the caller" });
      },
      stats(engine: EngineId): LimiterStats {
        return { engine, lastAt: null, today: 0, dailyCap: 100 };
      },
    },
  });

  const result = expectFailure(await run(harness, { q: "cancel limiter" }, controller.signal));

  assert.equal(result.details.code, "E_CANCELLED");
  assert.equal(harness.page.callCount("navigate"), 0);
  assert.equal(isFailure(result), true);
});

test("an abort during extract renders E_CANCELLED and writes no artifact", async () => {
  const controller = new AbortController();
  const base = new StubEngine({ id: "google" });
  const engine: Engine = {
    id: "google",
    buildUrl: (query) => base.buildUrl(query),
    settle: (page, signal) => base.settle(page, signal),
    detectWall: (page) => base.detectWall(page),
    extract: async () => {
      controller.abort("the user pressed stop");
      throw new Error("stopped mid-extract");
    },
    canaries: (page) => base.canaries(page),
  };
  const harness = makeHarness({ engines: [engine] });

  const result = expectFailure(await run(harness, { q: "abort extract", engines: "google" }, controller.signal));

  assert.equal(result.details.code, "E_CANCELLED");
  assert.equal(result.details.stage, "extract");
  assert.equal(harness.saved.length, 0, "an abort is not a page state");
  assert.equal(result.details.artifact, undefined);
});

test("an artifact-save failure does not mask the original error", async () => {
  const engine = new StubEngine({ id: "google", extractError: fail("E_PARSE", "extract") });
  const artifacts: Artifacts = {
    async save(): Promise<string> {
      throw new Error("EACCES: agent dir is read-only");
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
  const harness = makeHarness({ engines: [engine], artifacts });

  const result = expectFailure(await run(harness, { q: "artifact fail", engines: "google" }));
  const text = textOf(result);

  assert.equal(result.details.code, "E_PARSE");
  assert.equal(result.details.stage, "extract");
  assert.equal(result.details.artifact, undefined);
  assert.doesNotMatch(text, /artifact: /);
  assert.match(text, /\[E_PARSE\]/);
});

test("an abort during settle is normalized to E_CANCELLED", async () => {
  const engine = new StubEngine({
    id: "google",
    settleError: new DOMException("The operation was aborted.", "AbortError"),
  });
  const harness = makeHarness({ engines: [engine] });

  const result = expectFailure(await run(harness, { q: "cancel settle" }));

  assert.equal(result.details.code, "E_CANCELLED");
  assert.equal(engine.extracts, 0);
  assert.match(textOf(result), /\[E_CANCELLED\]/);
});

test("an already-aborted signal fails before the limiter", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = makeHarness({ engines: [new StubEngine({ id: "google" })] });

  const result = expectFailure(await run(harness, { q: "pre-aborted" }, controller.signal));

  assert.equal(result.details.code, "E_CANCELLED");
  assert.deepEqual(harness.limiterCalls, []);
  assert.equal(harness.page.callCount("navigate"), 0);
});

test("an abort with a custom reason still renders E_CANCELLED", async () => {
  const controller = new AbortController();
  const harness = makeHarness({
    engines: [new StubEngine({ id: "google", settleError: "stop now" })],
    limiter: {
      async acquire(): Promise<void> {
        controller.abort("the user pressed stop");
      },
      stats(engine: EngineId): LimiterStats {
        return { engine, lastAt: null, today: 0, dailyCap: 100 };
      },
    },
  });

  const result = expectFailure(await run(harness, { q: "custom abort" }, controller.signal));

  assert.equal(result.details.code, "E_CANCELLED");
  assert.match(textOf(result), /\[E_CANCELLED\]/);
});

test("onUpdate receives a short per-engine progress line", async () => {
  const harness = makeHarness({ engines: [new StubEngine({ id: "google" })] });
  const updates: unknown[] = [];

  expectSuccess(
    await run(harness, { q: "progress" }, undefined, (update: unknown) => {
      updates.push(update);
    }),
  );

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    content: [{ type: "text", text: "searching google…" }],
    details: {},
  });
});

test("a cache hit skips the progress callback because nothing is searched", async () => {
  const harness = makeHarness({ engines: [new StubEngine({ id: "google" })] });
  harness.cache.set(
    serpKey({ engine: "google", text: "quiet cache", n: 5, page: 1, summary: true }),
    { engine: "google", query: "quiet cache", results: [], pageCarried: false, timings: {} } satisfies RawSerp,
    harness.config.cache.serpTtlMs,
  );
  const updates: unknown[] = [];

  expectSuccess(await run(harness, { q: "quiet cache" }, undefined, (update: unknown) => updates.push(update)));

  assert.deepEqual(updates, []);
});


// ---------------------------------------------------------------------------
// Google /goto resolution (SPEC §6.1, extract/goto.ts)
// ---------------------------------------------------------------------------

const GOTO_ITEM: SerpItem = {
  title: "Wrapper result",
  url: "https://www.google.com/goto?url=AbC123opaque",
  snippet: "A result whose href is a /goto wrapper.",
};

test("/goto wrappers are resolved through the injected fetch and cached across runs", async () => {
  const engine = new StubEngine({ id: "google", results: [GOTO_ITEM] });
  const fetched: string[] = [];
  const harness = makeHarness({
    engines: [engine],
    fetchImpl: async (input: RequestInfo | URL): Promise<Response> => {
      fetched.push(String(input));
      return new Response(null, { status: 302, headers: { location: "https://example.test/real-target" } });
    },
  });

  const first = expectSuccess(await run(harness, { q: "wrapper query", n: 5 }));
  assert.equal(fetched.length, 1, "one wrapper must cost exactly one GET");
  assert.match(first.content.map((block) => block.text).join(""), /example\.test\/real-target/);

  // The resolved SERP is cached, so a repeated query never repeats the redirect.
  const second = expectSuccess(await run(harness, { q: "wrapper query", n: 5 }));
  assert.equal(fetched.length, 1, "a cache hit must not refetch the wrapper");
  assert.match(second.content.map((block) => block.text).join(""), /example\.test\/real-target/);
});

test("an unresolvable /goto wrapper is kept instead of failing the search", async () => {
  const engine = new StubEngine({ id: "google", results: [GOTO_ITEM] });
  const harness = makeHarness({
    engines: [engine],
    // A 200 with no Location is the observed live case: one navigation fallback
    // lands on the wrapper itself (a Google URL), which must not become a result.
    fetchImpl: async (): Promise<Response> => new Response(null, { status: 200 }),
  });

  const result = expectSuccess(await run(harness, { q: "wrapper query", n: 5 }));
  const text = result.content.map((block) => block.text).join("");
  assert.match(text, /google\.com\/goto/);
  assert.equal(harness.page.navigations().length, 2, "SERP navigation plus one fallback navigation");
});

test("a failing /goto fetch keeps the wrapper and never becomes a search failure", async () => {
  const engine = new StubEngine({ id: "google", results: [GOTO_ITEM] });
  const harness = makeHarness({
    engines: [engine],
    fetchImpl: async (): Promise<Response> => {
      throw new Error("network down");
    },
  });

  const result = expectSuccess(await run(harness, { q: "wrapper query", n: 5 }));
  assert.match(result.content.map((block) => block.text).join(""), /google\.com\/goto/);
});

// ---------------------------------------------------------------------------
// Settle failures on a wall page must become E_WALL, not E_TIMEOUT
// ---------------------------------------------------------------------------

const SETTLE_WALL: Wall = { kind: "captcha", url: "https://google.example.test/sorry", markers: ["captcha"] };

test("a settle timeout on a wall page is reported as E_WALL with an artifact", async () => {
  // Real wall pages (/sorry, a captcha, consent) do not carry the adapter's
  // result containers, so settle times out. Before this, the tool returned
  // E_TIMEOUT — which is not fallbackable — and the user saw a timeout on a
  // page that clearly asked for a human.
  const engine = new StubEngine({
    id: "google",
    settleError: fail("E_TIMEOUT", "settle", { engine: "google" }),
  });
  engine.wallOnDetect = SETTLE_WALL;
  const harness = makeHarness({ engines: [engine] });

  const failure = expectFailure(await run(harness, { q: "wall query", n: 5 }));
  assert.equal(failure.details.code, "E_WALL");
  assert.equal(failure.details.wall, "captcha");
  assert.equal(harness.saved.length, 1, "the wall snapshot must be written once");
});

test("a settle timeout without a wall stays E_TIMEOUT and writes no artifact", async () => {
  const engine = new StubEngine({
    id: "google",
    settleError: fail("E_TIMEOUT", "settle", { engine: "google" }),
  });
  const harness = makeHarness({ engines: [engine] });

  const failure = expectFailure(await run(harness, { q: "slow query", n: 5 }));
  assert.equal(failure.details.code, "E_TIMEOUT");
  assert.equal(harness.saved.length, 0);
});

// ---------------------------------------------------------------------------
// P8: AI wait wiring (summary:true/false, artifacts, timing, details)
// ---------------------------------------------------------------------------

function scriptedProbe(sequence: readonly AiProbe[]): { hooks: EngineAi; calls: () => number } {
  let index = 0;
  let calls = 0;
  return {
    calls: () => calls,
    hooks: {
      probe: async () => {
        calls += 1;
        const value = sequence[Math.min(index, sequence.length - 1)] ?? { state: "none", chars: 0 };
        index += 1;
        return value;
      },
    },
  };
}

test("summary:false never probes and reports aiState none with zero wait", async () => {
  const probe = scriptedProbe([{ state: "answer", chars: 900 }]);
  const harness = makeHarness({
    engines: [
      // No AI at all: a real adapter with `summary:false` skips extraction of
      // the block, so the stub models the same absence.
      new StubEngine({ id: "google", aiHooks: probe.hooks }),
    ],
  });

  const result = expectSuccess(await run(harness, { q: "x", engines: "google", summary: false }));
  assert.equal(probe.calls(), 0, "summary:false must not pay for the wait (V8.4)");
  assert.equal(result.details.aiWaitMs, 0);
  assert.equal(result.details.aiState, "none");
  assert.equal(result.details.ai, false);
});

test("summary:true waits for the answer and records aiWaitMs/aiChars", async () => {
  const answer = "A".repeat(400);
  const probe = scriptedProbe([
    { state: "lead", chars: 20 },
    { state: "answer", chars: 400 },
  ]);
  const harness = makeHarness({
    engines: [
      new StubEngine({
        id: "google",
        ai: { text: answer, sources: ["a.test"], state: "answer" },
        aiHooks: probe.hooks,
      }),
    ],
    config: (config) => {
      config.search.aiWaitMs = 6000;
    },
  });

  const result = expectSuccess(await run(harness, { q: "x", engines: "google" }));
  assert.ok(probe.calls() >= 1);
  assert.equal(result.details.aiState, "answer");
  assert.equal(result.details.ai, true);
  assert.ok(result.details.aiWaitMs > 0, "the clock advanced while waiting");
  assert.ok(result.details.aiChars > 0);
  assert.equal(harness.saved.length, 0, "a completed answer needs no artifact");
  assert.ok(textOf(result).includes("ai:yes"));
});

test("a lead that never becomes prose saves an artifact and never claims an answer", async () => {
  const probe = scriptedProbe([{ state: "lead", chars: 20 }]);
  const harness = makeHarness({
    engines: [
      new StubEngine({
        id: "google",
        ai: { text: "short lead", sources: [], state: "lead" },
        aiHooks: probe.hooks,
      }),
    ],
    config: (config) => {
      config.search.aiWaitMs = 400;
    },
  });

  const result = expectSuccess(await run(harness, { q: "x", engines: "google" }));
  assert.equal(result.details.aiState, "lead");
  assert.equal(result.details.ai, false);
  assert.equal(harness.saved.length, 1, "V8.5: the timed-out wait left proof behind");
  assert.equal(harness.saved[0]?.code, "AI_TIMEOUT");
  const extra = harness.saved[0]?.extra as { aiWait?: Record<string, unknown> } | undefined;
  assert.equal(extra?.aiWait?.state, "lead");
  assert.ok(textOf(result).includes("ai:lead"));
  assert.equal(textOf(result).includes("AI:"), false);
});

test("a page with no AI block exits after the none grace and still leaves an artifact", async () => {
  const probe = scriptedProbe([{ state: "none", chars: 0 }]);
  const harness = makeHarness({
    engines: [new StubEngine({ id: "duckduckgo", aiHooks: probe.hooks })],
    config: (config) => {
      config.search.aiWaitMs = 6000;
    },
  });

  const result = expectSuccess(await run(harness, { q: "x", engines: "duckduckgo" }));
  assert.equal(result.details.aiState, "none");
  assert.equal(result.details.ai, false);
  // V8.4: no AI block must not cost the whole 6 s budget.
  assert.ok(result.details.aiWaitMs <= 1500, `waited ${result.details.aiWaitMs} ms`);
  assert.equal(harness.saved[0]?.code, "AI_TIMEOUT");
});

test("aiWaitMs:0 probes once and returns (config disables the wait)", async () => {
  const probe = scriptedProbe([{ state: "lead", chars: 20 }]);
  const harness = makeHarness({
    engines: [
      new StubEngine({ id: "google", ai: { text: "short", sources: [], state: "lead" }, aiHooks: probe.hooks }),
    ],
    config: (config) => {
      config.search.aiWaitMs = 0;
    },
  });

  const result = expectSuccess(await run(harness, { q: "x", engines: "google" }));
  assert.equal(probe.calls(), 1);
  assert.equal(result.details.aiWaitMs, 0);
});

test("aiExpand is opt-in: the expand hook runs only when configured", async () => {
  let expanded = 0;
  const hooks: EngineAi = {
    probe: async () => ({ state: "answer", chars: 400 }),
    expand: async () => {
      expanded += 1;
      return true;
    },
  };
  const engine = (): StubEngine =>
    new StubEngine({ id: "google", ai: { text: "A".repeat(400), sources: [], state: "answer" }, aiHooks: hooks });

  const off = makeHarness({ engines: [engine()] });
  expectSuccess(await run(off, { q: "x", engines: "google" }));
  assert.equal(expanded, 0, "default config must not click anything");

  const on = makeHarness({
    engines: [engine()],
    config: (config) => {
      config.search.aiExpand = true;
    },
  });
  expectSuccess(await run(on, { q: "x", engines: "google" }));
  assert.equal(expanded, 1);
});

// ---------------------------------------------------------------------------
// P9-D — a merged search splits n and reports every engine
// ---------------------------------------------------------------------------

test("a merged search splits n across its engines instead of letting one fill every slot", async () => {
  const google = new StubEngine({
    id: "google",
    results: [
      { title: "G1", url: "https://g.example.test/1", snippet: "" },
      { title: "G2", url: "https://g.example.test/2", snippet: "" },
      { title: "G3", url: "https://g.example.test/3", snippet: "" },
    ],
  });
  const ddg = new StubEngine({
    id: "duckduckgo",
    results: [
      { title: "D1", url: "https://d.example.test/1", snippet: "" },
      { title: "D2", url: "https://d.example.test/2", snippet: "" },
      { title: "D3", url: "https://d.example.test/3", snippet: "" },
    ],
  });
  const harness = makeHarness({ engines: [google, ddg] });

  const result = expectSuccess(await run(harness, { q: "split", n: 3, engines: ["google", "duckduckgo"] }));
  assert.equal(google.queries[0]?.n, 2, "ceil(3 / 2) per engine");
  assert.equal(ddg.queries[0]?.n, 2);
  assert.match(textOf(result), /google:\d+ duckduckgo:\d+/, "the header accounts for both engines");
  assert.deepEqual(Object.keys(result.details.perEngine ?? {}).sort(), ["duckduckgo", "google"]);
});

test("a merged search names the engine that failed and the code it failed with", async () => {
  const google = new StubEngine({
    id: "google",
    results: [{ title: "G1", url: "https://g.example.test/1", snippet: "" }],
  });
  const yandex = new StubEngine({ id: "yandex", extractError: fail("E_WALL", "navigate") });
  const harness = makeHarness({ engines: [google, yandex] });

  const result = expectSuccess(await run(harness, { q: "wall", n: 2, engines: ["google", "yandex"] }));
  assert.equal(result.details.failedEngines?.yandex, "E_WALL");
  assert.equal(result.details.perEngine?.yandex, 0);
  assert.match(textOf(result), /yandex:0\(E_WALL\)/);
});
