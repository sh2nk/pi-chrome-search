/**
 * P10-A: the anchor control panel.
 *
 * The bootstrap tab used to be `about:blank`: a blank page in the user's face
 * that told them nothing. It is now a local `assets/anchor.html` document (no
 * network, no cookies, our own CSS) painted with the current engine, query,
 * stage, pace, session counters, last error and session id. Everything the panel
 * shows is work this process is already doing — nothing is read from the
 * profile and nothing is sent anywhere.
 *
 * Three deliberate choices:
 *
 *  - **The page is a shipped asset, not a generated file.** Nothing is written
 *    to the agent directory at runtime: the anchor is a static shell, and state
 *    arrives through `Runtime.evaluate` (P10-A), which is the only way to update
 *    a `file://` document without touching it on disk.
 *  - **The URL is built with `pathToFileURL()`.** A hand-built `file://` +
 *    `path.join` works on POSIX and breaks on Windows (`C:\…` needs a drive
 *    letter in the URL path); this is the same portability doctrine as PO2.
 *  - **Writes are throttled on the leading edge.** The first stage after an
 *    idle period paints immediately (the query must be visible as soon as a
 *    search starts) and anything faster than {@link PANEL_MIN_INTERVAL_MS} is
 *    coalesced into one trailing write, so the panel never exceeds two updates
 *    per second. `window.panel: false` disables all of it and restores the old
 *    `about:blank` anchor.
 */

import { fileURLToPath, pathToFileURL } from "node:url";

import type { PageKey } from "../cdp/types.ts";
import type { PacingWindow } from "../config/index.ts";
import type { EngineId } from "../engines/types.ts";
import type { Clock } from "./types.ts";

/** Highest number of panel paints per second (PLAN-v2 P10-A). */
export const PANEL_MIN_INTERVAL_MS = 500;
export const PANEL_VERSION = 1 as const;
const QUERY_MAX_CHARS = 240;
const HINT_MAX_CHARS = 240;
const SESSION_MAX_CHARS = 64;
const COUNTER_MAX = 1_000_000;

/**
 * What the panel is doing right now. `read` is the read pipeline; `done` is the
 * settle point after which `window.follow` may hand the screen back to the
 * anchor. `pace` is the limiter wait, which can be several seconds.
 */
export type PanelStage =
  | "connect"
  | "pace"
  | "navigate"
  | "settle"
  | "extract"
  | "read"
  | "done"
  | "error";

export interface PanelCounter {
  engine: EngineId;
  today: number;
}

export interface PanelError {
  code: string;
  hint?: string;
}

export interface PanelState {
  version: typeof PANEL_VERSION;
  sessionId: string;
  engine: EngineId | null;
  query: string | null;
  stage: PanelStage;
  pace: PacingWindow | null;
  counters: PanelCounter[];
  error: PanelError | null;
  /** ISO timestamp of the state change, not of the paint. */
  updatedAt: string;
}

/**
 * One stage change announced by a tool. Every field is optional except `stage`:
 * an announcement is a patch, so the query survives the `settle`/`extract`
 * transitions and the counters survive a stage change.
 */
export interface WorkAnnouncement {
  engine?: EngineId | null;
  query?: string | null;
  stage: PanelStage;
  /**
   * The owned tab this stage belongs to when it is not an engine tab: a read
   * slot (`read`, `read#2`, …). `window.follow: "work"` raises that tab; the
   * panel itself never shows a page key.
   */
  page?: PageKey | null;
  pace?: PacingWindow | null;
  counters?: readonly PanelCounter[];
  error?: PanelError | null;
}

/** What a stage announcement needs from a connector (the optional panel channel). */
export interface WorkChannel {
  announce?(update: WorkAnnouncement): Promise<void>;
}

/**
 * Publish one stage on the panel/follow channel. Best effort by contract: a
 * connector without an anchor, a closed tab or a failed paint is observability,
 * never a tool failure (S12.5). Every tool goes through this one helper so the
 * guarantee cannot drift per call site.
 */
export async function announceWork(channel: WorkChannel | undefined, update: WorkAnnouncement): Promise<void> {
  const announce = channel?.announce;
  if (announce === undefined) return;
  try {
    await announce.call(channel, update);
  } catch {
    // A dead anchor tab must never turn into a failed search or read.
  }
}

/** Context the panel needs but an announcement must not have to repeat. */
export interface PanelContext {
  sessionId: string;
  now: number;
}

const STAGES: ReadonlySet<string> = new Set<PanelStage>([
  "connect",
  "pace",
  "navigate",
  "settle",
  "extract",
  "read",
  "done",
  "error",
]);

const ENGINES: ReadonlySet<string> = new Set<EngineId>(["google", "duckduckgo", "yandex"]);

/** Control characters would corrupt the rendered single line; strip, never escape. */
function clean(value: string, max: number): string {
  // Control characters would corrupt the rendered single span; strip, never escape.
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return stripped.slice(0, max);
}

function cleanNumber(value: unknown, max = COUNTER_MAX): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function cleanPace(value: PacingWindow | null | undefined): PacingWindow | null {
  if (value === null || value === undefined) return null;
  const [min, max] = value;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const lo = Math.max(0, Math.round(min));
  const hi = Math.max(lo, Math.round(max));
  return [lo, hi];
}

function cleanCounters(value: readonly PanelCounter[] | undefined): PanelCounter[] | undefined {
  if (value === undefined) return undefined;
  const seen = new Set<EngineId>();
  const counters: PanelCounter[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!ENGINES.has(entry.engine) || seen.has(entry.engine)) continue;
    seen.add(entry.engine);
    counters.push({
      engine: entry.engine,
      today: cleanNumber(entry.today),
    });
  }
  return counters;
}

/** The initial state of a fresh anchor: session id only, nothing invented. */
export function initialPanelState(context: PanelContext): PanelState {
  return {
    version: PANEL_VERSION,
    sessionId: clean(context.sessionId, SESSION_MAX_CHARS),
    engine: null,
    query: null,
    stage: "connect",
    pace: null,
    counters: [],
    error: null,
    updatedAt: new Date(context.now).toISOString(),
  };
}

/**
 * Merge one announcement into the previous state. Pure: a bad announcement can
 * blank a field but cannot crash the panel or leak an arbitrary object into the
 * evaluated expression.
 */
export function applyAnnouncement(
  previous: PanelState,
  update: WorkAnnouncement,
  context: PanelContext,
): PanelState {
  const stage: PanelStage = STAGES.has(update.stage) ? update.stage : "connect";

  let engine = previous.engine;
  if (update.engine !== undefined) {
    engine = update.engine !== null && ENGINES.has(update.engine) ? update.engine : null;
  }

  let query = previous.query;
  if (update.query !== undefined) {
    query = update.query === null ? null : clean(update.query, QUERY_MAX_CHARS);
  }

  const pace = update.pace === undefined ? previous.pace : cleanPace(update.pace);
  const counters = cleanCounters(update.counters) ?? previous.counters;

  let error = previous.error;
  if (update.error !== undefined) {
    error =
      update.error === null
        ? null
        : {
            code: clean(update.error.code, 64),
            ...(update.error.hint === undefined ? {} : { hint: clean(update.error.hint, HINT_MAX_CHARS) }),
          };
  }

  return {
    version: PANEL_VERSION,
    sessionId: clean(context.sessionId, SESSION_MAX_CHARS),
    engine,
    query,
    stage,
    pace,
    counters: counters.map((counter) => ({ ...counter })),
    error,
    updatedAt: new Date(context.now).toISOString(),
  };
}

/**
 * The one expression the connector evaluates on the anchor. JSON is a valid JS
 * literal; `<` and the two JS line separators are escaped so a hostile query
 * cannot terminate the expression or the surrounding script.
 */
export function renderPanelExpression(state: PanelState): string {
  const payload = JSON.stringify(state)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return (
    "(() => { const s = " +
    payload +
    "; const p = window.__wcsPanel; " +
    "if (!p || typeof p.render !== 'function') return false; " +
    "try { p.render(s); return true; } catch { return false; } })()"
  );
}

/** Absolute path of the shipped anchor asset (no agent-directory copy). */
export function panelAssetPath(): string {
  return fileURLToPath(new URL("../../assets/anchor.html", import.meta.url));
}

/** `file://` URL for `assets/anchor.html`, built portably (PO2). */
export function panelFileUrl(): string {
  return pathToFileURL(panelAssetPath()).href;
}

/** What a channel needs from the browser: paint one state, report readiness. */
export interface PanelSink {
  /** Resolves true when the page painted it; false when the document is not ready. */
  write(state: PanelState): Promise<boolean>;
}

export interface PanelChannelOptions {
  sink: PanelSink;
  clock: Clock;
  /** Default {@link PANEL_MIN_INTERVAL_MS}. */
  minIntervalMs?: number;
}

/**
 * Leading-edge throttle with one coalesced trailing write. A stage sequence like
 * navigate→settle→extract (often < 100 ms) paints the first stage immediately
 * and the last one 500 ms later, so the panel is current by the time the user
 * looks at it, without a write per stage.
 */
export class PanelChannel {
  readonly #sink: PanelSink;
  readonly #clock: Clock;
  readonly #minIntervalMs: number;
  #lastPaintAt = Number.NEGATIVE_INFINITY;
  #pending: PanelState | undefined;
  #trailing = false;
  #closed = false;

  constructor(options: PanelChannelOptions) {
    this.#sink = options.sink;
    this.#clock = options.clock;
    this.#minIntervalMs = Math.max(0, Math.round(options.minIntervalMs ?? PANEL_MIN_INTERVAL_MS));
  }

  /**
   * Publish a state; awaits only a write that is due now.
   *
   * There is deliberately no "initial paint": the static asset already renders
   * its own empty shell, and spending the throttle window on a cosmetic write
   * would delay the first real stage — the query — by up to 500 ms. The first
   * announcement is always the leading edge and therefore immediate (V10.1).
   */
  async publish(state: PanelState): Promise<void> {
    if (this.#closed) return;
    this.#pending = state;
    if (this.#due()) {
      await this.#flush();
      return;
    }
    this.#scheduleTrailing();
  }

  /** Force the pending state out (teardown, doctor snapshot). */
  async flush(): Promise<void> {
    if (this.#closed) return;
    await this.#flush();
  }

  close(): void {
    this.#closed = true;
    this.#pending = undefined;
  }

  #due(): boolean {
    return this.#clock.now() - this.#lastPaintAt >= this.#minIntervalMs;
  }

  async #flush(): Promise<void> {
    const state = this.#pending;
    if (state === undefined || this.#closed) return;
    this.#pending = undefined;
    this.#lastPaintAt = this.#clock.now();
    try {
      await this.#sink.write(state);
    } catch {
      // A paint is observability: a dead anchor tab must never fail a search.
    }
  }

  #scheduleTrailing(): void {
    if (this.#trailing) return;
    this.#trailing = true;
    const delay = Math.max(0, this.#minIntervalMs - (this.#clock.now() - this.#lastPaintAt));
    void this.#clock
      .sleep(delay)
      .then(async () => {
        this.#trailing = false;
        await this.#flush();
      })
      .catch(() => {
        this.#trailing = false;
      });
  }
}
