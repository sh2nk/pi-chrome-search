/**
 * SPEC S8: one deadline per call, and the arithmetic is a test.
 *
 * The budget is created in one place, every stage derives from what is left, and
 * exhaustion is `E_TIMEOUT` at stage `budget` — distinct from a stage timing out
 * on its own. The worst case is computed from the shipped constants, so a later
 * default change cannot quietly outgrow the 60 s promise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_REQUEST_TIMEOUT_MS } from "../../src/cdp/client.ts";
import { DEFAULT_CONFIG } from "../../src/config/index.ts";
import { DUCKDUCKGO_SETTLE_DEADLINE_MS } from "../../src/engines/duckduckgo.ts";
import { GOOGLE_SETTLE_DEADLINE_MS } from "../../src/engines/google.ts";
import { YANDEX_SETTLE_DEADLINE_MS } from "../../src/engines/yandex.ts";
import { GOTO_BATCH_TIMEOUT_MS } from "../../src/extract/goto.ts";
import { createCallBudget, raceSignal } from "../../src/runtime/budget.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { FakeClock } from "../helpers/fake-cdp.ts";
import { createEngineStub, createHarness } from "../helpers/search-harness.ts";

test("S8.1: the shipped budget is 60 s and is configurable", () => {
  assert.equal(DEFAULT_CONFIG.search.budgetMs, 60_000);
});

test("S8.1: remaining time draws down on the injected clock", () => {
  const clock = new FakeClock();
  const budget = createCallBudget({ clock, budgetMs: 1_000, label: "test" });
  try {
    assert.equal(budget.remainingMs(), 1_000);
    assert.equal(budget.expired(), false);
    clock.advance(600);
    assert.equal(budget.remainingMs(), 400);
    budget.check("navigate");
    clock.advance(400);
    assert.equal(budget.expired(), true);
    assert.throws(
      () => budget.check("extract"),
      (error: unknown) =>
        isWebSearchError(error) && error.details.code === "E_TIMEOUT" && error.details.stage === "budget",
    );
  } finally {
    budget.dispose();
  }
});

test("S8.1: a queued stage is released by the budget signal", async () => {
  const controller = new AbortController();
  const pending = new Promise<string>(() => {});
  const raced = raceSignal(pending, controller.signal);
  const reason = new Error("deadline");
  controller.abort(reason);
  await assert.rejects(raced, (error: unknown) => error === reason);
});

test("S8.2: the documented worst case is inside the 60 s budget", () => {
  // One `auto` attempt: the widest pacing window, the slowest adapter settle,
  // the AI wait, the bounded link-resolution batch, and one CDP request for
  // extraction. A coverage set shares the same deadline: the call cannot outlive
  // it, and an engine that does not fit is reported as E_TIMEOUT at stage budget.
  const pacing = Math.max(...Object.values(DEFAULT_CONFIG.pacing).map((window) => window[1]));
  const settle = Math.max(
    GOOGLE_SETTLE_DEADLINE_MS,
    DUCKDUCKGO_SETTLE_DEADLINE_MS,
    YANDEX_SETTLE_DEADLINE_MS,
  );
  const aiWait = DEFAULT_CONFIG.search.aiWaitMs;
  const linkResolution = GOTO_BATCH_TIMEOUT_MS;
  const extraction = DEFAULT_REQUEST_TIMEOUT_MS;
  const worstCase = pacing + settle + aiWait + linkResolution + extraction;

  assert.ok(
    worstCase <= DEFAULT_CONFIG.search.budgetMs,
    `worst case ${worstCase} ms exceeds search.budgetMs ${DEFAULT_CONFIG.search.budgetMs} ms`,
  );
  assert.equal(
    DEFAULT_CONFIG.search.budgetMs,
    60_000,
    "SPEC D7 fixes the search budget at 60000 ms",
  );
});

test("S8.1: an exhausted budget is E_TIMEOUT(stage=budget) with an artifact", async () => {
  const engine = createEngineStub("google");
  const harness = createHarness({
    engines: [engine],
    configure: (config) => {
      config.search.budgetMs = 1_000;
    },
  });
  // 5 s of page waiting inside a 1 s call: the clock crosses the deadline while
  // the adapter settles, which is exactly what a slow SERP does.
  engine.settleImpl = async () => {
    await harness.clock.sleep(5_000);
  };

  const tool = createWebSearchTool(() => harness.deps);
  const result = await tool.execute(
    "call-1",
    { q: "budget", engines: "google", summary: false },
    undefined,
    undefined,
  );

  assert.equal("isError" in result, true, "an exhausted budget is a failure, not a partial success");
  if (!("isError" in result)) return;
  assert.equal(result.details.code, "E_TIMEOUT");
  assert.equal(result.details.stage, "budget");
  assert.ok(result.details.artifact !== undefined, "S8.1 requires an artifact for the page state");
  assert.equal(engine.queries.length, 0, "extraction must not start with no time left");
});

test("S8.1: a caller abort still wins over the budget", async () => {
  const engine = createEngineStub("google");
  engine.settleImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const harness = createHarness({ engines: [engine] });
  const controller = new AbortController();
  const tool = createWebSearchTool(() => harness.deps);
  const pending = tool.execute(
    "call-1",
    { q: "budget", engines: "google", summary: false },
    controller.signal,
    undefined,
  );
  controller.abort(new DOMException("cancelled", "AbortError"));
  const result = await pending;
  assert.equal("isError" in result, true);
  if (!("isError" in result)) return;
  assert.equal(result.details.code, "E_CANCELLED");
});
