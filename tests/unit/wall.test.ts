/**
 * A wall is immediate (S8.5, S12.4, SPEC D5; PLAN P7).
 *
 * The product never solves a captcha, never waits for a timer and never
 * re-navigates a walled page. The observable contract this suite pins:
 *
 *  - `E_WALL` reaches the agent at once, with `wall`, `retryable` and an
 *    artifact directory for the page the human is looking at;
 *  - the window is surfaced exactly once, so the captcha is in front of them;
 *  - the tab keeps the wall page: no re-navigation, no reload, no anchor jump;
 *  - no clock sleep runs on the wall path (the wait is the human's, not ours);
 *  - a wall in a coverage set is reported per engine and its tab is left alone
 *    while the remaining engines are asked.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Wall } from "../../src/engines/types.ts";
import { ERROR_HINTS } from "../../src/runtime/error-codes.ts";
import { fail } from "../../src/runtime/errors.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { createEngineStub, createHarness, resultText } from "../helpers/search-harness.ts";

const WALL: Wall = {
  kind: "captcha",
  url: "https://www.google.example.test/sorry/index?continue=1",
  markers: ["unusual traffic", "not a robot"],
};

/** One enabled engine; the wall is the only outcome. */
function singleEngineHarness(wall: Wall) {
  const google = createEngineStub("google");
  let navigationsAtWall = -1;
  const rig = createHarness({
    engines: [google],
    configure: (config) => {
      config.engines.duckduckgo = { ...config.engines.duckduckgo, enabled: false };
      config.engines.yandex = { ...config.engines.yandex, enabled: false };
    },
  });
  google.detectWall = async () => {
    navigationsAtWall = rig.pages.get("google")?.navigations().length ?? -1;
    return wall;
  };
  return { rig, google, navigationsAtWall: () => navigationsAtWall };
}

test("D5/S8.5 a wall is E_WALL at once: surfaced once, one artifact, no timer", async () => {
  const { rig, google, navigationsAtWall } = singleEngineHarness(WALL);
  await rig.deps.cdp.acquirePage("google");
  const page = rig.pages.get("google");
  assert.ok(page !== undefined);

  const result = await createWebSearchTool(async () => rig.deps).execute(
    "call-wall",
    { q: "cloudflare outage", engines: "google" },
    undefined,
    undefined,
  );

  if (!("isError" in result)) assert.fail("a wall must be a typed failure");
  assert.equal(result.isError, true);
  const details = result.details;
  assert.equal(details.code, "E_WALL");
  assert.equal(details.stage, "navigate");
  assert.equal(details.engine, "google");
  assert.equal(details.retryable, true);
  assert.equal(details.wall, "captcha");
  assert.match(details.artifact ?? "", /artifact/, "the page state is on disk for the human and the log");
  const text = resultText(result);
  assert.match(text, /E_WALL/, "the failure names its code");
  assert.ok(
    text.includes(ERROR_HINTS.E_WALL),
    "the hint names the only real remedy: solve it in the visible window and retry",
  );

  assert.equal(navigationsAtWall(), 1, "the wall was detected on the one SERP navigation");
  assert.equal(page.navigations().length, 1, "no automatic re-navigation after a wall");
  assert.equal(
    page.lastNavigation(),
    google.buildUrl({ text: "cloudflare outage", n: 5, page: 1, summary: true }),
    "the tab still shows the SERP the wall appeared on",
  );
  assert.equal(page.bringToFrontCount(), 1, "the window is surfaced exactly once");

  assert.deepEqual(rig.clock.sleepLog(), [], "a wall is not a wait-for-human timer");
  assert.equal(rig.artifacts.length, 1, "one artifact for the wall the caller sees");
  assert.equal(rig.artifacts[0]?.code, "E_WALL");
  assert.deepEqual(rig.artifacts[0]?.extra, {
    wall: { kind: "captcha", url: WALL.url, markers: [...WALL.markers] },
  });
});

test("D5 a wall that breaks the settle marker is still E_WALL, not a timeout", async () => {
  const google = createEngineStub("google");
  google.settleImpl = async () => {
    throw fail("E_TIMEOUT", "settle", {
      engine: "google",
      message: 'marker "results" not found after 8000 ms',
    });
  };
  google.detectWall = async () => WALL;
  const rig = createHarness({
    engines: [google],
    configure: (config) => {
      config.engines.duckduckgo = { ...config.engines.duckduckgo, enabled: false };
      config.engines.yandex = { ...config.engines.yandex, enabled: false };
    },
  });
  await rig.deps.cdp.acquirePage("google");
  const page = rig.pages.get("google");
  assert.ok(page !== undefined);

  const result = await createWebSearchTool(async () => rig.deps).execute(
    "call-wall-settle",
    { q: "cloudflare outage", engines: "google" },
    undefined,
    undefined,
  );

  if (!("isError" in result)) assert.fail("a wall must be a typed failure");
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "E_WALL", "a captcha page usually fails the readiness marker first");
  assert.equal(result.details.wall, "captcha");
  assert.equal(page.navigations().length, 1, "the failed settle did not trigger a retry navigation");
  assert.deepEqual(rig.clock.sleepLog(), [], "no backoff loop around the wall");
  assert.equal(rig.artifacts.length, 1);
});

test("S4.1/D5 a wall in a coverage set is reported per engine and its tab keeps the page", async () => {
  const google = createEngineStub("google");
  const yandex = createEngineStub("yandex");
  let yandexNavigationsAtWall = -1;
  const rig = createHarness({
    engines: [google, yandex],
    configure: (config) => {
      config.engines.duckduckgo = { ...config.engines.duckduckgo, enabled: false };
      // A coverage set needs at least two engines; `google` and `yandex` remain.
      config.engines.yandex = { ...config.engines.yandex, enabled: true };
    },
  });
  yandex.detectWall = async () => {
    yandexNavigationsAtWall = rig.pages.get("yandex")?.navigations().length ?? -1;
    return { ...WALL, url: "https://yandex.example.test/showcaptcha" };
  };
  await rig.deps.cdp.acquirePage("yandex");
  const yandexPage = rig.pages.get("yandex");
  assert.ok(yandexPage !== undefined);

  const result = await createWebSearchTool(async () => rig.deps).execute(
    "call-wall-merge",
    { q: "redis cluster", engines: ["google", "yandex"], n: 2 },
    undefined,
    undefined,
  );

  if ("isError" in result) assert.fail("the coverage set still merges the engines that answered");
  assert.equal(result.details.failedEngines?.yandex, "E_WALL");
  assert.equal(result.details.perEngine?.yandex, 0, "the walled engine contributed no result");
  assert.equal(result.details.perEngine?.google, 1, "n=2 across two engines is one result each");

  assert.equal(yandexNavigationsAtWall, 1);
  assert.equal(yandexPage.navigations().length, 1, "a walled tab is never navigated again");
  assert.equal(yandexPage.bringToFrontCount(), 1, "surfaced once for the human to solve");
  assert.deepEqual(
    rig.clock.sleepLog(),
    [],
    "the coverage set paces nothing and waits for no timer after a wall",
  );
});
