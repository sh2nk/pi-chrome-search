/**
 * P2-C unit tests: human-like search primitives (SPEC §5.4).
 *
 * Everything is offline and virtual-time: `FakePage` records every click,
 * keystroke delay, press, scroll and focus call, and `FakeClock` owns all
 * sleeps. A test that passed by actually sleeping would fail the "no real time
 * elapsed" case below.
 *
 * The engine constants mirror SPEC §5.4 on purpose (30–80 ms/char, 300–900 px,
 * poll jitter ±25%); importing them from the module under test would make the
 * assertions tautological.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CdpPage } from "../../src/cdp/types.ts";
import {
  humanScroll,
  humanSearch,
  waitForMarker,
  type HumanSearchOptions,
} from "../../src/cdp/humanize.ts";
import { WebSearchError, isWebSearchError } from "../../src/runtime/error-codes.ts";
import { fail } from "../../src/runtime/errors.ts";
import { FakeClock } from "../helpers/clock.ts";
import { FakePage, type EvaluateHandler } from "../helpers/fake-page.ts";

const HOME = "https://search.example.test/";
const SERP = "https://search.example.test/search?q=example";
const MARKER = "Search results";
const BOX_SELECTORS = ["#missing-box", "input[name=q]"];
/** rng 0.4 → scroll 540 px, pause 90 ms; used to keep every fixture deterministic. */
const FIXED_RNG = (): number => 0.4;

// ---------------------------------------------------------------------------
// DOM/evaluate model
// ---------------------------------------------------------------------------

const COUNT_RE = /document\.querySelectorAll\(("(?:[^"\\]|\\.)*")\)\.length/;
const EXISTS_RE = /document\.querySelector\(("(?:[^"\\]|\\.)*")\)/;

interface DomModel {
  /** Selectors that `document.querySelector` finds. */
  boxes?: readonly string[];
  /** Per-selector `querySelectorAll(...).length`; missing means 0. */
  counts?: Readonly<Record<string, number>>;
}

/**
 * Answers the two expressions `humanize` emits. Anything else returns `null`,
 * like a document that matched nothing.
 */
function domEvaluate(model: DomModel = {}): EvaluateHandler {
  return (expression) => {
    const counted = COUNT_RE.exec(expression);
    if (counted !== null) {
      const selector = JSON.parse(counted[1]!) as string;
      return model.counts?.[selector] ?? 0;
    }
    const exists = EXISTS_RE.exec(expression);
    if (exists !== null) {
      const selector = JSON.parse(exists[1]!) as string;
      return (model.boxes ?? []).includes(selector);
    }
    return null;
  };
}

function makeOptions(
  page: FakePage,
  clock: FakeClock,
  overrides: Partial<HumanSearchOptions> = {},
): HumanSearchOptions {
  return {
    page,
    query: "example query",
    homeUrl: HOME,
    serpUrl: SERP,
    boxSelectors: [...BOX_SELECTORS],
    marker: MARKER,
    engine: "google",
    mode: "auto",
    firstInSession: true,
    focus: "session",
    clock,
    rng: FIXED_RNG,
    ...overrides,
  };
}

function callKinds(page: FakePage): string[] {
  return page.calls().map((call) => call.kind);
}

/** Yield to the event loop until `condition()` holds; for pending-sleep tests. */
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`condition never became true: ${label}`);
}

/**
 * Guard against a test that would otherwise hang the whole file: a real 2 s
 * timer fails it instead. This is a harness safety net, not the module's sleep.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`test timed out after ${timeoutMs} ms`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

/** Catch a rejection and prove it is a `WebSearchError`, so tests read as one assertion. */
async function rejectionOf(promise: Promise<unknown>): Promise<WebSearchError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the call to reject");
}

// ---------------------------------------------------------------------------
// humanSearch — typed path
// ---------------------------------------------------------------------------

test("first search of a session types into the box and presses Enter", async () => {
  const clock = new FakeClock({ now: 1_000 });
  let page!: FakePage;
  page = new FakePage({
    url: HOME,
    // The marker only exists after typing, so the settle wait proves ordering.
    text: () => (page.calls("typeText").length > 0 ? `Results: ${MARKER}` : "home page"),
    clock,
    random: () => 0.5,
    evaluate: domEvaluate({ boxes: ["input[name=q]"] }),
  });

  const result = await humanSearch(makeOptions(page, clock));

  // 0.5 → 30 + floor(0.5 * 51) = 55 ms per character, 13 characters.
  assert.deepEqual(page.typedTexts(), ["example query"]);
  assert.equal(page.typeDelays().length, [..."example query"].length);
  for (const delay of page.typeDelays()) assert.ok(delay >= 30 && delay <= 80, `delay ${delay}`);
  const typed = page.calls("typeText")[0];
  assert.equal(typed?.minMs, 30);
  assert.equal(typed?.maxMs, 80);

  // Candidates are tried in order: the missing one is skipped, the real box is clicked.
  assert.deepEqual(page.clicks(), ["input[name=q]"]);
  assert.deepEqual(page.presses(), ["Enter"]);
  assert.deepEqual(page.navigations(), [HOME]);

  // Click → type → Enter, never Enter before the query exists.
  const kinds = callKinds(page);
  const clickAt = kinds.indexOf("click");
  const typeAt = kinds.indexOf("typeText");
  const pressAt = kinds.indexOf("press");
  assert.ok(clickAt >= 0 && clickAt < typeAt && typeAt < pressAt, kinds.join(","));

  // Focus happened once (policy "session", first search), before navigation.
  assert.equal(page.bringToFrontCount(), 1);
  assert.equal(page.calls("bringToFront")[0]?.seq, 1);
  assert.equal(page.calls("navigate")[0]?.seq, 2);

  // Marker was already there by the time we settled → no poll sleeps.
  // The only sleeps are the 13 keystroke delays plus the scroll pause.
  assert.deepEqual(clock.durations(), [...Array(13).fill(55), 90]);
  assert.deepEqual(result, {
    typed: true,
    typedPath: true,
    focused: true,
    settleMs: 0,
    scrollPx: 540,
    fellBackToSerp: false,
  });

  // The scroll happens after the query was submitted, i.e. before extraction.
  assert.deepEqual(page.scrolls(), [540]);
  assert.ok((page.calls("scroll")[0]?.seq ?? 0) > (page.calls("press")[0]?.seq ?? 0));
});

test("later searches navigate the SERP URL directly and do not focus or type", async () => {
  const clock = new FakeClock({ now: 5_000 });
  const page = new FakePage({
    url: "about:blank",
    text: `Results: ${MARKER}`,
    clock,
    evaluate: domEvaluate({ boxes: ["input[name=q]"] }),
  });

  const result = await humanSearch(makeOptions(page, clock, { firstInSession: false }));

  assert.deepEqual(page.navigations(), [SERP]);
  assert.deepEqual(page.clicks(), []);
  assert.deepEqual(page.typedTexts(), []);
  assert.deepEqual(page.presses(), []);
  assert.equal(page.bringToFrontCount(), 0);
  assert.deepEqual(clock.durations(), [90]); // only the scroll pause

  assert.deepEqual(result, {
    typed: false,
    typedPath: false,
    focused: false,
    settleMs: 0,
    scrollPx: 540,
    fellBackToSerp: false,
  });
});

test('mode "always" types on every search, not just the first', async () => {
  const clock = new FakeClock();
  let page!: FakePage;
  page = new FakePage({
    url: HOME,
    text: () => (page.calls("typeText").length > 0 ? MARKER : "home page"),
    clock,
    random: () => 0.5,
    evaluate: domEvaluate({ boxes: ["input[name=q]"] }),
  });

  const result = await humanSearch(
    makeOptions(page, clock, { mode: "always", firstInSession: false, focus: "session" }),
  );

  assert.equal(result.typed, true);
  assert.equal(result.typedPath, true);
  assert.equal(result.focused, false); // focus is a separate policy
  assert.deepEqual(page.navigations(), [HOME]);
  assert.deepEqual(page.clicks(), ["input[name=q]"]);
  assert.deepEqual(page.typedTexts(), ["example query"]);
  assert.deepEqual(page.presses(), ["Enter"]);
  assert.equal(page.bringToFrontCount(), 0);
});

// ---------------------------------------------------------------------------
// humanSearch — focus policies
// ---------------------------------------------------------------------------

test("focus policy: always every call, session only the first, never zero", async () => {
  const alwaysClock = new FakeClock();
  const alwaysPage = new FakePage({ text: MARKER, evaluate: domEvaluate({ boxes: ["input[name=q]"] }) });
  await humanSearch(makeOptions(alwaysPage, alwaysClock, { focus: "always", firstInSession: false }));
  await humanSearch(makeOptions(alwaysPage, alwaysClock, { focus: "always", firstInSession: false }));
  assert.equal(alwaysPage.bringToFrontCount(), 2);

  const sessionClock = new FakeClock();
  const sessionPage = new FakePage({ text: MARKER, evaluate: domEvaluate({ boxes: ["input[name=q]"] }) });
  const first = await humanSearch(makeOptions(sessionPage, sessionClock, { firstInSession: true }));
  const second = await humanSearch(makeOptions(sessionPage, sessionClock, { firstInSession: false }));
  assert.equal(first.focused, true);
  assert.equal(second.focused, false);
  assert.equal(sessionPage.bringToFrontCount(), 1);

  const neverClock = new FakeClock();
  const neverPage = new FakePage({ text: MARKER, evaluate: domEvaluate({ boxes: ["input[name=q]"] }) });
  const never = await humanSearch(
    makeOptions(neverPage, neverClock, { focus: "never", firstInSession: true }),
  );
  assert.equal(never.focused, false);
  assert.equal(neverPage.bringToFrontCount(), 0);
});

// ---------------------------------------------------------------------------
// waitForMarker
// ---------------------------------------------------------------------------

test("waitForMarker resolves instantly when the marker is already present", async () => {
  const clock = new FakeClock({ now: 42_000 });
  const page = new FakePage({ text: `before ${MARKER} after` });

  const settleMs = await waitForMarker(page, { marker: MARKER, clock, deadlineMs: 8_000 });

  assert.equal(settleMs, 0);
  assert.equal(clock.sleepLog().length, 0);
  assert.equal(page.callCount("innerText"), 1);
  assert.equal(page.callCount("evaluate"), 0);
});

test("waitForMarker polls, and settleMs equals the virtual time it consumed", async () => {
  const clock = new FakeClock();
  const start = clock.now();
  let reads = 0;
  const page = new FakePage({
    text: () => (reads++ >= 3 ? `ready ${MARKER}` : "loading…"),
  });

  const settleMs = await waitForMarker(page, { marker: MARKER, clock, pollMs: 150 });

  // Three misses → three jittered sleeps, then a present marker.
  const slept = clock.sleepLog();
  assert.equal(slept.length, 3);
  assert.equal(settleMs, clock.totalSleptMs());
  assert.equal(settleMs, clock.now() - start);
  assert.ok(settleMs > 0);
  for (const record of slept) {
    assert.ok(record.ms >= 150 * 0.75 && record.ms <= 150 * 1.25, `poll slept ${record.ms} ms`);
  }
  assert.equal(page.callCount("innerText"), 4);
});

test("waitForMarker honours selector and minCount (default 1)", async () => {
  const clock = new FakeClock();
  let evaluations = 0;
  const page = new FakePage({
    text: MARKER,
    evaluate: () => (evaluations++ < 2 ? 2 : 3),
  });

  const settleMs = await waitForMarker(page, {
    marker: MARKER,
    selector: "#result",
    minCount: 3,
    clock,
    pollMs: 100,
  });

  assert.equal(evaluations, 3);
  assert.equal(clock.sleepLog().length, 2);
  assert.ok(settleMs > 0);

  // minCount defaults to 1: a single match is enough, with no sleep.
  const instantClock = new FakeClock();
  const oneCount = new FakePage({ text: MARKER, evaluate: () => 1 });
  const instant = await waitForMarker(oneCount, {
    marker: MARKER,
    selector: "#result",
    clock: instantClock,
  });
  assert.equal(instant, 0);
  assert.equal(instantClock.sleepLog().length, 0);
});

test("waitForMarker raises E_TIMEOUT with the doctor hint on the deadline", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ text: "still loading" });

  await assert.rejects(
    () => waitForMarker(page, { marker: MARKER, clock, deadlineMs: 500, pollMs: 100 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
      assert.equal(error.details.code, "E_TIMEOUT");
      assert.equal(error.details.stage, "settle");
      assert.equal(error.details.retryable, true);
      assert.ok(error.details.hint.includes("/web-doctor"), error.details.hint);
      assert.match(error.details.message ?? "", /marker/);
      return true;
    },
  );

  // Deadline plus at most one jittered poll; virtual time only.
  assert.ok(clock.totalSleptMs() >= 500, `slept ${clock.totalSleptMs()} ms`);
  assert.ok(clock.totalSleptMs() < 625, `slept ${clock.totalSleptMs()} ms`);
});

test("waitForMarker reports the failing selector in the timeout message", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ text: MARKER, evaluate: () => 1 });

  await assert.rejects(
    () =>
      waitForMarker(page, {
        marker: MARKER,
        selector: "#result",
        minCount: 2,
        clock,
        deadlineMs: 200,
        pollMs: 100,
      }),
    (error: unknown) =>
      isWebSearchError(error) &&
      error.details.code === "E_TIMEOUT" &&
      /selector #result/.test(error.details.message ?? ""),
  );
});

test("waitForMarker maps abort to E_CANCELLED, before and during a poll sleep", async () => {
  // Already aborted: no page read, no sleep.
  const immediateClock = new FakeClock();
  const immediatePage = new FakePage({ text: "loading" });
  const already = new AbortController();
  already.abort();

  await assert.rejects(
    () =>
      waitForMarker(immediatePage, {
        marker: MARKER,
        clock: immediateClock,
        signal: already.signal,
      }),
    (error: unknown) =>
      isWebSearchError(error) && error.details.code === "E_CANCELLED" && error.details.stage === "settle",
  );
  assert.equal(immediateClock.sleepLog().length, 0);
  assert.equal(immediatePage.callCount("innerText"), 0);

  // Abort while the poll timer is pending: the sleep rejects, the loop exits.
  const clock = new FakeClock({ autoAdvance: false });
  const page = new FakePage({ text: "loading" });
  const controller = new AbortController();
  const pending = waitForMarker(page, {
    marker: MARKER,
    clock,
    pollMs: 1_000,
    deadlineMs: 60_000,
    signal: controller.signal,
  });

  await waitUntil(() => clock.pendingCount() === 1, "first poll sleep is pending");
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      isWebSearchError(error) && error.details.code === "E_CANCELLED" && error.details.stage === "settle",
  );
  assert.equal(clock.pendingCount(), 0);
});

test("poll intervals are jittered by ±25% and never fall below the floor", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ text: "loading" });

  await assert.rejects(
    () => waitForMarker(page, { marker: MARKER, clock, pollMs: 200, deadlineMs: 1_000 }),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_TIMEOUT",
  );

  const durations = clock.durations();
  assert.ok(durations.length >= 3, `expected several polls, got ${durations.length}`);
  for (const duration of durations) {
    assert.ok(duration >= 200 * 0.75, `poll slept ${duration} ms (below 75%)`);
    assert.ok(duration <= 200 * 1.25, `poll slept ${duration} ms (above 125%)`);
  }
});

test("waitForMarker takes jitter from the injected rng", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ text: "loading" });

  await assert.rejects(
    () =>
      waitForMarker(page, {
        marker: MARKER,
        clock,
        pollMs: 200,
        deadlineMs: 500,
        rng: () => 0, // factor 0.75 → every poll is exactly 150 ms
      }),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_TIMEOUT",
  );

  const durations = clock.durations();
  assert.ok(durations.length >= 3, `expected several polls, got ${durations.length}`);
  for (const duration of durations) assert.equal(duration, 150);
});

test("a tiny poll stays inside the ±25% window and never drops to zero", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ text: "loading" });

  await assert.rejects(
    () =>
      waitForMarker(page, {
        marker: MARKER,
        clock,
        pollMs: 1,
        deadlineMs: 10,
        rng: () => 0.999, // the widest factor; the window still wins over rounding
      }),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_TIMEOUT",
  );

  const durations = clock.durations();
  assert.ok(durations.length >= 5, `expected several polls, got ${durations.length}`);
  // floor(0.75 * 1) = 0, so the floor is the 1 ms minimum; ceil(1.25 * 1) = 2.
  for (const duration of durations) {
    assert.ok(duration >= 1 && duration <= 2, `poll slept ${duration} ms`);
    assert.ok(Number.isInteger(duration), `poll slept ${duration} ms`);
  }
});

test("a 60 s virtual deadline costs no real time", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ text: "loading" });
  const realStart = Date.now();

  await assert.rejects(
    () => waitForMarker(page, { marker: MARKER, clock, deadlineMs: 60_000, pollMs: 150 }),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_TIMEOUT",
  );

  const realElapsed = Date.now() - realStart;
  assert.ok(clock.totalSleptMs() >= 60_000, `virtual sleep ${clock.totalSleptMs()} ms`);
  assert.ok(realElapsed < 2_000, `spent ${realElapsed} ms of real time`);
  assert.equal(clock.now() - clock.sleepLog()[0]!.at, clock.totalSleptMs());
});

// ---------------------------------------------------------------------------
// humanSearch — fallback, cancellation, engine decoration
// ---------------------------------------------------------------------------

test("a missing search box falls back to the SERP URL without typing and without hanging", async () => {
  const clock = new FakeClock();
  const page = new FakePage({
    url: HOME,
    text: "home page",
    clock,
    evaluate: domEvaluate({ boxes: [] }),
    onNavigate: (url, current) => {
      if (url === SERP) current.setText(`Results: ${MARKER}`);
    },
  });

  const result = await humanSearch(makeOptions(page, clock, { deadlineMs: 600, pollMs: 100 }));

  assert.deepEqual(page.navigations(), [HOME, SERP]);
  assert.deepEqual(page.clicks(), []);
  assert.deepEqual(page.typedTexts(), []);
  assert.deepEqual(page.presses(), []);
  assert.equal(result.fellBackToSerp, true);
  assert.equal(result.typed, false); // no keystroke reached the box
  assert.equal(result.typedPath, true); // the typed path was selected, then degraded
  assert.equal(result.settleMs, 0);
  assert.equal(result.scrollPx, 540);

  // Bounded by the box deadline (600 ms here, not the 3 s default) + scroll pause.
  const boxWait = clock.totalSleptMs() - 90;
  assert.ok(boxWait >= 600, `box wait ${boxWait} ms`);
  assert.ok(boxWait < 725, `box wait ${boxWait} ms`);
});

test("humanSearch decorates a settle timeout with the engine and stage", async () => {
  const clock = new FakeClock();
  const page = new FakePage({ text: "loading", evaluate: () => true });

  await assert.rejects(
    () =>
      humanSearch(makeOptions(page, clock, { firstInSession: false, deadlineMs: 300, pollMs: 100 })),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_TIMEOUT");
      assert.equal(error.details.stage, "settle");
      assert.equal(error.details.engine, "google");
      return true;
    },
  );
});

test("a generic navigate failure is E_CDP_DISCONNECTED, never E_TARGET_LOST", async () => {
  const clock = new FakeClock();
  const page = new FakePage({
    url: HOME,
    text: MARKER,
    clock,
    evaluate: domEvaluate({ boxes: ["input[name=q]"] }),
    // A socket/protocol throw is not "the owned tab was closed": the browser
    // layer never said E_TARGET_LOST, so humanize must not invent it.
    onNavigate: () => {
      throw new Error("webSocket is not open: readyState 3");
    },
  });

  const error = await rejectionOf(humanSearch(makeOptions(page, clock)));

  assert.equal(error.details.code, "E_CDP_DISCONNECTED");
  assert.equal(error.details.stage, "navigate");
  assert.equal(error.details.engine, "google");
  assert.equal(error.details.retryable, true);
  assert.match(error.details.message ?? "", /webSocket/);
  assert.deepEqual(page.presses(), []);
});

test("a generic failure during the settle wait is E_CDP_DISCONNECTED", async () => {
  const clock = new FakeClock();
  const page = new FakePage({
    url: "about:blank",
    text: () => {
      throw new Error("CDP target closed while reading text");
    },
  });

  const error = await rejectionOf(humanSearch(makeOptions(page, clock, { firstInSession: false })));

  assert.equal(error.details.code, "E_CDP_DISCONNECTED");
  assert.equal(error.details.stage, "settle");
  assert.equal(error.details.engine, "google");
});

test("a WebSearchError raised by the browser layer passes through unchanged", async () => {
  const clock = new FakeClock();
  const targetLost = fail("E_TARGET_LOST", "settle", {
    engine: "google",
    message: "the owned tab was closed by the user",
  });
  const page = new FakePage({
    url: "about:blank",
    text: () => {
      throw targetLost;
    },
  });

  const error = await rejectionOf(humanSearch(makeOptions(page, clock, { firstInSession: false })));

  // Same instance, same code/stage/hint: no re-wrapping, no code rewriting.
  assert.equal(error, targetLost);
  assert.equal(error.details.code, "E_TARGET_LOST");
  assert.equal(error.details.stage, "settle");
  assert.match(error.details.message ?? "", /closed by the user/);
});

test("a TimeoutError becomes E_TIMEOUT and an AbortError becomes E_CANCELLED", async () => {
  const timeoutClock = new FakeClock();
  const timeoutError = Object.assign(new Error("navigation timed out"), { name: "TimeoutError" });
  const timeoutPage = new FakePage({
    text: MARKER,
    evaluate: domEvaluate({ boxes: ["input[name=q]"] }),
    onNavigate: () => {
      throw timeoutError;
    },
  });

  const timedOut = await rejectionOf(humanSearch(makeOptions(timeoutPage, timeoutClock)));

  assert.equal(timedOut.details.code, "E_TIMEOUT");
  assert.equal(timedOut.details.stage, "navigate");
  assert.equal(timedOut.details.engine, "google");

  const abortClock = new FakeClock();
  const abortPage = new FakePage({
    text: MARKER,
    evaluate: domEvaluate({ boxes: ["input[name=q]"] }),
    onNavigate: () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    },
  });

  const cancelled = await rejectionOf(humanSearch(makeOptions(abortPage, abortClock)));

  assert.equal(cancelled.details.code, "E_CANCELLED");
  assert.equal(cancelled.details.stage, "navigate");
  assert.equal(cancelled.details.engine, "google");
});

test("a marker already on the home page settles at 0 ms (documented stale-marker risk)", async () => {
  const clock = new FakeClock();
  const page = new FakePage({
    url: HOME,
    // The home page itself mentions the marker: text alone cannot distinguish
    // "results are here" from "the page always says this". Adapters must pass
    // selector+minCount for this reason; humanize never guesses a navigation.
    text: `home page mentioning ${MARKER} in a promo banner`,
    clock,
    evaluate: domEvaluate({ boxes: [] }),
  });

  const result = await humanSearch(makeOptions(page, clock, { deadlineMs: 400, pollMs: 100 }));

  assert.equal(result.fellBackToSerp, true);
  assert.equal(result.typedPath, true);
  assert.equal(result.typed, false);
  // Exactly the risk: the settle wait cost nothing even though no SERP loaded.
  assert.equal(result.settleMs, 0);
  // Only the box wait and the scroll pause slept; the settle loop never polled.
  const boxWait = clock.totalSleptMs() - 90;
  assert.ok(boxWait >= 400, `box wait ${boxWait} ms`);
});

test("humanSearch refuses to act when the signal is already aborted", async () => {

  const clock = new FakeClock();
  const page = new FakePage({ text: MARKER, evaluate: domEvaluate({ boxes: ["input[name=q]"] }) });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => humanSearch(makeOptions(page, clock, { signal: controller.signal, focus: "always" })),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CANCELLED");
      assert.equal(error.details.stage, "navigate");
      assert.equal(error.details.engine, "google");
      return true;
    },
  );
  assert.deepEqual(page.navigations(), []);
  assert.equal(page.bringToFrontCount(), 0);
  assert.equal(clock.totalSleptMs(), 0);
});

test("an abort mid-typing never presses Enter", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  let page!: FakePage;
  page = new FakePage({
    url: HOME,
    text: "home page",
    clock,
    evaluate: domEvaluate({ boxes: ["input[name=q]"] }),
  });
  const controller = new AbortController();
  const pending = humanSearch(makeOptions(page, clock, { signal: controller.signal }));

  await waitUntil(() => clock.pendingCount() === 1, "first keystroke delay is pending");
  controller.abort();
  // The page owns typeText and its per-character sleeps carry no signal, so the
  // remaining keystrokes drain; the pre-Enter check is what stops the submit.
  clock.setAutoAdvance(true);
  clock.advance(1_000);

  await assert.rejects(
    withTimeout(pending),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CANCELLED");
      assert.equal(error.details.stage, "navigate");
      return true;
    },
  );
  assert.equal(page.callCount("typeText"), 1);
  assert.deepEqual(page.presses(), []);
  assert.equal(page.callCount("navigate"), 1); // home only; no SERP submit
});

// ---------------------------------------------------------------------------
// humanScroll
// ---------------------------------------------------------------------------

test("humanScroll stays within 300–900 px for in-range and out-of-range rng", async () => {
  const cases: Array<{ rng: () => number; expected: number }> = [
    { rng: () => 0, expected: 300 },
    { rng: () => 0.999, expected: 900 },
    { rng: () => -5, expected: 300 },
    { rng: () => 7, expected: 900 },
    { rng: () => Number.NaN, expected: 300 },
  ];

  for (const { rng, expected } of cases) {
    const clock = new FakeClock();
    const page = new FakePage();
    const px = await humanScroll(page, { rng, clock });

    assert.equal(px, expected);
    assert.deepEqual(page.scrolls(), [expected]);
    assert.equal(page.scrollY(), expected);
    const pause = clock.durations();
    assert.equal(pause.length, 1);
    assert.ok(pause[0]! >= 50 && pause[0]! <= 150, `pause ${pause[0]} ms`);
  }
});

test("humanScroll's pause is abort-aware through the clock", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const page = new FakePage();
  const controller = new AbortController();
  const pending = humanScroll(page, { rng: FIXED_RNG, clock, signal: controller.signal });

  await waitUntil(() => clock.pendingCount() === 1, "scroll pause is pending");
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CANCELLED",
  );
  assert.deepEqual(page.scrolls(), [540]);
});

// ---------------------------------------------------------------------------
// CdpPage compatibility
// ---------------------------------------------------------------------------

test("humanize consumes only the frozen CdpPage surface", async () => {
  const clock = new FakeClock();
  const fake = new FakePage({
    text: MARKER,
    clock,
    evaluate: domEvaluate({ boxes: ["input[name=q]"] }),
  });
  // Only the frozen surface reaches the module; spies stay on the fake.
  const page: CdpPage = fake;

  const result = await humanSearch({
    page,
    query: "example query",
    homeUrl: HOME,
    serpUrl: SERP,
    boxSelectors: [...BOX_SELECTORS],
    marker: MARKER,
    engine: "duckduckgo",
    mode: "auto",
    firstInSession: false,
    focus: "never",
    clock,
  });

  assert.equal(result.typed, false);
  assert.equal(result.typedPath, false);
  assert.equal(result.focused, false);
  assert.equal(result.settleMs, 0);
  assert.equal(result.fellBackToSerp, false);
  // No rng injected here: the scroll must still land in the SPEC window.
  assert.ok(result.scrollPx >= 300 && result.scrollPx <= 900, `scroll ${result.scrollPx} px`);
  assert.deepEqual(fake.scrolls(), [result.scrollPx]);
});
