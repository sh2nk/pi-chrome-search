/**
 * SPEC S8.3: `/goto` resolution is bounded.
 *
 * v1 resolved every wrapper sequentially with a 5 s timeout, so one SERP could
 * spend 50 s in link resolution. The batch runs three at a time under one total
 * deadline; a wrapper the batch does not reach stays a wrapper and is marked
 * unresolved (S7.4), never fabricated.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GOTO_BATCH_TIMEOUT_MS,
  GOTO_CONCURRENCY,
  createGotoResolver,
  resolveGotoBatch,
} from "../../src/extract/goto.ts";
import type { RawSerp } from "../../src/engines/types.ts";
import type { Cache } from "../../src/runtime/types.ts";
import { createWebSearchTool } from "../../src/tools/web_search.ts";
import { FakeClock } from "../helpers/fake-cdp.ts";
import { createEngineStub, createHarness } from "../helpers/search-harness.ts";

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

function wrapper(index: number): string {
  return `https://www.google.com/goto?url=opaque-${index}`;
}

test("S8.3: the shipped bounds are 3 concurrent resolutions and an 8 s batch", () => {
  assert.equal(GOTO_CONCURRENCY, 3);
  assert.equal(GOTO_BATCH_TIMEOUT_MS, 8_000);
});

test("S8.3: resolutions run three at a time and all six resolve", async () => {
  const clock = new FakeClock();
  let active = 0;
  let peak = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    active += 1;
    peak = Math.max(peak, active);
    const target = String(input).includes("opaque-")
      ? String(input).slice(String(input).indexOf("opaque-"))
      : "target";
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return new Response(null, {
      status: 302,
      headers: { location: `https://target.example.test/${target}` },
    });
  }) as typeof fetch;

  const resolver = createGotoResolver({ cache: memoryCache(), clock, fetchImpl });
  const wrappers = Array.from({ length: 6 }, (_, index) => wrapper(index));
  const batch = await resolveGotoBatch({ resolver, wrappers, deadlineMs: 1_000 });

  assert.equal(batch.resolved, 6);
  assert.equal(batch.unresolved, 0);
  assert.equal(batch.timedOut, false);
  assert.ok(peak <= GOTO_CONCURRENCY, `peak concurrency ${peak} exceeded ${GOTO_CONCURRENCY}`);
  assert.ok(peak > 1, "the batch must actually resolve in parallel, not sequentially");
});

test("S8.3: one total deadline stops the batch; unfinished wrappers stay unresolved", async () => {
  const clock = new FakeClock();
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("The /goto request timed out.", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;

  const resolver = createGotoResolver({ cache: memoryCache(), clock, fetchImpl });
  const wrappers = Array.from({ length: 5 }, (_, index) => wrapper(index));
  const startedAt = Date.now();
  const batch = await resolveGotoBatch({ resolver, wrappers, deadlineMs: 40 });
  const elapsed = Date.now() - startedAt;

  assert.equal(batch.resolved, 0);
  assert.equal(batch.unresolved, 5);
  assert.equal(batch.timedOut, true);
  assert.ok(elapsed < 1_000, `batch took ${elapsed} ms; the total deadline did not bound it`);
  for (const value of batch.byWrapper.values()) {
    assert.equal(value.url, null);
    assert.equal(value.method, "unresolved");
  }
});

test("S8.3: a caller abort is not reported as a successful batch", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  const resolver = createGotoResolver({ cache: memoryCache(), clock, fetchImpl });
  const batch = resolveGotoBatch({
    resolver,
    wrappers: [wrapper(1), wrapper(2)],
    deadlineMs: 5_000,
    signal: controller.signal,
  });
  controller.abort(new DOMException("cancelled by the caller", "AbortError"));
  await assert.rejects(batch);
});

test("S8.3: web_search resolves a SERP's wrappers with bounded concurrency", async () => {
  const engine = createEngineStub("google");
  const wrappers = Array.from({ length: 5 }, (_, index) => wrapper(index));
  engine.extractImpl = async (query): Promise<RawSerp> => ({
    engine: "google",
    query: query.text,
    results: wrappers.map((url, index) => ({
      title: `result ${index}`,
      url,
      snippet: `snippet ${index}`,
    })),
    pageCarried: false,
    timings: {},
  });
  const harness = createHarness({ engines: [engine] });

  let active = 0;
  let peak = 0;
  harness.deps.fetchImpl = (async (input: string | URL | Request) => {
    active += 1;
    peak = Math.max(peak, active);
    const target = String(input).slice(String(input).indexOf("opaque-"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(null, {
      status: 302,
      headers: { location: `https://target.example.test/${target}` },
    });
  }) as typeof fetch;

  const result = await createWebSearchTool(() => harness.deps).execute(
    "call-1",
    { q: "goto batch", engines: "google", summary: false },
    undefined,
    undefined,
  );
  assert.equal("isError" in result, false);
  if ("isError" in result) return;
  assert.equal(result.details.unresolved, undefined, "every wrapper resolved");
  const text = result.content.map((block) => block.text ?? "").join("");
  assert.match(text, /target\.example\.test\/opaque-4/);
  assert.ok(peak <= GOTO_CONCURRENCY, `peak concurrency ${peak} exceeded ${GOTO_CONCURRENCY}`);
});
