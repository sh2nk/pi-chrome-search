/**
 * In-memory LRU cache for SERP payloads and `/goto` resolutions (SPEC §8).
 *
 * Nothing is persisted: a cache key may contain the user's query text or a SERP
 * wrapper URL, so it must never reach disk or a log. Keys contain only what the
 * caller supplies — never cookies, headers or tokens — and values are plain
 * data (functions and Map/Set containers are rejected, see
 * `PLAIN_DATA_MAX_DEPTH`).
 *
 * TTL is injected through `Clock`, which makes the 10 min / 24 h boundaries
 * testable without real sleeps. An entry that expires exactly now is expired:
 * a 24 h `/goto` resolution is gone at 24 h, not after.
 */

import type { EngineId } from "../engines/types.ts";
import { WebSearchError } from "./error-codes.ts";
import type { Cache, Clock } from "./types.ts";

/**
 * Depth bound for the plain-data check in `set`. Containers are inspected from
 * the root (depth 0) down to depth 4; a function nested deeper than that is not
 * detected. The bound keeps a `set` of a large payload cheap, and a cycle is
 * stopped by the `Map` below regardless of depth.
 */
const PLAIN_DATA_MAX_DEPTH = 4;

function configError(message: string, hint: string): WebSearchError {
  return new WebSearchError({ code: "E_CONFIG", stage: "config", retryable: false, hint, message });
}

/**
 * Containers whose contents a property walk cannot see. `Object.values(new
 * Map([["cb", fn]]))` is `[]`, so a Map would smuggle a function past the
 * check. Cache values are plain JSON data by contract (they become artifacts
 * and log rows), so these are rejected rather than descended: callers must
 * unwrap a Map/Set into an object/array before caching it.
 */
function opaqueContainer(value: object): string | null {
  if (value instanceof Map) return "Map";
  if (value instanceof Set) return "Set";
  if (value instanceof WeakMap) return "WeakMap";
  if (value instanceof WeakSet) return "WeakSet";
  return null;
}

/**
 * Reject functions anywhere in the top `PLAIN_DATA_MAX_DEPTH` levels of the
 * value, and opaque containers anywhere they are seen within that bound. The
 * cache promises plain data: a function would make a cache hit behave
 * differently from a fresh fetch, and it cannot be serialized into an artifact
 * or a log row.
 *
 * `seen` maps an object to the shallowest depth it was walked at. A shared
 * object can be reached first through a deep branch (so only part of it was
 * inspected before the depth bound cut the walk) and later through a shallower
 * one, where more of it would be in range: `{p:{q:X}, r:X}` with
 * `X = {a:{b:{cb: fn}}}`. Skipping the second visit would hide `cb` at depth 4.
 * So a shallower re-visit re-walks the object; the stored depth only decreases,
 * so a cycle is still stopped (a cycle always re-visits at a greater depth).
 */
function assertPlainData(
  value: unknown,
  key: string,
  depth = 0,
  seen = new Map<object, number>(),
): void {
  if (typeof value === "function") {
    throw configError(
      `refusing to cache a function under key ${JSON.stringify(key)} at depth ${depth}`,
      "cache values must be plain data; functions cannot be cached",
    );
  }
  if (depth >= PLAIN_DATA_MAX_DEPTH) return;
  if (typeof value !== "object" || value === null) return;
  const container = opaqueContainer(value);
  if (container !== null) {
    throw configError(
      `refusing to cache a ${container} under key ${JSON.stringify(key)} at depth ${depth}`,
      `cache values must be plain data; unwrap the ${container} into an object or array first`,
    );
  }
  const seenAt = seen.get(value);
  if (seenAt !== undefined && seenAt <= depth) return;
  seen.set(value, depth);
  if (Array.isArray(value)) {
    for (const item of value) assertPlainData(item, key, depth + 1, seen);
    return;
  }
  for (const item of Object.values(value)) assertPlainData(item, key, depth + 1, seen);
}

/** SERP cache lifetime (SPEC §8). Mirrors `DEFAULT_CONFIG.cache.serpTtlMs`. */
export const SERP_TTL_MS = 600_000;
/** `/goto` resolution lifetime (SPEC §8). Mirrors `DEFAULT_CONFIG.cache.gotoTtlMs`. */
export const GOTO_TTL_MS = 86_400_000;
/** LRU ceiling (SPEC §8). Mirrors `DEFAULT_CONFIG.cache.maxEntries`. */
export const DEFAULT_CACHE_MAX_ENTRIES = 200;

export interface CacheStats {
  /** Lifetime `get` hits, including repeated hits on the same key. */
  hits: number;
  /** Lifetime `get` misses: absent, or present but expired. */
  misses: number;
  /** Lifetime entries dropped by the LRU ceiling; `clear()` does not reset it. */
  evictions: number;
  size: number;
}

export interface CacheOptions {
  maxEntries: number;
  clock: Clock;
}

export interface CacheWithStats extends Cache {
  stats(): CacheStats;
}

export interface SerpKeyInput {
  engine: EngineId;
  text: string;
  n: number;
  page?: number;
  /** Engine UI language (`query.lang`). Part of the key: a lang change changes the SERP. */
  lang?: string;
  /** Engine region/country (`query.region`). Same reasoning as `lang`. */
  region?: string;
  summary: boolean;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export function createCache(options: CacheOptions): CacheWithStats {
  const { maxEntries, clock } = options;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new WebSearchError({
      code: "E_CONFIG",
      stage: "config",
      retryable: false,
      hint: "set cache.maxEntries to a positive integer",
      message: `cache.maxEntries must be a positive integer, got ${String(maxEntries)}`,
    });
  }

  // Map iteration order is insertion order. A hit re-inserts the entry at the
  // end, so `keys().next()` is always the least recently used entry — not the
  // one inserted first if it has been touched since.
  const entries = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  /**
   * Drop expired entries that no `get` happened to touch, so `size()` reports
   * live entries instead of "stored at some point". O(n), but n is bounded by
   * `maxEntries` (the map never grows past it). A purged entry is not an
   * eviction and does not touch the hit/miss counters: it simply aged out.
   */
  function purgeExpired(): void {
    const now = clock.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  return {
    get<T>(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      if (entry.expiresAt <= clock.now()) {
        entries.delete(key);
        misses += 1;
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      hits += 1;
      return entry.value as T;
    },

    set<T>(key: string, value: T, ttlMs: number): void {
      // A non-positive or non-finite TTL means "do not cache this result".
      // Callers use it to bypass the cache for one call without branching,
      // and an existing entry under the same key is left untouched.
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
      assertPlainData(value, key);
      entries.delete(key); // re-insert so a touched/updated key becomes the newest
      entries.set(key, { value, expiresAt: clock.now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
        evictions += 1;
      }
    },

    size(): number {
      purgeExpired();
      return entries.size;
    },

    clear(): void {
      // Counters are lifetime statistics and deliberately survive `clear()`;
      // callers use `stats()` to see cache effectiveness, not current contents.
      entries.clear();
    },

    stats(): CacheStats {
      purgeExpired();
      return { hits, misses, evictions, size: entries.size };
    },
  };
}

/**
 * Stable key for a SERP request. Only fields that change the engine's answer
 * belong in it; `page: undefined` and `page: 1` are the same page. `lang` and
 * `region` are part of the key because a mid-session region change makes the
 * engine answer a different SERP, and serving the previous region's results for
 * the whole TTL would be a wrong cache hit. Text is trimmed and inner
 * whitespace collapsed, but not lower-cased: quoted case can be significant to
 * an engine, and a false cache hit is worse than a miss.
 */
export function serpKey(q: SerpKeyInput): string {
  const text = q.text.trim().replace(/\s+/g, " ");
  return `serp:v1:${JSON.stringify([
    q.engine,
    text,
    q.n,
    q.page ?? 1,
    q.lang ?? "",
    q.region ?? "",
    q.summary,
  ])}`;
}

/**
 * Stable key for a `/goto` (or `/url`) wrapper resolution. Fragments do not
 * affect the redirect target, so they are stripped; everything else is kept
 * verbatim because the wrapper URL is the engine's own encoding of the target.
 */
export function gotoKey(wrapperUrl: string): string {
  const url = wrapperUrl.trim();
  const hash = url.indexOf("#");
  return `goto:v1:${hash >= 0 ? url.slice(0, hash) : url}`;
}
