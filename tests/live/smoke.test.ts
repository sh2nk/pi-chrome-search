/**
 * Opt-in live smoke (AGENTS §6, PLAN V7.5).
 *
 * `PI_CHROME_LIVE=1 npm run test:live` — one query per engine, `n=2`, one run
 * each, no retries. A wall is reported as SKIP, never as a failure: the user may
 * be asked to solve a captcha, and hammering the profile is exactly what the
 * hard rules forbid. Without the env var every test skips, so `npm test` never
 * touches Chrome.
 *
 * This is also the honest replacement for the "3 engines, ai:yes/no, chars,
 * latency" table: it prints one line per engine in TAP output, and the
 * orchestrator copies that line into `evidence/P7.md`.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConnector } from "../../src/cdp/browser.ts";
import { discoverEndpoint } from "../../src/cdp/discovery.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createDefaultRegistry } from "../../src/engines/index.ts";
import type { EngineId } from "../../src/engines/types.ts";
import { createArtifacts } from "../../src/runtime/artifacts.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { createSystemClock } from "../../src/runtime/clock.ts";
import { createLimiter } from "../../src/runtime/limiter.ts";
import { createLogger } from "../../src/runtime/log.ts";
import { createTools } from "../../src/tools/index.ts";

const LIVE = process.env.PI_CHROME_LIVE === "1";

/** One neutral, engine-appropriate query. Never personal, never a wall bait. */
const QUERIES: ReadonlyArray<{ engine: EngineId; q: string }> = [
  { engine: "google", q: "rust tokio select macro example" },
  { engine: "duckduckgo", q: "rust tokio select macro example" },
  { engine: "yandex", q: "rust tokio select macro example" },
];

const MAX_OUTPUT_CHARS = 2500;

interface SmokeResult {
  ok: boolean;
  ai: boolean | null;
  aiState: string | null;
  aiWaitMs: number | null;
  aiChars: number | null;
  results: number | null;
  chars: number;
  ms: number;
  code?: string;
  wall?: boolean;
}

async function runOnce(engine: EngineId, q: string): Promise<SmokeResult> {
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
    limiter: createLimiter({ config, clock }),
    artifacts: createArtifacts({ config, clock }),
    log,
    clock,
  };
  const tool = createTools({
    getDeps: () => deps,
    getDoctorDeps: () => {
      throw new Error("live smoke does not run the doctor");
    },
  }).find((candidate) => candidate.name === "web_search");
  assert.ok(tool !== undefined);

  const started = Date.now();
  try {
    const result = await tool.execute("live-smoke", { q, engines: [engine], n: 2 }, undefined, undefined);
    const text = result.content.map((block) => block.text ?? "").join("");
    const failure = "isError" in result && result.isError === true;
    const details = result.details as {
      ai?: unknown;
      aiState?: unknown;
      aiWaitMs?: unknown;
      aiChars?: unknown;
      results?: unknown;
      code?: unknown;
      wall?: unknown;
    };
    return {
      ok: !failure,
      ai: typeof details.ai === "boolean" ? details.ai : null,
      aiState: typeof details.aiState === "string" ? details.aiState : null,
      aiWaitMs: typeof details.aiWaitMs === "number" ? details.aiWaitMs : null,
      aiChars: typeof details.aiChars === "number" ? details.aiChars : null,
      results: typeof details.results === "number" ? details.results : null,
      chars: text.length,
      ms: Date.now() - started,
      ...(typeof details.code === "string" ? { code: details.code } : {}),
      ...(details.wall !== undefined ? { wall: true } : {}),
    };
  } finally {
    await connector.releaseAll().catch(() => {});
  }
}

for (const { engine, q } of QUERIES) {
  test(`live ${engine}: one query, n=2`, { skip: LIVE ? false : "set PI_CHROME_LIVE=1 to run one live query per engine" }, async () => {
    const result = await runOnce(engine, q);
    // P8 gate format: `ai:|aiWaitMs|aiChars` so the evidence table is copy-paste.
    const line =
      `live ${engine}: ok=${String(result.ok)} ai=${String(result.aiState ?? result.ai)}` +
      `|wait=${String(result.aiWaitMs)}ms|chars=${String(result.aiChars)}` +
      ` results=${String(result.results)} output=${result.chars} ${result.ms}ms` +
      `${result.code === undefined ? "" : ` code=${result.code}`}`;
    console.log(line);

    if (result.wall === true || result.code === "E_WALL") {
      // The window is surfaced by the tool; the user solves it. Not a failure.
      return;
    }
    if (result.code === "E_CDP_UNAVAILABLE" || result.code === "E_BUSY") {
      return;
    }
    assert.equal(result.ok, true, `${engine} failed with ${result.code ?? "unknown"}`);
    // V8.3: `ai:yes` with under 200 chars of prose is a failure, not a pass.
    if (result.aiState === "answer") {
      assert.ok((result.aiChars ?? 0) >= 200, `${engine}: ai:yes with aiChars=${String(result.aiChars)}`);
    }
    // V8.4: the wait is bounded; a summary-less page must not pay the full budget.
    assert.ok((result.aiWaitMs ?? 0) <= 6000, `${engine}: aiWaitMs=${String(result.aiWaitMs)}`);
    assert.ok((result.results ?? 0) >= 1, `${engine} returned no results`);
    assert.ok(result.chars <= MAX_OUTPUT_CHARS, `${engine} returned ${result.chars} chars, cap ${MAX_OUTPUT_CHARS}`);
  });
}
