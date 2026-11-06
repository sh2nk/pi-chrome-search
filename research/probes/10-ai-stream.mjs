#!/usr/bin/env node
/**
 * 10 — S4: observe one live AI Overview while it streams (PLAN-v2 §3, P8).
 *
 * One navigation, one query, one engine (`--engine google|yandex|duckduckgo`).
 * After the SERP URL is sent, the adapter's own `ai.probe()` is polled every
 * `--interval` ms and every observation is printed as JSONL. That gives the
 * three states the plan asks for (none → lead → answer) with real timestamps and
 * real character counts, and it also measures the latency the wait costs.
 *
 * This is a measurement, not a search loop: the query is issued once, no retry,
 * no second engine, no clicking. A captcha/wall is reported and left alone.
 *
 *   node research/probes/10-ai-stream.mjs --engine google \
 *     --query "how does a solar panel work" --max 40 --interval 250
 *
 * Output: one JSON object per line, then a summary line starting with `summary`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("../../src/", import.meta.url).pathname;
const load = (rel) => import(`file://${root}${rel}`);

const { loadConfig } = await load("config.ts");
const { discoverEndpoint } = await load("cdp/discovery.ts");
const { createConnector } = await load("cdp/browser.ts");
const { createSystemClock } = await load("runtime/clock.ts");
const { createLogger } = await load("runtime/log.ts");
const { createCache } = await load("runtime/cache.ts");
const { createLimiter } = await load("runtime/limiter.ts");
const { createArtifacts } = await load("runtime/artifacts.ts");
const { createDefaultRegistry } = await load("engines/index.ts");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const engineId = arg("--engine", "google");
const query = arg("--query");
const maxPolls = Number(arg("--max", "40"));
const intervalMs = Number(arg("--interval", "250"));
const n = Number(arg("--n", "3"));
if (!query) {
  console.error("usage: --engine <google|duckduckgo|yandex> --query <text> [--max 40] [--interval 250]");
  process.exit(2);
}
if (engineId !== "google" && engineId !== "duckduckgo" && engineId !== "yandex") {
  console.error("unknown engine: " + engineId);
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
// Same services the tool layer builds; only the limiter would pace a second call.
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

const engine = deps.engines.get(engineId);
if (engine.ai === undefined) {
  console.error(`${engineId} has no AI probe`);
  process.exit(2);
}

let page;
try {
  await connector.connect();
  page = await connector.acquirePage(engineId);
  const url = engine.buildUrl({ text: query, n, summary: true });
  console.log(JSON.stringify({ event: "navigate", engine: engineId, url, at: Date.now() }));
  const started = Date.now();
  await page.navigate(url);

  const timeline = [];
  let answerAt = null;
  let leadAt = null;
  for (let index = 0; index < maxPolls; index += 1) {
    const probe = await engine.ai.probe(page);
    const t = Date.now() - started;
    timeline.push({ t, state: probe.state, chars: probe.chars });
    console.log(JSON.stringify({ event: "probe", t, state: probe.state, chars: probe.chars, polls: index + 1 }));
    if (probe.state === "lead" && leadAt === null) leadAt = t;
    if (probe.state === "answer" && leadAt !== null && answerAt === null) answerAt = t;
    if (probe.state === "answer") {
      if (answerAt === null && leadAt === null) answerAt = t;
      break;
    }
    await sleep(intervalMs);
  }
  const last = timeline[timeline.length - 1] ?? { state: "none", chars: 0, t: 0 };
  console.log(
    JSON.stringify({
      event: "summary",
      engine: engineId,
      final: last.state,
      chars: last.chars,
      firstLeadMs: leadAt,
      answerMs: answerAt,
      observedForMs: last.t,
      probes: timeline.length,
    }),
  );
} catch (error) {
  // A wall is reported, never retried and never solved here.
  console.log(JSON.stringify({ event: "error", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await connector.releaseAll().catch(() => {});
}
