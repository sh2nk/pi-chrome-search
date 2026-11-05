import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { DEFAULT_CONFIG, type Config, type PacingConfig } from "../../src/config.ts";
import { ENGINE_IDS, type EngineId } from "../../src/engines/types.ts";
import { createLimiter, resolveStatePath } from "../../src/runtime/limiter.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import type { Clock } from "../../src/runtime/types.ts";

interface Waiter {
  settled: boolean;
  resolve(): void;
  reject(): void;
}

/**
 * Deterministic clock. `sleep` parks the caller until the test calls `flush`,
 * so the limiter's virtual wait can be asserted without real time passing.
 */
class FakeClock implements Clock {
  #now: number;
  readonly sleeps: number[] = [];
  readonly #waiters: Waiter[] = [];

  constructor(start = Date.UTC(2026, 0, 5, 9, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  /** Simulate an RTC change / VM resume: the wall clock jumps backwards. */
  rewind(ms: number): void {
    this.#now -= ms;
  }

  setNow(ms: number): void {
    this.#now = ms;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>((resolvePromise, rejectPromise) => {
      if (signal?.aborted) {
        rejectPromise(abortError());
        return;
      }
      const waiter: Waiter = {
        settled: false,
        resolve: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          this.#now += ms;
          resolvePromise();
        },
        reject: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          signal?.removeEventListener("abort", onAbort);
          rejectPromise(abortError());
        },
      };
      const onAbort = (): void => waiter.reject();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  pendingSleeps(): number {
    return this.#waiters.filter((waiter) => !waiter.settled).length;
  }

  /** Let the limiter reach its sleep, then advance virtual time through it. */
  async flush(): Promise<void> {
    for (let guard = 0; guard < 1000; guard += 1) {
      const waiter = this.#waiters.find((candidate) => !candidate.settled);
      if (!waiter) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.pendingSleeps() === 0) return;
        continue;
      }
      waiter.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("FakeClock.flush: sleeps did not drain");
  }

  async waitForSleeps(count: number): Promise<void> {
    for (let attempt = 0; attempt < 200 && this.pendingSleeps() < count; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(this.pendingSleeps(), count, `expected ${count} pending sleep(s)`);
  }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

interface PersistedState {
  version: number;
  day: string;
  engines: Record<EngineId, { lastAt: number | null; today: number }>;
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-chrome-search-limiter-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function statePath(): string {
  return join(tempDir(), "state.json");
}

function testConfig(
  options: { pacing?: Partial<PacingConfig>; caps?: Partial<Record<EngineId, number>> } = {},
): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  if (options.pacing) Object.assign(config.pacing, options.pacing);
  for (const engine of ENGINE_IDS) {
    const cap = options.caps?.[engine];
    if (cap !== undefined) config.engines[engine].dailyCap = cap;
  }
  return config;
}

function seededRng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function sequenceRng(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}

function readState(path: string): PersistedState {
  return JSON.parse(readFileSync(path, "utf8")) as PersistedState;
}

/** Mirror of the limiter's local-day format, computed independently. */
function dayOf(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

test("gap is drawn from the configured [min,max] window and slept virtually", async () => {
  const clock = new FakeClock();
  const path = statePath();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0,
  });

  await limiter.acquire("google");
  assert.deepEqual(clock.sleeps, [], "the first search has nothing to wait for");
  const startedAt = clock.now();

  const pending = limiter.acquire("google");
  await clock.flush();
  await pending;

  assert.deepEqual(clock.sleeps, [2500], "rng 0 must produce the window minimum");
  assert.equal(clock.now() - startedAt, 2500);
  assert.equal(limiter.stats("google").today, 2);
});

test("a seeded rng keeps the gap inside the window and is reproducible", async () => {
  async function gapFor(seed: number): Promise<number> {
    const clock = new FakeClock();
    const limiter = createLimiter({
      config: testConfig({ pacing: { google: [2500, 5000] } }),
      clock,
      statePath: statePath(),
      rng: seededRng(seed),
    });
    await limiter.acquire("google");
    const pending = limiter.acquire("google");
    await clock.flush();
    await pending;
    assert.equal(clock.sleeps.length, 1);
    return clock.sleeps[0] ?? -1;
  }

  const gap = await gapFor(7);
  assert.ok(gap >= 2500 && gap <= 5000, `gap ${gap} outside [2500,5000]`);
  assert.equal(await gapFor(7), gap, "same seed must produce the same gap");
});

test("two sequential acquires sleep the right amount", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: statePath(),
    rng: () => 0.5, // 3750 ms
  });

  await limiter.acquire("google");
  const pending = limiter.acquire("google");
  await clock.flush();
  await pending;

  assert.deepEqual(clock.sleeps, [3750]);
  assert.equal(limiter.stats("google").today, 2);
});

test("concurrent acquires serialize: order and total sleep", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    // draws: initial acquire 0, first concurrent 0, second concurrent 0.5
    clock,
    statePath: statePath(),
    rng: sequenceRng([0, 0, 0.5]),
  });

  await limiter.acquire("google");

  const order: number[] = [];
  const first = limiter.acquire("google").then(() => {
    order.push(1);
  });
  const second = limiter.acquire("google").then(() => {
    order.push(2);
  });

  await clock.flush();
  await Promise.all([first, second]);

  assert.deepEqual(order, [1, 2], "the queue must preserve call order");
  assert.deepEqual(clock.sleeps, [2500, 3750]);
  assert.equal(clock.sleeps.reduce((sum, ms) => sum + ms, 0), 6250);
  assert.equal(limiter.stats("google").today, 3);
});

test("the daily cap throws E_RATE_LIMITED before any sleep", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: testConfig({ caps: { google: 1 } }),
    clock,
    statePath: statePath(),
    rng: () => 0.5,
  });

  await limiter.acquire("google");
  assert.deepEqual(clock.sleeps, []);

  await assert.rejects(
    limiter.acquire("google"),
    (error: unknown) => {
      assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
      assert.equal(error.details.code, "E_RATE_LIMITED");
      assert.equal(error.details.engine, "google");
      assert.equal(error.details.stage, "navigate");
      assert.equal(error.details.retryable, true);
      assert.match(error.details.hint, /local day reset/);
      assert.match(error.details.hint, /another engine/);
      return true;
    },
  );

  assert.deepEqual(clock.sleeps, [], "a capped engine must not sleep first");
  assert.equal(limiter.stats("google").today, 1);
});

test("a new local day resets today but keeps lastAt", async () => {
  const clock = new FakeClock(Date.UTC(2026, 0, 5, 9, 0, 0));
  const path = statePath();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      day: "2000-01-01",
      engines: {
        google: { lastAt: clock.now() - 10_000, today: 1 },
        duckduckgo: { lastAt: null, today: 0 },
        yandex: { lastAt: null, today: 0 },
      },
    }),
    "utf8",
  );

  const limiter = createLimiter({
    config: testConfig({ caps: { google: 1 }, pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0.5,
  });

  assert.equal(limiter.stats("google").today, 0, "stats projects the new day");
  await limiter.acquire("google");

  assert.equal(limiter.stats("google").today, 1);
  assert.deepEqual(clock.sleeps, [], "lastAt survived the rollover but 10 s already elapsed");
  assert.equal(readState(path).day, dayOf(clock.now()));
});

test("state survives a new limiter instance on the same file", async () => {
  const clock = new FakeClock();
  const path = statePath();
  const config = testConfig({ pacing: { google: [2500, 5000] } });
  const first = createLimiter({ config, clock, statePath: path, rng: () => 0.5 });

  await first.acquire("google");
  const lastAt = first.stats("google").lastAt;
  assert.ok(lastAt !== null);

  const second = createLimiter({ config, clock, statePath: path, rng: () => 0.5 });
  assert.equal(second.statePath(), path);
  assert.equal(second.stats("google").today, 1);
  assert.equal(second.stats("google").lastAt, lastAt);

  const pending = second.acquire("google");
  await clock.flush();
  await pending;

  assert.deepEqual(clock.sleeps, [3750], "the restored lastAt must still gate the gap");
  assert.equal(second.stats("google").today, 2);
});

test("a corrupt state file starts fresh and is rewritten", async () => {
  const clock = new FakeClock();
  const path = statePath();
  writeFileSync(path, "{ this is not json", "utf8");

  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0.5,
  });

  const pending = limiter.acquire("google");
  await clock.flush();
  await pending;

  assert.equal(limiter.stats("google").today, 1);
  const persisted = readState(path);
  assert.equal(persisted.version, 1);
  assert.equal(persisted.day, dayOf(clock.now()));
  assert.equal(persisted.engines.google.today, 1);
});

test("an abort during the sleep is E_CANCELLED and consumes no daily slot", async () => {
  const clock = new FakeClock();
  const path = statePath();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0.5,
  });

  await limiter.acquire("google");

  const controller = new AbortController();
  const pending = limiter.acquire("google", controller.signal);
  await clock.waitForSleeps(1);
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CANCELLED",
  );

  assert.equal(limiter.stats("google").today, 1, "the aborted call must not count");
  assert.equal(readState(path).engines.google.today, 1);
  assert.deepEqual(clock.sleeps, [3750]);
});

test("the state file is valid JSON with mode 0600 and no temp file left behind", async () => {
  const clock = new FakeClock();
  const path = statePath();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0.5,
  });

  await limiter.acquire("google");

  const mode = statSync(path).mode & 0o777;
  assert.equal(mode & 0o077, 0, `state file must not be group/world accessible (mode ${mode.toString(8)})`);

  const persisted = readState(path);
  assert.equal(persisted.version, 1);
  assert.equal(typeof persisted.day, "string");
  assert.deepEqual(Object.keys(persisted.engines).sort(), ["duckduckgo", "google", "yandex"]);
  assert.equal(persisted.engines.google.today, 1);
  assert.equal(typeof persisted.engines.google.lastAt, "number");
  assert.equal(persisted.engines.duckduckgo.lastAt, null);

  assert.throws(() => statSync(`${path}.tmp`), /ENOENT/);
});

test("the default state path is derived from PI_CODING_AGENT_DIR", () => {
  assert.equal(
    resolveStatePath({ PI_CODING_AGENT_DIR: "/tmp/agentdir" }),
    "/tmp/agentdir/web-search/state.json",
  );
  assert.match(resolveStatePath({}), /\.pi\/agent\/web-search\/state\.json$/);
});

const DAY_MS = 86_400_000;

function isCancelled(error: unknown): boolean {
  return isWebSearchError(error) && error.details.code === "E_CANCELLED";
}

test("one engine's gap does not delay another engine", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000], yandex: [5000, 9000] } }),
    clock,
    statePath: statePath(),
    rng: () => 0,
  });

  await limiter.acquire("google");

  let googleDone = false;
  const google = limiter.acquire("google").then(() => {
    googleDone = true;
  });
  await clock.waitForSleeps(1);
  assert.equal(clock.pendingSleeps(), 1, "google is pacing");

  // Yandex has never run, so it must not wait behind google's sleep. `run` is
  // synchronous up to its save, so one macrotask is enough to settle it; the
  // test would hang on `await yandex` if the queues were shared.
  let yandexDone = false;
  const yandex = limiter.acquire("yandex").then(() => {
    yandexDone = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(yandexDone, true, "yandex must resolve without waiting for google");
  assert.equal(googleDone, false, "google must still be sleeping");
  assert.equal(clock.pendingSleeps(), 1, "only google's sleep is pending");
  assert.equal(limiter.stats("yandex").today, 1);

  await yandex;
  await clock.flush();
  await google;
  assert.deepEqual(clock.sleeps, [2500], "yandex introduced no sleep");
});

test("dailyCap 0 means unlimited", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: testConfig({ caps: { google: 0 }, pacing: { google: [0, 0] } }),
    clock,
    statePath: statePath(),
    rng: () => 0.5,
  });

  for (let index = 0; index < 5; index += 1) {
    await limiter.acquire("google");
  }

  assert.equal(limiter.stats("google").today, 5);
  assert.equal(limiter.stats("google").dailyCap, 0);
  assert.deepEqual(clock.sleeps, [], "a zero gap window never sleeps");
});

test("an acquire with an already-aborted signal fails before touching state", async () => {
  const clock = new FakeClock();
  const path = statePath();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0.5,
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(limiter.acquire("google", controller.signal), isCancelled);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(limiter.stats("google").today, 0);
  assert.equal(limiter.stats("google").lastAt, null);
  assert.throws(() => statSync(path), /ENOENT/, "an aborted call must not create the state file");
});

test("a pre-aborted acquire rejects while the one ahead of it is still sleeping", async () => {
  const clock = new FakeClock();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: statePath(),
    rng: () => 0.5,
  });

  await limiter.acquire("google");

  let firstDone = false;
  const first = limiter.acquire("google").then(() => {
    firstDone = true;
  });
  await clock.waitForSleeps(1);

  const controller = new AbortController();
  controller.abort();

  // No `flush`, no `setImmediate`: awaiting the rejection itself proves the
  // pre-aborted call did not queue behind the pending sleep.
  await assert.rejects(limiter.acquire("google", controller.signal), isCancelled);
  assert.equal(firstDone, false, "the first acquire must still be sleeping");
  assert.equal(clock.pendingSleeps(), 1);

  await clock.flush();
  await first;
  assert.deepEqual(clock.sleeps, [3750]);
  assert.equal(limiter.stats("google").today, 2, "only the queued acquire consumed a slot");
});

test("a 1 h clock step-back repairs lastAt instead of sleeping for the skew", async (t) => {
  const clock = new FakeClock();
  const path = statePath();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0.5,
  });

  await limiter.acquire("google");
  const acquiredAt = clock.now();
  clock.rewind(3_600_000);

  const startedAt = process.hrtime.bigint();
  await limiter.acquire("google");
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  // 1 h skew + 2500 ms gap = 3,602,500 ms under the old policy.
  t.diagnostic(
    `1 h step-back: slept ${clock.sleeps.length === 0 ? 0 : String(clock.sleeps)} ms ` +
      `(old policy: 3,602,500 ms); real elapsed ${elapsedMs.toFixed(2)} ms`,
  );

  assert.deepEqual(clock.sleeps, [], "the skew must not be slept through");
  assert.equal(clock.now(), acquiredAt - 3_600_000, "virtual time must not advance");
  assert.equal(limiter.stats("google").lastAt, clock.now());
  assert.equal(limiter.stats("google").today, 2);

  const persisted = readState(path);
  assert.equal(persisted.engines.google.lastAt, clock.now(), "the correction must be persisted");
  assert.equal(persisted.engines.google.today, 2);

  // Normal pacing resumes from the corrected timestamp.
  const next = limiter.acquire("google");
  await clock.flush();
  await next;
  assert.deepEqual(clock.sleeps, [3750], "the next acquire uses the normal gap");
});

test("a state file with lastAt 24 h in the future resolves immediately", async (t) => {
  const now = Date.UTC(2026, 0, 5, 9, 0, 0);
  const clock = new FakeClock(now);
  const path = statePath();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      day: dayOf(now),
      engines: {
        google: { lastAt: now + DAY_MS, today: 1 },
        duckduckgo: { lastAt: null, today: 0 },
        yandex: { lastAt: null, today: 0 },
      },
    }),
    "utf8",
  );

  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0,
  });

  const startedAt = process.hrtime.bigint();
  await limiter.acquire("google");
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  // A future lastAt + the 2500 ms gap asks for 86,402,500 ms under the old
  // policy; the repair must resolve without a single sleep.
  t.diagnostic(
    `24 h-ahead state: slept ${clock.sleeps.length === 0 ? 0 : String(clock.sleeps)} ms ` +
      `(old policy: 86,402,500 ms); real elapsed ${elapsedMs.toFixed(2)} ms`,
  );

  assert.deepEqual(clock.sleeps, []);
  assert.equal(clock.now(), now, "no virtual time may pass");
  assert.equal(limiter.stats("google").today, 2);

  const persisted = readState(path);
  assert.equal(persisted.engines.google.lastAt, now, "the future timestamp must be replaced");
  assert.equal(persisted.engines.google.today, 2);
});

test("stats() repairs a future lastAt instead of reporting it", () => {
  const now = Date.UTC(2026, 0, 5, 9, 0, 0);
  const clock = new FakeClock(now);
  const path = statePath();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      day: dayOf(now),
      engines: {
        google: { lastAt: now + DAY_MS, today: 2 },
        duckduckgo: { lastAt: now + DAY_MS, today: 0 },
        yandex: { lastAt: null, today: 0 },
      },
    }),
    "utf8",
  );

  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [2500, 5000] } }),
    clock,
    statePath: path,
    rng: () => 0,
  });

  assert.equal(readState(path).engines.google.lastAt, now + DAY_MS, "precondition: the file is skewed");

  // No acquire: the doctor calls stats() first and must not see a timestamp
  // 24 h ahead.
  const stats = limiter.stats("google");
  assert.ok(stats.lastAt !== null);
  assert.ok(stats.lastAt <= clock.now(), `stats().lastAt ${stats.lastAt} must not be in the future`);
  assert.equal(stats.lastAt, now, "the skew is reset to now, exactly like acquire");
  assert.equal(stats.today, 2, "repairing the timestamp must not touch the count");
  assert.deepEqual(clock.sleeps, [], "stats() must never sleep");

  assert.equal(readState(path).engines.google.lastAt, now, "the correction must be persisted");
  assert.equal(
    readState(path).engines.duckduckgo.lastAt,
    now + DAY_MS,
    "an engine that was not queried keeps its own state until stats() asks for it",
  );

  // Querying the other engine repairs it too, so /web-doctor converges.
  assert.equal(limiter.stats("duckduckgo").lastAt, now);
  assert.equal(readState(path).engines.duckduckgo.lastAt, now);

  // A second stats() call is a no-op: the value is already sane.
  assert.equal(limiter.stats("google").lastAt, now);
});

test("concurrent cross-engine acquires leave a valid state file with all counts", async () => {
  const clock = new FakeClock();
  const path = statePath();
  const limiter = createLimiter({
    config: testConfig({ pacing: { google: [0, 0], duckduckgo: [0, 0], yandex: [0, 0] } }),
    clock,
    statePath: path,
    rng: () => 0,
  });

  await Promise.all([limiter.acquire("google"), limiter.acquire("duckduckgo"), limiter.acquire("yandex")]);

  const persisted = readState(path);
  assert.deepEqual(persisted.engines, {
    google: { lastAt: clock.now(), today: 1 },
    duckduckgo: { lastAt: clock.now(), today: 1 },
    yandex: { lastAt: clock.now(), today: 1 },
  });
  assert.equal(persisted.day, dayOf(clock.now()));
  assert.throws(() => statSync(`${path}.tmp`), /ENOENT/, "no temp file may be left behind");
  assert.equal(limiter.stats("google").today, 1);
  assert.equal(limiter.stats("duckduckgo").today, 1);
  assert.equal(limiter.stats("yandex").today, 1);
});

