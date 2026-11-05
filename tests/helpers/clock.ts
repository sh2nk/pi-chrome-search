/**
 * Deterministic `Clock` for cache/TTL/pacing tests (P2-B) and abort paths (P2-C).
 *
 * Two modes:
 *  - `autoAdvance: true` (default) — `sleep(ms)` resolves in a microtask and moves
 *    virtual time forward by `ms`. No wall-clock wait, so limiter tests can simply
 *    `await limiter.acquire(...)`.
 *  - `autoAdvance: false` — sleeps stay pending until `advance()`/`advanceTo()`.
 *    This is the mode to use when asserting abort behaviour: an auto-advancing
 *    sleep has no observable pending window.
 *
 * Abort choice: reject with `signal.reason` when set, otherwise with a DOMException
 * named `AbortError` (the same shape `node:timers/promises` produces). The tool
 * layer maps that to `E_CANCELLED`; tests that need the exact taxonomy can pass
 * `new WebSearchError({ code: "E_CANCELLED", ... })` as the abort reason.
 */

import type { Clock } from "../../src/runtime/types.ts";

/** Default virtual epoch: 2026-01-01T00:00:00Z. Deterministic across timezones for date math. */
export const DEFAULT_FAKE_NOW = Date.UTC(2026, 0, 1);

export interface FakeClockOptions {
  /** Initial virtual epoch milliseconds. */
  now?: number;
  /** Resolve sleeps immediately and move time forward. Default `true`. */
  autoAdvance?: boolean;
}

export interface SleepRecord {
  /** Requested duration. */
  ms: number;
  /** Virtual time when `sleep` was called. */
  at: number;
  /** Virtual time when the sleep was due. */
  due: number;
  /** Virtual time when it settled, or `null` while pending / rejected. */
  resolvedAt: number | null;
}

interface Waiter {
  record: SleepRecord;
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function abortReason(signal?: AbortSignal): unknown {
  if (signal !== undefined && signal.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(value: unknown): boolean {
  if (value instanceof DOMException) return value.name === "AbortError";
  return value instanceof Error && value.name === "AbortError";
}

export class FakeClock implements Clock {
  #now: number;
  #autoAdvance: boolean;
  #log: SleepRecord[] = [];
  #waiters = new Set<Waiter>();

  constructor(options: FakeClockOptions = {}) {
    this.#now = options.now ?? DEFAULT_FAKE_NOW;
    this.#autoAdvance = options.autoAdvance ?? true;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.sleep: expected a finite non-negative duration, got ${String(ms)}`);
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    const record: SleepRecord = { ms, at: this.#now, due: this.#now + ms, resolvedAt: null };
    this.#log.push(record);

    if (this.#autoAdvance) {
      this.#now = record.due;
      record.resolvedAt = record.due;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        record,
        resolve: () => {
          record.resolvedAt = this.#now;
          this.#detach(waiter);
          this.#waiters.delete(waiter);
          resolve();
        },
        reject: (reason: unknown) => {
          this.#detach(waiter);
          this.#waiters.delete(waiter);
          reject(reason);
        },
      };
      if (signal !== undefined) {
        waiter.signal = signal;
        waiter.onAbort = () => waiter.reject(abortReason(signal));
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.add(waiter);
    });
  }

  /** Move virtual time forward and resolve every sleep whose due time was reached. */
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.advance: expected a finite non-negative duration, got ${String(ms)}`);
    }
    this.#now += ms;
    this.#wake();
    return this.#now;
  }

  /** Jump to an absolute epoch. Refuses to move backwards (use `setNow` for that). */
  advanceTo(epochMs: number): number {
    if (!Number.isFinite(epochMs)) throw new RangeError("FakeClock.advanceTo: expected a finite epoch");
    if (epochMs > this.#now) {
      this.#now = epochMs;
      this.#wake();
    }
    return this.#now;
  }

  /** Test escape hatch for date-boundary scenarios (e.g. daily caps). */
  setNow(epochMs: number): void {
    if (!Number.isFinite(epochMs)) throw new RangeError("FakeClock.setNow: expected a finite epoch");
    this.#now = epochMs;
  }

  /** Only affects future sleeps; already-pending waiters keep waiting for `advance`. */
  setAutoAdvance(enabled: boolean): void {
    this.#autoAdvance = enabled;
  }

  pendingCount(): number {
    return this.#waiters.size;
  }

  /** Every recorded sleep, in call order. Durations are what tests usually assert. */
  sleepLog(): ReadonlyArray<SleepRecord> {
    return this.#log.map((record) => ({ ...record }));
  }

  durations(): number[] {
    return this.#log.map((record) => record.ms);
  }

  totalSleptMs(): number {
    return this.#log.reduce((sum, record) => sum + record.ms, 0);
  }

  #wake(): void {
    const due = [...this.#waiters].filter((waiter) => waiter.record.due <= this.#now);
    due.sort((a, b) => a.record.due - b.record.due);
    for (const waiter of due) waiter.resolve();
  }

  #detach(waiter: Waiter): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
  }
}
