/**
 * P11 — the attention coordinator.
 *
 * One event, three layers: a throttled progress line (L0, called back to the
 * terminal surface), exactly one notification (L1) and exactly one raise (L2).
 * Nothing here may block or fail the connect loop; `flush()` exists so the
 * doctor can wait for the outcomes before it prints its report.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AwaitingAllowInfo } from "../../src/cdp/browser.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import {
  createAllowAttention,
  oscNotification,
  renderAwaitingAllow,
} from "../../src/runtime/attention.ts";
import { browserBrandFor } from "../../src/runtime/host.ts";

function configWith(raiseOnPrompt: "auto" | "never"): Config {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.window.raiseOnPrompt = raiseOnPrompt;
  return config;
}

function event(elapsedMs: number, attempt = 1): AwaitingAllowInfo {
  return {
    attempt,
    elapsedMs,
    budgetMs: 60_000,
    hint: "open chrome://inspect/#remote-debugging, tick \"Discover network targets\" and click Allow",
    brand: browserBrandFor("/home/u/.config/google-chrome"),
    endpoint: {
      port: 9222,
      wsUrl: "ws://127.0.0.1:9222/devtools/browser/x",
      source: "devtools-active-port",
      profileDir: "/home/u/.config/google-chrome",
    },
  };
}

test("one notification and one raise per session, however many progress events arrive", async () => {
  const lines: string[] = [];
  let notifications = 0;
  let raises = 0;
  const attention = createAllowAttention({
    config: configWith("auto"),
    onProgress: (line) => lines.push(line),
    notify: async () => {
      notifications += 1;
      return { delivered: true, via: "notify-send", tried: ["notify-send"] };
    },
    raise: async () => {
      raises += 1;
      return { raised: true, via: "hyprctl", tried: ["hyprctl"] };
    },
  });

  for (const elapsed of [0, 1_000, 3_000, 9_000, 21_000]) {
    attention.onAwaitingAllow(event(elapsed));
  }
  const outcome = await attention.flush();

  assert.equal(notifications, 1, "a notification every two seconds is harassment, not attention");
  assert.equal(raises, 1);
  assert.equal(outcome.awaited, true);
  assert.equal(outcome.waitedMs, 21_000);
  assert.equal(outcome.notified?.via, "notify-send");
  assert.equal(outcome.raise?.via, "hyprctl");
  // Throttled to one line per >=2 s, starting with the first event.
  assert.deepEqual(lines.map((line) => line.split("…")[1]?.trim().split(" ")[0]), ["0s", "3s", "9s", "21s"]);
});

test("the final event reports the total wait without another line or notification", async () => {
  const lines: string[] = [];
  let notifications = 0;
  const attention = createAllowAttention({
    config: configWith("auto"),
    onProgress: (line) => lines.push(line),
    notify: async () => {
      notifications += 1;
      return { delivered: true, via: "notify-send", tried: [] };
    },
    raise: async () => ({ raised: false, via: null, tried: [] }),
  });

  attention.onAwaitingAllow(event(3_000));
  attention.onAwaitingAllow({ ...event(8_015), attempt: 2, final: true });

  const outcome = await attention.flush();
  assert.equal(lines.length, 1, "giving up is not a progress event");
  assert.equal(notifications, 1);
  assert.equal(outcome.waitedMs, 8_015, "the report must name the whole wait, not the last heartbeat");
});

test("the notification is critical and tells the user the call resumes by itself", async () => {
  const requests: Parameters<NonNullable<Parameters<typeof createAllowAttention>[0]["notify"]>>[0][] = [];
  const attention = createAllowAttention({
    config: configWith("auto"),
    notify: async (request) => {
      requests.push(request);
      return { delivered: false, via: null, tried: [] };
    },
    raise: async () => ({ raised: false, via: null, tried: [] }),
  });

  attention.onAwaitingAllow(event(0));
  await attention.flush();

  const request = requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.urgency, "critical");
  assert.match(request.title, /Allow/);
  assert.match(request.body, /inspect/);
  assert.match(request.body, /resumes by itself/);
});

test("a failed notification and an unavailable raise never reject the hook", async () => {
  const attention = createAllowAttention({
    config: configWith("never"),
    notify: async () => {
      throw new Error("desktop is gone");
    },
    raise: async () => {
      throw new Error("compositor is gone");
    },
  });

  attention.onAwaitingAllow(event(0));
  const outcome = await attention.flush();
  assert.equal(outcome.notified, null);
  assert.equal(outcome.raise, null);
  assert.equal(attention.outcome().awaited, true);
});

test("OSC notification carries both escape dialects and strips control bytes", () => {
  const text = "waiting\u0007 for\u001b Allow";
  const sequence = oscNotification(text);
  assert.ok(sequence.startsWith("\u001b]9;"));
  assert.ok(sequence.includes("\u001b]777;notify;pi-chrome-search;"));
  assert.ok(sequence.endsWith("\u0007"), "every OSC is BEL-terminated");
  assert.ok(!sequence.includes("\u001b Allow"));
});

test("the plain progress line never contains an escape", () => {
  const line = renderAwaitingAllow(event(4_500));
  assert.match(line, /^waiting for the Allow prompt… 5s — open chrome:\/\/inspect/);
  assert.equal(line.includes("\u001b"), false);
});
