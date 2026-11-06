/**
 * Opt-in live gate for P9 (read integrity).
 *
 * `PI_CHROME_LIVE=1 npm run test:live` — exactly two reads, concurrently, once.
 * The point is the field regression: four parallel reads used to return the
 * *last* navigation's body. A repeat is not retried; if the pages move, the
 * gate reports and the user re-runs later.
 *
 * Without the env var the test skips, so `npm test` never touches Chrome.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConnector } from "../../src/cdp/browser.ts";
import { pageLockFor } from "../../src/cdp/page-lock.ts";
import { discoverEndpoint } from "../../src/cdp/discovery.ts";
import { loadConfig } from "../../src/config.ts";
import { createDefaultRegistry } from "../../src/engines/index.ts";
import { createArtifacts } from "../../src/runtime/artifacts.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { createSystemClock } from "../../src/runtime/clock.ts";
import { createLimiter } from "../../src/runtime/limiter.ts";
import { createLogger } from "../../src/runtime/log.ts";
import { createWebReadTool, type WebReadResult } from "../../src/tools/web_read.ts";

const LIVE = process.env.PI_CHROME_LIVE === "1";

/** Two stable, public, text-only pages that must never share a body. */
const URLS = ["https://example.com/", "https://www.iana.org/help/example-domains"] as const;

function textOf(result: WebReadResult): string {
  return result.content.map((block) => block.text).join("\n");
}

test(
  "live P9: two concurrent reads return their own bodies and leave no lock behind",
  { skip: LIVE ? false : "set PI_CHROME_LIVE=1 to run two live reads" },
  async () => {
    const env = process.env;
    const config = loadConfig({ env });
    const stateDir = join(env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "web-search");
    const clock = createSystemClock();
    const log = createLogger({ path: join(stateDir, "decisions.jsonl"), clock });
    const connector = createConnector({
      config,
      clock,
      log,
      discover: () =>
        discoverEndpoint({ ports: config.cdp.ports, ws: config.cdp.ws, timeoutMs: config.cdp.connectTimeoutMs }),
    });
    const deps = {
      config,
      engines: createDefaultRegistry(config),
      cdp: connector,
      cache: createCache({ maxEntries: config.cache.maxEntries, clock }),
      limiter: createLimiter({ config, clock, statePath: join(stateDir, "state.json") }),
      artifacts: createArtifacts({ config, clock }),
      log,
      clock,
    };
    const tool = createWebReadTool(() => deps);

    const started = Date.now();
    try {
      const results = await Promise.all(URLS.map((url) => tool.execute("live-p9", { url }, undefined, undefined)));
      const elapsed = Date.now() - started;

      for (const [index, result] of results.entries()) {
        const failure = "isError" in result && result.isError === true;
        if (failure) {
          const details = result.details as { code?: string };
          if (details.code === "E_CDP_UNAVAILABLE" || details.code === "E_BUSY" || details.code === "E_WALL") return;
          assert.fail(`read ${URLS[index]} failed with ${details.code ?? "unknown"}`);
        }
      }

      const [first, second] = results as [
        Extract<WebReadResult, { details: { finalUrl: string } }>,
        Extract<WebReadResult, { details: { finalUrl: string } }>,
      ];
      const firstText = textOf(first);
      const secondText = textOf(second);

      console.log(
        `live read: ${URLS[0]} title="${first.details.title}" ${first.details.chars} chars | ` +
          `${URLS[1]} title="${second.details.title}" ${second.details.chars} chars | ${elapsed}ms total`,
      );

      assert.notEqual(firstText, secondText, "two concurrent reads must not return the same body");
      assert.match(first.details.finalUrl, /example\.com/);
      assert.match(second.details.finalUrl, /iana\.org/);
      assert.ok(firstText.length > 0 && secondText.length > 0);
      assert.notEqual(first.details.title, second.details.title, "titles must differ too");
      assert.equal(pageLockFor(deps.cdp).pending(), 0, "no read lock may survive the batch");
    } finally {
      await connector.releaseAll().catch(() => undefined);
    }
  },
);
