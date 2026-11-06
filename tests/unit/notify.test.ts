/**
 * P11/L1 — the desktop-notification ladder.
 *
 * Offline by construction: the capability resolver and the command runner are
 * injected, so no test can start a process or touch a real desktop session. The
 * cases pin the portability ladder (notify-send → gdbus → dbus-send), the
 * per-OS adapters, and the "never fatal, never throws" contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { notifyDesktop, type CommandRunner, type NotifyResult } from "../../src/runtime/notify.ts";
import { createHostContext, type CapabilityName } from "../../src/runtime/host.ts";

interface RunRecord {
  command: string;
  args: string[];
  timeoutMs: number;
}

function harness(options: {
  platform?: NodeJS.Platform;
  installed?: readonly CapabilityName[];
  fail?: readonly string[];
} = {}): {
  resultOf: (request: Parameters<typeof notifyDesktop>[0]) => Promise<NotifyResult>;
  runs: RunRecord[];
} {
  const installed = new Set(options.installed ?? []);
  const failing = new Set(options.fail ?? []);
  const runs: RunRecord[] = [];
  const host = createHostContext({
    platform: options.platform ?? "linux",
    env: {},
    capabilities: (name) => (installed.has(name) ? `/fake/bin/${name}` : null),
  });
  const run: CommandRunner = async (command, args, timeoutMs) => {
    runs.push({ command, args: [...args], timeoutMs });
    const name = command.split("/").pop() ?? command;
    if (failing.has(name)) throw new Error(`${name} failed`);
  };

  return {
    runs,
    resultOf: (request) => notifyDesktop(request, { host, run, timeoutMs: 250 }),
  };
}

test("linux: notify-send is the first adapter and asks for a persistent critical popup", async () => {
  const helper = harness({ installed: ["notify-send", "gdbus"] });
  const result = await helper.resultOf({ title: "Allow", body: "click it", urgency: "critical" });

  assert.equal(result.delivered, true);
  assert.equal(result.via, "notify-send");
  assert.deepEqual(result.tried, ["notify-send"]);
  assert.equal(helper.runs.length, 1);
  const [run] = helper.runs;
  assert.equal(run?.command, "/fake/bin/notify-send");
  assert.deepEqual(run?.args.slice(0, 6), ["-a", "pi-chrome-search", "-u", "critical", "-t", "0"]);
  assert.equal(run?.args[6], "Allow");
  assert.equal(run?.args[7], "click it");
});

test("linux: a failed adapter falls through to gdbus, and to dbus-send after that", async () => {
  const helper = harness({ installed: ["notify-send", "gdbus"], fail: ["notify-send"] });
  const result = await helper.resultOf({ title: "Allow", body: "click it" });

  assert.equal(result.via, "gdbus");
  assert.deepEqual(result.tried, ["notify-send", "gdbus"]);
  const gdbus = helper.runs[1];
  assert.equal(gdbus?.command, "/fake/bin/gdbus");
  assert.deepEqual(gdbus?.args.slice(0, 6), [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.Notifications",
    "--object-path",
    "/org/freedesktop/Notifications",
  ]);
  assert.ok(gdbus?.args.includes("org.freedesktop.Notifications.Notify"));
  assert.equal(gdbus?.args.at(-2), "{'urgency': <byte 1>}", "normal urgency is an XDG hint, not a flag");
});

test("linux: nothing installed is a clean 'unavailable', never an error", async () => {
  const helper = harness({ installed: [] });
  const result = await helper.resultOf({ title: "Allow", body: "click it" });

  assert.deepEqual(result, { delivered: false, via: null, tried: [] });
  assert.equal(helper.runs.length, 0);
});

test("every adapter failing still returns a result instead of throwing", async () => {
  const helper = harness({
    installed: ["notify-send", "gdbus", "dbus-send"],
    fail: ["notify-send", "gdbus", "dbus-send"],
  });
  const result = await helper.resultOf({ title: "Allow", body: "click it" });

  assert.equal(result.delivered, false);
  assert.equal(result.via, null);
  assert.deepEqual(result.tried, ["notify-send", "gdbus", "dbus-send"]);
  assert.match(result.error ?? "", /dbus-send failed/);
});

test("macOS uses osascript and quotes the text safely", async () => {
  const helper = harness({ platform: "darwin", installed: ["osascript"] });
  const result = await helper.resultOf({ title: 'Allow "now"', body: "click it\\please" });

  assert.equal(result.via, "osascript");
  const [run] = helper.runs;
  assert.equal(run?.command, "/fake/bin/osascript");
  assert.equal(run?.args[0], "-e");
  assert.match(run?.args[1] ?? "", /^display notification "click it\\\\please" with title "Allow \\"now\\""$/);
  // The hint mentions osascript only where it exists; no Linux adapter is tried.
  assert.deepEqual(result.tried, ["osascript"]);
});

test("Windows uses powershell and a self-contained toast script", async () => {
  const helper = harness({ platform: "win32", installed: ["powershell"] });
  const result = await helper.resultOf({ title: "Allow", body: "click it" });

  assert.equal(result.via, "powershell");
  const [run] = helper.runs;
  assert.equal(run?.args[0], "-NoProfile");
  assert.equal(run?.args[1], "-NonInteractive");
  assert.match(run?.args[3] ?? "", /ToastNotificationManager/);
});

test("notification text is collapsed to one line and capped", async () => {
  const helper = harness({ installed: ["notify-send"] });
  const body = `line one\nline two ${"x".repeat(400)}`;
  await helper.resultOf({ title: "  Allow\nnow  ", body });

  const [run] = helper.runs;
  assert.equal(run?.args[6], "Allow now");
  assert.ok((run?.args[7] ?? "").length <= 300);
  assert.equal((run?.args[7] ?? "").includes("\n"), false);
});

test("a synchronous runner throw is still swallowed", async () => {
  const host = createHostContext({
    platform: "linux",
    env: {},
    capabilities: (name) => (name === "notify-send" ? "/fake/bin/notify-send" : null),
  });
  const run = (() => {
    throw "not even an Error";
  }) as unknown as CommandRunner;
  const result = await notifyDesktop({ title: "t", body: "b" }, { host, run });
  assert.equal(result.delivered, false);
  assert.equal(result.error, "not even an Error");
});
