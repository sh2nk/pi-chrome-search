/**
 * The visible window (S12; PLAN P7).
 *
 * Three policies decide what the owner sees: `window.focus` raises a tab, the
 * follow policy keeps the work or the anchor in front, and `window.idleMs` hands
 * the screen back after the last stage. All of it runs over the fake CDP client,
 * so the suite can assert exactly which owned tab was raised, when, and that a
 * wall — the one state a human has to act on — is never followed by a focus
 * steal or a navigation.
 *
 * `focus: "never"` dominates every automatic raise (S12.2), with one documented
 * exception the SPEC states separately: a wall surfaces the window so the human
 * can click it (S12.4, AGENTS rule 4) — asserted at the tool layer in
 * `wall.test.ts`, where the page is the real thing.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { panelFileUrl } from "../../src/runtime/panel.ts";
import { createSessionHarness, type SessionHarness } from "../helpers/session-harness.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness(
  options: Parameters<typeof createSessionHarness>[0] = {},
): Promise<SessionHarness> {
  const created = await createSessionHarness(options);
  cleanups.push(async () => await created.cleanup());
  return created;
}

/** Let the microtask queue run without moving virtual time. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("S12.2 focus:never dominates every automatic raise", async () => {
  const rig = await harness({
    configure: (config) => {
      config.window.focus = "never";
      config.window.follow = "work";
    },
  });
  await rig.session.connect();
  await rig.session.acquirePage("google");

  await rig.session.announce({ stage: "navigate", engine: "google" });
  await rig.session.announce({ stage: "extract", engine: "google" });
  await rig.session.announce({ stage: "done", engine: "google" });
  rig.clock.advance(rig.config.window.idleMs * 2);
  await tick();

  assert.deepEqual(rig.raises(), [], "no stage and no idle hand-back may touch the window");
});

test("S12.2 focus:session raises a tab on first acquisition only", async () => {
  const rig = await harness({
    configure: (config) => {
      config.window.focus = "session";
    },
  });
  await rig.session.connect();

  await rig.session.acquirePage("google");
  const google = rig.targetFor("google");
  assert.deepEqual(rig.raises(), [google], "the first use of the tab is raised once");

  await rig.session.acquirePage("google");
  assert.deepEqual(rig.raises(), [google], "the second use of the same tab is not raised again");

  await rig.session.releasePage("google");
  await rig.session.acquirePage("google");
  const replacement = rig.targetFor("google");
  assert.notEqual(replacement, google, "release closed the owned tab");
  assert.deepEqual(rig.raises(), [google, replacement], "a fresh tab is a new first use");
});

test("S12.2 follow:work keeps the work tab in front and hands back after idleMs", async () => {
  const rig = await harness({
    autoAdvance: false,
    configure: (config) => {
      config.window.focus = "session";
      config.window.follow = "work";
      config.window.idleMs = 1500;
    },
  });
  await rig.session.connect();
  await rig.session.acquirePage("google");
  const google = rig.targetFor("google");
  const anchor = rig.anchorTarget();
  assert.deepEqual(rig.raises(), [google]);

  await rig.session.announce({ stage: "navigate", engine: "google" });
  assert.deepEqual(rig.raises(), [google, google], "the working stage raises the work tab");

  await rig.session.announce({ stage: "done", engine: "google" });
  assert.deepEqual(rig.raises().at(-1), google, "done itself does not move the screen");

  rig.clock.advance(1499);
  await tick();
  assert.deepEqual(rig.raises().at(-1), google, "the hand-back waits the full idle window");

  rig.clock.advance(1);
  await tick();
  assert.deepEqual(rig.raises().at(-1), anchor, "then the anchor panel comes back");
});

test("S12.2 a new stage cancels a pending idle hand-back", async () => {
  const rig = await harness({
    autoAdvance: false,
    configure: (config) => {
      config.window.focus = "session";
      config.window.follow = "work";
      config.window.idleMs = 1000;
    },
  });
  await rig.session.connect();
  await rig.session.acquirePage("google");
  const google = rig.targetFor("google");
  const anchor = rig.anchorTarget();

  await rig.session.announce({ stage: "done", engine: "google" });
  await rig.session.announce({ stage: "navigate", engine: "google" });
  rig.clock.advance(5000);
  await tick();

  assert.equal(rig.raises().includes(anchor), false, "the cancelled generation never raises the anchor");
  assert.deepEqual(rig.raises().at(-1), google);
});

test("S12.2 follow:anchor hands the screen back on every announcement", async () => {
  const rig = await harness({
    configure: (config) => {
      config.window.focus = "session";
      config.window.follow = "anchor";
    },
  });
  await rig.session.connect();
  await rig.session.acquirePage("google");
  const anchor = rig.anchorTarget();
  const before = rig.raises().length;

  await rig.session.announce({ stage: "navigate", engine: "google" });
  await rig.session.announce({ stage: "settle", engine: "google" });

  const after = rig.raises().slice(before);
  assert.deepEqual(after, [anchor, anchor], "the anchor stays visible while the work happens");
});

test("S12.2 follow:never leaves the screen alone after the acquisition raise", async () => {
  const rig = await harness({
    autoAdvance: false,
    configure: (config) => {
      config.window.focus = "always";
      config.window.follow = "never";
    },
  });
  await rig.session.connect();
  await rig.session.acquirePage("duckduckgo");
  const duckduckgo = rig.targetFor("duckduckgo");
  assert.deepEqual(rig.raises(), [duckduckgo]);

  await rig.session.announce({ stage: "navigate", engine: "duckduckgo" });
  await rig.session.announce({ stage: "done", engine: "duckduckgo" });
  rig.clock.advance(10_000);
  await tick();

  assert.deepEqual(rig.raises(), [duckduckgo], "no stage raise, no idle hand-back");
});

test("S12.4/S12.2 an error stage — the wall case — never hands focus back", async () => {
  const rig = await harness({
    autoAdvance: false,
    configure: (config) => {
      config.window.focus = "never";
      config.window.follow = "work";
      config.window.idleMs = 500;
    },
  });
  await rig.session.connect();
  await rig.session.acquirePage("yandex");

  await rig.session.announce({
    stage: "error",
    engine: "yandex",
    error: { code: "E_WALL", hint: "solve the captcha in the visible window, then retry" },
  });
  rig.clock.advance(10_000);
  await tick();

  assert.deepEqual(rig.raises(), [], "the human is solving a captcha; stealing focus would fight them");
  assert.equal(rig.client.commands.filter((command) => command.method === "Page.navigate").length, 0);
});

test("S12.2 shutdown cancels a pending idle hand-back", async () => {
  const rig = await harness({
    autoAdvance: false,
    configure: (config) => {
      config.window.focus = "session";
      config.window.follow = "work";
      config.window.idleMs = 1000;
    },
  });
  await rig.session.connect();
  await rig.session.acquirePage("google");

  await rig.session.announce({ stage: "done", engine: "google" });
  const before = rig.raises().length;
  await rig.session.releaseAll();
  rig.clock.advance(10_000);
  await tick();

  assert.equal(rig.raises().length, before, "a released session does not raise anything");
});

test("S12.1 the anchor hosts the shipped panel and is painted by one Runtime.evaluate", async () => {
  const rig = await harness({
    configure: (config) => {
      config.window.panel = true;
    },
  });
  await rig.session.connect();

  const anchor = rig.session.info()?.ownedTargets.find((target) => target.key === null);
  assert.ok(anchor !== undefined);
  assert.equal(anchor.url, panelFileUrl(), "the anchor is the local asset, never a network page");

  await rig.session.announce({
    stage: "pace",
    engine: "google",
    query: "rust <async>?",
    pace: rig.config.pacing.google,
    counters: [{ engine: "google", today: 2 }],
  });

  const paints = rig.evaluations().filter((expression) => expression.includes("__wcsPanel"));
  assert.equal(paints.length, 1, "the first stage paints immediately and only once");
  const paint = paints[0] ?? "";
  assert.match(paint, /"query":"rust \\u003casync>\?"/, "a hostile query cannot terminate the expression");
  assert.match(paint, /"stage":"pace"/);
  assert.match(paint, /"counters":\[/);
  assert.equal(rig.evaluations().some((expression) => expression.includes("addScriptToEvaluateOnNewDocument")), false);
});

test("S12.1 window.panel:false keeps the historical about:blank anchor", async () => {
  const rig = await harness({
    configure: (config) => {
      config.window.panel = false;
    },
  });
  await rig.session.connect();

  const anchor = rig.session.info()?.ownedTargets.find((target) => target.key === null);
  assert.equal(anchor?.url, "about:blank");
  await rig.session.announce({ stage: "navigate", engine: "google", query: "q" });
  assert.equal(
    rig.evaluations().filter((expression) => expression.includes("__wcsPanel")).length,
    0,
    "no panel, no paint",
  );
});

test("S12.5 a dead panel never fails a stage change", async () => {
  const rig = await harness({
    evaluate: (expression) => {
      if (expression.includes("navigator.webdriver")) return false;
      if (expression.includes("__wcsPanel")) throw new Error("the anchor tab is gone");
      return null;
    },
    configure: (config) => {
      config.window.panel = true;
    },
  });
  await rig.session.connect();

  await rig.session.announce({ stage: "navigate", engine: "google", query: "first" });
  await rig.session.announce({ stage: "extract", engine: "google" });

  const warnings = rig.logs.filter((row) => row.event === "panel_paint_failed");
  assert.equal(warnings.length, 1, "a broken panel is reported once, not once per stage");
  assert.equal(rig.session.state(), "ready", "the session is untouched by the failed paint");
});

test("S12.2 follow:work raises the read slot tab that a stage names", async () => {
  const rig = await harness({
    autoAdvance: false,
    configure: (config) => {
      config.window.focus = "session";
      config.window.follow = "work";
      config.window.idleMs = 1000;
    },
  });
  await rig.session.connect();
  await rig.session.acquirePage("read");
  const read = rig.targetFor("read");
  const anchor = rig.anchorTarget();

  await rig.session.announce({ stage: "read", page: "read" });
  assert.deepEqual(rig.raises().at(-1), read, "a read raises its own slot tab, not 'no tab'");

  await rig.session.announce({ stage: "done", page: "read" });
  rig.clock.advance(1000);
  await tick();
  assert.deepEqual(rig.raises().at(-1), anchor, "and the anchor comes back after the idle window");
});
