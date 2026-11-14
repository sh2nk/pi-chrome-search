/**
 * The anchor control panel (S12.1, S12.5; PLAN P7).
 *
 * The panel is an instrument, never a dependency: a paint is throttled, a dead
 * anchor is reported once and swallowed, and a hostile query can blank a field
 * but cannot escape the evaluated expression or inject markup. The shipped
 * asset is a `file://` document with no network of its own.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_CONFIG } from "../../src/config/index.ts";
import {
  PANEL_VERSION,
  PanelChannel,
  applyAnnouncement,
  initialPanelState,
  panelAssetPath,
  panelFileUrl,
  renderPanelExpression,
  type PanelCounter,
  type PanelState,
  type WorkAnnouncement,
} from "../../src/runtime/panel.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { FakeClock } from "../helpers/fake-cdp.ts";
import { createEngineStub, createHarness, resultText } from "../helpers/search-harness.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function state(stage: WorkAnnouncement["stage"], overrides: Partial<PanelState> = {}): PanelState {
  const base = applyAnnouncement(initialPanelState({ sessionId: "session-1", now: NOW }), { stage }, {
    sessionId: "session-1",
    now: NOW,
  });
  return { ...base, ...overrides };
}

function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("S12.5 the first stage paints immediately and a burst is coalesced", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const writes: PanelState[] = [];
  const channel = new PanelChannel({
    clock,
    minIntervalMs: 500,
    sink: {
      write: async (painted) => {
        writes.push(painted);
        return true;
      },
    },
  });

  await channel.publish(state("pace"));
  assert.equal(writes.length, 1, "the query must be visible as soon as a search starts");

  await channel.publish(state("navigate"));
  await channel.publish(state("settle"));
  await channel.publish(state("extract"));
  assert.equal(writes.length, 1, "three stages inside one throttle window are one pending paint");

  clock.advance(499);
  await tick();
  assert.equal(writes.length, 1, "the trailing paint waits the full window");

  clock.advance(1);
  await tick();
  assert.equal(writes.length, 2);
  assert.equal(writes[1]?.stage, "extract", "the trailing write carries the newest state, not the oldest");
});

test("S12.5 a slow stage sequence never exceeds two paints per window", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const writes: PanelState[] = [];
  const channel = new PanelChannel({
    clock,
    minIntervalMs: 500,
    sink: {
      write: async (painted) => {
        writes.push(painted);
        return true;
      },
    },
  });

  const stages: WorkAnnouncement["stage"][] = ["pace", "navigate", "settle", "extract", "read", "done"];
  for (const stage of stages) {
    await channel.publish(state(stage));
    clock.advance(100);
    await tick();
  }
  // 600 ms elapsed: the leading paint plus at most one trailing paint per window.
  assert.ok(writes.length <= 3, `expected at most 3 paints for 600 ms, got ${writes.length}`);
  assert.equal(writes[0]?.stage, "pace");
});

test("S12.5 a throwing sink never rejects a publish or a flush", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const channel = new PanelChannel({
    clock,
    minIntervalMs: 500,
    sink: {
      write: async () => {
        throw new Error("anchor tab is gone");
      },
    },
  });

  await channel.publish(state("navigate"));
  await channel.publish(state("extract"));
  clock.advance(500);
  await tick();
  await channel.flush();
  channel.close();
});

test("S12.5 close stops every further paint; flush forces the pending state", async () => {
  const clock = new FakeClock({ autoAdvance: false });
  const writes: PanelState[] = [];
  const channel = new PanelChannel({
    clock,
    minIntervalMs: 500,
    sink: {
      write: async (painted) => {
        writes.push(painted);
        return true;
      },
    },
  });

  await channel.publish(state("pace"));
  await channel.publish(state("extract"));
  await channel.flush();
  assert.equal(writes.length, 2, "flush writes the coalesced state without waiting");
  assert.equal(writes[1]?.stage, "extract");

  channel.close();
  await channel.publish(state("done"));
  clock.advance(5000);
  await tick();
  await channel.flush();
  assert.equal(writes.length, 2, "a closed channel is silent");
});

test("S12.5 an announcement is a patch: query, engine and counters survive a stage change", () => {
  const context = { sessionId: "session-1", now: NOW };
  const afterPace = applyAnnouncement(
    initialPanelState(context),
    {
      stage: "pace",
      engine: "google",
      query: "redis cluster",
      pace: [2500, 5000],
      counters: [{ engine: "google", today: 3 }],
    },
    context,
  );
  const afterExtract = applyAnnouncement(afterPace, { stage: "extract" }, context);

  assert.equal(afterExtract.stage, "extract");
  assert.equal(afterExtract.engine, "google");
  assert.equal(afterExtract.query, "redis cluster");
  assert.deepEqual(afterExtract.pace, [2500, 5000]);
  assert.deepEqual(afterExtract.counters, [{ engine: "google", today: 3 }]);
  assert.equal(afterExtract.version, PANEL_VERSION);

  const cleared = applyAnnouncement(afterExtract, { stage: "done", query: null, error: null }, context);
  assert.equal(cleared.query, null, "an explicit null clears the field");
});

test("S12.5 a hostile announcement blanks fields but never escapes its bounds", () => {
  const context = { sessionId: "s".repeat(200), now: NOW };
  const previous = initialPanelState(context);
  const painted = applyAnnouncement(
    previous,
    {
      stage: "not-a-stage" as WorkAnnouncement["stage"],
      engine: "bing" as WorkAnnouncement["engine"],
      query: "a\nb\u0000c" + "x".repeat(400),
      pace: [-5, 10],
      counters: [
        { engine: "google", today: -5 },
        { engine: "google", today: 2 },
        { engine: "yandex", today: 5_000_000 },
        { engine: "bing" as unknown as PanelCounter["engine"], today: 1 },
        { engine: "duckduckgo", today: Number.NaN },
      ],
      error: { code: "E_".repeat(100), hint: "h\n" + "y".repeat(400) },
    },
    context,
  );

  assert.equal(painted.stage, "connect", "an unknown stage falls back to the initial one");
  assert.equal(painted.engine, null, "an unknown engine is not shown as the current one");
  assert.equal(painted.sessionId.length, 64);
  assert.equal(painted.query?.includes("\n"), false, "control characters never reach the document");
  assert.equal(painted.query?.includes("\u0000"), false);
  assert.equal([...(painted.query ?? "")].length, 240, "the query is clamped");
  assert.deepEqual(painted.pace, [0, 10], "a broken pace is clamped, not thrown away silently");
  assert.deepEqual(painted.counters, [
    { engine: "google", today: 0 },
    { engine: "yandex", today: 1_000_000 },
    { engine: "duckduckgo", today: 0 },
  ]);
  assert.equal(painted.error?.code.length, 64);
  assert.equal(painted.error?.hint?.includes("\n"), false);
  assert.equal([...(painted.error?.hint ?? "")].length, 240);
});

test("S12.1 the evaluated expression round-trips the state and cannot be terminated early", () => {
  const hostile = state("extract", {
    query: "</script><script>alert(1)</script>\u2028\u2029",
  });
  const expression = renderPanelExpression(hostile);

  assert.equal(expression.includes("<"), false, "no raw `<` may reach the evaluated script");
  assert.equal(expression.includes("\u2028"), false);
  assert.equal(expression.includes("\u2029"), false);
  assert.match(expression, /\\u003c/);

  const seen: PanelState[] = [];
  const fakeWindow = {
    __wcsPanel: {
      render: (painted: PanelState) => {
        seen.push(painted);
      },
    },
  };
  const evaluate = new Function("window", `return ${expression}`) as (target: unknown) => unknown;
  assert.equal(evaluate(fakeWindow), true);
  assert.deepEqual(seen[0], hostile, "the page receives the state, not a mangled string");
});

test("S12.1 a missing or broken render hook reports false instead of throwing", () => {
  const expression = renderPanelExpression(state("navigate"));
  const evaluate = new Function("window", `return ${expression}`) as (target: unknown) => unknown;

  assert.equal(evaluate({}), false, "an anchor without the hook is not ready");
  assert.equal(
    evaluate({
      __wcsPanel: {
        render: () => {
          throw new Error("the document is gone");
        },
      },
    }),
    false,
    "a throwing render is contained inside the expression",
  );
});

test("S12.1 the shipped asset is a local document with the documented hooks", async () => {
  const asset = await readFile(panelAssetPath(), "utf8");

  assert.match(asset, /window\.__wcsPanel = \{ render: render \}/);
  assert.match(asset, /function render\(state\)/);
  for (const id of [
    "stage",
    "engine",
    "query",
    "pace",
    "session",
    "error",
    "count-google",
    "count-duckduckgo",
    "count-yandex",
  ]) {
    assert.match(asset, new RegExp(`id="${id}"`), `the panel must show #${id}`);
  }
  assert.match(asset, /default-src 'none'/, "the panel loads nothing");
  assert.equal(/https?:\/\//.test(asset), false, "no network URL in the panel");
  assert.equal(/\.innerHTML\s*=/.test(asset), false, "state reaches the DOM through textContent only");
});

test("S12.1 the panel URL is a portable file:// URL of that asset", () => {
  const url = panelFileUrl();
  assert.ok(url.startsWith("file://"), url);
  assert.ok(url.endsWith("/assets/anchor.html"), url);
  assert.notEqual(url, "about:blank");
});

test("S12.5 a dead announcement channel never fails a search", async () => {
  const google = createEngineStub("google");
  const rig = createHarness({ engines: [google] });
  const announcements: WorkAnnouncement[] = [];
  rig.deps.cdp.announce = async (update) => {
    announcements.push(update);
    throw new Error("the anchor tab is gone");
  };

  const result = await createWebSearchTool(async () => rig.deps).execute(
    "call-1",
    { q: "redis cluster", engines: "google" },
    undefined,
    undefined,
  );

  if ("isError" in result) assert.fail("a cosmetic paint must not fail a search");
  assert.deepEqual(result.details.engines, ["google"]);
  assert.equal(result.details.results, 3, "the search still rendered its results");
  assert.match(resultText(result), /3 results/);
  assert.ok(announcements.length > 0, "the tool did announce; the channel refused the paint");
  assert.deepEqual(
    announcements.map((update) => update.stage),
    ["pace", "navigate", "extract", "done"],
    "every stage is reported, so a reachable panel would have painted them",
  );
});

test("S12.5 the panel receives the real pacing window, and a broken limiter is not fatal", async () => {
  const google = createEngineStub("google");
  const rig = createHarness({
    engines: [google],
    configure: (config) => {
      config.pacing.google = [2500, 5000];
    },
  });
  const updates: WorkAnnouncement[] = [];
  rig.deps.cdp.announce = async (update) => {
    updates.push(update);
  };
  // The anchor counters are observability: a limiter without stats must not fail.
  rig.deps.limiter.stats = () => {
    throw new Error("the limiter has no stats");
  };

  const result = await createWebSearchTool(async () => rig.deps).execute(
    "call-2",
    { q: "redis cluster", engines: "google" },
    undefined,
    undefined,
  );

  if ("isError" in result) assert.fail("a stats failure must never fail a search");
  const pace = updates.find((update) => update.stage === "pace");
  assert.ok(pace !== undefined, "the pace stage is announced before the wait");
  assert.deepEqual(pace.pace, [2500, 5000], "the panel shows the window the limiter actually uses");
  assert.deepEqual(pace.counters, [], "a failed stats read leaves the counters empty, not the search failed");
});

test("S12.5 the panel pace window is the one the config actually paces with", () => {
  // The anchor renders `pace` from the same tuple the limiter reads; a second
  // source of truth here would show the user a different rhythm than the tool.
  assert.deepEqual(DEFAULT_CONFIG.pacing.google, [2500, 5000]);
  const painted = applyAnnouncement(
    initialPanelState({ sessionId: "session-1", now: NOW }),
    { stage: "pace", engine: "google", pace: DEFAULT_CONFIG.pacing.google },
    { sessionId: "session-1", now: NOW },
  );
  assert.deepEqual(painted.pace, DEFAULT_CONFIG.pacing.google);
});
