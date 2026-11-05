/**
 * Offline tests for the Google `/goto` resolver (SPEC §6.1, PLAN P3-Goto).
 *
 * No network and no Chrome: `fetch` is a scripted double, cookies come from a
 * spy, and TTL boundaries are driven by `FakeClock`. The live behaviour this
 * encodes (302 → real URL, 200-without-redirect → one navigation, `/sorry` →
 * unresolved) is recorded in `research/FINDINGS.md` §2.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  createGotoResolver,
  isGotoWrapper,
} from "../../src/extract/goto.ts";
import type { GotoCookie, GotoLogRow, GotoResolverOptions } from "../../src/extract/goto.ts";
import { GOTO_TTL_MS, createCache, gotoKey, serpKey } from "../../src/runtime/cache.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { FakeClock } from "../helpers/clock.ts";

const WRAPPER = "https://www.google.com/goto?url=CAESabc123";

/**
 * The resolver defaults to the global `fetch`. A test that forgets `fetchImpl`
 * would otherwise hit google.com for real and pass or fail for the wrong
 * reason, so the global is poisoned for the whole file.
 */
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (() => {
    throw new Error("goto tests are offline: pass fetchImpl, never the global fetch");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

type FetchHandler = (url: string, init: RequestInit) => Promise<Response> | Response;
type FetchInput = Parameters<typeof fetch>[0];

/** Recording fetch double. Every call is kept so "no network" can be asserted. */
function fakeFetch(handler: FetchHandler): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

function redirect(status: number, location?: string): Response {
  const headers = new Headers();
  if (location !== undefined) headers.set("location", location);
  return new Response(null, { status, headers });
}

/** A browser `redirect: "manual"` response: status 0 and no readable headers. */
function opaqueRedirect(): Response {
  return { status: 0, headers: new Headers(), body: null } as unknown as Response;
}

/** A fetch that never answers on its own, only rejecting when its signal aborts. */
function hangingFetch(onStart?: () => void): typeof fetch {
  return (async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
    onStart?.();
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) return;
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;
}

function harness(overrides: Partial<GotoResolverOptions> = {}): {
  clock: FakeClock;
  cache: ReturnType<typeof createCache>;
  logs: GotoLogRow[];
  resolver: ReturnType<typeof createGotoResolver>;
} {
  const clock = new FakeClock();
  const cache = createCache({ maxEntries: 50, clock });
  const logs: GotoLogRow[] = [];
  const resolver = createGotoResolver({
    cache,
    clock,
    log: (row) => logs.push(row),
    ...overrides,
  });
  return { clock, cache, logs, resolver };
}

function expectCode(error: unknown, code: string, stage: string): true {
  assert.ok(isWebSearchError(error), `expected a WebSearchError, got ${String(error)}`);
  assert.equal(error.details.code, code);
  assert.equal(error.details.stage, stage);
  assert.ok(error.details.hint.length > 0, "an error without a hint is not diagnosable");
  return true;
}

test("isGotoWrapper accepts only absolute Google /goto URLs", () => {
  assert.equal(isGotoWrapper("https://www.google.com/goto?url=CAESabc"), true);
  assert.equal(isGotoWrapper("https://google.de/goto?url=x"), true);
  assert.equal(isGotoWrapper("http://www.google.co.uk/goto"), true);
  assert.equal(isGotoWrapper("  https://www.google.com/goto?url=x  "), true);

  assert.equal(isGotoWrapper("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F"), false);
  assert.equal(isGotoWrapper("https://example.com/goto?url=x"), false);
  assert.equal(isGotoWrapper("/goto?url=x"), false, "no host to send the request to");
  assert.equal(isGotoWrapper("javascript:alert(1)"), false);
  assert.equal(isGotoWrapper("not a url"), false);
  assert.equal(isGotoWrapper(""), false);
  assert.equal(isGotoWrapper("   "), false);
  assert.equal(isGotoWrapper("ftp://www.google.com/goto"), false);

  // The cookie-bearing GET goes to whatever host this accepts, so a
  // google-lookalike must not pass even though it is a well-formed /goto URL.
  for (const hostile of [
    "https://google.duckdns.org/goto?url=x",
    "https://google.com.evil.co/goto?url=x",
    "https://google.co.uk.evil/goto?url=x",
    "https://notgoogle.com/goto?url=x",
  ]) {
    assert.equal(isGotoWrapper(hostile), false, hostile);
  }
});

test("a non-wrapper input is E_CONFIG at stage resolve and never touches the network", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/"));
  const { resolver } = harness({ fetchImpl: impl });

  for (const bad of [
    "https://example.com/url?q=https%3A%2F%2Fexample.com%2F",
    "/goto?url=CAESabc",
    "https://www.google.com/search?q=x",
    "",
  ]) {
    await assert.rejects(resolver.resolve(bad), (error: unknown) => {
      expectCode(error, "E_CONFIG", "resolve");
      assert.match((error as { details: { hint: string } }).details.hint, /parseLink/);
      return true;
    });
  }
  assert.equal(calls.length, 0, "a caller bug must not spend a request");
});

test("a cache hit performs no fetch and no cookie read", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/"));
  let cookieReads = 0;
  const { cache, resolver, logs } = harness({
    fetchImpl: impl,
    cookieSource: async () => {
      cookieReads += 1;
      return [{ name: "SID", value: "session-value" }];
    },
  });
  cache.set(gotoKey(WRAPPER), { url: "https://example.com/cached", status: 302 }, GOTO_TTL_MS);

  const resolution = await resolver.resolve(WRAPPER);
  assert.deepEqual(resolution, {
    url: "https://example.com/cached",
    wrapperUrl: WRAPPER,
    method: "cache",
    status: 302,
  });
  assert.equal(calls.length, 0);
  assert.equal(cookieReads, 0);
  assert.deepEqual(logs, [{ wrapperHost: "www.google.com", method: "cache" }]);
});

test("/goto cache keys are namespaced away from SERP keys", () => {
  const key = gotoKey(WRAPPER);
  assert.ok(key.startsWith("goto:v1:"), "a namespace prefix is what keeps the families apart");
  const serp = serpKey({ engine: "google", text: WRAPPER, n: 5, summary: true });
  assert.notEqual(key, serp);
  assert.ok(!serp.startsWith("goto:"));
});

test("cookie header is built from google.com cookies and sent verbatim", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/page?x=1"));
  const asked: string[][] = [];
  const { resolver } = harness({
    fetchImpl: impl,
    cookieSource: async (urls) => {
      asked.push([...urls]);
      return [
        { name: "SID", value: "abc123" },
        { name: "CONSENT", value: "YES+" },
      ];
    },
  });

  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.method, "http");
  assert.equal(resolution.url, "https://example.com/page?x=1");
  assert.deepEqual(asked, [["https://www.google.com/"]]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WRAPPER);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual", "manual is the whole trick: read Location, never follow");
  assert.equal(new Headers(calls[0].init.headers).get("cookie"), "SID=abc123; CONSENT=YES+");
});

test("the cookie origin comes from the wrapper host, not a hard-coded google.com", async () => {
  const wrapper = "https://google.de/goto?url=CAESde";
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.de/a"));
  const asked: string[][] = [];
  const { resolver } = harness({
    fetchImpl: impl,
    cookieSource: async (urls) => {
      asked.push([...urls]);
      return [{ name: "NID", value: "de-value" }];
    },
  });

  const resolution = await resolver.resolve(wrapper);
  assert.equal(resolution.method, "http");
  assert.deepEqual(asked, [["https://google.de/"]], "a google.de wrapper asks for google.de cookies");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, wrapper, "the GET itself still goes to the wrapper URL");
  assert.equal(new Headers(calls[0].init.headers).get("cookie"), "NID=de-value");

  // A www wrapper keeps its own host: deriving from the URL is the whole point.
  const wwwWrapper = "https://www.google.co.uk/goto?url=CAESuk";
  const second = fakeFetch(() => redirect(302, "https://example.co.uk/a"));
  const askedSecond: string[][] = [];
  const { resolver: secondResolver } = harness({
    fetchImpl: second.impl,
    cookieSource: async (urls) => {
      askedSecond.push([...urls]);
      return [];
    },
  });
  await secondResolver.resolve(wwwWrapper);
  assert.deepEqual(askedSecond, [["https://www.google.co.uk/"]]);
  assert.equal(second.calls[0].url, wwwWrapper);
});

test("cookie values never appear in the resolution or the log row", async () => {
  const { impl } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver, logs } = harness({
    fetchImpl: impl,
    cookieSource: async () => [
      { name: "SID", value: "super-secret-cookie-value" },
      { name: "NID", value: "another-secret" },
    ],
  });

  const resolution = await resolver.resolve(WRAPPER);
  const serialized = JSON.stringify({ resolution, logs });
  assert.ok(!serialized.includes("super-secret-cookie-value"));
  assert.ok(!serialized.includes("another-secret"));
  assert.deepEqual(logs, [{ wrapperHost: "www.google.com", method: "http", status: 302 }]);
});

test("cookies that could inject a header or a second cookie are dropped", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver } = harness({
    fetchImpl: impl,
    cookieSource: async () => [
      { name: "OK", value: "1" },
      { name: "BAD\r\nInjected", value: "x" },
      { name: "inj", value: "a;b" },
      { name: "eq", value: "ok=yes" },
    ],
  });

  await resolver.resolve(WRAPPER);
  assert.equal(new Headers(calls[0].init.headers).get("cookie"), "OK=1; eq=ok=yes");

  const { impl: impl2, calls: calls2 } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver: resolver2 } = harness({
    fetchImpl: impl2,
    cookieSource: async () => [{ name: "inj", value: "a;b" }],
  });
  await resolver2.resolve(WRAPPER);
  assert.equal(calls2[0].init.headers, undefined, "nothing usable means no Cookie header at all");
});

test("a failing cookie source degrades to a cookie-less request, never an error", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver } = harness({
    fetchImpl: impl,
    cookieSource: async () => {
      throw new Error("Network.getCookies failed");
    },
  });

  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.url, "https://example.com/a");
  assert.equal(resolution.method, "http");
  assert.equal(resolution.reason, "no-cookies");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers, undefined);
});

test("every redirect status is read the same way and the target is not rewritten", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const location = "https://Example.COM/Path?b=2&a=1#frag";
    const { impl, calls } = fakeFetch(() => redirect(status, location));
    const { resolver } = harness({ fetchImpl: impl });

    const resolution = await resolver.resolve(WRAPPER);
    assert.equal(resolution.method, "http", `status ${status}`);
    assert.equal(resolution.status, status);
    assert.equal(resolution.url, location, "strip nothing: the caller owns normalisation");
    assert.equal(resolution.reason, undefined);
    assert.equal(calls.length, 1, "no redirect following, not even once");
  }
});

test("a Google-valued Location is unresolved and is never followed", async () => {
  for (const location of [
    "https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch",
    "https://consent.google.com/ml?continue=https%3A%2F%2Fwww.google.com%2F",
    "https://www.google.com/goto?url=CAESother",
  ]) {
    const { impl, calls } = fakeFetch(() => redirect(302, location));
    const { resolver, cache } = harness({ fetchImpl: impl });

    const resolution = await resolver.resolve(WRAPPER);
    assert.equal(resolution.url, null);
    assert.equal(resolution.method, "unresolved");
    assert.equal(resolution.reason, "unexpected-redirect");
    assert.equal(resolution.status, 302);
    assert.equal(calls.length, 1, "one request, one answer — no chain walking");
    assert.equal(cache.size(), 0, "failures are never cached");
  }
});

test("200 with a working navigation fallback resolves once and caches", async () => {
  const { impl, calls } = fakeFetch(() => redirect(200));
  const navigated: string[] = [];
  const { resolver } = harness({
    fetchImpl: impl,
    navigateFallback: async (wrapperUrl) => {
      navigated.push(wrapperUrl);
      return "https://example.org/article";
    },
  });

  const first = await resolver.resolve(WRAPPER);
  assert.deepEqual(first, {
    url: "https://example.org/article",
    wrapperUrl: WRAPPER,
    method: "navigate",
    status: 200,
  });
  assert.deepEqual(navigated, [WRAPPER]);

  const second = await resolver.resolve(WRAPPER);
  assert.equal(second.method, "cache");
  assert.equal(second.url, "https://example.org/article");
  assert.equal(calls.length, 1, "the cached navigation is not repeated");
  assert.equal(navigated.length, 1);
});

test("200 falls back to unresolved when the fallback is missing or useless", async () => {
  // No fallback supplied at all.
  {
    const { impl, calls } = fakeFetch(() => redirect(200));
    const { resolver } = harness({ fetchImpl: impl });
    const resolution = await resolver.resolve(WRAPPER);
    assert.equal(resolution.method, "unresolved");
    assert.equal(resolution.reason, "no-redirect");
    assert.equal(resolution.url, null);
    assert.equal(resolution.status, 200);
    assert.equal(calls.length, 1);
  }

  for (const fallback of [
    async () => null,
    async () => "https://www.google.com/search?q=still-here",
    async () => "/search?q=relative",
    async () => "javascript:void(0)",
    async (): Promise<string | null> => {
      throw new Error("tab went away");
    },
  ]) {
    const { impl, calls } = fakeFetch(() => redirect(200));
    const { resolver, cache } = harness({ fetchImpl: impl, navigateFallback: fallback });
    const resolution = await resolver.resolve(WRAPPER);
    assert.equal(resolution.method, "unresolved");
    assert.equal(resolution.reason, "no-redirect");
    assert.equal(resolution.url, null);
    assert.equal(calls.length, 1, "the fallback is a single shot, never a retry loop");
    assert.equal(cache.size(), 0);
  }
});

test("wall, server and client statuses map to distinct reasons and are not cached", async () => {
  const cases: Array<[number, string]> = [
    [403, "wall"],
    [429, "wall"],
    [500, "http-500"],
    [503, "http-503"],
    [404, "http-404"],
    [401, "http-401"],
  ];
  for (const [status, reason] of cases) {
    const { impl, calls } = fakeFetch(() => redirect(status));
    const { resolver, cache } = harness({ fetchImpl: impl });
    const resolution = await resolver.resolve(WRAPPER);
    assert.equal(resolution.method, "unresolved", `status ${status}`);
    assert.equal(resolution.reason, reason);
    assert.equal(resolution.status, status);
    assert.equal(resolution.url, null);
    assert.equal(calls.length, 1);
    assert.equal(cache.size(), 0);
    assert.equal(cache.stats().hits, 0, "an unresolved answer must not be served as a hit");
  }
});

test("a 2xx that is not a redirect uses the same single fallback path", async () => {
  const { impl } = fakeFetch(() => redirect(204));
  const { resolver } = harness({ fetchImpl: impl });
  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.method, "unresolved");
  assert.equal(resolution.reason, "no-redirect");
  assert.equal(resolution.status, 204);
});

test("an opaque manual redirect (status 0) is reported, not guessed", async () => {
  const { impl, calls } = fakeFetch(() => opaqueRedirect());
  const { resolver } = harness({ fetchImpl: impl });
  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.method, "unresolved");
  assert.equal(resolution.reason, "opaque-redirect");
  assert.equal(resolution.url, null);
  assert.equal(calls.length, 1);
});

test("malformed Location values are unresolved with bad-location", async () => {
  for (const location of ["javascript:alert(1)", "/search?q=x", "", undefined, "//example.com/x"]) {
    const { impl, calls } = fakeFetch(() => redirect(302, location));
    const { resolver } = harness({ fetchImpl: impl });
    const resolution = await resolver.resolve(WRAPPER);
    assert.equal(resolution.method, "unresolved", `location ${String(location)}`);
    assert.equal(resolution.reason, "bad-location");
    assert.equal(resolution.url, null);
    assert.equal(resolution.status, 302);
    assert.equal(calls.length, 1);
  }
});

test("a cookie source that breaks its contract degrades to no-cookies", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver } = harness({
    fetchImpl: impl,
    // Simulates a caller wired to the wrong CDP shape; it must not look like a
    // fetch failure.
    cookieSource: (async () => "not-an-array") as unknown as GotoResolverOptions["cookieSource"],
  });
  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.method, "http");
  assert.equal(resolution.reason, "no-cookies");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers, undefined);
});

test("a cached value is re-validated on read, so a foreign writer cannot smuggle a bad target", async () => {
  for (const planted of [
    "javascript:alert(1)",
    "https://www.google.com/search?q=still-a-wrapper",
    "https://consent.google.com/ml?continue=x",
    "/relative/path",
    "ftp://example.com/file",
    "",
  ]) {
    const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/real"));
    const { cache, resolver } = harness({ fetchImpl: impl });
    // `Cache` is shared, `isCachedGoto` only checks the shape: another writer
    // under the goto:v1: prefix must not be able to name the result.
    cache.set(gotoKey(WRAPPER), { url: planted, status: 302 }, GOTO_TTL_MS);

    const resolution = await resolver.resolve(WRAPPER);
    assert.equal(resolution.method, "http", `planted ${JSON.stringify(planted)}`);
    assert.equal(resolution.url, "https://example.com/real");
    assert.equal(calls.length, 1, "a poisoned entry is a miss, so the network answers");

    const second = await resolver.resolve(WRAPPER);
    assert.equal(second.method, "cache", "the successful resolution overwrites the poison");
    assert.equal(second.url, "https://example.com/real");
  }
});

test("a junk value under the goto key is a miss, not a crash", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { cache, resolver } = harness({ fetchImpl: impl });
  cache.set(gotoKey(WRAPPER), "not-a-resolution", GOTO_TTL_MS);

  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.method, "http");
  assert.equal(resolution.url, "https://example.com/a");
  assert.equal(calls.length, 1);
});

test("a network failure is fetch-failed with no status, and is not retried", async () => {
  let calls = 0;
  const { impl } = fakeFetch(() => {
    calls += 1;
    throw new TypeError("fetch failed");
  });
  const { resolver, cache } = harness({ fetchImpl: impl });
  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.method, "unresolved");
  assert.equal(resolution.reason, "fetch-failed");
  assert.equal(resolution.status, undefined);
  assert.equal(calls, 1, "exactly one attempt");
  assert.equal(cache.size(), 0);
});

test("the request deadline turns a hanging fetch into fetch-failed, not a hang", async () => {
  const { resolver } = harness({ fetchImpl: hangingFetch(), timeoutMs: 20 });
  const startedAt = Date.now();
  const resolution = await resolver.resolve(WRAPPER);
  const elapsed = Date.now() - startedAt;
  assert.equal(resolution.method, "unresolved");
  assert.equal(resolution.reason, "fetch-failed");
  assert.ok(elapsed < 2_000, `the deadline must fire, took ${elapsed} ms`);
});

test("an already-aborted call is E_CANCELLED before any work", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver } = harness({ fetchImpl: impl });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(resolver.resolve(WRAPPER, controller.signal), (error: unknown) =>
    expectCode(error, "E_CANCELLED", "resolve"),
  );
  assert.equal(calls.length, 0);
});

test("an abort during the fetch is E_CANCELLED even if the fetch ignores its signal", async () => {
  const controller = new AbortController();
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  // Deliberately ignores `init.signal`: the resolver must race abort itself.
  const ignoringFetch = (async () => {
    signalStarted();
    return await new Promise<Response>(() => {});
  }) as typeof fetch;
  const { resolver } = harness({ fetchImpl: ignoringFetch });

  const pending = resolver.resolve(WRAPPER, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => expectCode(error, "E_CANCELLED", "resolve"));
});

test("an abort during a hanging cookie read is E_CANCELLED, never a stall", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const { resolver } = harness({
    fetchImpl: impl,
    // Ignores the deadline entirely: the resolver itself must race the abort.
    cookieSource: async () => {
      signalStarted();
      return await new Promise<readonly GotoCookie[]>(() => {});
    },
  });

  const controller = new AbortController();
  const pending = resolver.resolve(WRAPPER, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => expectCode(error, "E_CANCELLED", "resolve"));
  assert.equal(calls.length, 0, "the GET never starts after a cancelled resolve");
});

test("a cookie source slower than the deadline degrades to cookie-timeout, not a hang", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver, cache } = harness({
    fetchImpl: impl,
    timeoutMs: 20,
    cookieSource: async () => await new Promise<readonly GotoCookie[]>(() => {}),
  });

  const startedAt = Date.now();
  const resolution = await resolver.resolve(WRAPPER);
  const elapsed = Date.now() - startedAt;

  assert.equal(resolution.method, "http", "the GET still gets its own full deadline");
  assert.equal(resolution.url, "https://example.com/a");
  assert.equal(resolution.reason, "cookie-timeout", "a documented, non-fatal reason");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers, undefined, "no cookies were read, so no Cookie header");
  assert.equal(cache.size(), 1, "the resolution still counts as a success");
  assert.ok(elapsed < 2_000, `the cookie deadline must fire, took ${elapsed} ms`);
});

test("successful resolutions are cached for 24 h and die at the TTL boundary", async () => {
  assert.equal(DEFAULT_CONFIG.cache.gotoTtlMs, GOTO_TTL_MS);
  assert.equal(GOTO_TTL_MS, 86_400_000);

  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver, clock } = harness({ fetchImpl: impl }); // default ttl

  const first = await resolver.resolve(WRAPPER);
  assert.equal(first.method, "http");
  assert.equal(calls.length, 1);

  // A SERP TTL (10 min) must not evict a /goto resolution.
  clock.advance(DEFAULT_CONFIG.cache.serpTtlMs);
  assert.equal((await resolver.resolve(WRAPPER)).method, "cache");
  assert.equal(calls.length, 1);

  clock.advance(GOTO_TTL_MS - DEFAULT_CONFIG.cache.serpTtlMs - 1);
  assert.equal((await resolver.resolve(WRAPPER)).method, "cache", "still alive 1 ms before the TTL");
  assert.equal(calls.length, 1);

  clock.advance(1); // exactly at expiresAt: expired, as cache.ts documents
  const afterExpiry = await resolver.resolve(WRAPPER);
  assert.equal(afterExpiry.method, "http");
  assert.equal(calls.length, 2, "expiry means exactly one refetch");
});

test("the default TTL tracks DEFAULT_CONFIG.cache.gotoTtlMs instead of a local constant", async () => {
  const original = DEFAULT_CONFIG.cache.gotoTtlMs;
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  try {
    // A config change must reach an already-defaulted resolver, so a local
    // duplicate of 24 h cannot drift away from the config silently.
    const configured = original + 7_000;
    DEFAULT_CONFIG.cache.gotoTtlMs = configured;
    const { resolver, clock } = harness({ fetchImpl: impl });

    await resolver.resolve(WRAPPER);
    clock.advance(configured - 1);
    assert.equal((await resolver.resolve(WRAPPER)).method, "cache");
    clock.advance(1);
    assert.equal((await resolver.resolve(WRAPPER)).method, "http");
    assert.equal(calls.length, 2);
  } finally {
    DEFAULT_CONFIG.cache.gotoTtlMs = original;
  }
});

test("an explicit ttlMs overrides the default", async () => {
  const { impl, calls } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver, clock } = harness({ fetchImpl: impl, ttlMs: 1_000 });

  await resolver.resolve(WRAPPER);
  clock.advance(999);
  assert.equal((await resolver.resolve(WRAPPER)).method, "cache");
  clock.advance(1);
  assert.equal((await resolver.resolve(WRAPPER)).method, "http");
  assert.equal(calls.length, 2);
});

test("unresolved wrappers are not cached and are probed again", async () => {
  const { impl, calls } = fakeFetch(() => redirect(403));
  const { resolver, cache } = harness({ fetchImpl: impl });

  assert.equal((await resolver.resolve(WRAPPER)).reason, "wall");
  assert.equal((await resolver.resolve(WRAPPER)).reason, "wall");
  assert.equal(calls.length, 2);
  assert.equal(cache.size(), 0);
});

test("the log carries host and method only", async () => {
  const { impl } = fakeFetch(() => redirect(302, "https://example.com/a"));
  const { resolver, logs } = harness({
    fetchImpl: impl,
    cookieSource: async () => [{ name: "SID", value: "leaky-value" }],
  });
  await resolver.resolve(WRAPPER);

  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], { wrapperHost: "www.google.com", method: "http", status: 302 });
  const serialized = JSON.stringify(logs[0]);
  assert.ok(!serialized.includes("CAESabc123"), "the wrapper query is a signed blob, not a log field");
  assert.ok(!serialized.includes("leaky-value"));
});

test("an invalid timeout is rejected at construction with E_CONFIG", () => {
  const clock = new FakeClock();
  const cache = createCache({ maxEntries: 10, clock });
  for (const timeoutMs of [0, -1, Number.NaN]) {
    assert.throws(
      () => createGotoResolver({ cache, clock, timeoutMs }),
      (error: unknown) => expectCode(error, "E_CONFIG", "config"),
    );
  }
});
