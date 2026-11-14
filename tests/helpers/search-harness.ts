/**
 * Offline harness for the `web_search` contract tests (S4, S7, S8).
 *
 * It builds the real tool over stub adapters: no socket, no Chrome, no DNS. The
 * stub records every `Query` it receives, which is how the support-matrix test
 * proves what the engine was actually asked for instead of trusting the URL
 * builder alone.
 */

import type { CdpPage } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import type {
  Engine,
  EngineAi,
  EngineId,
  EngineInteraction,
  Query,
  RawSerp,
  SerpItem,
} from "../../src/engines/types.ts";
import { createCache, type CacheWithStats } from "../../src/runtime/cache.ts";
import type { ArtifactInput, Artifacts, Limiter, Logger } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import { FakeClock, FakePage } from "./fake-cdp.ts";

export interface EngineStub extends Engine {
  readonly queries: Query[];
  /**
   * Replace the default extraction. The hook receives the recorded query, so a
   * test can answer differently for page 1 and page 2.
   */
  extractImpl?: (query: Query, page: CdpPage) => Promise<RawSerp>;
  settleImpl?: (page: CdpPage) => Promise<void>;
  expandCalls: number;
}

export interface EngineStubOptions {
  results?: SerpItem[];
  ai?: EngineAi;
  interaction?: EngineInteraction;
}

function defaultResults(id: EngineId): SerpItem[] {
  return [
    { title: `${id} result 1`, url: `https://${id}.example.test/1`, snippet: `${id} snippet 1` },
    { title: `${id} result 2`, url: `https://${id}.example.test/2`, snippet: `${id} snippet 2` },
    { title: `${id} result 3`, url: `https://${id}.example.test/3`, snippet: `${id} snippet 3` },
  ];
}

export function createEngineStub(id: EngineId, options: EngineStubOptions = {}): EngineStub {
  const queries: Query[] = [];
  const ai: EngineAi | undefined =
    options.ai === undefined
      ? undefined
      : {
          probe: (page) => options.ai!.probe(page),
          ...(options.ai.expand === undefined
            ? {}
            : {
                expand: async (page, expandOptions) => {
                  stub.expandCalls += 1;
                  return await options.ai!.expand!(page, expandOptions);
                },
              }),
        };
  const stub: EngineStub = {
    id,
    ...(options.interaction === undefined ? {} : { interaction: options.interaction }),
    ...(ai === undefined ? {} : { ai }),
    queries,
    expandCalls: 0,
    buildUrl: (query: Query) => {
      const page = query.page === undefined ? "" : `&p=${query.page}`;
      return `https://${id}.example.test/search?q=${encodeURIComponent(query.text)}${page}`;
    },
    async settle(page: CdpPage) {
      if (stub.settleImpl !== undefined) await stub.settleImpl(page);
    },
    async detectWall() {
      return null;
    },
    async extract(page: CdpPage, query: Query): Promise<RawSerp> {
      stub.queries.push(structuredClone(query));
      if (stub.extractImpl !== undefined) return await stub.extractImpl(query, page);
      return {
        engine: id,
        query: query.text,
        results: (options.results ?? defaultResults(id)).slice(0, query.n),
        pageCarried: false,
        timings: {},
      };
    },
    async canaries() {
      return {};
    },
  };
  return stub;
}

export interface HarnessOptions {
  engines: EngineStub[];
  /** Mutate the cloned defaults before the tool sees them. */
  configure?: (config: Config) => void;
  cache?: CacheWithStats;
}

export interface Harness {
  deps: ToolDeps;
  clock: FakeClock;
  config: Config;
  pages: Map<EngineId, FakePage>;
  artifacts: ArtifactInput[];
}

export function createHarness(options: HarnessOptions): Harness {
  const clock = new FakeClock();
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.window.focus = "never";
  config.humanize = "auto";
  config.cache.serpTtlMs = 0;
  for (const id of ["google", "duckduckgo", "yandex"] as const) config.pacing[id] = [0, 0];
  options.configure?.(config);

  const pages = new Map<EngineId, FakePage>();
  const artifacts: ArtifactInput[] = [];
  const cache = options.cache ?? createCache({ maxEntries: 50, clock });
  const engineMap: Partial<Record<EngineId, Engine>> = {};
  for (const engine of options.engines) engineMap[engine.id] = engine;

  const limiter: Limiter = {
    async acquire() {},
    stats: (engine) => ({ engine, lastAt: null, today: 0 }),
  };
  const log: Logger = { async write() {}, path: () => "/dev/null" };
  const artifactWriter: Artifacts = {
    async save(input) {
      artifacts.push(input);
      return `/tmp/artifact-${artifacts.length}`;
    },
    async prune() {
      return { removed: 0, kept: 0, bytes: 0 };
    },
    async size() {
      return 0;
    },
    root: () => "/tmp/artifact",
  };

  const deps: ToolDeps = {
    config,
    engines: createEngineRegistry(engineMap, config),
    cdp: {
      connect: async () => {
        throw new Error("connect is not part of this offline test");
      },
      acquirePage: async (key: string) => {
        const id = key as EngineId;
        let page = pages.get(id);
        if (page === undefined) {
          page = new FakePage({ url: `https://${id}.example.test/`, text: "results", clock });
          pages.set(id, page);
        }
        return page;
      },
      releaseAll: async () => {},
      isConnected: () => true,
      endpoint: () => null,
    },
    cache,
    limiter,
    artifacts: artifactWriter,
    log,
    clock,
    fetchImpl: (async () => new Response(null, { status: 403 })) as typeof fetch,
  };

  return { deps, clock, config, pages, artifacts };
}

/** One text copy of a tool result, for `assert.match` on what the model sees. */
export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}
