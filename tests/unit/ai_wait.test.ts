/**
 * P8-A: the streaming-summary wait (`src/cdp/ai-wait.ts`).
 *
 * Every case drives virtual time through `FakeClock`, so the suite proves the
 * deadline, the "no block" grace and the early-answer path without sleeping.
 * The probe is a scripted sequence: this file tests the wait's contract, not an
 * engine's DOM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { waitForAi, DEFAULT_AI_WAIT_MS, DEFAULT_NONE_GRACE_MS } from "../../src/cdp/ai-wait.ts";
import type { CdpPage } from "../../src/cdp/types.ts";
import type { AiProbe } from "../../src/engines/types.ts";
import { AI_ANSWER_MIN_CHARS } from "../../src/engines/types.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { WebSearchError } from "../../src/runtime/error-codes.ts";
import { FakeClock } from "../helpers/clock.ts";
import { FakePage } from "../helpers/fake-page.ts";

function page(): CdpPage {
  return new FakePage({ url: "https://www.google.com/search?q=sample" });
}

/** Probe that replays `sequence`, repeating the last entry once it is exhausted. */
function sequenceProbe(sequence: readonly AiProbe[]): {
  probe: (page: CdpPage) => Promise<AiProbe>;
  polls: () => number;
} {
  let index = 0;
  let polls = 0;
  return {
    probe: async () => {
      polls += 1;
      const value = sequence[Math.min(index, sequence.length - 1)] ?? { state: "none", chars: 0 };
      index += 1;
      return value;
    },
    polls: () => polls,
  };
}

/** No jitter: the clock math is the subject here, not the poll shape. */
const STEADY = (): number => 0.5;

test("an answer already on the page resolves on the first probe with no sleep", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "answer", chars: AI_ANSWER_MIN_CHARS }]);
  const result = await waitForAi(page(), { probe: scripted.probe }, { clock, pollMs: 150, rng: STEADY });

  assert.deepEqual(result, { state: "answer", chars: AI_ANSWER_MIN_CHARS, waitMs: 0, timedOut: false, polls: 1 });
  assert.equal(clock.durations().length, 0);
});

test("a lead that turns into prose returns as soon as the prose appears", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([
    { state: "none", chars: 0 },
    { state: "lead", chars: 31 },
    { state: "lead", chars: 31 },
    { state: "answer", chars: 812 },
  ]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 6000, rng: STEADY },
  );

  assert.equal(result.state, "answer");
  assert.equal(result.chars, 812);
  assert.equal(result.timedOut, false);
  assert.equal(result.waitMs, 300);
  assert.equal(result.polls, 4);
});

test("a lead that never becomes prose waits out the deadline and reports a timeout", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "lead", chars: 31 }]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 600, rng: STEADY },
  );

  assert.equal(result.state, "lead");
  assert.equal(result.chars, 31);
  assert.equal(result.timedOut, true);
  assert.equal(result.waitMs, 600);
  assert.equal(result.polls, 7);
});

test("a page with no AI block stops after the grace instead of the whole deadline", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "none", chars: 0 }]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 6000, noneGraceMs: 300, rng: STEADY },
  );

  assert.equal(result.state, "none");
  assert.equal(result.timedOut, true);
  assert.equal(result.waitMs, 300, "the 6 s budget must not be spent on a page with no AI block");
  assert.equal(result.polls, 4);
});

test("the default budgets are the documented ones", () => {
  assert.equal(DEFAULT_AI_WAIT_MS, 6000);
  // V8.4: a no-AI search pays at most 1.5 s; the constant leaves room for the
  // probe round-trip and the jittered poll on top of the grace itself.
  assert.equal(DEFAULT_NONE_GRACE_MS, 1400);
  assert.ok(DEFAULT_NONE_GRACE_MS < 1500);
});

test("a zero budget probes once and returns (summary:false never waits)", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "answer", chars: 400 }]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 0, rng: STEADY },
  );

  assert.equal(result.state, "answer");
  assert.equal(result.waitMs, 0);
  assert.equal(result.polls, 1);
  assert.equal(clock.durations().length, 0);
});

test("a declared answer shorter than the minimum does not stop the wait", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "answer", chars: 40 }]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 500, rng: STEADY },
  );

  assert.equal(result.state, "answer");
  assert.equal(result.chars, 40);
  assert.equal(result.timedOut, true, "40 chars is not an answer, whatever the probe called it");
  assert.equal(result.waitMs, 500);
});

test("the strongest observation wins: a lead is not erased by a later empty probe", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([
    { state: "lead", chars: 31 },
    { state: "none", chars: 0 },
    { state: "none", chars: 0 },
  ]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 300, noneGraceMs: 0, rng: STEADY },
  );

  assert.equal(result.state, "lead");
  assert.equal(result.chars, 31);
  assert.equal(result.timedOut, true);
});

test("a malformed probe payload is treated as nothing seen, never as an answer", async () => {
  const clock = new FakeClock();
  const result = await waitForAi(
    page(),
    { probe: async () => ({ state: "answer", chars: Number.NaN }) as unknown as AiProbe },
    { clock, pollMs: 100, deadlineMs: 400, noneGraceMs: 200, rng: STEADY },
  );

  assert.equal(result.state, "answer", "the state string is kept, but...");
  assert.equal(result.chars, 0, "...a non-finite width is zero");
  assert.equal(result.timedOut, true);
});

test("an aborted wait fails with E_CANCELLED and names the engine", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  controller.abort(
    new WebSearchError({ code: "E_CANCELLED", stage: "settle", retryable: false, hint: "cancelled", message: "cancelled" }),
  );

  await assert.rejects(
    waitForAi(
      page(),
      { probe: async () => ({ state: "none", chars: 0 }) },
      { clock, signal: controller.signal, engine: "google" },
    ),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CANCELLED");
      assert.equal(error.details.engine, "google");
      return true;
    },
  );
});

test("a probe failure is not swallowed: a torn socket is still a failure", async () => {
  const clock = new FakeClock();
  await assert.rejects(
    waitForAi(
      page(),
      {
        probe: async () => {
          throw new Error("socket closed");
        },
      },
      { clock, engine: "yandex" },
    ),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CDP_DISCONNECTED");
      assert.equal(error.details.engine, "yandex");
      return true;
    },
  );
});
