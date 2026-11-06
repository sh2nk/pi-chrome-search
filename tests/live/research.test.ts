/**
 * Opt-in live gate for P13 (claims that answer the question, V13.4).
 *
 * `PI_CHROME_LIVE=1 npm run test:live` — three queries, one run each, no
 * retries. A wall is reported and the user re-runs later; hammering the profile
 * is exactly what the hard rules forbid. Without the env var the test skips, so
 * `npm test` never touches Chrome.
 *
 * `PI_CHROME_P13_OUT=/path.json` also writes the trimmed transcript (claims,
 * citations, excerpts only — no cookies, no SERP HTML, no query history) so it
 * can be committed as `tests/fixtures/research-live-p13.json` and scanned by the
 * offline V13.2 test. Queries are neutral technical/factual questions.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConnector } from "../../src/cdp/browser.ts";
import { discoverEndpoint } from "../../src/cdp/discovery.ts";
import { loadConfig } from "../../src/config.ts";
import { createDefaultRegistry } from "../../src/engines/index.ts";
import { claimsCoverage } from "../../src/extract/claims.ts";
import { createArtifacts } from "../../src/runtime/artifacts.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { createSystemClock } from "../../src/runtime/clock.ts";
import { createLimiter } from "../../src/runtime/limiter.ts";
import { createLogger } from "../../src/runtime/log.ts";
import { createWebResearchTool, type WebResearchResult } from "../../src/tools/web_research.ts";
import type { ToolDeps } from "../../src/tools/types.ts";

const LIVE = process.env.PI_CHROME_LIVE === "1";

/**
 * One neutral query per language/engine route. `quick` = one search + two reads
 * per query, so the whole gate spends three searches and six reads.
 */
const QUERIES: ReadonlyArray<{ id: string; q: string; class: string }> = [
  { id: "postgres", q: "postgres max_connections по умолчанию", class: "technical RU" },
  { id: "compose", q: "docker compose healthcheck интервал", class: "technical RU" },
  { id: "cors", q: "CORS Access-Control-Allow-Origin настройка", class: "technical RU/EN" },
];

function throwawayDir(): string {
  return mkdtempSync(join(tmpdir(), "p13-live-"));
}

function makeDeps(): ToolDeps {
  const env = { ...process.env, PI_CODING_AGENT_DIR: throwawayDir() };
  const config = loadConfig({ env });
  const stateDir = join(env.PI_CODING_AGENT_DIR, "web-search");
  const clock = createSystemClock();
  const log = createLogger({ path: join(stateDir, "decisions.jsonl"), clock });
  const connector = createConnector({
    config,
    clock,
    log,
    lockPath: join(stateDir, "web-search.lock"),
    discover: () =>
      discoverEndpoint({ ports: config.cdp.ports, ws: config.cdp.ws, timeoutMs: config.cdp.connectTimeoutMs }),
  });
  return {
    config,
    engines: createDefaultRegistry(config),
    cdp: connector,
    cache: createCache({ maxEntries: config.cache.maxEntries, clock }),
    limiter: createLimiter({ config, clock, statePath: join(stateDir, "state.json") }),
    artifacts: createArtifacts({ config, clock }),
    log,
    clock,
  };
}

interface Transcript {
  queries: Array<{
    q: string;
    enough: boolean;
    searches: number;
    reads: number;
    claims: Array<{ text: string; sourceUrl: string; citations: string[] }>;
    citations: Array<{ url: string; domain: string }>;
    excerpts: Array<{ url: string; excerpt: string }>;
  }>;
  claims: Array<{ text: string; sourceUrl: string; citations: string[] }>;
  citations: Array<{ url: string; domain: string }>;
  excerpts: Array<{ url: string; excerpt: string }>;
}

test(
  "live P13: three queries return claims that answer the question",
  { skip: LIVE ? false : "set PI_CHROME_LIVE=1 to run the live research gate" },
  async (t) => {
    const deps = makeDeps();
    const tool = createWebResearchTool(() => deps);
    t.after(async () => {
      await deps.cdp.releaseAll();
    });

    const transcript: Transcript = { queries: [], claims: [], citations: [], excerpts: [] };
    let answered = 0;
    let walled = 0;

    for (const entry of QUERIES) {
      const started = Date.now();
      const result: WebResearchResult = await tool.execute(
        `live-p13-${entry.id}`,
        { q: entry.q, budget: "quick" },
        undefined,
        undefined,
      );
      const ms = Date.now() - started;
      if ("isError" in result) {
        t.diagnostic(`${entry.id} (${entry.class}): ${result.details.code} at ${result.details.stage} in ${ms} ms`);
        // A wall is the user's to solve; never retry, never automate (hard rule 6).
        if (result.details.code === "E_WALL" || result.details.code === "E_CDP_AWAITING_ALLOW") {
          walled += 1;
          continue;
        }
        assert.fail(`live research failed: ${result.details.code} ${result.details.message ?? ""}`);
      }

      const { evidence, searches, reads, coverage } = result.details;
      assert.ok(evidence.claims.length > 0, `${entry.id}: no claim produced`);
      const coverageRatio = claimsCoverage(entry.q, evidence.claims.map((claim) => claim.text));
      if (coverageRatio >= 0.6) answered += 1;

      t.diagnostic(
        `${entry.id} (${entry.class}): searches ${searches}/1 · reads ${reads}/2 · enough:${coverage.enough ? "yes" : "no"} · coverage ${(coverageRatio * 100).toFixed(0)}% · ${ms} ms`,
      );
      for (const claim of evidence.claims) {
        t.diagnostic(`  claim: ${claim.text} [${claim.sourceUrl}]`);
      }

      transcript.queries.push({
        q: entry.q,
        enough: coverage.enough,
        searches,
        reads,
        claims: evidence.claims,
        citations: evidence.citations,
        excerpts: evidence.excerpts,
      });
      transcript.claims.push(...evidence.claims);
      transcript.citations.push(...evidence.citations);
      transcript.excerpts.push(...evidence.excerpts);
    }

    if (walled > 0) {
      t.diagnostic(`${walled}/${QUERIES.length} queries hit a wall and were skipped, not retried`);
    }
    assert.ok(
      answered + walled >= 2,
      `only ${answered}/${QUERIES.length} queries produced claims covering >= 60% of their terms`,
    );

    const out = process.env.PI_CHROME_P13_OUT?.trim();
    if (out !== undefined && out !== "") writeFileSync(out, `${JSON.stringify(transcript, null, 2)}\n`);
  },
);
