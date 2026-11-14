/**
 * Desktop attention for the one manual step (S8.4, S12; PLAN P7).
 *
 * The CDP Allow prompt is inside a browser window the agent cannot see, so the
 * product fires exactly one notification and, unless `window.raiseOnPrompt` is
 * "never", one best-effort raise. Everything here is injectable, so the suite
 * proves the *count* (one, not one per retry), the policy (`"never"` skips the
 * ladder), and that a missing binary or a failing adapter is a result — never a
 * reason to fail a search.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { raiseBrowserWindow } from "../../src/cdp/raise.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import { createAllowAttention, renderAwaitingAllow } from "../../src/runtime/attention.ts";
import type { AwaitingAllowInfo } from "../../src/session/index.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { fail } from "../../src/runtime/errors.ts";
import { createHostContext } from "../../src/runtime/host.ts";
import type { Logger } from "../../src/runtime/types.ts";
import { createSession } from "../../src/session/index.ts";
import { FakeClock } from "../helpers/fake-cdp.ts";
import { notifyDesktop, type CommandRunner, type NotifyRequest } from "../../src/runtime/notify.ts";

const HINT = "open chrome://inspect/#remote-debugging and click Allow for this session";

function allowConfig(raiseOnPrompt: Config["window"]["raiseOnPrompt"] = "auto"): Config {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.cdp.attachWaitMs = 60_000;
  config.window.raiseOnPrompt = raiseOnPrompt;
  return config;
}

function linuxHost(capabilities: Record<string, string> = {}) {
  return createHostContext({
    platform: "linux",
    home: "/tmp/pi-chrome-search-home",
    env: {},
    capabilities: (name) => capabilities[name] ?? null,
  });
}

function recorder(): { run: CommandRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push({ command, args: [...args] });
    },
  };
}

function allowInfo(elapsedMs: number, final = false): AwaitingAllowInfo {
  return {
    attempt: 1,
    elapsedMs,
    budgetMs: 60_000,
    hint: HINT,
    brand: { id: "chrome", label: "Google Chrome", scheme: "chrome" },
    endpoint: { port: 9222, wsUrl: "ws://127.0.0.1:9222/devtools/browser/x", source: "env-ports" },
    ...(final ? { final: true } : {}),
  };
}

test("S8.4 one notification and one raise for the whole Allow wait", async () => {
  const config = allowConfig();
  const notified: NotifyRequest[] = [];
  const raised: number[] = [];
  const progress: string[] = [];
  const attention = createAllowAttention({
    config,
    notify: async (request) => {
      notified.push(request);
      return { delivered: true, via: "notify-send", tried: ["notify-send"] };
    },
    raise: async () => {
      raised.push(1);
      return { raised: true, via: "wmctrl", tried: ["wmctrl"] };
    },
    onProgress: (line) => progress.push(line),
  });

  for (const elapsedMs of [0, 1_000, 2_000, 4_000]) attention.onAwaitingAllow(allowInfo(elapsedMs));
  attention.onAwaitingAllow(allowInfo(10_000, true));
  const outcome = await attention.flush();

  assert.equal(notified.length, 1, "a notification every two seconds is worse than a missed one");
  assert.equal(raised.length, 1);
  assert.equal(outcome.awaited, true);
  assert.equal(outcome.waitedMs, 10_000, "the final event carries the total wait");
  assert.deepEqual(outcome.notified, { delivered: true, via: "notify-send", tried: ["notify-send"] });
  assert.deepEqual(outcome.raise, { raised: true, via: "wmctrl", tried: ["wmctrl"] });

  const announcement = notified[0];
  assert.ok(announcement !== undefined);
  assert.match(announcement.title, /Allow/);
  assert.ok(announcement.body.includes(HINT), "the body repeats the executable hint");
  assert.match(announcement.body, /click Allow/i);
  assert.equal(announcement.urgency, "critical");

  assert.equal(progress.length, 3, "the wait prints on its own cadence, not per event");
  assert.deepEqual(
    progress.map((line) => line.match(/(\d+)s/)?.[1]),
    ["0", "2", "4"],
  );
  assert.ok(renderAwaitingAllow(allowInfo(2_000)).includes(HINT));
});

test("S8.4 the final event alone notifies nobody: the prompt was never reachable", async () => {
  let notified = 0;
  let raised = 0;
  const progress: string[] = [];
  const attention = createAllowAttention({
    config: allowConfig(),
    notify: async () => {
      notified += 1;
      return { delivered: true, via: "notify-send", tried: ["notify-send"] };
    },
    raise: async () => {
      raised += 1;
      return { raised: true, via: "wmctrl", tried: ["wmctrl"] };
    },
    onProgress: (line) => progress.push(line),
  });

  attention.onAwaitingAllow(allowInfo(60_000, true));
  const outcome = await attention.flush();

  assert.equal(notified, 0);
  assert.equal(raised, 0);
  assert.deepEqual(progress, []);
  assert.equal(outcome.awaited, true);
  assert.equal(outcome.waitedMs, 60_000);
});

test("S8.4 a failed notification or raise is reported, never thrown", async () => {
  const attention = createAllowAttention({
    config: allowConfig(),
    notify: async () => ({
      delivered: false,
      via: null,
      tried: ["notify-send", "gdbus"],
      error: "no notification server",
    }),
    raise: async () => {
      throw new Error("no compositor adapter");
    },
  });

  attention.onAwaitingAllow(allowInfo(0));
  const outcome = await attention.flush();

  assert.equal(outcome.notified?.delivered, false);
  assert.deepEqual(outcome.notified?.tried, ["notify-send", "gdbus"]);
  assert.equal(outcome.raise, null, "a rejected raise is an absent raise");
});

test("S12.2 window.raiseOnPrompt:never skips the raise ladder entirely", async () => {
  const { run, calls } = recorder();
  const attention = createAllowAttention({
    config: allowConfig("never"),
    notify: async () => ({ delivered: true, via: "notify-send", tried: ["notify-send"] }),
    raiseOptions: { host: linuxHost({ wmctrl: "/usr/bin/wmctrl" }), run },
  });

  attention.onAwaitingAllow(allowInfo(0));
  const outcome = await attention.flush();

  assert.equal(calls.length, 0, "never means never: no process is spawned");
  assert.equal(outcome.raise?.skipped, true);
  assert.equal(outcome.raise?.tried.length, 0);
});

test("S8.4 the notify ladder stops at the first adapter that works", async () => {
  const attempts: string[] = [];
  const result = await notifyDesktop(
    { title: "Chrome is waiting for Allow", body: HINT, urgency: "critical" },
    {
      host: linuxHost(),
      resolve: (name) =>
        name === "notify-send" ? "/usr/bin/notify-send" : name === "gdbus" ? "/usr/bin/gdbus" : null,
      run: async (command) => {
        attempts.push(command);
        if (command.endsWith("notify-send")) throw new Error("no notification server");
      },
    },
  );

  assert.equal(result.delivered, true);
  assert.equal(result.via, "gdbus");
  assert.deepEqual(result.tried, ["notify-send", "gdbus"]);
  assert.deepEqual(attempts, ["/usr/bin/notify-send", "/usr/bin/gdbus"]);
});

test("S8.4 no notification binary is a result, not an exception", async () => {
  const result = await notifyDesktop(
    { title: "Chrome is waiting for Allow", body: HINT },
    { host: linuxHost(), resolve: () => null, run: async () => assert.fail("nothing to run") },
  );

  assert.equal(result.delivered, false);
  assert.equal(result.via, null);
  assert.deepEqual(result.tried, []);
});

test("S12.2 the raise ladder focuses an existing window and nothing more", async () => {
  const { run, calls } = recorder();
  const result = await raiseBrowserWindow({
    host: linuxHost(),
    brand: { id: "chrome", label: "Google Chrome", scheme: "chrome" },
    policy: "auto",
    resolve: (name) => (name === "wmctrl" ? "/usr/bin/wmctrl" : null),
    run,
  });

  assert.equal(result.raised, true);
  assert.equal(result.via, "wmctrl");
  assert.deepEqual(result.tried, ["wmctrl"]);
  assert.equal(calls.length, 1, "one success stops the ladder");
  const [call] = calls;
  assert.ok(call !== undefined);
  assert.equal(call.command, "/usr/bin/wmctrl");
  assert.ok(
    call.args.every((arg) => !/launch|open|start/i.test(arg)),
    "attention never launches or opens anything",
  );
});

test("S12.2 raise policy never runs no adapter at all", async () => {
  const { run, calls } = recorder();
  const result = await raiseBrowserWindow({
    host: linuxHost({ wmctrl: "/usr/bin/wmctrl" }),
    policy: "never",
    run,
  });

  assert.equal(result.raised, false);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.tried, []);
  assert.equal(calls.length, 0);
});

test("S12.2 an absent raise adapter is a normal result", async () => {
  const result = await raiseBrowserWindow({
    host: linuxHost(),
    policy: "auto",
    resolve: () => null,
    run: async () => assert.fail("nothing to run"),
  });

  assert.equal(result.raised, false);
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.tried, []);
});

test("S8.4/S12.2 the extension wiring turns a pending Allow prompt into one notification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chrome-attention-"));
  const clock = new FakeClock();
  const log: Logger = { async write() {}, path: () => "/dev/null" };
  const notified: NotifyRequest[] = [];
  const config = allowConfig();
  config.cdp.attachWaitMs = 1_000;
  const attention = createAllowAttention({
    config,
    notify: async (request) => {
      notified.push(request);
      return { delivered: true, via: "notify-send", tried: ["notify-send"] };
    },
    raise: async () => ({ raised: false, via: null, tried: [] }),
  });
  const session = createSession({
    config,
    discover: async () => ({
      port: 9222,
      wsUrl: "ws://127.0.0.1:9222/devtools/browser/pending-allow",
      source: "env-ports",
    }),
    connectClient: async () => {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "CDP socket closed before it was ready",
      });
    },
    clock,
    log,
    lockPath: join(dir, "web-search.lock"),
    onAwaitingAllow: (info) => attention.onAwaitingAllow(info),
  });

  let error: unknown;
  try {
    await session.connect();
  } catch (caught) {
    error = caught;
  }
  const outcome = await attention.flush();
  await session.shutdown();
  await rm(dir, { recursive: true, force: true });

  assert.ok(isWebSearchError(error), `expected a WebSearchError, got ${String(error)}`);
  assert.equal(error.details.code, "E_CDP_AWAITING_ALLOW");
  assert.equal(notified.length, 1, "retries of the handshake never multiply the notification");
  assert.equal(outcome.awaited, true);
  assert.equal(outcome.waitedMs, 1_000, "the wait is the configured cdp.attachWaitMs");
  assert.equal(outcome.notified?.delivered, true);
});
