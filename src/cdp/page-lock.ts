/**
 * Exclusive, FIFO page locks (P9-A).
 *
 * The connector hands out work tabs idempotently (`acquirePage("read")` always
 * returns the same tab), which is exactly what a *serialized* tool needs and
 * exactly what a parallel one must not rely on: four concurrent `web_read`
 * calls used to navigate the same tab and all extract the last body. The tab
 * cannot defend itself, so the caller takes a lock before touching it.
 *
 * Three properties matter here:
 *
 *  - **FIFO per key.** Callers are served in arrival order, so a pathological
 *    request cannot starve the queue (`prev` is captured at enqueue time).
 *  - **No lock leak.** The task runs in `try/finally`; a throwing task releases
 *    the next waiter, and an aborted caller never holds a key forever.
 *  - **Per connector, not global.** The lock is keyed by connector identity so
 *    two pi sessions (two connectors) do not serialise each other; the browser
 *    lock file already arbitrates the truly global case. This only works while
 *    the connector is the one instance the tools share (the runtime builds it
 *    once) — a connector rebuilt per call would hand out a fresh lock per call.
 *
 * The pool (`config.read.pool`) is a set of independent keys (`read`, `read#2`,
 * …): `pick()` returns the least-loaded one *synchronously*, so two callers who
 * arrive together do not both choose slot 1 and queue behind each other while
 * slot 2 is free.
 *
 * Search tabs use the engine id as their key: `web_search`, `image_search` and
 * `/web-doctor` all touch `google`/`duckduckgo`/`yandex` through the same lock,
 * so one tab has exactly one writer even when pi runs several tool calls of a
 * turn at once (two typists in one search box interleave their characters).
 */

export interface KeyedLock {
  /** Run `task` exclusively under `key`, resolving with its result. */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Queued + running tasks for `key` (all keys when omitted). */
  pending(key?: string): number;
  /** Least-loaded key among `keys`; ties keep the caller's order. */
  pick(keys: readonly string[]): string;
}

export function createKeyedLock(): KeyedLock {
  /** key → promise that resolves when the current tail leaves the critical section. */
  const tails = new Map<string, Promise<void>>();
  const counts = new Map<string, number>();

  function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    counts.set(key, (counts.get(key) ?? 0) + 1);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The stored tail never rejects: a failed task must not poison the queue.
    const tail = previous.then(() => gate);
    tails.set(key, tail);

    return (async () => {
      try {
        await previous;
        return await task();
      } finally {
        release();
        const left = (counts.get(key) ?? 1) - 1;
        if (left <= 0) {
          counts.delete(key);
          // Only drop the tail when it is ours; a later enqueue may have
          // replaced it already (same key, newer generation).
          if (tails.get(key) === tail) tails.delete(key);
        } else {
          counts.set(key, left);
        }
      }
    })();
  }

  function pending(key?: string): number {
    if (key !== undefined) return counts.get(key) ?? 0;
    let total = 0;
    for (const value of counts.values()) total += value;
    return total;
  }

  function pick(keys: readonly string[]): string {
    let best = keys[0];
    if (best === undefined) throw new Error("page-lock: pick() needs at least one key");
    let bestCount = counts.get(best) ?? 0;
    for (const key of keys.slice(1)) {
      const count = counts.get(key) ?? 0;
      if (count < bestCount) {
        best = key;
        bestCount = count;
      }
    }
    return best;
  }

  return { run, pending, pick };
}

/**
 * One lock per connector. A `WeakMap` keeps solved sessions out of memory and
 * makes the lock reachable from every tool instance built over the same
 * connector (the `web_research` tool builds its own `web_read` inside).
 */
const locks = new WeakMap<object, KeyedLock>();

export function pageLockFor(connector: object): KeyedLock {
  const existing = locks.get(connector);
  if (existing !== undefined) return existing;
  const created = createKeyedLock();
  locks.set(connector, created);
  return created;
}

/** Slot keys for a pool size; `1` keeps the historical single `read` key. */
export function readSlotKeys(pool: number): string[] {
  const size = Number.isFinite(pool) ? Math.min(3, Math.max(1, Math.floor(pool))) : 1;
  if (size === 1) return ["read"];
  const keys: string[] = ["read"];
  for (let slot = 2; slot <= size; slot += 1) keys.push(`read#${slot}`);
  return keys;
}
