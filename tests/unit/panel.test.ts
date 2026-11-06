/**
 * P10-A unit tests: the anchor control panel.
 *
 * Everything is offline. `PanelChannel` runs on `FakeClock`, so the "≤ 2 paints
 * per second" rule is asserted on virtual time instead of by sleeping. The asset
 * test reads the shipped `assets/anchor.html` and proves it is local-only: no
 * network reference, a CSP that forbids fetches, and no markup injection path.
 *
 *   node --test tests/unit/panel.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  PANEL_MIN_INTERVAL_MS,
  PanelChannel,
  applyAnnouncement,
  initialPanelState,
  panelAssetPath,
  panelFileUrl,
  renderPanelExpression,
  type PanelSink,
  type PanelState,
} from "../../src/runtime/panel.ts";
import { FakeClock } from "../helpers/clock.ts";

const CONTEXT = { sessionId: "session-1234-5678", now: Date.UTC(2026, 10, 6, 12, 0, 0) };

function fresh(): PanelState {
  return initialPanelState(CONTEXT);
}

/** A sink that records every paint and reports readiness. */
function recorder(readiness = true): { sink: PanelSink; painted: PanelState[] } {
  const painted: PanelState[] = [];
  return {
    painted,
    sink: {
      async write(state: PanelState): Promise<boolean> {
        painted.push(state);
        return readiness;
      },
    },
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

test("the initial anchor state invents nothing beyond the session id", () => {
  const state = fresh();
  assert.equal(state.version, 1);
  assert.equal(state.sessionId, CONTEXT.sessionId);
  assert.equal(state.engine, null);
  assert.equal(state.query, null);
  assert.equal(state.stage, "connect");
  assert.equal(state.pace, null);
  assert.deepEqual(state.counters, []);
  assert.equal(state.error, null);
  assert.equal(state.updatedAt, new Date(CONTEXT.now).toISOString());
});

test("an announcement is a patch: the query and counters survive stage changes", () => {
  let state = applyAnnouncement(
    fresh(),
    {
      engine: "yandex",
      query: "что такое трансформер",
      stage: "navigate",
      pace: [5000, 9000],
      counters: [{ engine: "yandex", today: 3, cap: 150 }],
    },
    CONTEXT,
  );

  state = applyAnnouncement(state, { stage: "settle" }, CONTEXT);
  assert.equal(state.stage, "settle");
  assert.equal(state.engine, "yandex");
  assert.equal(state.query, "что такое трансформер");
  assert.deepEqual(state.pace, [5000, 9000]);
  assert.deepEqual(state.counters, [{ engine: "yandex", today: 3, cap: 150 }]);

  state = applyAnnouncement(state, { stage: "done", pace: null, error: null }, CONTEXT);
  assert.equal(state.pace, null);
  assert.equal(state.error, null);
});

test("a hostile announcement cannot inject markup, control characters or an unknown engine", () => {
  const state = applyAnnouncement(
    fresh(),
    {
      engine: "not-an-engine" as never,
      query: `</script><img src=x onerror=alert(1)> \u0000\n${"z".repeat(400)}`,
      stage: "navigate",
      counters: [
        { engine: "google" as never, today: Number.NaN, cap: -5 },
        { engine: "yandex", today: 1, cap: 150 },
      ],
      error: { code: "E_PARSE\n", hint: "<b>layout</b>" },
    },
    CONTEXT,
  );

  assert.equal(state.engine, null);
  assert.ok(!state.query?.includes("\n"), "control characters are flattened");
  assert.ok(!state.query?.includes("\u0000"));
  assert.ok((state.query ?? "").length <= 240);
  assert.deepEqual(state.counters, [
    { engine: "google", today: 0, cap: 0 },
    { engine: "yandex", today: 1, cap: 150 },
  ]);
  assert.equal(state.error?.code, "E_PARSE");
  // Text, not markup: the page assigns textContent; the expression only carries JSON.
  const expression = renderPanelExpression(state);
  assert.ok(!expression.includes("</script>"));
  assert.ok(expression.includes("\\u003c/script>"));
});

test("renderPanelExpression is one self-contained call into the page script", () => {
  const state = applyAnnouncement(fresh(), { engine: "google", query: "rust tokio", stage: "extract" }, CONTEXT);
  const expression = renderPanelExpression(state);

  assert.match(expression, /window\.__wcsPanel/);
  assert.match(expression, /typeof p\.render/);
  assert.ok(expression.includes("rust tokio"));
  assert.ok(expression.includes('"version":1'));
  // U+2028/U+2029 would terminate a JS literal in older engines; both are escaped.
  const separators = renderPanelExpression({
    ...state,
    query: "a\u2028b\u2029c",
  });
  assert.ok(!separators.includes("\u2028"));
  assert.ok(!separators.includes("\u2029"));
});

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------

test("the anchor asset ships locally, forbids the network and paints text only", () => {
  const html = readFileSync(panelAssetPath(), "utf8");

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(html, /https?:\/\//i, "the panel must not reference the network");
  assert.doesNotMatch(html, /\bsrc\s*=/, "no external or embedded resource is loaded");
  assert.doesNotMatch(html, /\.innerHTML\s*=/, "a query must never be parsed as markup");
  assert.match(html, /\.textContent\s*=/, "state arrives as text nodes");
  assert.match(html, /window\.__wcsPanel = \{ render: render \}/);
  assert.match(html, /window\.__wcsPanelReady = true/);
});

test("panelFileUrl is a portable file:// URL to the shipped asset", () => {
  const url = panelFileUrl();
  assert.match(url, /^file:\/\//);
  assert.match(url, /assets\/anchor\.html$/);
  assert.equal(decodeURIComponent(new URL(url).pathname), panelAssetPath());
});

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

test("the first paint is immediate, the second is coalesced, and ≤ 2/s holds", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const { sink, painted } = recorder();
  const channel = new PanelChannel({ sink, clock });
  const a = applyAnnouncement(fresh(), { engine: "google", query: "a", stage: "navigate" }, CONTEXT);
  const b = applyAnnouncement(a, { stage: "settle" }, CONTEXT);
  const c = applyAnnouncement(b, { stage: "extract" }, CONTEXT);

  await channel.publish(a);
  assert.equal(painted.length, 1, "the query is visible before the search waits");

  await channel.publish(b);
  assert.equal(painted.length, 1, "a stage change inside the window is coalesced");

  clock.advance(PANEL_MIN_INTERVAL_MS);
  await settleMicrotasks();
  assert.equal(painted.length, 2);
  assert.equal(painted[1]?.stage, "settle", "the trailing write carries the latest state");

  clock.advance(PANEL_MIN_INTERVAL_MS);
  await channel.publish(c);
  assert.equal(painted.length, 3, "after the window the next stage paints immediately");
  assert.equal(painted[2]?.stage, "extract");
});

test("three rapid stages paint the first and the last, not all three", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const { sink, painted } = recorder();
  const channel = new PanelChannel({ sink, clock });

  let state = fresh();
  await channel.publish(state); // first paint
  state = applyAnnouncement(state, { stage: "navigate" }, CONTEXT);
  await channel.publish(state);
  state = applyAnnouncement(state, { stage: "settle" }, CONTEXT);
  await channel.publish(state);
  state = applyAnnouncement(state, { stage: "extract" }, CONTEXT);
  await channel.publish(state);

  clock.advance(PANEL_MIN_INTERVAL_MS);
  await settleMicrotasks();
  assert.equal(painted.length, 2);
  assert.equal(painted.at(-1)?.stage, "extract");
});

test("a sink that throws or is not ready never fails the caller", async () => {
  const clock = new FakeClock();
  const throwing = new PanelChannel({
    clock,
    sink: {
      async write(): Promise<boolean> {
        throw new Error("anchor tab is gone");
      },
    },
  });
  await throwing.publish(fresh());

  const { sink, painted } = recorder(false);
  const notReady = new PanelChannel({ clock, sink });
  await notReady.publish(fresh());
  assert.equal(painted.length, 1, "a paint attempt is still recorded; readiness is the sink's answer");
});

test("close stops every later paint, including a pending trailing write", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const { sink, painted } = recorder();
  const channel = new PanelChannel({ sink, clock });
  const a = fresh();
  const b = applyAnnouncement(a, { stage: "done" }, CONTEXT);

  await channel.publish(a);
  await channel.publish(b);
  channel.close();
  clock.advance(PANEL_MIN_INTERVAL_MS * 2);
  await settleMicrotasks();

  assert.equal(painted.length, 1);
});
