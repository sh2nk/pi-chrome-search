/**
 * Offline harness for the `web_read` contract tests (S5, S8.1).
 *
 * It builds the real tool over a `FakePage` and a fake connector: no socket, no
 * Chrome, no DNS. The connector records slot acquisition/release, and an
 * injected `fetchBytes` returns committed PDF fixtures, so the PDF ladder and
 * the SSRF re-check run end to end without a browser.
 */

import type { CdpPage, FetchedBytes, FetchBytesOptions } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import { createCache } from "../../src/runtime/cache.ts";
import type { ArtifactInput, Artifacts, Limiter, Logger } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import { FakeClock, FakePage } from "./fake-cdp.ts";

export interface ReadHarnessOptions {
  configure?: (config: Config) => void;
  /** Pre-built pages by slot key; a missing key creates a blank `FakePage`. */
  pages?: Map<string, FakePage>;
  fetchBytes?: (url: string, options?: FetchBytesOptions) => Promise<FetchedBytes>;
}

export interface ReadHarness {
  deps: ToolDeps;
  clock: FakeClock;
  config: Config;
  artifacts: ArtifactInput[];
  acquired: string[];
  released: string[];
  pages: Map<string, FakePage>;
  /** Get or create the page for one read slot. */
  page(key: string): FakePage;
}

export function createReadHarness(options: ReadHarnessOptions = {}): ReadHarness {
  const clock = new FakeClock();
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.window.focus = "never";
  config.window.follow = "never";
  config.window.panel = false;
  config.artifacts.enabled = true;
  options.configure?.(config);

  const pages = options.pages ?? new Map<string, FakePage>();
  const acquired: string[] = [];
  const released: string[] = [];
  const artifacts: ArtifactInput[] = [];

  function page(key: string): FakePage {
    let existing = pages.get(key);
    if (existing === undefined) {
      existing = new FakePage({ clock });
      pages.set(key, existing);
    }
    return existing;
  }

  const limiter: Limiter = {
    async acquire() {},
    stats: (engine) => ({ engine, lastAt: null, today: 0 }),
  };
  const log: Logger = { async write() {}, path: () => "/dev/null" };
  const writer: Artifacts = {
    async save(input) {
      artifacts.push(input);
      return `/tmp/read-artifact-${artifacts.length}`;
    },
    async prune() {
      return { removed: 0, kept: 0, bytes: 0 };
    },
    async size() {
      return 0;
    },
    root: () => "/tmp/read-artifact",
  };

  const cdp: ToolDeps["cdp"] = {
    connect: async () => {
      throw new Error("connect is not part of this offline test");
    },
    acquirePage: async (key: string): Promise<CdpPage> => {
      acquired.push(key);
      return page(key);
    },
    releasePage: async (key: string): Promise<void> => {
      released.push(key);
      pages.delete(key);
    },
    releaseAll: async () => {},
    isConnected: () => true,
    endpoint: () => null,
    ...(options.fetchBytes === undefined ? {} : { fetchBytes: options.fetchBytes }),
  };

  const deps: ToolDeps = {
    config,
    engines: createEngineRegistry({}, config),
    cdp,
    cache: createCache({ maxEntries: 10, clock }),
    limiter,
    artifacts: writer,
    log,
    clock,
  };

  return { deps, clock, config, artifacts, acquired, released, pages, page };
}
