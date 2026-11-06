/**
 * V0.5: a stub adapter + a stub tool must compile and run against the frozen
 * contracts, using only a fake CdpPage. This is the "can four agents code in
 * parallel against these interfaces" proof.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CdpPage } from "../../src/cdp/types.ts";
import type { Config } from "../../src/config.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import type { Engine, Query, RawSerp, Wall } from "../../src/engines/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import type { Artifacts, Cache, Clock, Limiter, LimiterStats, Logger } from "../../src/runtime/types.ts";

const PAGE_TEXT = "stub serp";

class FakePage implements CdpPage {
  #url = "about:blank";
  #text = PAGE_TEXT;

  url(): string {
    return this.#url;
  }
  async currentUrl(): Promise<string> {
    return this.#url;
  }
  async title(): Promise<string> {
    return "fake";
  }
  async navigate(url: string): Promise<void> {
    this.#url = url;
  }
  async evaluate<T>(_expression: string): Promise<T> {
    return { n: 3 } as T;
  }
  async innerText(): Promise<string> {
    return this.#text;
  }
  async html(): Promise<string> {
    return `<html><body>${this.#text}</body></html>`;
  }
  async click(): Promise<void> {}
  async typeText(): Promise<void> {}
  async press(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.from("");
  }
  async cookiesFor(): Promise<{ name: string; value: string; domain: string }[]> {
    return [];
  }
  async bringToFront(): Promise<void> {}
}

class StubEngine implements Engine {
  readonly id = "google" as const;

  buildUrl(q: Query): string {
    return `https://www.google.com/search?q=${encodeURIComponent(q.text)}&hl=ru`;
  }
  async settle(): Promise<void> {}
  async detectWall(): Promise<Wall | null> {
    return null;
  }
  async extract(page: CdpPage, q: Query): Promise<RawSerp> {
    const text = await page.innerText();
    return {
      engine: this.id,
      query: q.text,
      results: [{ title: text, url: page.url(), snippet: text }],
      pageCarried: false,
      timings: {},
    };
  }
  async canaries(): Promise<Record<string, number>> {
    return { h3: 1 };
  }
}

class MemoryCache implements Cache {
  readonly #map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.#map.get(key) as T | undefined;
  }
  set<T>(key: string, value: T): void {
    this.#map.set(key, value);
  }
  size(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
}

const logger: Logger = {
  async write(): Promise<void> {},
  path(): string {
    return "/dev/null";
  },
};

const artifacts: Artifacts = {
  async save(): Promise<string> {
    return "/tmp/stub-artifact";
  },
  async prune() {
    return { removed: 0, kept: 0, bytes: 0 };
  },
  async size(): Promise<number> {
    return 0;
  },
  root(): string {
    return "/tmp/stub-artifacts";
  },
};

const limiter: Limiter = {
  async acquire(): Promise<void> {},
  stats(_engine): LimiterStats {
    return { engine: "google", lastAt: null, today: 0, dailyCap: 300 };
  },
};

const clock: Clock = {
  now: () => 0,
  async sleep(): Promise<void> {},
};

async function runStubTool(deps: ToolDeps, query: Query): Promise<string> {
  const order = deps.engines.select("auto");
  const engineId = order[0];
  assert.ok(engineId);
  const engine = deps.engines.get(engineId);
  await deps.limiter.acquire(engine.id);
  const url = engine.buildUrl(query);
  const page = await deps.cdp.acquirePage(engine.id);
  await page.navigate(url);
  const wall = await engine.detectWall(page);
  if (wall) throw new Error(`unexpected wall ${wall.kind}`);
  const serp = await engine.extract(page, query);
  deps.cache.set(`serp:${engine.id}:${query.text}`, serp, deps.config.cache.serpTtlMs);
  return `${serp.engine} · ${serp.results.length} results · ai:${serp.ai ? "yes" : "no"}`;
}

test("stub adapter and stub tool satisfy the frozen contracts", async () => {
  const config: Config = parseStubConfig();
  const page = new FakePage();
  const deps: ToolDeps = {
    config,
    engines: createEngineRegistry({ google: new StubEngine() }, config),
    cdp: {
      async connect() {
        return {
          endpoint: { port: 9222, wsUrl: "ws://127.0.0.1:9222/devtools/browser/x", source: "devtools-active-port" },
          browser: { product: "Chrome/0", protocolVersion: "1.3", userAgent: "stub", revision: "r", jsVersion: "0" },
          webdriver: false,
        };
      },
      async acquirePage() {
        return page;
      },
      async releaseAll() {},
      isConnected: () => true,
      endpoint: () => null,
    },
    cache: new MemoryCache(),
    limiter,
    artifacts,
    log: logger,
    clock,
  };

  const out = await runStubTool(deps, { text: "трансформер", n: 5, summary: true });
  assert.equal(out, "google · 1 results · ai:no");
  assert.equal(deps.cache.size(), 1);
  assert.deepEqual(deps.engines.enabled(), ["google"]);
});

function parseStubConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}
