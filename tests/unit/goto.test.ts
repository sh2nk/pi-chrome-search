/**
 * SPEC S7.4: a `/goto` wrapper is resolved by asking Google the way the browser
 * would (cookies, `redirect: "manual"`), never by decoding the signed protobuf
 * and never by following a redirect into another Google page.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGotoResolver } from "../../src/extract/goto.ts";
import { gotoKey, createCache } from "../../src/runtime/cache.ts";
import type { Cache } from "../../src/runtime/types.ts";
import { FakeClock } from "../helpers/fake-cdp.ts";

const WRAPPER = "https://www.google.com/goto?url=opaque-token";

function memoryCache(): Cache {
  const rows = new Map<string, unknown>();
  return {
    get: <T>(key: string) => rows.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      rows.set(key, value);
    },
    size: () => rows.size,
    clear: () => rows.clear(),
  };
}

test("S7.4: cookies are sent with redirect:manual and the Location is the result", async () => {
  const clock = new FakeClock();
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(null, {
      status: 302,
      headers: { location: "https://destination.example.test/page" },
    });
  }) as typeof fetch;

  const resolver = createGotoResolver({
    cache: memoryCache(),
    clock,
    fetchImpl,
    cookieSource: async () => [{ name: "SID", value: "secret-cookie-value" }],
  });
  const resolution = await resolver.resolve(WRAPPER);

  assert.equal(resolution.url, "https://destination.example.test/page");
  assert.equal(resolution.method, "http");
  assert.equal(seen?.init?.redirect, "manual", "following redirects would walk into Google");
  assert.equal(seen?.init?.method, "GET");
  const headers = seen?.init?.headers as Record<string, string>;
  assert.equal(headers.cookie, "SID=secret-cookie-value");
  assert.doesNotMatch(JSON.stringify(resolution), /secret-cookie-value/);
});

test("S7.4: a 200 without Location stays an unresolved wrapper", async () => {
  const resolver = createGotoResolver({
    cache: memoryCache(),
    clock: new FakeClock(),
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
  });
  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.url, null);
  assert.equal(resolution.method, "unresolved");
  assert.equal(resolution.reason, "no-redirect");
  assert.equal(resolution.wrapperUrl, WRAPPER);
});

test("S7.4: a Google-valued Location is never returned as a destination", async () => {
  const resolver = createGotoResolver({
    cache: memoryCache(),
    clock: new FakeClock(),
    fetchImpl: (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://consent.google.com/save" },
      })) as typeof fetch,
  });
  const resolution = await resolver.resolve(WRAPPER);
  assert.equal(resolution.url, null);
  assert.equal(resolution.reason, "unexpected-redirect");
});

test("S4.5/S7.4: only a real destination is cached and a hit costs no fetch", async () => {
  const clock = new FakeClock();
  const cache = createCache({ maxEntries: 10, clock });
  let fetches = 0;
  const resolver = createGotoResolver({
    cache,
    clock,
    fetchImpl: (async () => {
      fetches += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://destination.example.test/page" },
      });
    }) as typeof fetch,
  });

  await resolver.resolve(WRAPPER);
  const hit = await resolver.resolve(WRAPPER);
  assert.equal(fetches, 1);
  assert.equal(hit.method, "cache");
  assert.equal(hit.url, "https://destination.example.test/page");
  assert.ok(cache.get(gotoKey(WRAPPER)) !== undefined);

  const failing = createGotoResolver({
    cache,
    clock,
    fetchImpl: (async () => new Response(null, { status: 403 })) as typeof fetch,
  });
  const walled = await failing.resolve("https://www.google.com/goto?url=other");
  assert.equal(walled.url, null);
  assert.equal(
    cache.get(gotoKey("https://www.google.com/goto?url=other")),
    undefined,
    "an unresolved wrapper must not be cached as a failure",
  );
});

test("S7.4: a non-wrapper URL is a caller bug, not a request", async () => {
  const resolver = createGotoResolver({
    cache: memoryCache(),
    clock: new FakeClock(),
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
  });
  await assert.rejects(resolver.resolve("https://example.com/page"), /not an absolute Google \/goto wrapper/);
});
