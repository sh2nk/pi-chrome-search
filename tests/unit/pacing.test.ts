/**
 * Politeness is pacing, not a counter (S10.1, S10.2, SPEC D8; PLAN P7).
 *
 * The limiter is the only thing between an eager agent and a burst of searches
 * on the user's own IP, so every property here is asserted on a virtual clock:
 *
 *  - the configured windows are the documented ones (2.5–5 s, 2–4 s, 5–9 s);
 *  - the first search of an engine never waits, and a later one never fires
 *    before its jittered gap has elapsed (a "minimum gap" that is sometimes
 *    skipped is not politeness);
 *  - the gap is a fresh draw inside the window, so the rhythm is not metronomic,
 *    and a hostile rng cannot escape the window;
 *  - callers on one engine are serialized in arrival order, per engine in
 *    parallel with every other engine;
 *  - there is no daily cap and no persisted state: a thousand acquisitions in
 *    one virtual day all resolve, and a forward clock jump changes nothing;
 *  - an abort rejects with `E_CANCELLED` and never poisons the queue behind it;
 *  - a `lastAt` in the future is clock skew, not an hour-long sleep.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, type Config, type PacingWindow } from "../../src/config/index.ts";
import { ENGINE_IDS, type EngineId } from "../../src/engines/types.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { createLimiter } from "../../src/runtime/limiter.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { FakeClock } from "../helpers/fake-cdp.ts";
import { createEngineStub, createHarness } from "../helpers/search-harness.ts";

const DAY_MS = 86_400_000;

/** The documented pacing windows (S10.1). */
const DOCUMENTED: Record<EngineId, PacingWindow> = {
  google: [2500, 5000],
  duckduckgo: [2000, 4000],
  yandex: [5000, 9000],
};

function pacingConfig(overrides: Partial<Record<EngineId, PacingWindow>> = {}): Config {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.pacing = { ...DOCUMENTED, ...overrides };
  return config;
}

/** Deterministic rng that replays `values` and then repeats the last one. */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}

/** Let queued microtasks run without touching the virtual clock. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the promise to reject");
}

function errorCode(error: unknown): string {
  assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
  return error.details.code;
}

test("S10.1 the shipped pacing windows are the documented ones", () => {
  assert.deepEqual(DEFAULT_CONFIG.pacing, DOCUMENTED);
  assert.deepEqual([...ENGINE_IDS], ["google", "duckduckgo", "yandex"], "Yandex last in the canonical order");
});

test("S10.1 the first search of an engine never waits", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({ config: pacingConfig(), clock, rng: () => 0.5 });

  await limiter.acquire("google");

  assert.deepEqual(clock.durations(), [], "nothing to wait for on the first search");
  assert.equal(limiter.stats("google").lastAt, clock.now());
});

test("S10.1 the second search waits the jittered gap and never fires early", async () => {
  const clock = new FakeClock();
  // rng 0.5 over [2500, 5000] is a 3750 ms gap.
  const limiter = createLimiter({ config: pacingConfig(), clock, rng: () => 0.5 });

  await limiter.acquire("google");
  const firstAt = clock.now();
  await limiter.acquire("google");

  assert.deepEqual(clock.durations(), [3750], "exactly the remaining part of the gap");
  assert.equal(clock.now() - firstAt, 3750);

  // A caller that arrives late only waits what is left, never a full gap again.
  clock.advance(1000);
  const lateAt = clock.now();
  await limiter.acquire("google");
  assert.equal(clock.now() - lateAt, 2750);
  assert.ok(clock.durations().at(-1)! >= 0);
  assert.ok(lateAt - firstAt + 2750 >= DOCUMENTED.google[0], "spacing from the previous search stays above the floor");
});

test("S10.1 every rng draw lands inside the configured window", async () => {
  for (const [engine, window] of Object.entries(DOCUMENTED) as Array<[EngineId, PacingWindow]>) {
    for (const draw of [0, 0.0001, 0.25, 0.5, 0.75, 0.9999]) {
      const clock = new FakeClock();
      const limiter = createLimiter({ config: pacingConfig(), clock, rng: () => draw });
      await limiter.acquire(engine);
      const startedAt = clock.now();
      await limiter.acquire(engine);
      const gap = clock.now() - startedAt;
      const [min, max] = window;
      assert.ok(gap >= min && gap <= max, `${engine} ${draw}: ${gap} outside ${min}..${max}`);
      assert.equal(gap, Math.round(min + draw * (max - min)), `${engine} ${draw}: the draw decides the gap`);
    }
  }
});

test("S10.1 the gap is jittered, not metronomic", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: pacingConfig(),
    clock,
    rng: sequence([0.5, 0, 0.9, 0.2, 0.7]),
  });

  const gaps: number[] = [];
  let previous = clock.now();
  for (let call = 0; call < 5; call += 1) {
    await limiter.acquire("google");
    gaps.push(clock.now() - previous);
    previous = clock.now();
  }

  // The first gap belongs to a sample drawn before any search, so compare the
  // observed gaps to each other, not to a constant.
  const observed = gaps.slice(1);
  assert.ok(new Set(observed).size > 1, `expected varied gaps, got ${JSON.stringify(observed)}`);
  for (const gap of observed) assert.ok(gap >= 2500 && gap <= 5000, `gap ${gap} escaped the window`);
});

test("S10.1 a broken rng is clamped into the window instead of producing a burst or a hang", async () => {
  const cases: Array<[number, number]> = [
    [Number.NaN, 2500],
    [Number.POSITIVE_INFINITY, 2500],
    [-3, 2500],
    [5, 5000],
    [1, 5000],
  ];
  for (const [draw, expected] of cases) {
    const clock = new FakeClock();
    const limiter = createLimiter({ config: pacingConfig(), clock, rng: () => draw });
    await limiter.acquire("google");
    const startedAt = clock.now();
    await limiter.acquire("google");
    assert.equal(clock.now() - startedAt, expected, `rng ${draw}`);
  }
});

test("S10.2 concurrent callers on one engine are serialized, not merged", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  // Draw 1 (5000 ms) is consumed by the first, immediate search; draw 2 is 9000.
  const limiter = createLimiter({ config: pacingConfig(), clock, rng: sequence([0, 1]) });

  await limiter.acquire("yandex");
  let done = false;
  const second = limiter.acquire("yandex").then(() => {
    done = true;
  });
  await tick();

  assert.deepEqual(clock.durations(), [9000], "the second caller computed its gap after the first updated lastAt");
  assert.equal(clock.pendingCount(), 1);
  assert.equal(done, false);

  clock.advance(8999);
  await tick();
  assert.equal(done, false, "one millisecond early is early");

  clock.advance(1);
  await second;
  assert.equal(done, true);
});

test("S10.1 pacing on one engine does not delay another", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: pacingConfig({ google: [100, 200], yandex: [5000, 9000] }),
    clock,
    rng: () => 0,
  });

  await limiter.acquire("google");
  await limiter.acquire("yandex");
  assert.deepEqual(clock.durations(), [], "different engines have independent gaps");

  await limiter.acquire("google");
  await limiter.acquire("yandex");

  assert.deepEqual(clock.durations(), [100, 4900], "each engine waits only for its own window");
});

test("S10.1/D8 there is no daily cap and no persisted rate state", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: pacingConfig({ google: [0, 0], duckduckgo: [0, 0], yandex: [0, 0] }),
    clock,
    rng: () => 0,
  });

  for (let call = 0; call < 400; call += 1) await limiter.acquire("google");

  // A thousand searches are a policy statement, not an unmeasured guess: they
  // all resolve. The counter is observability for the anchor panel, never a gate.
  assert.equal(limiter.stats("google").today, 400);
  assert.equal(limiter.stats("yandex").today, 0);
  assert.deepEqual(clock.durations(), [], "no wait was invented for a full day's quota");

  clock.advance(DAY_MS);
  await limiter.acquire("google");
  assert.equal(limiter.stats("google").today, 401, "a new day neither resets nor blocks anything");
});

test("S10.1 stats are read-only observations, not a reservation", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({ config: pacingConfig(), clock, rng: () => 0.5 });

  const before = clock.now();
  const stats = limiter.stats("duckduckgo");
  assert.equal(stats.engine, "duckduckgo");
  assert.equal(stats.today, 0);
  assert.equal(stats.lastAt, null);
  assert.equal(clock.now(), before, "reading stats must not advance or sleep the clock");
});

test("S10.1 an already-aborted caller fails at once instead of queueing behind a sleep", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const limiter = createLimiter({ config: pacingConfig(), clock, rng: () => 0 });

  await limiter.acquire("google");
  const controller = new AbortController();
  controller.abort();

  const error = await rejection(limiter.acquire("google", controller.signal));
  assert.equal(errorCode(error), "E_CANCELLED");
  assert.deepEqual(clock.durations(), [], "an aborted call never starts a pacing sleep");
});

test("S10.2 an abort during the wait is E_CANCELLED and does not poison the queue", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const limiter = createLimiter({ config: pacingConfig(), clock, rng: () => 0 });

  await limiter.acquire("google");
  const controller = new AbortController();
  const cancelled = limiter.acquire("google", controller.signal).then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
  await tick();
  assert.deepEqual(clock.durations(), [2500]);

  controller.abort();
  const error = await cancelled;
  assert.equal(errorCode(error), "E_CANCELLED");

  // The tail is not rejected: the next caller waits its own gap and proceeds.
  const next = limiter.acquire("google");
  await tick();
  clock.advance(2500);
  await next;
  assert.equal(limiter.stats("google").today, 2, "the aborted call never counted as a search");
});

test("S10.1 a lastAt in the future is clock skew, not a hang", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({ config: pacingConfig(), clock, rng: () => 0.5 });

  await limiter.acquire("google");
  // An RTC correction or a VM resumed from a snapshot moves `now` backwards.
  clock.setNow(clock.now() - 3_600_000);

  const startedAt = clock.now();
  await limiter.acquire("google");

  assert.equal(clock.now(), startedAt, "no sleep for a stamp that never happened");
  assert.deepEqual(clock.durations(), []);
  assert.equal(limiter.stats("google").lastAt, startedAt, "the stale stamp was repaired to now");
});

test("S10.2 one in-flight live search per engine: two tool calls never overlap", async () => {
  const google = createEngineStub("google");
  let inFlight = 0;
  let peak = 0;
  let extractions = 0;
  google.extractImpl = async (query) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // Yield twice: a second attempt would be visible here if it were allowed in.
    await Promise.resolve();
    await Promise.resolve();
    inFlight -= 1;
    extractions += 1;
    return {
      engine: "google",
      query: query.text,
      results: [{ title: query.text, url: `https://google.example.test/${extractions}`, snippet: "s" }],
      pageCarried: false,
      timings: {},
    };
  };
  const rig = createHarness({ engines: [google] });
  const tool = createWebSearchTool(async () => rig.deps);

  const [first, second] = await Promise.all([
    tool.execute("call-1", { q: "first query", engines: "google" }, undefined, undefined),
    tool.execute("call-2", { q: "second query", engines: "google" }, undefined, undefined),
  ]);

  assert.equal("isError" in first, false);
  assert.equal("isError" in second, false);
  assert.equal(extractions, 2, "both searches really ran");
  assert.equal(peak, 1, "the second call queued on the engine tab instead of reading the same document");
});
