#!/usr/bin/env node
/**
 * 08 — one real `web_search` run per engine through the extension's own stack.
 *
 * This is the P3 live gate harness (V3.5–V3.7): it builds the same runtime the
 * extension builds (`src/index.ts`), calls the registered `web_search` tool with
 * a single query and prints an evidence line the orchestrator can paste into
 * `evidence/P3-live.md`. No retries, no loop: one engine, one query, one run.
 *
 *   PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker \
 *     node research/probes/08-live-search.mjs --engine google --query "…" --n 5
 *
 * The broker (07-cdp-broker.mjs) is optional but strongly preferred: it keeps a
 * single Chrome connection, so the user Allows remote debugging once instead of
 * once per gate.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("../../src/", import.meta.url).pathname;
const load = (rel) => import(`file://${root}${rel}`);

const { loadConfig } = await load("config.ts");
const { discoverEndpoint } = await load("cdp/discovery.ts");
const { createConnector } = await load("cdp/browser.ts");
const { createCache } = await load("runtime/cache.ts");
const { createSystemClock } = await load("runtime/clock.ts");
const { createLimiter } = await load("runtime/limiter.ts");
const { createArtifacts } = await load("runtime/artifacts.ts");
const { createLogger } = await load("runtime/log.ts");
const { createDefaultRegistry } = await load("engines/index.ts");
const { createTools } = await load("tools/index.ts");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const engine = arg("--engine");
const query = arg("--query");
const n = Number(arg("--n", "5"));
const format = arg("--format", "md");
if (!engine || !query) {
  console.error("usage: --engine <google|duckduckgo|yandex> --query <text> [--n 5] [--format md|json]");
  process.exit(2);
}

const env = process.env;
const config = loadConfig({ env });
const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const stateDir = join(agentDir, "web-search");
const clock = createSystemClock();
const log = createLogger({ path: join(stateDir, "decisions.jsonl"), clock });
const cache = createCache({ maxEntries: config.cache.maxEntries, clock });
const limiter = createLimiter({ config, clock, statePath: join(stateDir, "state.json") });
const artifacts = createArtifacts({ config, clock });
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
  cache,
  limiter,
  artifacts,
  log,
  clock,
};

const tool = createTools(() => deps)[0];
const started = Date.now();
let outcome;
try {
  outcome = await tool.execute("live-gate", { q: query, engines: [engine], n, format });
} finally {
  await connector.releaseAll().catch(() => {});
}

const latencyMs = Date.now() - started;
const details = outcome.details ?? {};
const text = Array.isArray(outcome.content) ? outcome.content.map((block) => block.text ?? "").join("") : "";

console.log(
  JSON.stringify(
    {
      engine,
      queryClass: arg("--class", "gate"),
      n,
      format,
      ok: outcome.isError !== true,
      ai: details.ai ?? null,
      results: details.results ?? null,
      chars: text.length,
      latencyMs,
      degraded: details.degraded ?? false,
      pageIgnored: details.pageIgnored ?? false,
      error: outcome.isError === true ? { code: details.code, stage: details.stage } : undefined,
      text,
    },
    null,
    2,
  ),
);
process.exit(outcome.isError === true ? 1 : 0);
