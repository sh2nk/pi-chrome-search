/**
 * P11/L2 — the optional window-raise ladder.
 *
 * The whole point is that this layer is *optional*: a missing compositor tool is
 * a normal result, never a failure and never a reason to open something. These
 * tests pin the adapter table, the exact command line, the policy switch and the
 * hard rule that nothing may launch a browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { raiseBrowserWindow, type RaiseResult } from "../../src/cdp/raise.ts";
import { browserBrandFor, createHostContext, type CapabilityName } from "../../src/runtime/host.ts";
import type { CommandRunner } from "../../src/runtime/notify.ts";

interface RunRecord {
  command: string;
  args: string[];
}

function harness(options: {
  platform?: NodeJS.Platform;
  installed?: readonly CapabilityName[];
  fail?: readonly string[];
} = {}): {
  raise: (overrides?: Parameters<typeof raiseBrowserWindow>[0]) => Promise<RaiseResult>;
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
  const run: CommandRunner = async (command, args) => {
    runs.push({ command, args: [...args] });
    const name = command.split("/").pop() ?? command;
    if (failing.has(name)) throw new Error(`${name} refused`);
  };

  return {
    runs,
    raise: (overrides = {}) => raiseBrowserWindow({ host, run, timeoutMs: 250, ...overrides }),
  };
}

const brand = browserBrandFor("/home/u/.config/google-chrome");

test("policy 'never' skips the ladder entirely", async () => {
  const helper = harness({ installed: ["wmctrl", "hyprctl"] });
  const result = await helper.raise({ policy: "never", brand });

  assert.equal(result.skipped, true);
  assert.equal(result.raised, false);
  assert.deepEqual(result.tried, []);
  assert.equal(helper.runs.length, 0);
});

test("no adapter installed is an honest 'unavailable', not an error", async () => {
  const helper = harness({ installed: [] });
  const result = await helper.raise({ brand });

  assert.equal(result.raised, false);
  assert.equal(result.via, null);
  assert.deepEqual(result.tried, []);
  assert.equal(result.error, undefined);
});

test("hyprctl: the modern Lua form is tried before the legacy dispatcher", async () => {
  const helper = harness({ installed: ["hyprctl"] });
  const result = await helper.raise({ brand });

  assert.equal(result.raised, true);
  assert.equal(result.via, "hyprctl-eval");
  assert.deepEqual(helper.runs[0]?.args, ["eval", 'hl.dsp.focus({window="class:google-chrome"})']);

  const legacy = harness({ installed: ["hyprctl"], fail: [] });
  // A build without `eval` fails the first form; the second must still run.
  const run = legacy.raise;
  const fallback = await (async () => {
    const original = legacy.runs.length;
    const resultLegacy = await (async () => {
      let calls = 0;
      return await raiseBrowserWindow({
        host: createHostContext({
          platform: "linux",
          env: {},
          capabilities: (name) => (name === "hyprctl" ? "/fake/bin/hyprctl" : null),
        }),
        brand,
        timeoutMs: 250,
        run: async (command, args) => {
          calls += 1;
          if (calls === 1) throw new Error("unknown command eval");
          legacy.runs.push({ command, args: [...args] });
        },
      });
    })();
    return resultLegacy;
  })();
  assert.equal(fallback.via, "hyprctl-dispatch");
  assert.deepEqual(legacy.runs.at(-1)?.args, ["dispatch", "focuswindow", "class:google-chrome"]);
  void run;
});

test("a X11 tool is preferred, and a refusing one falls through to the next", async () => {
  const helper = harness({ installed: ["wmctrl", "hyprctl"], fail: ["wmctrl"] });
  const result = await helper.raise({ brand });

  assert.equal(result.via, "hyprctl-eval");
  assert.deepEqual(result.tried, ["wmctrl", "hyprctl-eval"]);
  assert.equal(helper.runs[0]?.command, "/fake/bin/wmctrl");
  assert.deepEqual(helper.runs[0]?.args, ["-a", "Google Chrome"]);
});

test("the brand decides the window identity, not a hardcoded 'Google Chrome'", async () => {
  const brave = harness({ installed: ["hyprctl"] });
  const braveResult = await brave.raise({ brand: browserBrandFor("/home/u/.config/BraveSoftware/Brave-Browser") });
  assert.deepEqual(brave.runs[0]?.args, ["eval", 'hl.dsp.focus({window="class:brave-browser"})']);
  assert.equal(braveResult.via, "hyprctl-eval");

  const edge = harness({ installed: ["wmctrl"] });
  await edge.raise({ brand: browserBrandFor("/home/u/.config/microsoft-edge") });
  assert.deepEqual(edge.runs[0]?.args, ["-a", "Microsoft Edge"]);
});

test("macOS activates the running app; Windows uses AppActivate", async () => {
  const mac = harness({ platform: "darwin", installed: ["osascript"] });
  const macResult = await mac.raise({ brand });
  assert.equal(macResult.via, "osascript");
  assert.match(mac.runs[0]?.args.join(" ") ?? "", /tell application "Google Chrome" to activate/);

  const win = harness({ platform: "win32", installed: ["powershell"] });
  const winResult = await win.raise({ brand });
  assert.equal(winResult.via, "powershell");
  assert.match(win.runs[0]?.args.join(" ") ?? "", /AppActivate\('Google Chrome'\)/);
});

test("no adapter may launch a browser or open a URL", async () => {
  const helper = harness({
    installed: ["wmctrl", "xdotool", "kdotool", "hyprctl", "swaymsg", "osascript", "powershell", "gio"],
  });
  await helper.raise({ brand });
  const lines = helper.runs.map((run) => `${run.command} ${run.args.join(" ")}`);
  for (const line of lines) {
    assert.doesNotMatch(line, /google-chrome-stable|--restart|https?:\/\/|gio launch/i);
  }
});
