/**
 * The one real clock implementation. Tests inject FakeClock (tests/helpers);
 * production code imports this instead of touching `setTimeout` directly, so
 * pacing/typing/settle can be driven virtually in tests.
 */

import type { Clock } from "./types.ts";

/** Rejection value for an aborted sleep; `toFailure` maps it to E_CANCELLED. */
export function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
      if (signal?.aborted) return Promise.reject(abortError());
      if (ms <= 0) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;

        const onAbort = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
      });
    },
  };
}

export const systemClock: Clock = createSystemClock();
