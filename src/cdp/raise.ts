/**
 * Best-effort "bring the browser window forward" for the Allow prompt (P11/L2).
 *
 * This is the **optional** layer. There is no portable API to raise a foreign
 * window: X11 has EWMH, Wayland has nothing, and every compositor invents its
 * own IPC. So the module is a table of *optional* adapters, tried in portability
 * order (X11 tools → KWin → Hyprland → sway → macOS → Windows), each with a 1 s
 * timeout, and `raise: unavailable` is a perfectly normal result.
 *
 * Hard rules:
 *  - it only *focuses an existing window*; it never opens a window, a tab or a
 *    URL, and never launches the browser (`gio launch chrome.desktop` is
 *    deliberately absent: activating a stopped browser is not attention, it is
 *    a side effect);
 *  - the exact command is logged so a wrong adapter is diagnosable;
 *  - `window.raiseOnPrompt: "never"` skips the whole ladder;
 *  - it never throws.
 */

import { execFile } from "node:child_process";

import { capability, host, type BrowserBrand, type CapabilityName, type HostContext } from "../runtime/host.ts";
import type { CommandRunner } from "../runtime/notify.ts";

export interface RaiseResult {
  raised: boolean;
  /** Adapter that succeeded (`wmctrl`, `hyprctl`, …), or `null`. */
  via: string | null;
  /** Exact command line, for the doctor/log; `undefined` when nothing was tried. */
  command?: string;
  /** Commands that were tried and failed, in order. */
  tried: string[];
  /** Why the last attempt failed (never the full window list). */
  error?: string;
  /** True when the policy forbade any attempt. */
  skipped?: boolean;
}

export interface RaiseOptions {
  host?: HostContext;
  brand?: BrowserBrand | null;
  policy?: "auto" | "never";
  resolve?: (name: CapabilityName) => string | null;
  run?: CommandRunner;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1_000;

const systemRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (error) => {
        if (error !== null) reject(error);
        else resolve(undefined);
      },
    );
  });

/** Window identity per family: a compositor matches by WM_CLASS or app_id. */
interface WindowIdentity {
  /** X11/Wayland class or app_id, e.g. `google-chrome`. */
  class: string;
  /** Window title fragment used by `wmctrl -a` and AppActivate. */
  title: string;
  /** macOS application name for `osascript … activate`. */
  app: string;
}

const IDENTITIES: Record<string, WindowIdentity> = {
  chrome: { class: "google-chrome", title: "Google Chrome", app: "Google Chrome" },
  chromium: { class: "chromium", title: "Chromium", app: "Chromium" },
  brave: { class: "brave-browser", title: "Brave", app: "Brave Browser" },
  edge: { class: "microsoft-edge", title: "Microsoft Edge", app: "Microsoft Edge" },
};

function identityFor(brand: BrowserBrand | null): WindowIdentity {
  const id = brand?.id ?? "chrome";
  return IDENTITIES[id] ?? IDENTITIES.chrome!;
}

interface Adapter {
  via: string;
  /** Candidate binaries in preference order; the first installed one is used. */
  binaries: readonly CapabilityName[];
  args: (command: string, identity: WindowIdentity) => string[];
}

/**
 * Portability order: the X11/EWMH pair first (works on X11 and under XWayland),
 * then the two compositor-specific tools, then sway's IPC client. Each row is
 * tried only when its binary exists; one success stops the ladder.
 */
const LINUX_ADAPTERS: readonly Adapter[] = [
  {
    via: "wmctrl",
    binaries: ["wmctrl"],
    args: (_command, identity) => ["-a", identity.title],
  },
  {
    via: "xdotool",
    binaries: ["xdotool"],
    args: (_command, identity) => ["search", "--class", identity.class, "windowactivate"],
  },
  {
    via: "kdotool",
    binaries: ["kdotool"],
    args: (_command, identity) => ["search", "--class", identity.class, "windowactivate"],
  },
  // Hyprland 0.57 replaced the dispatcher string with a Lua API (`hyprctl eval
  // 'hl.dsp.focus(…)'`); older builds still accept `dispatch focuswindow`. Try the
  // modern form, then the legacy one — the binary is the same, the syntax is not.
  {
    via: "hyprctl-eval",
    binaries: ["hyprctl"],
    args: (_command, identity) => ["eval", `hl.dsp.focus({window="class:${identity.class}"})`],
  },
  {
    via: "hyprctl-dispatch",
    binaries: ["hyprctl"],
    args: (_command, identity) => ["dispatch", "focuswindow", `class:${identity.class}`],
  },
  {
    via: "swaymsg",
    binaries: ["swaymsg"],
    args: (_command, identity) => [`[app_id="${identity.class}"]`, "focus"],
  },
];

interface Candidate {
  via: string;
  command: string;
  args: string[];
}

function linuxCandidates(
  identity: WindowIdentity,
  resolve: (name: CapabilityName) => string | null,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const adapter of LINUX_ADAPTERS) {
    for (const binary of adapter.binaries) {
      const command = resolve(binary);
      if (command === null) continue;
      candidates.push({ via: adapter.via, command, args: adapter.args(command, identity) });
      break;
    }
  }
  return candidates;
}

function darwinCandidates(
  identity: WindowIdentity,
  resolve: (name: CapabilityName) => string | null,
): Candidate[] {
  const osascript = resolve("osascript");
  if (osascript === null) return [];
  // `activate` raises the running app; it never launches one that is not
  // running (AppleScript asks the user in that case), which is the right
  // behaviour for attention.
  return [
    {
      via: "osascript",
      command: osascript,
      args: ["-e", `tell application ${JSON.stringify(identity.app)} to activate`],
    },
  ];
}

function windowsCandidates(
  identity: WindowIdentity,
  resolve: (name: CapabilityName) => string | null,
): Candidate[] {
  const powershell = resolve("powershell");
  if (powershell === null) return [];
  const app = identity.title.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `[Microsoft.VisualBasic.Interaction]::AppActivate('${app}')`,
  ].join("; ");
  return [{ via: "powershell", command: powershell, args: ["-NoProfile", "-NonInteractive", "-Command", script] }];
}

/**
 * Try to raise the browser window once. Never throws, never installs, never
 * relaunches; an absent adapter or a refusing compositor is a normal result.
 */
export async function raiseBrowserWindow(options: RaiseOptions = {}): Promise<RaiseResult> {
  const ctx = options.host ?? host();
  const policy = options.policy ?? "auto";
  if (policy === "never") {
    return { raised: false, via: null, tried: [], skipped: true };
  }

  const identity = identityFor(options.brand ?? null);
  const resolve = options.resolve ?? ((name: CapabilityName) => capability(name, ctx));
  const run = options.run ?? systemRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const candidates =
    ctx.platform === "darwin"
      ? darwinCandidates(identity, resolve)
      : ctx.platform === "win32"
        ? windowsCandidates(identity, resolve)
        : linuxCandidates(identity, resolve);

  const tried: string[] = [];
  let error: string | undefined;
  for (const candidate of candidates) {
    const line = [candidate.command, ...candidate.args].join(" ");
    tried.push(candidate.via);
    try {
      await run(candidate.command, candidate.args, timeoutMs);
      return { raised: true, via: candidate.via, command: line, tried };
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  return {
    raised: false,
    via: null,
    tried,
    ...(error === undefined ? {} : { error: error.length > 200 ? `${error.slice(0, 199)}…` : error }),
  };
}
