/**
 * Per-engine pacing (S10.1, ADR-0001 D8).
 *
 * Politeness is a minimum gap with jitter between searches on one engine plus
 * one in-flight search per engine. There is no daily cap, no counter that can
 * fail a call, and no persisted state file: the engines are free, a quota was
 * an unmeasured guess, and a stale state file is a bug waiting to happen.
 *
 * `acquire` is serialized in-process per engine: concurrent callers queue, so
 * the second one computes its gap after the first one updated `lastAt`. The
 * page lock in `src/cdp/page-lock.ts` supplies the same guarantee for the tab.
 */

import type { Config } from "../config/index.ts";
import { ENGINE_IDS, type EngineId } from "../engines/types.ts";
import { ERROR_HINTS, WebSearchError } from "./error-codes.ts";
import type { Clock, Limiter, LimiterStats } from "./types.ts";

export interface LimiterOptions {
  config: Config;
  clock: Clock;
  /** Injectable uniform [0,1) source; defaults to `Math.random`. */
  rng?: () => number;
}

interface EngineCounters {
  lastAt: number | null;
  today: number;
}

function emptyCounters(): Record<EngineId, EngineCounters> {
  return {
    google: { lastAt: null, today: 0 },
    duckduckgo: { lastAt: null, today: 0 },
    yandex: { lastAt: null, today: 0 },
  };
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

export function createLimiter(options: LimiterOptions): Limiter {
  const { config, clock } = options;
  const rng = options.rng ?? Math.random;
  const counters = emptyCounters();
  // One tail promise per engine: `acquire` chains onto it, so two concurrent
  // callers cannot both read the same `lastAt` and compute the same gap.
  const tails = new Map<EngineId, Promise<void>>();

  /** Uniform draw from the configured [min,max] window, rounded to whole ms. */
  function targetGap(engine: EngineId): number {
    const [min, max] = config.pacing[engine];
    const sample = rng();
    // Clamp defensively: a bad rng must not produce a negative or huge wait.
    const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
    return Math.max(0, Math.round(min + unit * (max - min)));
  }

  /**
   * A `lastAt` in the future is clock skew, not a real gap: an RTC change or a
   * VM resumed from a snapshot can move `now` backwards by hours. Sleeping the
   * whole skew would turn a clock adjustment into a hang, so the stale stamp is
   * reset to `now` and the wait is zero. A forward jump needs no special case.
   */
  function repairFutureLastAt(entry: EngineCounters): boolean {
    const now = clock.now();
    if (entry.lastAt === null || entry.lastAt <= now) return false;
    entry.lastAt = now;
    return true;
  }

  async function run(engine: EngineId, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelled(engine);
    const entry = counters[engine];
    const skewRepaired = repairFutureLastAt(entry);

    const gap = targetGap(engine);
    if (!skewRepaired && entry.lastAt !== null) {
      const waitMs = gap - (clock.now() - entry.lastAt);
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

    if (signal?.aborted) throw cancelled(engine);
    entry.today += 1;
    entry.lastAt = clock.now();
  }

  return {
    acquire(engine: EngineId, signal?: AbortSignal): Promise<void> {
      // An already-aborted caller must fail immediately, not after the sleep of
      // whoever is ahead of it in the per-engine queue.
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
      const entry = counters[engine];
      repairFutureLastAt(entry);
      return { engine, lastAt: entry.lastAt, today: entry.today };
    },
  };
}

/** Exported so tests and the doctor can name the canonical engine order. */
export { ENGINE_IDS };
