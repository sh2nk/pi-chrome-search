/**
 * SPEC S4.2: the support matrix is literal, and an argument is honoured or
 * reported — never silently dropped (S7.1).
 *
 * These tests drive the real `web_search` orchestrator over stub adapters and
 * assert what each engine was actually asked for, plus what the caller is told
 * when an engine cannot honour the request (DuckDuckGo has no pagination).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SUPPORT_MATRIX } from "../../src/engines/types.ts";
import type { EngineId, RawSerp } from "../../src/engines/types.ts";
import { createWebSearchTool, type WebSearchResult } from "../../src/tools/web_search.ts";
import { createEngineStub, createHarness, resultText } from "../helpers/search-harness.ts";

const OPERATOR_QUERY = 'site:example.com "exact phrase" -ad OR filetype:pdf after:2025-01-01';

function toolFor(harness: ReturnType<typeof createHarness>) {
  return createWebSearchTool(() => harness.deps);
}

async function search(
  harness: ReturnType<typeof createHarness>,
  input: Parameters<ReturnType<typeof createWebSearchTool>["execute"]>[1],
): Promise<WebSearchResult> {
  return await toolFor(harness).execute("call-1", input, undefined, undefined);
}

test("S4.2: the matrix is exactly the SPEC table", () => {
  assert.deepEqual(SUPPORT_MATRIX.n, { google: "yes", duckduckgo: "yes", yandex: "yes" });
  assert.deepEqual(SUPPORT_MATRIX.page, { google: "yes", duckduckgo: "flag", yandex: "yes" });
  assert.deepEqual(SUPPORT_MATRIX.summary, { google: "yes", duckduckgo: "yes", yandex: "yes" });
});

test("S3.6/S4.2: q reaches every engine verbatim, operators included", async () => {
  for (const id of ["google", "duckduckgo", "yandex"] as const) {
    const engine = createEngineStub(id);
    const harness = createHarness({ engines: [engine] });
    const result = await search(harness, { q: OPERATOR_QUERY, engines: id, summary: false });
    assert.equal("isError" in result, false, `${id} should search`);
    assert.equal(engine.queries.length, 1, `${id} was asked once`);
    assert.equal(engine.queries[0]?.text, OPERATOR_QUERY, `${id} must not rewrite q`);
  }
});

test("S4.2: n is honoured by every engine", async () => {
  for (const id of ["google", "duckduckgo", "yandex"] as const) {
    const engine = createEngineStub(id);
    const harness = createHarness({ engines: [engine] });
    const result = await search(harness, { q: "matrix", n: 2, engines: id, summary: false });
    assert.equal("isError" in result, false);
    assert.equal(engine.queries[0]?.n, 2, `${id} must receive n=2`);
    if (!("isError" in result)) assert.equal(result.details.results, 2);
  }
});

test("S4.2: summary is honoured by every engine", async () => {
  for (const id of ["google", "duckduckgo", "yandex"] as const) {
    const engine = createEngineStub(id);
    const harness = createHarness({ engines: [engine] });
    await search(harness, { q: "matrix", engines: id, summary: true });
    assert.equal(engine.queries[0]?.summary, true, `${id} must be asked for a summary`);

    const off = createEngineStub(id);
    const offHarness = createHarness({ engines: [off] });
    await search(offHarness, { q: "matrix", engines: id, summary: false });
    assert.equal(off.queries[0]?.summary, false, `${id} must skip a summary`);
  }
});

test("S4.2: page is honoured by Google and Yandex", async () => {
  for (const id of ["google", "yandex"] as const) {
    const engine = createEngineStub(id);
    const harness = createHarness({ engines: [engine] });
    const result = await search(harness, { q: "matrix", page: 2, engines: id, summary: false });
    assert.equal("isError" in result, false);
    assert.equal(engine.queries[0]?.page, 2, `${id} must receive page=2`);
    if (!("isError" in result)) assert.equal(result.details.ignored, undefined);
  }
});

test("S4.2: DuckDuckGo serves page 1 and reports ignored.page", async () => {
  const engine = createEngineStub("duckduckgo");
  const harness = createHarness({ engines: [engine] });
  const result = await search(harness, { q: "matrix", page: 2, engines: "duckduckgo", summary: false });
  assert.equal("isError" in result, false);
  assert.equal(engine.queries[0]?.page, undefined, "DDG must not receive a page it cannot honour");
  if ("isError" in result) return;
  assert.deepEqual(result.details.ignored, { page: "duckduckgo" });
  assert.match(resultText(result), /ignored: page\(duckduckgo\)/, "the model sees the flag (S7.1)");
});

test("S4.2: page 1 is not a paging request, so nothing is flagged", async () => {
  const engine = createEngineStub("duckduckgo");
  const harness = createHarness({ engines: [engine] });
  const result = await search(harness, { q: "matrix", page: 1, engines: "duckduckgo", summary: false });
  assert.equal("isError" in result, false);
  if (!("isError" in result)) assert.equal(result.details.ignored, undefined);
});

test("S4.2/S7.1: a coverage set reports page as ignored only for DDG", async () => {
  const google = createEngineStub("google");
  const duckduckgo = createEngineStub("duckduckgo");
  const harness = createHarness({ engines: [google, duckduckgo] });
  const result = await search(harness, {
    q: "matrix",
    n: 4,
    page: 2,
    engines: ["google", "duckduckgo"],
    summary: false,
  });
  assert.equal("isError" in result, false);
  assert.equal(google.queries[0]?.page, 2);
  assert.equal(duckduckgo.queries[0]?.page, undefined);
  if (!("isError" in result)) assert.deepEqual(result.details.ignored, { page: "duckduckgo" });
});

test("S4.2: the JSON view carries the same ignored flag", async () => {
  const engine = createEngineStub("duckduckgo");
  const harness = createHarness({ engines: [engine] });
  const result = await search(harness, {
    q: "matrix",
    page: 2,
    engines: "duckduckgo",
    summary: false,
    format: "json",
  });
  assert.equal("isError" in result, false);
  const text = resultText(result);
  const parsed = JSON.parse(text) as { ignored?: Record<string, string> };
  assert.deepEqual(parsed.ignored, { page: "duckduckgo" });
});

test("S4.1: auto stops at the first engine that works", async () => {
  const google = createEngineStub("google");
  const duckduckgo = createEngineStub("duckduckgo");
  const harness = createHarness({ engines: [google, duckduckgo] });
  const result = await search(harness, { q: "matrix", engines: "auto", summary: false });
  assert.equal("isError" in result, false);
  assert.equal(google.queries.length, 1);
  assert.equal(duckduckgo.queries.length, 0, "auto is a fallback chain, not a merge");
  if (!("isError" in result)) assert.deepEqual(result.details.engines, ["google"]);
});

test("S4.1/S4.4: E_EMPTY inside a coverage set continues and reports perEngine=0", async () => {
  const google = createEngineStub("google");
  google.extractImpl = async (query): Promise<RawSerp> => ({
    engine: "google",
    query: query.text,
    results: [],
    pageCarried: false,
    timings: {},
  });
  const duckduckgo = createEngineStub("duckduckgo");
  const harness = createHarness({ engines: [google, duckduckgo] });
  const result = await search(harness, {
    q: "matrix",
    n: 2,
    engines: ["google", "duckduckgo"],
    summary: false,
  });
  assert.equal("isError" in result, false, "an empty first engine must not fail the coverage set");
  if ("isError" in result) return;
  assert.deepEqual(result.details.perEngine, { google: 0, duckduckgo: 1 });
  assert.deepEqual(result.details.failedEngines, { google: "E_EMPTY" });
  assert.equal(result.details.results, 1);
});

test("S4.5: the cache key covers every honoured argument, not format", async () => {
  const engine = createEngineStub("google");
  const harness = createHarness({
    engines: [engine],
    configure: (config) => {
      config.cache.serpTtlMs = 600_000;
    },
  });
  const tool = toolFor(harness);
  const base = { q: "matrix", n: 2, engines: "google" as const, summary: false };

  await tool.execute("c1", { ...base, page: 1 }, undefined, undefined);
  await tool.execute("c2", { ...base, page: 2 }, undefined, undefined);
  await tool.execute("c3", { ...base, page: 1, n: 3 }, undefined, undefined);
  await tool.execute("c4", { ...base, page: 1, summary: true }, undefined, undefined);
  assert.equal(engine.queries.length, 4, "n, page and summary must all key the cache");

  const hit = await tool.execute("c5", { ...base, page: 1, format: "json" }, undefined, undefined);
  assert.equal(engine.queries.length, 4, "format does not change the engine answer");
  assert.equal("isError" in hit, false);
  if (!("isError" in hit)) assert.equal(hit.details.cached, true);

  const cachedIds: EngineId[] = engine.queries.map(() => "google");
  assert.equal(cachedIds.length, 4);
});
