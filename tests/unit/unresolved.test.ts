/**
 * S3.5 / S7.4: an unresolved Google `/goto` wrapper is not a destination.
 *
 * The wrapper is kept (it still works when clicked in the browser), but the
 * emitted result is marked so the model can tell a verified link from one that
 * may still redirect. This test drives the real `web_search` path with a fake
 * tab and a failing resolver: offline, one engine, no socket.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CdpPage } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import type { Engine, RawSerp } from "../../src/engines/types.ts";
import { compactSerps } from "../../src/extract/compact.ts";
import type { Artifacts, Cache, Limiter, Logger } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { FakeClock, FakePage } from "../helpers/fake-cdp.ts";

const HOME_URL = "https://www.google.example.test/";
const WRAPPER = "https://www.google.com/goto?url=opaque-token";

function googleStub(): Engine {
  return {
    id: "google",
    interaction: {
      homeUrl: HOME_URL,
      boxSelectors: ['input[name="q"]'],
      marker: "results",
    },
    buildUrl: () => "https://www.google.example.test/search?q=resolver",
    async settle() {},
    async detectWall() {
      return null;
    },
    async extract(): Promise<RawSerp> {
      return {
        engine: "google",
        query: "resolver",
        results: [{ title: "Example", url: WRAPPER, snippet: "a result behind a wrapper" }],
        pageCarried: false,
        timings: {},
      };
    },
    async canaries() {
      return {};
    },
  };
}

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
  config.humanize = "auto";
  config.window.focus = "never";
  config.cache.serpTtlMs = 0;
  for (const id of ["google", "duckduckgo", "yandex"] as const) config.pacing[id] = [0, 0];
  config.engines.google = { ...config.engines.google, enabled: true };
  config.engines.duckduckgo = { ...config.engines.duckduckgo, enabled: false };
  config.engines.yandex = { ...config.engines.yandex, enabled: false };
  return config;
}

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
    fetchImpl: (async () => new Response(null, { status: 403 })) as typeof fetch,
  };
}

test("an unresolved /goto wrapper stays in the result and is marked", async () => {
  const clock = new FakeClock();
  const config = testConfig();
  const tool = createWebSearchTool(() => depsFor(boxPage(clock), config, clock));

  const result = await tool.execute("call-1", { q: "resolver", engines: "google", summary: false }, undefined, undefined);
  assert.equal("isError" in result, false, "an opaque wrapper must not fail the search");
  if ("isError" in result) return;

  const text = result.content.map((block) => block.text).join("");
  assert.match(text, /unresolved/, "the emitted line must say the link is unresolved");
  assert.match(text, /goto\?url=opaque-token/, "the wrapper stays the link (S7.4)");
  assert.equal(result.details.unresolved, 1, "details counts the emitted unresolved result");
});

test("the JSON view carries the marker per result, not just in the prose", () => {
  const serp: RawSerp = {
    engine: "google",
    query: "resolver",
    results: [{ title: "Example", url: WRAPPER, snippet: "wrapper", unresolved: true }],
    pageCarried: false,
    timings: {},
  };
  const compact = compactSerps([serp], {
    n: 1,
    summaryMaxChars: 1200,
    snippetMaxChars: 140,
    outputMaxChars: 2500,
  });

  const results = compact.data.results;
  assert.ok(Array.isArray(results));
  assert.equal((results[0] as { unresolved?: boolean }).unresolved, true);
});
