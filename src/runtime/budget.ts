/**
 * One deadline per tool call (SPEC S8.1).
 *
 * A call gets a single budget. Every stage derives its own deadline from what is
 * left, so a slow navigation cannot buy extra time for the AI wait and a queued
 * page lock cannot outlive the call. Exhaustion is `E_TIMEOUT` at stage
 * `budget`: that is a different fact from a stage timing out on its own, and the
 * error code says which one happened.
 *
 * The timer is a hard stop for anything that honours its signal (navigation,
 * pacing, `/goto`, the AI wait). The `remainingMs()` check also uses the
 * injected `Clock`, which is what makes the budget testable without real waits
 * and what catches a clock jump that the timer would miss.
 *
 * This module owns no policy: the caller decides which stages to check and how
 * to spend what is left.
 */

import type { EngineId } from "../engines/types.ts";
import type { Stage } from "./error-codes.ts";
import { fail } from "./errors.ts";
import type { Clock } from "./types.ts";

export interface CallBudget {
  /** Caller signal combined with the budget timer. Pass it to every stage. */
  readonly signal: AbortSignal;
  readonly budgetMs: number;
  /** Clock time spent since the budget was created. */
  elapsedMs(): number;
  /** Clock time left, never negative. */
  remainingMs(): number;
  /** True once the timer fired or the clock says the budget is spent. */
  expired(): boolean;
  /**
   * Throw `E_TIMEOUT` at stage `budget` when nothing is left. Call it before a
   * stage starts, so a stage never begins with a deadline in the past.
   */
  check(stage: Stage, engine?: EngineId): void;
  /** Free the timer. Always call it; a call may end long before the deadline. */
  dispose(): void;
}

export interface CallBudgetOptions {
  clock: Clock;
  budgetMs: number;
  /** The caller's own abort (Ctrl-C / pi cancellation); it wins over the timer. */
  parent?: AbortSignal;
  /** Prefix for the failure message, e.g. `web_search`. */
  label?: string;
}

function budgetExhausted(budgetMs: number, label: string, engine?: EngineId): ReturnType<typeof fail> {
  return fail("E_TIMEOUT", "budget", {
    ...(engine === undefined ? {} : { engine }),
    message: `${label} exhausted its ${budgetMs} ms budget`,
    hint: "retry, or ask for less (a smaller `n`, fewer engines, or `summary:false`)",
  });
}

export function createCallBudget(options: CallBudgetOptions): CallBudget {
  const { clock } = options;
  const budgetMs = options.budgetMs;
  const label = options.label ?? "the call";
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw fail("E_CONFIG", "config", {
      message: `${label} budget must be a positive number of milliseconds, got ${String(budgetMs)}`,
      hint: "set search.budgetMs to a positive number of milliseconds",
    });
  }

  const startedAt = clock.now();
  const controller = new AbortController();
  let fired = false;

  const fire = (): void => {
    if (fired) return;
    fired = true;
    controller.abort(budgetExhausted(budgetMs, label));
  };
  // `unref` so a completed call never keeps the process alive for its whole
  // budget; `dispose()` clears it in the normal path anyway.
  const timer = setTimeout(fire, budgetMs);
  timer.unref?.();

  const signal =
    options.parent === undefined ? controller.signal : AbortSignal.any([options.parent, controller.signal]);

  const elapsedMs = (): number => Math.max(0, clock.now() - startedAt);
  const remainingMs = (): number => Math.max(0, budgetMs - elapsedMs());
  const expired = (): boolean => fired || remainingMs() <= 0;

  return {
    signal,
    budgetMs,
    elapsedMs,
    remainingMs,
    expired,
    check(stage, engine) {
      if (signal.aborted && options.parent?.aborted === true && !fired) {
        // The caller cancelled; that is E_CANCELLED, not a budget verdict.
        return;
      }
      if (fired || remainingMs() <= 0) {
        // Throw instead of firing the controller here: aborting the signal
        // would race the caller's own error path and lose the artifact the
        // in-flight stage is about to attach.
        throw budgetExhausted(budgetMs, `${label} (${stage})`, engine);
      }
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/**
 * Resolve/reject like `promise`, but reject as soon as `signal` aborts.
 *
 * Used for a stage that cannot be cancelled itself (a queued page lock). The
 * losing promise is left to finish; its rejection is swallowed so a late
 * `E_TIMEOUT` cannot surface as an unhandled rejection, and the stage it guards
 * checks the budget again before doing any work.
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  void promise.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
