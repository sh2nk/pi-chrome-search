import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  DEFAULT_CACHE_MAX_ENTRIES,
  GOTO_TTL_MS,
  SERP_TTL_MS,
  createCache,
  gotoKey,
  serpKey,
} from "../../src/runtime/cache.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import type { Clock } from "../../src/runtime/types.ts";

class ManualClock implements Clock {
  #now: number;

  constructor(start = 1_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }
}

test("get/set update hits, misses and size", () => {
  const cache = createCache({ maxEntries: 10, clock: new ManualClock() });

  assert.equal(cache.get("absent"), undefined);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 1, evictions: 0, size: 0 });

  cache.set("key", { value: 42 }, SERP_TTL_MS);
  assert.equal(cache.size(), 1);
  assert.deepEqual(cache.get("key"), { value: 42 });
  assert.deepEqual(cache.get("key"), { value: 42 });
  assert.deepEqual(cache.stats(), { hits: 2, misses: 1, evictions: 0, size: 1 });

  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get("key"), undefined);
});

test("TTL expiry deletes the entry; a later get is a miss and a re-set is a refetch", () => {
  const clock = new ManualClock();
  const cache = createCache({ maxEntries: 10, clock });

  cache.set("serp", "first", SERP_TTL_MS);
  clock.advance(SERP_TTL_MS - 1);
  assert.equal(cache.get("serp"), "first");
  assert.equal(cache.stats().hits, 1);

  clock.advance(1); // exactly at expiresAt: expired
  assert.equal(cache.get("serp"), undefined);
  assert.equal(cache.size(), 0);
  assert.equal(cache.stats().misses, 1);

  cache.set("serp", "second", SERP_TTL_MS);
  assert.equal(cache.get("serp"), "second");
});

test("SERP TTL is 10 minutes and /goto TTL is 24 hours", () => {
  assert.equal(SERP_TTL_MS, 600_000);
  assert.equal(GOTO_TTL_MS, 86_400_000);
  assert.equal(SERP_TTL_MS, DEFAULT_CONFIG.cache.serpTtlMs);
  assert.equal(GOTO_TTL_MS, DEFAULT_CONFIG.cache.gotoTtlMs);

  const clock = new ManualClock();
  const cache = createCache({ maxEntries: 10, clock });
  cache.set("serp", "s", SERP_TTL_MS);
  cache.set("goto", "g", GOTO_TTL_MS);

  clock.advance(SERP_TTL_MS);
  assert.equal(cache.get("serp"), undefined, "SERP must die at 10 minutes");
  assert.equal(cache.get("goto"), "g", "/goto must survive 10 minutes");

  clock.advance(GOTO_TTL_MS - SERP_TTL_MS);
  assert.equal(cache.get("goto"), undefined, "/goto must die at 24 hours");
});

test("ttl <= 0 is a documented no-op and leaves an existing entry alone", () => {
  const cache = createCache({ maxEntries: 10, clock: new ManualClock() });

  cache.set("a", 1, 0);
  cache.set("a", 1, -5);
  cache.set("a", 1, Number.NaN);
  assert.equal(cache.size(), 0);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, evictions: 0, size: 0 });

  cache.set("keep", "old", SERP_TTL_MS);
  cache.set("keep", "new", 0);
  assert.equal(cache.get("keep"), "old");
});

test("LRU evicts at 200 and the victim is the least recently used, not the first inserted", () => {
  const clock = new ManualClock();
  const cache = createCache({ maxEntries: DEFAULT_CACHE_MAX_ENTRIES, clock });
  assert.equal(DEFAULT_CACHE_MAX_ENTRIES, 200);
  assert.equal(DEFAULT_CACHE_MAX_ENTRIES, DEFAULT_CONFIG.cache.maxEntries);

  for (let index = 0; index < 200; index += 1) {
    cache.set(`k${index}`, index, SERP_TTL_MS);
  }
  assert.equal(cache.size(), 200);
  assert.equal(cache.stats().evictions, 0);

  cache.set("fresh", 999, SERP_TTL_MS);
  assert.equal(cache.size(), 200);
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.get("k0"), undefined, "k0 was the oldest inserted and must be evicted");
  assert.equal(cache.get("k1"), 1);
  assert.equal(cache.get("fresh"), 999);
});

test("a touch moves a key to the young end of the LRU", () => {
  const cache = createCache({ maxEntries: 3, clock: new ManualClock() });
  cache.set("a", "a", SERP_TTL_MS);
  cache.set("b", "b", SERP_TTL_MS);
  cache.set("c", "c", SERP_TTL_MS);

  assert.equal(cache.get("a"), "a"); // a is now newer than b
  cache.set("d", "d", SERP_TTL_MS);

  assert.equal(cache.get("a"), "a");
  assert.equal(cache.get("b"), undefined, "b became the least recently used");
  assert.equal(cache.get("c"), "c");
  assert.equal(cache.get("d"), "d");
  assert.equal(cache.stats().evictions, 1);
});

test("functions are rejected instead of stored", () => {
  const cache = createCache({ maxEntries: 10, clock: new ManualClock() });
  assert.throws(
    () => cache.set("fn", () => 1, SERP_TTL_MS),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CONFIG",
  );
  assert.equal(cache.size(), 0);
});

test("a function nested in an object or array is rejected too", () => {
  const cache = createCache({ maxEntries: 10, clock: new ManualClock() });

  assert.throws(
    () => cache.set("obj", { cb: () => 1 }, SERP_TTL_MS),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CONFIG",
  );
  assert.throws(
    () => cache.set("arr", [{ hits: [] }, { cb: () => 1 }], SERP_TTL_MS),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CONFIG",
  );
  assert.throws(
    () => cache.set("deep", { a: { b: { c: { cb: () => 1 } } } }, SERP_TTL_MS),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CONFIG",
  );
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, evictions: 0, size: 0 });

  // The walk is bounded at 4 levels below the root, so a function deeper than
  // that is not inspected. This documents the bound rather than pretending the
  // check is exhaustive.
  const beyondBound = { a: { b: { c: { d: { cb: () => 1 } } } } };
  cache.set("beyond", beyondBound, SERP_TTL_MS);
  assert.equal(cache.size(), 1);
});

test("a self-referencing (cyclic) value does not loop the plain-data check", () => {
  const cache = createCache({ maxEntries: 10, clock: new ManualClock() });
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;

  cache.set("cycle", cyclic, SERP_TTL_MS);
  assert.equal(cache.size(), 1);
  assert.equal(cache.get<Record<string, unknown>>("cycle"), cyclic);

  const cyclicWithFunction: Record<string, unknown> = {};
  const inner: Record<string, unknown> = { cb: () => 1 };
  cyclicWithFunction.inner = inner;
  inner.back = cyclicWithFunction;

  assert.throws(
    () => cache.set("cycle-fn", cyclicWithFunction, SERP_TTL_MS),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CONFIG",
  );
});

function isConfigError(error: unknown): boolean {
  return isWebSearchError(error) && error.details.code === "E_CONFIG";
}

test("a shared object reached again at a shallower depth is re-walked, not skipped", () => {
  const cache = createCache({ maxEntries: 10, clock: new ManualClock() });

  // `p.q` reaches X at depth 2, where the walk stops before X's grandchild;
  // `r` reaches the same X at depth 1, where `cb` at depth 4 is in range.
  const X = { a: { b: { cb: () => 1 } } };
  assert.throws(() => cache.set("alias", { p: { q: X }, r: X }, SERP_TTL_MS), isConfigError);
  assert.equal(cache.size(), 0, "the aliased function must not be stored");

  // Mutual alias: A.back === B and B.back === A, so the cycle must not hide
  // the deep function from the shallow branch nor loop the walk.
  const A: Record<string, unknown> = { tail: { leaf: { cb: () => 1 } } };
  const B: Record<string, unknown> = { back: A };
  A.back = B;
  assert.throws(() => cache.set("mutual", { p: { q: A }, r: A }, SERP_TTL_MS), isConfigError);
  assert.equal(cache.size(), 0);

  // A benign alias is still cacheable: the re-walk must not reject plain data.
  const plain = { a: { b: { value: 7 } } };
  cache.set("plain-alias", { p: { q: plain }, r: plain }, SERP_TTL_MS);
  assert.equal(cache.size(), 1);
  assert.deepEqual(cache.get("plain-alias"), { p: { q: plain }, r: plain });
});

test("Map, Set, WeakMap and WeakSet are rejected because a property walk cannot see inside", () => {
  const cache = createCache({ maxEntries: 10, clock: new ManualClock() });

  // `Object.values(new Map([["cb", fn]]))` is empty, so a Map would smuggle a
  // function past the plain-data check: the container itself must be refused.
  const cases: Array<[string, unknown]> = [
    ["map", { m: new Map<string, () => number>([["cb", () => 1]]) }],
    ["set", { s: new Set<() => number>([() => 1]) }],
    ["weakmap", { wm: new WeakMap<object, () => number>() }],
    ["weakset", { ws: new WeakSet<object>() }],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => cache.set(label, value, SERP_TTL_MS), isConfigError, `${label} must be E_CONFIG`);
  }
  assert.throws(() => cache.set("bare-map", new Map(), SERP_TTL_MS), isConfigError);
  assert.throws(() => cache.set("nested", [{ a: { s: new Set([1]) } }], SERP_TTL_MS), isConfigError);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, evictions: 0, size: 0 });

  // Containers deeper than the depth bound are not inspected, exactly like a
  // function beyond it: the bound is documented, not silently exhaustive.
  cache.set("beyond", { a: { b: { c: { d: new Set([1]) } } } }, SERP_TTL_MS);
  assert.equal(cache.size(), 1);
});

test("size() and stats().size purge expired entries nobody touched", () => {
  const clock = new ManualClock();
  const cache = createCache({ maxEntries: 10, clock });

  cache.set("short", "a", SERP_TTL_MS);
  cache.set("long", "b", GOTO_TTL_MS);
  assert.equal(cache.size(), 2);

  clock.advance(SERP_TTL_MS); // "short" expires exactly now, "long" survives
  assert.equal(cache.size(), 1, "an expired entry must not be reported as live");
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, evictions: 0, size: 1 });

  clock.advance(GOTO_TTL_MS);
  assert.equal(cache.stats().size, 0, "all entries expired");
  assert.equal(cache.stats().evictions, 0, "aging out is not an eviction");
  assert.equal(cache.stats().misses, 0, "purging is not a miss");
});

test("clear() keeps hits/misses/evictions and zeroes the reported size", () => {
  const cache = createCache({ maxEntries: 2, clock: new ManualClock() });
  cache.set("a", "a", SERP_TTL_MS);
  cache.set("b", "b", SERP_TTL_MS);
  cache.set("c", "c", SERP_TTL_MS); // evicts "a"
  assert.equal(cache.get("b"), "b"); // hit
  assert.equal(cache.get("missing"), undefined); // miss
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, evictions: 1, size: 2 });

  cache.clear();
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, evictions: 1, size: 0 });
  assert.equal(cache.size(), 0);
});

test("1000 inserts never grow past maxEntries", () => {
  const clock = new ManualClock();
  const cache = createCache({ maxEntries: 50, clock });

  for (let index = 0; index < 1000; index += 1) {
    cache.set(`k${index}`, index, SERP_TTL_MS);
    assert.ok(cache.size() <= 50, `size ${cache.size()} exceeded maxEntries after ${index + 1} inserts`);
  }

  assert.equal(cache.size(), 50);
  assert.equal(cache.stats().evictions, 950);
  assert.equal(cache.get("k0"), undefined, "the oldest keys are gone");
  assert.equal(cache.get("k999"), 999);
});

test("a non-positive maxEntries is E_CONFIG", () => {
  assert.throws(
    () => createCache({ maxEntries: 0, clock: new ManualClock() }),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CONFIG",
  );
});

test("serpKey is stable, whitespace-normalized and page 1 == page undefined", () => {
  const base = {
    engine: "google" as const,
    text: "  трансформер   архитектура ",
    n: 5,
    summary: true,
  };

  assert.equal(serpKey(base), serpKey({ ...base }));
  assert.equal(serpKey(base), serpKey({ ...base, text: "трансформер архитектура" }));
  assert.equal(serpKey(base), serpKey({ ...base, page: 1 }));
  assert.equal(serpKey(base), serpKey({ ...base, page: undefined }));
  assert.notEqual(serpKey(base), serpKey({ ...base, summary: false }));
  assert.notEqual(serpKey(base), serpKey({ ...base, engine: "yandex" }));
  assert.notEqual(serpKey(base), serpKey({ ...base, freshness: "d" }));
  assert.notEqual(serpKey(base), serpKey({ ...base, n: 10 }));
  assert.match(serpKey(base), /^serp:v1:/);
});

test("serpKey lang/region are part of the key", () => {
  const base = {
    engine: "google" as const,
    text: "трансформер архитектура",
    n: 5,
    summary: true,
  };

  assert.notEqual(serpKey(base), serpKey({ ...base, lang: "ru" }));
  assert.notEqual(serpKey(base), serpKey({ ...base, region: "ru" }));
  assert.notEqual(
    serpKey({ ...base, lang: "ru", region: "ru" }),
    serpKey({ ...base, lang: "en", region: "us" }),
    "a mid-session region/language change must not reuse the old SERP",
  );
  assert.equal(serpKey({ ...base, lang: "", region: "" }), serpKey(base), "empty means unset");
});

test("gotoKey is stable and ignores a fragment", () => {
  const url = "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F&sa=D";
  assert.equal(gotoKey(url), gotoKey(`  ${url}  `));
  assert.equal(gotoKey(`${url}#section`), gotoKey(url));
  assert.notEqual(gotoKey(url), gotoKey(`${url}&x=1`));
  assert.match(gotoKey(url), /^goto:v1:/);
});
