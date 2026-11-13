/**
 * Attention coordination for the CDP Allow prompt (P11).
 *
 * The connector emits `onAwaitingAllow` while a handshake is waiting; this
 * module turns that event into the three non-blocking layers:
 *
 *   L0  a progress line (`waiting for the Allow prompt… 42s`) and an OSC
 *       notification escape, emitted by the terminal surface only when stdout is
 *       a TTY (never into JSON or a log file);
 *   L1  exactly one desktop notification (`notify.ts`, non-fatal);
 *   L2  at most one best-effort window raise (`raise.ts`, `window.raiseOnPrompt`);
 *
 * L3 is the wait itself, owned by the connector (`cdp.attachWaitMs`). Nothing
 * here changes the connect outcome: a failed notification or an unavailable
 * raise is reported and ignored.
 */

import type { AwaitingAllowInfo } from "../cdp/browser.ts";
import { raiseBrowserWindow, type RaiseOptions, type RaiseResult } from "../cdp/raise.ts";
import type { Config } from "../config/index.ts";
import { notifyDesktop, type NotifyOptions, type NotifyResult } from "./notify.ts";

export interface AttentionOutcome {
  /** True when the connector reported a pending Allow at least once. */
  awaited: boolean;
  /** Total time the connector spent waiting (the last report wins). */
  waitedMs: number;
  notified: NotifyResult | null;
  raise: RaiseResult | null;
}

export interface AllowAttention {
  /** Connector hook; fire-and-forget, never throws into the connect loop. */
  onAwaitingAllow(info: AwaitingAllowInfo): void;
  /** Current outcome (notification/raise may still be in flight). */
  outcome(): AttentionOutcome;
  /** Wait for the notification and raise to settle (used by the doctor). */
  flush(): Promise<AttentionOutcome>;
}

export interface AllowAttentionOptions {
  config: Config;
  notify?: (request: Parameters<typeof notifyDesktop>[0]) => Promise<NotifyResult>;
  raise?: () => Promise<RaiseResult>;
  /** Injected `notifyDesktop` options (host, resolver, runner) for tests. */
  notifyOptions?: NotifyOptions;
  /** Injected `raiseBrowserWindow` options (host, brand, policy, runner) for tests. */
  raiseOptions?: RaiseOptions;
  /** Called with a one-line progress message; throttling is the caller's job. */
  onProgress?: (line: string) => void;
}

/** How often the wait may print; the connector calls this every attempt. */
const PROGRESS_EVERY_MS = 2_000;

/**
 * One attention event per session. Both L1 and L2 run at most once: a desktop
 * that fires a notification every two seconds is worse than a missed one.
 */
export function createAllowAttention(options: AllowAttentionOptions): AllowAttention {
  const config = options.config;
  let info: AwaitingAllowInfo | undefined;
  let notified: NotifyResult | null = null;
  let raised: RaiseResult | null = null;
  let started = false;
  let lastProgressAt = -PROGRESS_EVERY_MS;
  let inFlight: Promise<void> | undefined;
  const progress = options.onProgress;

  function describe(entry: AwaitingAllowInfo): string {
    const seconds = Math.max(0, Math.round(entry.elapsedMs / 1000));
    return `waiting for the Allow prompt… ${seconds}s — ${entry.hint}`;
  }

  function start(entry: AwaitingAllowInfo): void {
    const notify = options.notify ?? ((request) => notifyDesktop(request, options.notifyOptions));
    const raise =
      options.raise ??
      (() =>
        raiseBrowserWindow({
          policy: config.window.raiseOnPrompt,
          brand: entry.brand,
          ...(options.raiseOptions ?? {}),
        }));

    // Both layers are independent and non-fatal: run them together, remember
    // the first outcome, ignore the rest.
    inFlight = Promise.allSettled([
      notify({
        title: "Chrome is waiting for Allow",
        body:
          `${entry.hint} — open it and click Allow; the search resumes by itself. ` +
          `Waiting up to ${Math.round(entry.budgetMs / 1000)}s.`,
        urgency: "critical",
      }),
      raise(),
    ]).then(([notifyResult, raiseResult]) => {
      if (notifyResult.status === "fulfilled" && notified === null) notified = notifyResult.value;
      if (raiseResult.status === "fulfilled" && raised === null) raised = raiseResult.value;
    });
  }

  return {
    onAwaitingAllow(entry: AwaitingAllowInfo): void {
      info = entry;
      // The final event only carries the total wait; the prompt was not answered,
      // so a progress line would be a lie and another notification is noise.
      if (entry.final === true) return;
      if (!started) {
        started = true;
        start(entry);
      }
      const now = entry.elapsedMs;
      if (progress !== undefined && now - lastProgressAt >= PROGRESS_EVERY_MS) {
        lastProgressAt = now;
        progress(describe(entry));
      }
    },

    outcome(): AttentionOutcome {
      return {
        awaited: info !== undefined,
        waitedMs: info?.elapsedMs ?? 0,
        notified,
        raise: raised,
      };
    },

    async flush(): Promise<AttentionOutcome> {
      await inFlight;
      return this.outcome();
    },
  };
}

/**
 * OSC notification escapes (L0): OSC 9 (iTerm2/WezTerm/ConEmu) and OSC 777
 * (kitty/Ghostty/Konsole/foot) wrapped around the same one-line text. Terminals
 * that do not implement them silently ignore the sequence.
 *
 * Callers must gate this on `process.stdout.isTTY` (audit gate V11.5): an escape
 * written into a pipe, a log file, JSON output or CI is garbage.
 */
export function oscNotification(text: string): string {
  const safe = text.replace(/[\u0007\u001b]/g, " ");
  return `\u001b]9;${safe}\u0007\u001b]777;notify;pi-chrome-search;${safe}\u0007`;
}

/** JSON/CI-safe progress text (no escapes), for stderr and the doctor report. */
export function renderAwaitingAllow(entry: AwaitingAllowInfo): string {
  const seconds = Math.max(0, Math.round(entry.elapsedMs / 1000));
  return `waiting for the Allow prompt… ${seconds}s — ${entry.hint}`;
}
