/**
 * SPEC S4.3: the three AI states hold end to end.
 *
 * The adapter probes (wait), optionally expands (opt-in click), extracts, and
 * the renderer re-checks the answer floor. A short block that calls itself an
 * answer must come out as `lead`, and `details.ai` must be true only for an
 * `answer` — from the emitted text, never from the adapter's claim.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AiProbe, RawSerp } from "../../src/engines/types.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { createEngineStub, createHarness, resultText } from "../helpers/search-harness.ts";

const LONG_ANSWER = "A".repeat(250);
const SHORT_LEAD = "A short teaser with no full answer.";

function engineWithAi(probes: AiProbe[]) {
  let probeIndex = 0;
  const engine = createEngineStub("google", {
    ai: {
      async probe(): Promise<AiProbe> {
        const next = probes[Math.min(probeIndex, probes.length - 1)] ?? { state: "none", chars: 0 };
        probeIndex += 1;
        return next;
      },
      async expand() {
        return true;
      },
    },
  });
  return engine;
}

function serpWithAi(text: string): (query: { text: string }) => Promise<RawSerp> {
  return async (query) => ({
    engine: "google",
    query: query.text,
    ai: { text, sources: ["example.com"], state: "answer" },
    results: [{ title: "Result", url: "https://example.com/page", snippet: "snippet" }],
    pageCarried: false,
    timings: {},
  });
}

test("S4.3: wait → probe → extract keeps a real answer, and expand stays off by default", async () => {
  const engine = engineWithAi([
    { state: "lead", chars: 0 },
    { state: "answer", chars: LONG_ANSWER.length },
  ]);
  engine.extractImpl = serpWithAi(LONG_ANSWER);
  const harness = createHarness({ engines: [engine] });

  const result = await createWebSearchTool(() => harness.deps).execute(
    "call-1",
    { q: "ai states", engines: "google", summary: true },
    undefined,
    undefined,
  );

  assert.equal("isError" in result, false);
  if ("isError" in result) return;
  assert.equal(result.details.aiState, "answer");
  assert.equal(result.details.ai, true);
  assert.ok(result.details.aiChars > 200);
  assert.equal(engine.expandCalls, 0, "a visible click is opt-in (search.aiExpand)");
  assert.match(resultText(result), /^google · 1 results · ai:yes/m);
});

test("S4.3: a short block is re-checked at render and reported as lead", async () => {
  const engine = engineWithAi([{ state: "answer", chars: LONG_ANSWER.length }]);
  engine.extractImpl = serpWithAi(SHORT_LEAD);
  const harness = createHarness({ engines: [engine] });

  const result = await createWebSearchTool(() => harness.deps).execute(
    "call-1",
    { q: "ai states", engines: "google", summary: true },
    undefined,
    undefined,
  );

  assert.equal("isError" in result, false);
  if ("isError" in result) return;
  assert.equal(result.details.aiState, "lead", "an adapter cannot smuggle a short answer (S4.3)");
  assert.equal(result.details.ai, false);
  assert.equal(result.details.aiChars, 0, "no answer prose was rendered");
  const text = resultText(result);
  assert.match(text, /ai:lead/);
  assert.doesNotMatch(text, /^AI: /m, "a lead is never rendered as an answer body");
});

test("S4.3: search.aiExpand performs exactly one visible expand", async () => {
  const engine = engineWithAi([{ state: "answer", chars: LONG_ANSWER.length }]);
  engine.extractImpl = serpWithAi(LONG_ANSWER);
  const harness = createHarness({
    engines: [engine],
    configure: (config) => {
      config.search.aiExpand = true;
    },
  });

  const result = await createWebSearchTool(() => harness.deps).execute(
    "call-1",
    { q: "ai states", engines: "google", summary: true },
    undefined,
    undefined,
  );

  assert.equal("isError" in result, false);
  assert.equal(engine.expandCalls, 1);
});

test("S4.3: summary:false never probes or waits", async () => {
  const engine = engineWithAi([{ state: "answer", chars: LONG_ANSWER.length }]);
  engine.extractImpl = serpWithAi(LONG_ANSWER);
  const harness = createHarness({ engines: [engine] });

  const result = await createWebSearchTool(() => harness.deps).execute(
    "call-1",
    { q: "ai states", engines: "google", summary: false },
    undefined,
    undefined,
  );

  assert.equal("isError" in result, false);
  if (!("isError" in result)) assert.equal(result.details.aiWaitMs, 0);
});

test("S8.1/S4.3: the AI wait derives from the call budget, not a second deadline", async () => {
  const engine = engineWithAi([{ state: "lead", chars: 0 }]);
  engine.extractImpl = serpWithAi(LONG_ANSWER);
  const harness = createHarness({
    engines: [engine],
    configure: (config) => {
      config.search.budgetMs = 1_000;
      config.search.aiWaitMs = 6_000;
    },
  });

  const result = await createWebSearchTool(() => harness.deps).execute(
    "call-1",
    { q: "ai states", engines: "google", summary: true },
    undefined,
    undefined,
  );

  assert.equal("isError" in result, true, "a lead that outlives the call is a budget failure");
  if (!("isError" in result)) return;
  assert.equal(result.details.code, "E_TIMEOUT");
  assert.equal(result.details.stage, "budget");
});
