/**
 * `web_read` contract (SPEC S5, S8.1).
 *
 * The tool is driven over the real session-free orchestrator with a `FakePage`,
 * an injected DNS resolver and a fake byte fetcher. That makes the cases the
 * SPEC calls out — a client-rendered page with no text, a redirect into a
 * private range, a document that moves, the offset window, the PDF ladder and
 * the per-call budget — deterministic and socketless.
 *
 * Requirement ids in the test names are the contract: a failure here is a
 * contract change, not a fixture that needs updating.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  READINESS_PROBE,
  READINESS_SOFT_DEADLINE_MS,
  READINESS_TEXT_FLOOR,
  isDocumentReady,
} from "../../src/cdp/readiness.ts";
import type { FetchBytesOptions } from "../../src/cdp/types.ts";
import {
  READ_MAX_CHARS_CEILING,
  renderReadableDocument,
  type ReadableDocument,
} from "../../src/extract/read.ts";
import type { ResolveHost } from "../../src/runtime/ssrf.ts";
import { createWebReadTool } from "../../src/tools/web_read.ts";
import type { WebReadFailure, WebReadResult, WebReadSuccess } from "../../src/tools/web_read.ts";
import type { EvaluateHandler } from "../helpers/fake-cdp.ts";
import { FakePage } from "../helpers/fake-cdp.ts";
import {
  createReadHarness,
  type ReadHarness,
  type ReadHarnessOptions,
} from "../helpers/read-harness.ts";

const PUBLIC = "93.184.216.34";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pdf");

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

function resolverFor(map: Readonly<Record<string, readonly string[]>> = {}): ResolveHost {
  return async (host) => map[host] ?? [PUBLIC];
}

function handlers(entries: Array<[string, EvaluateHandler]>): ReadonlyMap<string, EvaluateHandler> {
  return new Map(entries);
}

function documentOf(text: string, title = "Test page"): ReadableDocument {
  return { title, blocks: [{ kind: "paragraph", inlines: [{ kind: "text", text }] }] };
}

function pageHandlers(
  options: {
    probe?: EvaluateHandler;
    extract?: EvaluateHandler;
    contentType?: EvaluateHandler;
  } = {},
): ReadonlyMap<string, EvaluateHandler> {
  return handlers([
    ["document.contentType", options.contentType ?? (() => "text/html")],
    [
      READINESS_PROBE,
      options.probe ?? (() => ({ readyState: "complete", textChars: 250 })),
    ],
    [
      "extractReadableDocument",
      options.extract ?? (() => documentOf("A readable article body. ".repeat(20))),
    ],
  ]);
}

function setup(options: {
  page?: FakePage;
  resolve?: ResolveHost;
  configure?: ReadHarnessOptions["configure"];
  fetchBytes?: ReadHarnessOptions["fetchBytes"];
} = {}): { harness: ReadHarness; run: (params: { url: string; offset?: number; maxChars?: number }) => Promise<WebReadResult> } {
  const harness = createReadHarness({
    ...(options.configure === undefined ? {} : { configure: options.configure }),
    ...(options.fetchBytes === undefined ? {} : { fetchBytes: options.fetchBytes }),
    pages: options.page === undefined ? undefined : new Map([["read", options.page]]),
  });
  const tool = createWebReadTool(() => harness.deps, {
    resolve: options.resolve ?? resolverFor(),
  });
  return {
    harness,
    run: (params) => tool.execute("read-test", params, undefined, undefined),
  };
}

function asFailure(result: WebReadResult): WebReadFailure {
  assert.ok("isError" in result && result.isError, `expected a failure, got ${JSON.stringify(result.details)}`);
  return result;
}

function asSuccess(result: WebReadResult): WebReadSuccess {
  assert.ok(!("isError" in result), `expected success, got ${JSON.stringify(result.details)}`);
  return result;
}

function textOf(result: WebReadResult): string {
  return result.content.map((block) => block.text).join("");
}

// ---------------------------------------------------------------------------
// S5.1 readiness, S5.2 thin document
// ---------------------------------------------------------------------------

test("S5.1 the readiness bar is interactive+text floor or complete", () => {
  assert.equal(isDocumentReady({ readyState: "loading", textChars: 500 }), false);
  assert.equal(isDocumentReady({ readyState: "interactive", textChars: READINESS_TEXT_FLOOR - 1 }), false);
  assert.equal(isDocumentReady({ readyState: "interactive", textChars: READINESS_TEXT_FLOOR }), true);
  assert.equal(isDocumentReady({ readyState: "complete", textChars: 0 }), true, "complete wins over the floor");
});

test("S5.2 a complete page with no text is E_EMPTY_PAGE with an artifact, never E_PARSE", async () => {
  const page = new FakePage({ url: "https://example.test/app" });
  page.setEvaluateHandlers(
    pageHandlers({
      probe: () => ({ readyState: "complete", textChars: 0 }),
      extract: () => ({ title: "App shell", blocks: [] }),
    }),
  );
  const { harness, run } = setup({ page });

  const failure = asFailure(await run({ url: "https://example.test/app" }));
  assert.equal(failure.details.code, "E_EMPTY_PAGE");
  assert.equal(failure.details.stage, "extract");
  assert.equal(failure.details.retryable, false);
  assert.equal(typeof failure.details.artifact, "string");
  assert.match(textOf(failure), /no readable text/);
  assert.match(textOf(failure), /E_EMPTY_PAGE/);
  assert.equal(harness.artifacts.length, 1);
  assert.equal(harness.artifacts[0]?.code, "E_EMPTY_PAGE");
});

test("S5.1 an interactive shell is polled until it paints text, without a fixed sleep", async () => {
  const page = new FakePage({ url: "https://example.test/app" });
  let probes = 0;
  page.setEvaluateHandlers(
    pageHandlers({
      probe: () => {
        probes += 1;
        return probes === 1
          ? { readyState: "interactive", textChars: 0 }
          : { readyState: "interactive", textChars: 250 };
      },
    }),
  );
  const { harness, run } = setup({ page });

  const success = asSuccess(await run({ url: "https://example.test/app" }));
  assert.equal(probes, 2);
  assert.ok(harness.clock.totalSleptMs() > 0);
  assert.ok(harness.clock.totalSleptMs() < READINESS_SOFT_DEADLINE_MS);
  assert.match(textOf(success), /readable article body/);
});

test("S5.1 a page that is already readable is never slept on", async () => {
  const page = new FakePage({ url: "https://example.test/ready" });
  page.setEvaluateHandlers(pageHandlers());
  const { harness, run } = setup({ page });

  asSuccess(await run({ url: "https://example.test/ready" }));
  assert.equal(harness.clock.totalSleptMs(), 0, "a ready document must not pay a settle sleep");
  assert.equal(harness.clock.durations().length, 0);
});

test("S5.1 the soft deadline stops the wait and extraction still reports real text", async () => {
  const page = new FakePage({ url: "https://example.test/slow" });
  let probes = 0;
  page.setEvaluateHandlers(
    pageHandlers({
      probe: () => {
        probes += 1;
        return { readyState: "interactive", textChars: 10 };
      },
    }),
  );
  const { harness, run } = setup({ page });

  const success = asSuccess(await run({ url: "https://example.test/slow" }));
  assert.ok(probes > 1);
  assert.ok(harness.clock.totalSleptMs() <= READINESS_SOFT_DEADLINE_MS);
  assert.match(textOf(success), /readable article body/);
});

// ---------------------------------------------------------------------------
// S5.3 SSRF: literal redirects and DNS answers
// ---------------------------------------------------------------------------

test("S5.3 a redirect to a private literal is E_BLOCKED_URL after navigation", async () => {
  const page = new FakePage({ url: "https://example.test/start" });
  page.setEvaluateHandlers(pageHandlers());
  page.setNavigateHandler(() => {
    page.setUrl("http://127.0.0.1:8080/admin");
  });
  let extracts = 0;
  page.setEvaluateHandlers(
    pageHandlers({
      extract: () => {
        extracts += 1;
        return documentOf("should never be read");
      },
    }),
  );
  const { harness, run } = setup({ page });

  const failure = asFailure(await run({ url: "https://example.test/start" }));
  assert.equal(failure.details.code, "E_BLOCKED_URL");
  assert.equal(failure.details.stage, "read");
  assert.equal(typeof failure.details.artifact, "string");
  assert.equal(extracts, 0, "a blocked landing must not be extracted");
  assert.equal(harness.artifacts[0]?.code, "E_BLOCKED_URL");
});

test("S5.3 a redirect to a hostname resolving privately is blocked, and DNS is injected", async () => {
  const page = new FakePage({ url: "https://example.test/start" });
  page.setEvaluateHandlers(pageHandlers());
  page.setNavigateHandler(() => {
    page.setUrl("https://internal.example.test/secret");
  });
  const calls: string[] = [];
  const resolve: ResolveHost = async (host) => {
    calls.push(host);
    return host === "internal.example.test" ? ["192.168.0.10"] : [PUBLIC];
  };
  const { run } = setup({ page, resolve });

  const failure = asFailure(await run({ url: "https://example.test/start" }));
  assert.equal(failure.details.code, "E_BLOCKED_URL");
  assert.match(failure.details.message ?? "", /resolves to a non-public address/);
  assert.deepEqual(calls, ["example.test", "internal.example.test"]);
});

test("S5.3 the document is re-guarded after readiness, so a self-navigation is checked", async () => {
  const page = new FakePage({ url: "https://example.test/app" });
  let probes = 0;
  page.setEvaluateHandlers(
    pageHandlers({
      probe: () => {
        probes += 1;
        if (probes === 2) page.setUrl("http://10.0.0.5/internal");
        return { readyState: "interactive", textChars: 0 };
      },
    }),
  );
  const { run } = setup({ page });

  const failure = asFailure(await run({ url: "https://example.test/app" }));
  assert.equal(failure.details.code, "E_BLOCKED_URL");
});

// ---------------------------------------------------------------------------
// S5.4 stability
// ---------------------------------------------------------------------------

test("S5.4 a document that moves during extraction is E_NAVIGATION_MISMATCH", async () => {
  const page = new FakePage({ url: "https://example.test/start" });
  page.setEvaluateHandlers(
    pageHandlers({
      extract: () => {
        page.setUrl("https://other.example.test/moved");
        return documentOf("the wrong document");
      },
    }),
  );
  const { harness, run } = setup({ page });

  const failure = asFailure(await run({ url: "https://example.test/start" }));
  assert.equal(failure.details.code, "E_NAVIGATION_MISMATCH");
  assert.equal(failure.details.retryable, true);
  assert.equal(typeof failure.details.artifact, "string");
  assert.equal(harness.artifacts[0]?.code, "E_NAVIGATION_MISMATCH");
});

// ---------------------------------------------------------------------------
// S5.5 paging
// ---------------------------------------------------------------------------

test("S5.5 concatenating the returned windows reproduces the document exactly", async () => {
  const body = "paragraph with spaces ".repeat(300).trim();
  const page = new FakePage({ url: "https://example.test/long" });
  page.setEvaluateHandlers(pageHandlers({ extract: () => documentOf(body) }));
  const { run } = setup({ page });

  const whole = asSuccess(await run({ url: "https://example.test/long", maxChars: READ_MAX_CHARS_CEILING }));
  assert.equal(whole.details.truncated, false);
  const fullText = textOf(whole);

  for (const maxChars of [17, 50, 333, 1000, 6000]) {
    const chunks: string[] = [];
    let offset = 0;
    let consumed = 0;
    // The renderer may back off a few chars per window, so the bound is the
    // document length, not `length / maxChars`.
    for (let guard = 0; guard < fullText.length + 10; guard += 1) {
      const pageResult = asSuccess(
        await run({ url: "https://example.test/long", offset, maxChars }),
      );
      assert.ok(pageResult.details.chars <= maxChars);
      assert.equal(pageResult.details.totalChars, fullText.length);
      chunks.push(textOf(pageResult));
      consumed += pageResult.details.chars;
      if (!pageResult.details.truncated) break;
      const next = pageResult.details.nextOffset;
      assert.equal(typeof next, "number");
      assert.ok((next as number) > offset, `nextOffset must move forward at maxChars=${maxChars}`);
      offset = next as number;
    }
    assert.equal(consumed, fullText.length, `continuation did not terminate at maxChars=${maxChars}`);
    assert.equal(chunks.join(""), fullText, `windows do not tile at maxChars=${maxChars}`);
  }
});

test("S5.5 a one-character window still advances and tiles exactly", async () => {
  const page = new FakePage({ url: "https://example.test/tiny" });
  page.setEvaluateHandlers(pageHandlers({ extract: () => documentOf("tiny body text") }));
  const { run } = setup({ page });

  const whole = asSuccess(await run({ url: "https://example.test/tiny", maxChars: 200 }));
  const fullText = textOf(whole);
  const chunks: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < fullText.length + 10; guard += 1) {
    const window = asSuccess(
      await run({ url: "https://example.test/tiny", offset, maxChars: 1 }),
    );
    assert.equal(window.details.chars, 1);
    chunks.push(textOf(window));
    if (!window.details.truncated) break;
    offset = window.details.nextOffset as number;
  }
  assert.equal(chunks.join(""), fullText);
});

test("S5.5 an offset past the end is E_OFFSET_RANGE naming the valid range", async () => {
  const page = new FakePage({ url: "https://example.test/short" });
  page.setEvaluateHandlers(pageHandlers({ extract: () => documentOf("only a short body") }));
  const { run } = setup({ page });

  const first = asSuccess(await run({ url: "https://example.test/short" }));
  const total = first.details.totalChars;
  assert.ok(total > 0);

  const past = asFailure(
    await run({ url: "https://example.test/short", offset: total }),
  );
  assert.equal(past.details.code, "E_OFFSET_RANGE");
  assert.equal(past.details.stage, "render");
  assert.match(past.details.message ?? "", new RegExp(`valid range 0\\.\\.${Math.max(0, total - 1)}`));

  const beyond = asFailure(
    await run({ url: "https://example.test/short", offset: total + 10_000 }),
  );
  assert.equal(beyond.details.code, "E_OFFSET_RANGE");

  const last = asSuccess(await run({ url: "https://example.test/short", offset: total - 1, maxChars: 1 }));
  assert.equal(last.details.chars, 1);
  assert.equal(last.details.truncated, false);
});

test("S5.5 a requested window above the ceiling is clamped and reported", async () => {
  const page = new FakePage({ url: "https://example.test/long" });
  page.setEvaluateHandlers(pageHandlers({ extract: () => documentOf("word ".repeat(9000).trim()) }));
  const { run } = setup({ page });

  const result = asSuccess(
    await run({ url: "https://example.test/long", maxChars: 999_999 }),
  );
  assert.equal(result.details.clamped, true);
  assert.equal(result.details.maxChars, READ_MAX_CHARS_CEILING);
  assert.ok(result.details.chars <= READ_MAX_CHARS_CEILING);
  assert.equal(result.details.truncated, true);

  const render = renderReadableDocument(documentOf("word ".repeat(9000).trim()), {
    maxChars: 999_999,
  });
  assert.equal(render.chars, result.details.chars, "the tool reports the renderer's own window");
});

// ---------------------------------------------------------------------------
// S5.6 PDF ladder
// ---------------------------------------------------------------------------

test("S5.6 PDF text comes from the in-tree rung and the slot is released", async () => {
  const page = new FakePage({ url: "https://example.test/doc.pdf" });
  page.setEvaluateHandlers(
    pageHandlers({ contentType: () => "application/pdf" }),
  );
  const fetchOptions: FetchBytesOptions[] = [];
  const { harness, run } = setup({
    page,
    fetchBytes: async (url: string, options?: FetchBytesOptions) => {
      assert.equal(url, "https://example.test/doc.pdf");
      if (options !== undefined) fetchOptions.push(options);
      return {
        url: "https://example.test/doc.pdf",
        status: 200,
        contentType: "application/pdf",
        bytes: fixture("basic.pdf"),
      };
    },
  });

  const success = asSuccess(await run({ url: "https://example.test/doc.pdf" }));
  assert.equal(success.details.pdf?.extractor, "in-tree");
  assert.equal(success.details.pdf?.pageCount, 2);
  assert.match(textOf(success), /--- p\.1 ---[\s\S]*Hello PDF world/);
  assert.equal(fetchOptions[0]?.maxBytes, harness.config.read.pdfMaxBytes);
  assert.deepEqual(harness.released, ["read"]);
  assert.equal(harness.pages.has("read"), false, "the PDF slot must not be reused");
});

test("S5.6 a scanned PDF is E_PDF_SCANNED with an artifact and a released slot", async () => {
  const page = new FakePage({ url: "https://example.test/scan.pdf" });
  page.setEvaluateHandlers(
    pageHandlers({ contentType: () => "application/pdf" }),
  );
  const { harness, run } = setup({
    page,
    fetchBytes: async () => ({
      url: "https://example.test/scan.pdf",
      status: 200,
      contentType: "application/pdf",
      bytes: fixture("scanned.pdf"),
    }),
  });

  const failure = asFailure(await run({ url: "https://example.test/scan.pdf" }));
  assert.equal(failure.details.code, "E_PDF_SCANNED");
  assert.equal(failure.details.stage, "extract");
  assert.equal(typeof failure.details.artifact, "string");
  assert.deepEqual(harness.released, ["read"]);
  assert.equal(harness.artifacts[0]?.code, "E_PDF_SCANNED");
});

test("S5.6 a PDF that redirects to a private host is E_BLOCKED_URL", async () => {
  const page = new FakePage({ url: "https://example.test/doc.pdf" });
  page.setEvaluateHandlers(
    pageHandlers({ contentType: () => "application/pdf" }),
  );
  const { harness, run } = setup({
    page,
    fetchBytes: async () => ({
      url: "http://10.0.0.5/secret.pdf",
      status: 200,
      contentType: "application/pdf",
      bytes: fixture("basic.pdf"),
    }),
  });

  const failure = asFailure(await run({ url: "https://example.test/doc.pdf" }));
  assert.equal(failure.details.code, "E_BLOCKED_URL");
  assert.equal(typeof failure.details.artifact, "string");
  assert.deepEqual(harness.released, ["read"]);
});

// ---------------------------------------------------------------------------
// S8.1 one deadline per call
// ---------------------------------------------------------------------------

test("S8.1 the read budget is one deadline and exhaustion is E_TIMEOUT with an artifact", async () => {
  const page = new FakePage({ url: "https://example.test/slow" });
  page.setEvaluateHandlers(
    pageHandlers({
      probe: () => ({ readyState: "interactive", textChars: 0 }),
    }),
  );
  const { harness, run } = setup({
    page,
    configure: (config: ReadHarness["config"]) => {
      config.read.budgetMs = 1000;
    },
  });

  const failure = asFailure(await run({ url: "https://example.test/slow" }));
  assert.equal(failure.details.code, "E_TIMEOUT");
  assert.equal(failure.details.stage, "budget");
  assert.equal(failure.details.retryable, true);
  assert.equal(typeof failure.details.artifact, "string");
  assert.ok(harness.clock.totalSleptMs() <= 1000, "readiness must be clamped by the call budget");
  assert.equal(harness.artifacts[0]?.code, "E_TIMEOUT");
});

// ---------------------------------------------------------------------------
// S5.7 read slots
// ---------------------------------------------------------------------------

test("S5.7 two concurrent reads with pool 2 take different slots and different tabs", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });

  const firstPage = new FakePage({ url: "https://example.test/first" });
  firstPage.setEvaluateHandlers(
    pageHandlers({
      probe: async () => {
        firstEntered();
        await firstGate;
        return { readyState: "complete", textChars: 250 };
      },
      extract: () => documentOf("first document text ".repeat(20)),
    }),
  );
  const secondPage = new FakePage({ url: "https://example.test/second" });
  secondPage.setEvaluateHandlers(
    pageHandlers({ extract: () => documentOf("second document text ".repeat(20)) }),
  );

  const harness = createReadHarness({
    configure: (config) => {
      config.read.pool = 2;
    },
    pages: new Map([
      ["read", firstPage],
      ["read#2", secondPage],
    ]),
  });
  const tool = createWebReadTool(() => harness.deps, { resolve: resolverFor() });

  const first = tool.execute("first", { url: "https://example.test/first" }, undefined, undefined);
  await entered;
  const second = await tool.execute("second", { url: "https://example.test/second" }, undefined, undefined);
  asSuccess(second);
  releaseFirst();
  asSuccess(await first);

  assert.deepEqual([...harness.acquired].sort(), ["read", "read#2"]);
  assert.equal(firstPage.lastNavigation(), "https://example.test/first");
  assert.equal(secondPage.lastNavigation(), "https://example.test/second");
  assert.notEqual(firstPage, secondPage);
});
