/**
 * Reflex policy guard rails (PLAN P5-B, gates V5.1–V5.5).
 *
 * The policy is the only component allowed to consult a model, so these tests
 * prove the negative space as well: disabled means zero calls, budgets stop
 * traffic instead of throwing, and every verdict — including the rules
 * baseline — reaches decisions.jsonl.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import {
  BUDGET_LOG_KIND,
  REFLEX_LOG_KIND,
  VERDICT_TTL_MS,
  createPolicy,
  type BackendResult,
  type CallMeta,
  type ReflexBackend,
  type ReflexPolicy,
} from "../../src/reflex/policy.ts";
import { createRules } from "../../src/reflex/rules.ts";
import type { Candidate, CoverageVerdict, Route, TriageResult } from "../../src/reflex/types.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { createLogger, readJsonl } from "../../src/runtime/log.ts";
import type { Cache, Logger } from "../../src/runtime/types.ts";
import { FakeClock } from "../helpers/clock.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-chrome-search-reflex-"));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(overrides: Partial<Config["reflex"]> = {}): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.reflex.enabled = true;
  Object.assign(config.reflex, overrides);
  return config;
}

function candidate(url: string, title: string, snippet = ""): Candidate {
  return { url, title, snippet, engine: "google" };
}

function meta(overrides: Partial<CallMeta> = {}): CallMeta {
  return { confidence: 0.9, stopReason: "stop", model: "fake-jev", ...overrides };
}

interface BackendOverrides {
  triage?: (items: Candidate[]) => BackendResult<TriageResult>;
  gateRead?: () => BackendResult<boolean>;
  coverage?: () => BackendResult<CoverageVerdict>;
  route?: () => BackendResult<Route>;
}

function spyBackend(overrides: BackendOverrides = {}): { backend: ReflexBackend; calls: string[] } {
  const calls: string[] = [];
  const backend: ReflexBackend = {
    triage: async (_query, items) => {
      calls.push("triage");
      return (
        overrides.triage?.(items) ?? {
          value: { keep: items.map((_, index) => index), scores: items.map(() => 3), flags: [] },
          meta: meta(),
        }
      );
    },
    gateRead: async () => {
      calls.push("gate_read");
      return overrides.gateRead?.() ?? { value: true, meta: meta() };
    },
    coverage: async () => {
      calls.push("coverage");
      return overrides.coverage?.() ?? { value: { enough: true, next: "stop" }, meta: meta() };
    },
    route: async () => {
      calls.push("route");
      return overrides.route?.() ?? { value: { engines: ["google"], n: 5, summary: true }, meta: meta() };
    },
  };
  return { backend, calls };
}

interface Harness {
  policy: ReflexPolicy;
  rows: Record<string, unknown>[];
  calls: string[];
  clock: FakeClock;
  cache: Cache;
}

interface HarnessOptions {
  config?: Config;
  overrides?: BackendOverrides;
  withBackend?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock();
  const cache = createCache({ maxEntries: 100, clock });
  const rows: Record<string, unknown>[] = [];
  const log: Logger = {
    write: async (row) => {
      rows.push(structuredClone(row));
    },
    path: () => "memory",
  };
  const spy = spyBackend(options.overrides);
  const policy = createPolicy({
    config: options.config ?? makeConfig(),
    clock,
    cache,
    log,
    rules: createRules(),
    ...(options.withBackend === false ? {} : { backend: spy.backend }),
  });
  return { policy, rows, calls: spy.calls, clock, cache };
}

function budgetRow(rows: Record<string, unknown>[]): Record<string, unknown> {
  const row = rows.find((entry) => entry.kind === BUDGET_LOG_KIND);
  assert.ok(row, "a budget event must be logged");
  return row;
}

// ---------------------------------------------------------------------------
// V5.1 — disabled means zero model calls, rules still logged
// ---------------------------------------------------------------------------

test("reflex.enabled=false performs zero backend calls and logs the rules verdict", async () => {
  const h = harness({ config: makeConfig({ enabled: false }) });
  const item = candidate("https://nodejs.org/en/download", "Node.js", "Install Node.js");

  const triage = await h.policy.triage("install node", [item]);
  const read = await h.policy.gateRead("install node", item);
  const coverage = await h.policy.coverage("install node", [{ url: item.url }]);
  const route = await h.policy.route("install node");

  assert.deepEqual(triage, await createRules().triage("install node", [item]));
  assert.equal(read, true);
  assert.equal(coverage.enough, false);
  assert.deepEqual(route.engines, ["google", "duckduckgo"]);

  assert.equal(h.calls.length, 0, "the disabled fast path must never touch the backend");
  assert.equal(h.rows.length, 4);
  for (const row of h.rows) {
    assert.equal(row.kind, REFLEX_LOG_KIND);
    assert.equal(row.model, "rules");
    assert.equal(row.fallback, true);
    assert.equal(row.reason, "disabled");
    assert.equal(row.confidence, 1);
    assert.equal(row.latencyMs, 0);
    assert.equal(row.costUsd, 0);
  }
  assert.equal(h.policy.stats().backendCalls, 0);
  assert.equal(h.policy.stats().rulesVerdicts, 4);
  assert.equal(h.clock.pendingCount(), 0);
});

test("a rules backend is not a fallback and still makes zero calls", async () => {
  const h = harness({ config: makeConfig({ backend: "rules" }) });

  await h.policy.route("install node");

  assert.equal(h.calls.length, 0);
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.reason, "backend_rules");
  assert.equal(row.fallback, false);
});

test("no injected backend falls back to rules without throwing", async () => {
  const h = harness({ withBackend: false });

  const route = await h.policy.route("install node");

  assert.deepEqual(route.engines, ["google", "duckduckgo"]);
  assert.equal(h.rows.at(-1)?.reason, "no_backend");
});

// ---------------------------------------------------------------------------
// V5.3 — abstain rules
// ---------------------------------------------------------------------------

const rules = createRules();

test("abstains below abstainBelow and returns the rules verdict", async () => {
  const h = harness({
    overrides: { gateRead: () => ({ value: true, meta: meta({ confidence: 0.4 }) }) },
  });
  const item = candidate("https://example.org/recipe", "Chocolate cake", "Flour, sugar, eggs.");

  const read = await h.policy.gateRead("asyncio library", item);

  assert.equal(read, false, "the low-confidence backend verdict must be discarded");
  assert.equal(h.calls.length, 1);
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.fallback, true);
  assert.equal(row.reason, "low_confidence");
  assert.equal(row.confidence, 0.4);
  // The verdict is the rules one; the rejected model stays visible separately.
  assert.equal(row.model, "rules");
  assert.equal(row.attemptedModel, "fake-jev");
});

test("abstains when stopReason is not \"stop\"", async () => {
  const h = harness({
    overrides: { gateRead: () => ({ value: true, meta: meta({ stopReason: "length" }) }) },
  });
  const item = candidate("https://example.org/recipe", "Chocolate cake", "Flour, sugar, eggs.");

  assert.equal(await h.policy.gateRead("asyncio library", item), false);
  assert.equal(h.rows.at(-1)?.reason, "stop_reason");
});

test("abstains when the backend reports an errorMessage", async () => {
  const h = harness({
    overrides: { gateRead: () => ({ value: true, meta: meta({ errorMessage: "provider 429" }) }) },
  });
  const item = candidate("https://example.org/recipe", "Chocolate cake", "Flour, sugar, eggs.");

  assert.equal(await h.policy.gateRead("asyncio library", item), false);
  assert.equal(h.rows.at(-1)?.reason, "backend_error_message");
});

test("abstains when the call exceeds maxLatencyMs", async () => {
  const h = harness({
    config: makeConfig({ maxLatencyMs: 1200 }),
    overrides: { gateRead: () => ({ value: true, meta: meta({ latencyMs: 5000 }) }) },
  });
  const item = candidate("https://example.org/recipe", "Chocolate cake", "Flour, sugar, eggs.");

  assert.equal(await h.policy.gateRead("asyncio library", item), false);
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.reason, "deadline");
  assert.equal(row.latencyMs, 5000);
});

test("abstains on a malformed backend verdict", async () => {
  const items = [
    candidate("https://nodejs.org/en/download", "Node.js", "Install Node.js"),
    candidate("https://example.org/other", "Other", "Nothing relevant"),
  ];
  const checks = createRules();
  const h = harness({
    overrides: {
      triage: () => ({ value: { keep: [0], scores: [], flags: [] }, meta: meta() }),
    },
  });

  const result = await h.policy.triage("install node", items);

  assert.deepEqual(result, await checks.triage("install node", items));
  assert.equal(h.rows.at(-1)?.reason, "invalid_verdict");
});

test("a thrown backend error falls back to rules without throwing", async () => {
  const h = harness({
    overrides: {
      gateRead: () => {
        throw new Error("socket closed");
      },
    },
  });
  const item = candidate("https://example.org/recipe", "Chocolate cake", "Flour, sugar, eggs.");

  assert.equal(await h.policy.gateRead("asyncio library", item), false);
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.reason, "backend_error");
  assert.equal(row.error, "socket closed");
});

test("accepts a healthy backend verdict and logs its telemetry", async () => {
  const h = harness({
    overrides: {
      gateRead: () => ({
        value: true,
        meta: meta({
          confidence: 0.92,
          model: "fake-jev",
          usage: { inputTokens: 1200, outputTokens: 8 },
          costUsd: 0.0004,
          latencyMs: 40,
        }),
      }),
    },
  });
  const item = candidate("https://example.org/recipe?secret=1", "Chocolate cake", "Flour, sugar, eggs.");

  assert.equal(await h.policy.gateRead("asyncio library", item), true);
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.decision, "gate_read");
  assert.equal(row.verdict, "read");
  assert.equal(row.fallback, false);
  assert.equal(row.confidence, 0.92);
  assert.equal(row.model, "fake-jev");
  assert.equal(row.latencyMs, 40);
  assert.equal(row.costUsd, 0.0004);
  assert.deepEqual(row.usage, { inputTokens: 1200, outputTokens: 8 });
  assert.equal(row.url, "https://example.org/recipe", "the query string is never logged");
  assert.equal(h.policy.stats().usdThisSession, 0.0004);
});

// ---------------------------------------------------------------------------
// V5.2 — budgets
// ---------------------------------------------------------------------------

test("call #31 in one search falls back to rules and logs a budget event", async () => {
  const h = harness({
    config: makeConfig({ maxCallsPerSearch: 30 }),
    overrides: { gateRead: () => ({ value: true, meta: meta() }) },
  });

  h.policy.beginSearch();
  let last = true;
  for (let index = 0; index < 31; index += 1) {
    last = await h.policy.gateRead(
      "quantum chromodynamics",
      candidate(`https://example.org/p${index}`, "Cooking recipes", "Flour, sugar, eggs."),
    );
  }

  assert.equal(h.calls.length, 30, "the 31st call must not reach the backend");
  assert.equal(last, false, "the rules verdict answers the blocked call");
  const event = budgetRow(h.rows);
  assert.equal(event.reason, "max_calls_per_search");
  assert.equal(event.used, 30);
  assert.equal(event.limit, 30);
  assert.equal(h.policy.stats().budgetStops, 1);
});

test("beginSearch resets the per-search counter", async () => {
  const h = harness({
    config: makeConfig({ maxCallsPerSearch: 2, maxCallsPerSession: 100 }),
    overrides: { gateRead: () => ({ value: true, meta: meta() }) },
  });

  await h.policy.gateRead("node", candidate("https://example.org/a", "A", "node"));
  await h.policy.gateRead("node", candidate("https://example.org/b", "B", "node"));
  assert.equal(h.calls.length, 2);

  h.policy.beginSearch();
  await h.policy.gateRead("node", candidate("https://example.org/c", "C", "node"));
  assert.equal(h.calls.length, 3, "a new search gets a fresh budget");
});

test("call #501 in a session falls back to rules", async () => {
  const h = harness({
    config: makeConfig({ maxCallsPerSearch: 1000, maxCallsPerSession: 500 }),
    overrides: { gateRead: () => ({ value: true, meta: meta() }) },
  });

  for (let index = 0; index < 501; index += 1) {
    h.policy.beginSearch();
    await h.policy.gateRead(
      `query ${index}`,
      candidate(`https://example.org/p${index}`, "Cooking", "Flour"),
    );
  }

  assert.equal(h.calls.length, 500);
  const event = budgetRow(h.rows);
  assert.equal(event.reason, "max_calls_per_session");
  assert.equal(event.used, 500);
  assert.equal(event.limit, 500);
});

test("exceeding maxUsdPerSession stops model traffic without throwing", async () => {
  const h = harness({
    config: makeConfig({ maxUsdPerSession: 0.05 }),
    overrides: { gateRead: () => ({ value: true, meta: meta({ costUsd: 0.03 }) }) },
  });

  assert.equal(await h.policy.gateRead("node", candidate("https://example.org/a", "A", "Flour")), true);
  assert.equal(await h.policy.gateRead("node", candidate("https://example.org/b", "B", "Sugar")), true);
  assert.equal(await h.policy.gateRead("node", candidate("https://example.org/c", "C", "Eggs")), false);

  assert.equal(h.calls.length, 2);
  assert.equal(h.policy.stats().usdThisSession, 0.06);
  const event = budgetRow(h.rows);
  assert.equal(event.reason, "max_usd_per_session");
  assert.equal(event.limit, 0.05);
});

// ---------------------------------------------------------------------------
// Verdict cache
// ---------------------------------------------------------------------------

test("a 24 h verdict-cache hit avoids the backend", async () => {
  const h = harness({
    overrides: { gateRead: () => ({ value: true, meta: meta() }) },
  });
  const item = candidate("https://nodejs.org/en/download", "Node.js", "Install Node.js");

  assert.equal(await h.policy.gateRead("install node", item), true);
  assert.equal(await h.policy.gateRead("install node", item), true);

  assert.equal(h.calls.length, 1, "the second call must be served from the cache");
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.cached, true);
  assert.equal(row.fallback, false);
  assert.equal(h.policy.stats().cacheHits, 1);

  h.clock.advance(VERDICT_TTL_MS - 1);
  assert.equal(await h.policy.gateRead("install node", item), true);
  assert.equal(h.calls.length, 1, "still inside the 24 h window");

  h.clock.advance(1);
  assert.equal(await h.policy.gateRead("install node", item), true);
  assert.equal(h.calls.length, 2, "the cache entry expires at 24 h");
});

test("the cache key includes the query", async () => {
  const h = harness({ overrides: { gateRead: () => ({ value: true, meta: meta() }) } });
  const item = candidate("https://nodejs.org/en/download", "Node.js", "Install Node.js");

  await h.policy.gateRead("install node", item);
  await h.policy.gateRead("remove node", item);

  assert.equal(h.calls.length, 2);
});

// ---------------------------------------------------------------------------
// V5.5 — decisions.jsonl schema and privacy
// ---------------------------------------------------------------------------

test("every decision row carries the schema fields; no query, page text or token leaks", async () => {
  const dir = tempDir();
  const file = join(dir, "decisions.jsonl");
  const clock = new FakeClock();
  const cache = createCache({ maxEntries: 50, clock });
  const log = createLogger({ path: file, clock });
  const spy = spyBackend({
    triage: (items) => ({
      value: { keep: items.map((_, index) => index), scores: items.map(() => 4), flags: [] },
      meta: meta({ usage: { inputTokens: 900, outputTokens: 12 }, costUsd: 0.0002 }),
    }),
  });
  const policy = createPolicy({
    config: makeConfig(),
    clock,
    cache,
    log,
    rules: createRules(),
    backend: spy.backend,
  });

  const marker = "zebra-marker-42";
  const item = candidate(
    `https://example.org/article?sxsrf=SECRETVALUE&${marker}=1`,
    "Node.js guide",
    `${marker} how to install node. Full page text must never be logged.`,
  );
  const items = [item, candidate("https://nodejs.org/en/download", "Download", "Install Node.js")];

  await policy.triage(`install node ${marker}`, items);
  await policy.gateRead(`install node ${marker}`, item);
  await policy.coverage(`install node ${marker}`, [{ url: item.url, excerpt: marker }]);
  await policy.route(`install node ${marker}`);

  const rows = await readJsonl(file);
  assert.equal(rows.length, 4);

  const required = [
    "decision",
    "verdict",
    "confidence",
    "latencyMs",
    "model",
    "usage",
    "costUsd",
    "fallback",
    "queryHash",
  ];
  for (const row of rows) {
    assert.equal(row.kind, REFLEX_LOG_KIND);
    for (const key of required) {
      assert.ok(key in row, `missing ${key} in ${JSON.stringify(row)}`);
    }
    assert.equal(typeof row.decision, "string");
    assert.equal(typeof row.verdict, "string");
    assert.equal(typeof row.confidence, "number");
    assert.equal(typeof row.latencyMs, "number");
    assert.equal(typeof row.model, "string");
    assert.equal(typeof row.costUsd, "number");
    assert.equal(typeof row.fallback, "boolean");
    assert.match(String(row.queryHash), /^[0-9a-f]{16}$/);
    assert.equal(typeof row.usage, "object");
  }

  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes(marker), "query/snippet text must never reach the log");
  assert.ok(!raw.includes("sxsrf"), "URL query strings must not reach the log");
  assert.ok(!raw.includes("SECRETVALUE"), "URL query values must not reach the log");
  assert.ok(!raw.includes("Full page text"), "page text must never reach the log");
});

test("a budget event is logged as its own row kind", async () => {
  const h = harness({
    config: makeConfig({ maxCallsPerSearch: 0 }),
    overrides: { gateRead: () => ({ value: true, meta: meta() }) },
  });

  await h.policy.gateRead("node", candidate("https://example.org/a", "A", "node"));

  const event = budgetRow(h.rows);
  assert.equal(event.kind, BUDGET_LOG_KIND);
  assert.equal(event.decision, "gate_read");
  assert.equal(typeof event.ts, "string");
  assert.match(String(event.queryHash), /^[0-9a-f]{16}$/);
  assert.equal(h.calls.length, 0);
});
