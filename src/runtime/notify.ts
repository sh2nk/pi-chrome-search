/**
 * Desktop attention for the one manual step in the product (P11/L1).
 *
 * The CDP Allow prompt appears inside the browser window, so an agent that is
 * thinking in a terminal can miss it entirely. This module delivers *one*
 * best-effort notification through a per-OS ladder:
 *
 *   Linux   `notify-send` → `gdbus call org.freedesktop.Notifications.Notify`
 *           → `dbus-send` (all optional, all probed with `capability()`)
 *   macOS   `osascript -e 'display notification …'`
 *   Windows `powershell` + the WinRT toast API (best effort)
 *
 * Rules this module obeys:
 *  - it never throws: a missing binary, a failed D-Bus session or a hostile
 *    `PATH` is a *result*, never a reason to fail a search (PO1);
 *  - it never opens a window, a tab or a URL: attention is signalled, never
 *    manufactured by a side effect;
 *  - it is the only place (besides `cdp/raise.ts`) allowed to spawn, and every
 *    binary comes from `capability()`, never from a hardcoded path (audit R13).
 */

import { execFile } from "node:child_process";

import { capability, host, type CapabilityName, type HostContext } from "./host.ts";

export type NotifyUrgency = "low" | "normal" | "critical";

export interface NotifyRequest {
  title: string;
  body: string;
  /** `critical` asks the server to keep the popup until dismissed (Linux). */
  urgency?: NotifyUrgency;
}

export interface NotifyResult {
  delivered: boolean;
  /** Which adapter succeeded (`notify-send`, `gdbus`, `dbus-send`, `osascript`, `powershell`). */
  via: string | null;
  /** Every adapter that was tried, in order (empty when no binary exists). */
  tried: string[];
  /** Last failure message; never includes the notification body. */
  error?: string;
}

/** Runs one command, throwing on a non-zero exit or a timeout. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<void>;

export interface NotifyOptions {
  /** Defaults to the process host context. */
  host?: HostContext;
  /** Defaults to `capability()` on that host context. */
  resolve?: (name: CapabilityName) => string | null;
  /** Defaults to `execFile` with a hard timeout; tests inject a recorder. */
  run?: CommandRunner;
  /** Per-adapter budget; the plan allows ~1 s. */
  timeoutMs?: number;
  /** App name shown by the notification server. */
  appName?: string;
}

const DEFAULT_APP_NAME = "pi-chrome-search";
const DEFAULT_TIMEOUT_MS = 1_000;

/** `execFile` with a hard timeout; the child is ours, never Chrome. */
const systemRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (error) => {
        if (error !== null) reject(error);
        else resolve();
      },
    );
  });

function clampText(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) : oneLine;
}

/** AppleScript/PowerShell string literal: JSON escaping is close enough. */
function quoted(value: string): string {
  return JSON.stringify(value);
}

interface Candidate {
  via: string;
  command: string;
  args: string[];
}

function notifySendArgs(appName: string, request: NotifyRequest): string[] {
  const urgency = request.urgency ?? "normal";
  return [
    "-a",
    appName,
    "-u",
    urgency,
    // 0 = "never expire" when the server advertises persistence; the XDG spec
    // treats it as a hint, so a server that ignores it still shows the popup.
    "-t",
    "0",
    clampText(request.title, 80),
    clampText(request.body, 300),
  ];
}

function linuxCandidates(
  appName: string,
  request: NotifyRequest,
  resolve: (name: CapabilityName) => string | null,
): Candidate[] {
  const title = clampText(request.title, 80);
  const body = clampText(request.body, 300);
  const urgency = request.urgency ?? "normal";
  const candidates: Candidate[] = [];

  const notifySend = resolve("notify-send");
  if (notifySend !== null) {
    candidates.push({ via: "notify-send", command: notifySend, args: notifySendArgs(appName, request) });
  }

  const gdbus = resolve("gdbus");
  if (gdbus !== null) {
    const hints = `{'urgency': <byte ${urgency === "critical" ? 2 : urgency === "low" ? 0 : 1}>}`;
    candidates.push({
      via: "gdbus",
      command: gdbus,
      args: [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.Notifications",
        "--object-path",
        "/org/freedesktop/Notifications",
        "--method",
        "org.freedesktop.Notifications.Notify",
        appName,
        "0",
        "",
        title,
        body,
        "[]",
        hints,
        "0",
      ],
    });
  }

  const dbusSend = resolve("dbus-send");
  if (dbusSend !== null) {
    candidates.push({
      via: "dbus-send",
      command: dbusSend,
      args: [
        "--session",
        "--type=method_call",
        "--dest=org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications.Notify",
        `string:${appName}`,
        "uint32:0",
        "string:",
        `string:${title}`,
        `string:${body}`,
        "array:string:",
        `dict:string:string:urgency,string:${urgency}`,
        "int32:0",
      ],
    });
  }

  return candidates;
}

function darwinCandidates(
  request: NotifyRequest,
  resolve: (name: CapabilityName) => string | null,
): Candidate[] {
  const osascript = resolve("osascript");
  if (osascript === null) return [];
  const script = `display notification ${quoted(clampText(request.body, 300))} with title ${quoted(
    clampText(request.title, 80),
  )}`;
  return [{ via: "osascript", command: osascript, args: ["-e", script] }];
}

function windowsCandidates(
  appName: string,
  request: NotifyRequest,
  resolve: (name: CapabilityName) => string | null,
): Candidate[] {
  const powershell = resolve("powershell");
  if (powershell === null) return [];
  const title = clampText(request.title, 80).replace(/'/g, "''");
  const body = clampText(request.body, 300).replace(/'/g, "''");
  // The WinRT toast API is available on every supported Windows; the script is
  // deliberately short and self-contained (no module install, no profile write).
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null",
    "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]>$null",
    `$t='<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${body}</text></binding></visual></toast>'`,
    "$x=New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$x.LoadXml($t)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appName}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join("; ");
  return [{ via: "powershell", command: powershell, args: ["-NoProfile", "-NonInteractive", "-Command", script] }];
}

/**
 * Deliver one notification. Adapters are tried in portability order and the
 * first success wins; every failure is swallowed into the result.
 */
export async function notifyDesktop(
  request: NotifyRequest,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  const ctx = options.host ?? host();
  const appName = options.appName ?? DEFAULT_APP_NAME;
  const resolve = options.resolve ?? ((name: CapabilityName) => capability(name, ctx));
  const run = options.run ?? systemRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const candidates =
    ctx.platform === "darwin"
      ? darwinCandidates(request, resolve)
      : ctx.platform === "win32"
        ? windowsCandidates(appName, request, resolve)
        : linuxCandidates(appName, request, resolve);

  const tried: string[] = [];
  let error: string | undefined;
  for (const candidate of candidates) {
    tried.push(candidate.via);
    try {
      await run(candidate.command, candidate.args, timeoutMs);
      return { delivered: true, via: candidate.via, tried };
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  return {
    delivered: false,
    via: null,
    tried,
    ...(error === undefined ? {} : { error: clampText(error, 200) }),
  };
}
