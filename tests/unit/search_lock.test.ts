/**
 * One writer per engine tab.
 *
 * The bug this suite exists for: pi runs the tool calls of one turn
 * concurrently, `web_search` acquired the engine tab from the limiter without a
 * page lock, and two calls typed their queries into the same search box at the
 * same time — `CloudCflloaurdef lDaurrea Dbulrea…` landed in the box and was
 * submitted.
 *
 * Two independent guards are asserted here, both offline:
 *  1. the tool layer takes the same FIFO page lock `web_read` uses, so the
 *     second concurrent search waits, sees `firstUse` already consumed and takes
 *     the direct SERP path instead of typing a duplicate query;
 *  2. `humanSearch` reads the box value back after typing and never presses
 *     Enter when it does not hold the query (`box-mismatch` → SERP fallback),
 *     which turns any remaining second writer into an honest fallback instead of
 *     a garbage SERP.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { humanSearch } from "../../src/cdp/humanize.ts";
import type { CdpPage } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import type { Engine, RawSerp } from "../../src/engines/types.ts";
import type { Cache, Limiter, Logger, Artifacts } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { FakeClock, FakePage } from "../helpers/fake-cdp.ts";

const HOME_URL = "https://www.google.example.test/";
const SERP_URL = "https://www.google.example.test/search?q=cloudflare";

/** A google-shaped adapter: one box, a text marker, one organic result. */
function googleStub(): Engine {
  return {
    id: "google",
    interaction: {
      homeUrl: HOME_URL,
      boxSelectors: ['input[name="q"]'],
      marker: "results",
    },
    buildUrl: (query) => `${SERP_URL}&n=${query.n}`,
    async settle() {},
    async detectWall() {
      return null;
    },
    async extract(): Promise<RawSerp> {
      return {
        engine: "google",
        query: "cloudflare",
        results: [{ title: "Cloudflare", url: "https://example.com/cloudflare", snippet: "edge" }],
        pageCarried: false,
        timings: {},
      };
    },
    async canaries() {
      return {};
    },
  };
}

/**
 * A page whose box value is whatever was typed last, so the humanize check sees
 * a consistent box. `evaluate` answers the three expressions the typed path
 * uses: box existence, result-count (unused here) and the live box value.
 */
function boxPage(clock: FakeClock): FakePage {
  let page: FakePage | undefined;
  page = new FakePage({
    url: HOME_URL,
    text: "results",
    clock,
    evaluate: (expression) => {
      if (expression.includes("querySelectorAll")) return 1;
      if (expression.includes("el.value")) return page?.typedTexts().at(-1) ?? "";
      return true;
    },
  });
  return page;
}

function memoryCache(): Cache {
  const rows = new Map<string, unknown>();
  return {
    get: <T>(key: string) => rows.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      rows.set(key, value);
    },
    size: () => rows.size,
    clear: () => rows.clear(),
  };
}

function testConfig(): Config {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.humanize = "always";
  config.window.focus = "never";
  config.cache.serpTtlMs = 0;
  config.engines.google = { ...config.engines.google, enabled: true };
  config.engines.duckduckgo = { ...config.engines.duckduckgo, enabled: false };
  config.engines.yandex = { ...config.engines.yandex, enabled: false };
  for (const id of ["google", "duckduckgo", "yandex"] as const) config.pacing[id] = [0, 0];
  return config;
}

/** Deps over one fake tab: no socket, no timers, no filesystem. */
function depsFor(page: CdpPage, config: Config, clock: FakeClock): ToolDeps {
  const limiter: Limiter = {
    async acquire() {},
    stats: (engine) => ({ engine, lastAt: null, today: 0 }),
  };
  const log: Logger = { async write() {}, path: () => "/dev/null" };
  const artifacts: Artifacts = {
    save: async () => "/tmp/artifact",
    prune: async () => ({ removed: 0, kept: 0, bytes: 0 }),
    size: async () => 0,
    root: () => "/tmp/artifact",
  };
  return {
    config,
    engines: createEngineRegistry({ google: googleStub() }, config),
    cdp: {
      connect: async () => {
        throw new Error("connect is not part of this offline test");
      },
      acquirePage: async () => page,
      releaseAll: async () => {},
      isConnected: () => true,
      endpoint: () => null,
    },
    cache: memoryCache(),
    limiter,
    artifacts,
    log,
    clock,
  };
}

test("two concurrent searches on one engine never type into the box together", async () => {
  const clock = new FakeClock();
  const page = boxPage(clock);
  const config = testConfig();
  // `auto` types only the first search of the session; the second one is the
  // path that used to race.
  config.humanize = "auto";
  // One deps object, like production: the page lock is keyed by connector identity.
  const deps = depsFor(page, config, clock);
  const tool = createWebSearchTool(() => deps);

  const [first, second] = await Promise.all([
    tool.execute("call-1", { q: "cloudflare durable objects", engines: "google" }, undefined, undefined),
    tool.execute("call-2", { q: "cloudflare r2 pricing", engines: "google" }, undefined, undefined),
  ]);

  assert.equal("isError" in first, false, "the first search must succeed");
  assert.equal("isError" in second, false, "the second search must succeed");
  assert.equal(page.typedTexts().length, 1, "only the first search may type: the second takes the SERP path");
  assert.deepEqual(page.presses().filter((key) => key === "Enter"), ["Enter"], "exactly one query was submitted");
  assert.equal(
    page.navigations().some((url) => url.startsWith(SERP_URL)),
    true,
    "the second search reached the SERP URL",
  );
});

test("humanize:always still submits one query at a time", async () => {
  const clock = new FakeClock();
  const page = boxPage(clock);
  const config = testConfig();
  // One deps object, like production: the page lock is keyed by connector identity.
  const deps = depsFor(page, config, clock);
  const tool = createWebSearchTool(() => deps);

  await Promise.all([
    tool.execute("call-1", { q: "cloudflare durable objects", engines: "google" }, undefined, undefined),
    tool.execute("call-2", { q: "cloudflare r2 pricing", engines: "google" }, undefined, undefined),
  ]);

  // Both searches type in this mode (a person refining a query), but never at
  // once: every `typeText` is finished by its own Enter before the next starts.
  const submitted = page
    .calls()
    .filter((call) => call.kind === "typeText" || (call.kind === "press" && call.key === "Enter"))
    .map((call) => (call.kind === "typeText" ? "typeText" : "Enter"));
  assert.deepEqual(submitted, ["typeText", "Enter", "typeText", "Enter"]);
  assert.equal(page.typedTexts().length, 2);
});

test("humanSearch does not submit a box that holds something else", async () => {
  const clock = new FakeClock();
  const page = new FakePage({
    url: HOME_URL,
    text: "results",
    clock,
    // Another writer won the box: the value is interleaved garbage, not our query.
    evaluate: (expression) => (expression.includes("el.value") ? "CloudCflloaurdef gDaurrea" : true),
  });

  const result = await humanSearch({
    page,
    query: "cloudflare durable objects",
    homeUrl: HOME_URL,
    serpUrl: SERP_URL,
    boxSelectors: ['input[name="q"]'],
    marker: "results",
    engine: "google",
    mode: "typing",
    firstInSession: true,
    focus: "never",
    clock,
  });

  assert.equal(result.typed, true, "the query really was typed");
  assert.equal(result.fellBackToSerp, true);
  assert.equal(result.fellBackReason, "box-mismatch");
  assert.deepEqual(page.presses().filter((key) => key === "Enter"), [], "garbage is never submitted");
  assert.equal(page.lastNavigation(), SERP_URL, "the honest SERP URL answers instead");
});

test("humanSearch submits the box when it holds exactly the query", async () => {
  const clock = new FakeClock();
  const query = "cloudflare durable objects";
  let page: FakePage | undefined;
  page = new FakePage({
    url: HOME_URL,
    text: "results",
    clock,
    evaluate: (expression) =>
      expression.includes("el.value") ? (page?.typedTexts().at(-1) ?? "") : true,
  });

  const result = await humanSearch({
    page,
    query,
    homeUrl: HOME_URL,
    serpUrl: SERP_URL,
    boxSelectors: ['input[name="q"]'],
    marker: "results",
    engine: "google",
    mode: "typing",
    firstInSession: true,
    focus: "never",
    clock,
  });

  assert.equal(result.typed, true);
  assert.equal(result.fellBackToSerp, false);
  assert.deepEqual(page.presses().filter((key) => key === "Enter"), ["Enter"], "the verified query is submitted");
});
