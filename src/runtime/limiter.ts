/**
 * Per-engine pacing and daily soft caps (SPEC §5.5).
 *
 * The state file keeps the last acquire timestamp and today's count so a pi
 * restart does not reset the pace. Writes are atomic (`<state>.tmp` + rename,
 * mode 0600). The day boundary is the local calendar date of `clock.now()`: a
 * new day clears the count but keeps `lastAt`, because two searches a second
 * apart across midnight would still look like a bot.
 *
 * `acquire` is serialized in-process per engine: concurrent callers queue, so
 * the second one computes its gap after the first one updated `lastAt`. The
 * lock file for cross-process exclusion belongs to the browser lane; this
 * limiter assumes one writer per state file.
 *
 * A `lastAt` in the future is treated as clock skew, not as a gap to wait out;
 * see `repairFutureLastAt`.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { Config } from "../config.ts";
import { ENGINE_IDS, type EngineId } from "../engines/types.ts";
import { ERROR_HINTS, WebSearchError } from "./error-codes.ts";
import type { Clock, Limiter, LimiterStats } from "./types.ts";

const STATE_VERSION = 1 as const;

interface EngineCounters {
  lastAt: number | null;
  today: number;
}

interface LimiterState {
  version: typeof STATE_VERSION;
  day: string;
  engines: Record<EngineId, EngineCounters>;
}

export interface LimiterOptions {
  config: Config;
  clock: Clock;
  /** Defaults to `<agent dir>/web-search/state.json`; tests inject a temp file. */
  statePath?: string;
  /** Injectable uniform [0,1) source; defaults to `Math.random`. */
  rng?: () => number;
}

export interface LimiterWithStats extends Limiter {
  /** Absolute path of the persisted state file. */
  statePath(): string;
}

/**
 * `$PI_CODING_AGENT_DIR/web-search/state.json`, or `~/.pi/agent/web-search/state.json`.
 * Kept separate from `resolveConfigPath` because the state is runtime data, not
 * user-editable config.
 */
export function resolveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PI_CODING_AGENT_DIR?.trim();
  const dir = raw && raw.length > 0 ? expandHome(raw) : join(homedir(), ".pi", "agent");
  return join(dir, "web-search", "state.json");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(homedir(), path);
}

function emptyEngines(): Record<EngineId, EngineCounters> {
  return {
    google: { lastAt: null, today: 0 },
    duckduckgo: { lastAt: null, today: 0 },
    yandex: { lastAt: null, today: 0 },
  };
}

function freshState(now: number): LimiterState {
  return { version: STATE_VERSION, day: localDay(now), engines: emptyEngines() };
}

/** Local calendar date, not UTC: the daily cap resets when the user's day does. */
function localDay(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDayString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Validate a parsed state file. Unknown versions or a malformed shape are
 * corruption, not errors: the caller starts fresh instead of crashing pi.
 */
function parseState(raw: unknown): LimiterState | null {
  if (!isRecord(raw) || raw.version !== STATE_VERSION || !isDayString(raw.day)) return null;
  if (!isRecord(raw.engines)) return null;

  const engines = emptyEngines();
  for (const engine of ENGINE_IDS) {
    const candidate = raw.engines[engine];
    if (!isRecord(candidate)) continue;
    const lastAt = candidate.lastAt;
    const today = candidate.today;
    engines[engine] = {
      lastAt: typeof lastAt === "number" && Number.isFinite(lastAt) ? lastAt : null,
      today: typeof today === "number" && Number.isInteger(today) && today >= 0 ? today : 0,
    };
  }
  return { version: STATE_VERSION, day: raw.day, engines };
}

function loadState(path: string, now: number): LimiterState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Missing or unreadable: start clean. If the directory really is not
    // writable, the next persist names the path in an E_CONFIG error.
    return freshState(now);
  }
  try {
    return parseState(JSON.parse(text)) ?? freshState(now);
  } catch {
    return freshState(now);
  }
}

function saveState(path: string, state: LimiterState): void {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // writeFileSync applies `mode` only when it creates the file; a leftover
    // temp file from a crashed run could otherwise keep broader permissions.
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort: the original error is the one worth reporting.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WebSearchError({
      code: "E_CONFIG",
      stage: "config",
      retryable: false,
      hint: `check that ${dirname(path)} exists and is writable; limiter state is ${path}`,
      message: `cannot persist limiter state: ${message}`,
    });
  }
}

function cancelled(engine: EngineId): WebSearchError {
  return new WebSearchError({
    code: "E_CANCELLED",
    engine,
    stage: "navigate",
    retryable: true,
    hint: ERROR_HINTS.E_CANCELLED,
  });
}

function rateLimited(engine: EngineId, today: number, cap: number): WebSearchError {
  const message = `daily cap ${cap} for ${engine} reached (${today} searches today)`;
  return new WebSearchError({
    code: "E_RATE_LIMITED",
    engine,
    stage: "navigate",
    retryable: true,
    hint: `${message}; wait for the local day reset or use another engine`,
    message,
  });
}

export function createLimiter(options: LimiterOptions): LimiterWithStats {
  const { config, clock } = options;
  const statePath = options.statePath ?? resolveStatePath();
  const rng = options.rng ?? Math.random;

  let state = loadState(statePath, clock.now());
  // One tail promise per engine: `acquire` chains onto it, so two concurrent
  // callers cannot both read the same `lastAt` and compute the same gap.
  const tails = new Map<EngineId, Promise<void>>();

  function rollover(): void {
    const day = localDay(clock.now());
    if (state.day === day) return;
    const engines = emptyEngines();
    for (const engine of ENGINE_IDS) {
      engines[engine] = { lastAt: state.engines[engine].lastAt, today: 0 };
    }
    state = { version: STATE_VERSION, day, engines };
  }

  /** Uniform draw from the configured [min,max] window, rounded to whole ms. */
  function targetGap(engine: EngineId): number {
    const [min, max] = config.pacing[engine];
    const sample = rng();
    // Clamp defensively: a bad rng must not produce a negative or huge wait.
    const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
    return Math.max(0, Math.round(min + unit * (max - min)));
  }

  /**
   * A `lastAt` in the future is clock skew, not a real gap: an RTC change, a VM
   * resumed from a snapshot, or a dual-boot session share this state file, so
   * `now` can jump backwards by hours. Sleeping `gap - (now - lastAt)` would
   * then sleep for the whole skew — a 1 h step-back asks for 3,602,500 ms and a
   * state file written 24 h ahead asks for 86,402,500 ms. The policy is: treat
   * the stale timestamp as unknown, reset it to `now`, wait 0 and persist the
   * corrected value. A forward jump needs no special case: the elapsed time is
   * simply large, so no sleep is taken. Returns true when a reset happened.
   */
  function repairFutureLastAt(counters: EngineCounters): boolean {
    const now = clock.now();
    if (counters.lastAt === null || counters.lastAt <= now) return false;
    const stale = counters.lastAt;
    counters.lastAt = now;
    try {
      // Persist on its own so the correction survives a later abort or cap
      // rejection. Rare event, so the extra atomic write is acceptable.
      saveState(statePath, state);
    } catch (error) {
      counters.lastAt = stale;
      throw error;
    }
    return true;
  }

  async function run(engine: EngineId, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelled(engine);

    rollover();
    const counters = state.engines[engine];

    // Repair before the cap check: a capped engine should still correct a
    // skewed file, and the repair itself never sleeps.
    const skewRepaired = repairFutureLastAt(counters);

    const cap = config.engines[engine].dailyCap;
    // `dailyCap: 0` disables the cap (config validates it as >= 0). Check the
    // cap before sleeping: a capped engine should fail fast, not wait first.
    if (cap > 0 && counters.today >= cap) throw rateLimited(engine, counters.today, cap);

    const gap = targetGap(engine);
    if (!skewRepaired && counters.lastAt !== null) {
      const waitMs = gap - (clock.now() - counters.lastAt);
      if (waitMs > 0) {
        try {
          await clock.sleep(waitMs, signal);
        } catch (error) {
          if (signal?.aborted) throw cancelled(engine);
          if (error instanceof WebSearchError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new WebSearchError({
            code: "E_TIMEOUT",
            engine,
            stage: "navigate",
            retryable: true,
            hint: ERROR_HINTS.E_TIMEOUT,
            message: `pacing sleep failed: ${message}`,
          });
        }
      }
    }

    // An abort during the sleep must not consume a daily slot.
    if (signal?.aborted) throw cancelled(engine);

    const previous: EngineCounters = { lastAt: counters.lastAt, today: counters.today };
    counters.today += 1;
    counters.lastAt = clock.now();
    try {
      saveState(statePath, state);
    } catch (error) {
      counters.lastAt = previous.lastAt;
      counters.today = previous.today;
      throw error;
    }
  }

  return {
    acquire(engine: EngineId, signal?: AbortSignal): Promise<void> {
      // An already-aborted caller must fail immediately, not after the sleep of
      // whoever is ahead of it in the per-engine queue: reject before chaining
      // so it never enters the queue and never waits.
      if (signal?.aborted) return Promise.reject(cancelled(engine));
      const previous = tails.get(engine) ?? Promise.resolve();
      const current = previous.then(() => run(engine, signal));
      // Store a non-rejecting tail: one failed acquire must not poison the
      // queue for the callers behind it.
      tails.set(engine, current.then(
        () => undefined,
        () => undefined,
      ));
      return current;
    },

    stats(engine: EngineId): LimiterStats {
      // Project today's view even when no acquire ran since midnight, so the
      // doctor does not report yesterday's exhausted cap. The file catches up
      // on the next acquire.
      rollover();
      const counters = state.engines[engine];
      // A future `lastAt` must not reach `/web-doctor` as a timestamp hours
      // ahead: repair it here under the same policy as `run` (reset to `now`,
      // persist, no sleep) instead of leaving the fix to the next acquire.
      repairFutureLastAt(counters);
      return {
        engine,
        lastAt: counters.lastAt,
        today: counters.today,
        dailyCap: config.engines[engine].dailyCap,
      };
    },

    statePath(): string {
      return statePath;
    },
  };
}
