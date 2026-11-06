/**
 * P4-A unit tests: the `web_read` tool (SPEC §7.2, PLAN V4.1).
 *
 * Everything is offline: `FakePage` models navigation/evaluation, the connector
 * is a two-method stub, and the SSRF guard gets an injected resolver. The tests
 * pin the security order (blocked URL → no acquire, no navigate; redirect →
 * second guard before extraction), the caps/continuation contract, the failure
 * taxonomy and the audit log line.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";

import type { CdpConnector, CdpPage } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import {
  READ_MAX_CHARS_CEILING,
  type ReadableDocument,
} from "../../src/extract/read.ts";
import type { PageSubject, PageVerdict, Reflex } from "../../src/reflex/types.ts";
import { createCache } from "../../src/runtime/cache.ts";
import type { ResolveHost } from "../../src/runtime/ssrf.ts";
import type { ArtifactInput, Artifacts, Cache, Limiter, LimiterStats, Logger } from "../../src/runtime/types.ts";
import type { ToolDeps } from "../../src/tools/types.ts";
import {
  WEB_READ_DESCRIPTION,
  createWebReadTool,
  webReadSchema,
  type WebReadFailure,
  type WebReadInput,
  type WebReadResult,
  type WebReadSuccess,
} from "../../src/tools/web_read.ts";
import { pageLockFor } from "../../src/cdp/page-lock.ts";
import { fail } from "../../src/runtime/errors.ts";
import { FakeClock } from "../helpers/clock.ts";
import { FakePage } from "../helpers/fake-page.ts";

const PUBLIC_RESOLVER: ResolveHost = async (host) =>
  host === "internal.example.test" ? ["10.0.0.7"] : ["93.184.216.34"];

const DEFAULT_DOC: ReadableDocument = {
  title: "Example page",
  blocks: [
    {
      kind: "paragraph",
      inlines: [
        { kind: "text", text: "Hello read world. " },
        { kind: "link", text: "next", href: "https://example.test/next" },
      ],
    },
  ],
};

const LONG_TEXT = "alpha beta gamma delta ".repeat(1200);

function longDoc(): ReadableDocument {
  return {
    title: "Long page",
    blocks: [{ kind: "paragraph", inlines: [{ kind: "text", text: LONG_TEXT }] }],
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  page?: FakePage;
  item?: ReadableDocument;
  config?: (config: Config) => void;
  acquireError?: unknown;
  /** Replace the default artifact stub (which deliberately throws on save). */
  artifacts?: Artifacts;
  /** Pooled harness: a distinct page per `PageKey` (a real browser has one tab per slot). */
  pagesByKey?: Record<string, FakePage>;
  /** P12-A: stub for `CdpConnector.fetchBytes`. */
  fetchBytes?: CdpConnector["fetchBytes"];
}

interface Harness {
  tool: ReturnType<typeof createWebReadTool>;
  deps: ToolDeps;
  page: FakePage;
  rows: Record<string, unknown>[];
  pagesRequested: number;
  pageKeys: string[];
  releasedKeys: string[];
  artifactInputs: ArtifactInput[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const config = structuredClone(DEFAULT_CONFIG);
  options.config?.(config);

  const item = options.item ?? DEFAULT_DOC;
  const page = options.page ?? new FakePage({ url: "about:blank", evaluate: () => item });
  const clock = new FakeClock();

  const rows: Record<string, unknown>[] = [];
  const log: Logger = {
    async write(row: Record<string, unknown>): Promise<void> {
      rows.push(row);
    },
    path: () => "/dev/null",
  };

  const limiter: Limiter = {
    async acquire(): Promise<void> {},
    stats(engine): LimiterStats {
      return { engine, lastAt: null, today: 0, dailyCap: 100 };
    },
  };

  const artifactInputs: ArtifactInput[] = [];
  const artifacts: Artifacts =
    options.artifacts ??
    ({
      async save(input: ArtifactInput): Promise<string> {
        artifactInputs.push(input);
        throw new Error("web_read must not write artifacts in this lane");
      },
      async prune() {
        return { removed: 0, kept: 0, bytes: 0 };
      },
      async size() {
        return 0;
      },
      root: () => "/tmp/opencode/pi-chrome-search/artifacts",
    } satisfies Artifacts);

  const cache: Cache = createCache({ maxEntries: 10, clock });
  let pagesRequested = 0;
  const pageKeys: string[] = [];
  const releasedKeys: string[] = [];
  const cdp: CdpConnector = {
    async connect() {
      throw new Error("connect() is not used by web_read unit tests");
    },
    async acquirePage(key): Promise<CdpPage> {
      pagesRequested += 1;
      pageKeys.push(key);
      if (options.acquireError !== undefined) throw options.acquireError;
      return options.pagesByKey?.[key] ?? page;
    },
    async releaseAll() {},
    isConnected: () => true,
    endpoint: () => null,
    ...(options.fetchBytes === undefined ? {} : { fetchBytes: options.fetchBytes }),
    async releasePage(key) {
      releasedKeys.push(key);
    },
  };

  const deps: ToolDeps = {
    config,
    engines: {
      get() {
        throw new Error("engine registry is not used by web_read");
      },
      has: () => false,
      enabled: () => [],
      select: () => [],
    },
    cdp,
    cache,
    limiter,
    artifacts,
    log,
    clock,
  };

  return {
    tool: createWebReadTool(() => deps, { resolve: PUBLIC_RESOLVER }),
    deps,
    page,
    rows,
    get pagesRequested(): number {
      return pagesRequested;
    },
    pageKeys,
    releasedKeys,
    artifactInputs,
  };
}

async function run(
  harness: Harness,
  input: unknown,
  signal?: AbortSignal,
): Promise<WebReadResult> {
  return await harness.tool.execute("call-1", input as WebReadInput, signal, undefined);
}

function isFailure(result: WebReadResult): result is WebReadFailure {
  return "isError" in result && result.isError === true;
}

function success(result: WebReadResult): WebReadSuccess {
  assert.equal(isFailure(result), false, `expected success, got ${JSON.stringify(result.details)}`);
  return result as WebReadSuccess;
}

function failure(result: WebReadResult): WebReadFailure {
  assert.equal(isFailure(result), true, "expected a rendered failure");
  return result as WebReadFailure;
}

function textOf(result: WebReadResult): string {
  return result.content.map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// Schema and registration
// ---------------------------------------------------------------------------

test("schema accepts every documented shape", () => {
  const valid: unknown[] = [
    { url: "https://example.test/page" },
    { url: "https://example.test/page", offset: 0, maxChars: 1, format: "md" },
    { url: "https://example.test/page", offset: 6000, maxChars: 20000, format: "text" },
    { url: "http://93.184.216.34/" },
  ];
  for (const value of valid) {
    assert.equal(Value.Check(webReadSchema, value), true, JSON.stringify(value));
  }
});

test("schema rejects invalid shapes", () => {
  const invalid: unknown[] = [
    {},
    { url: "" },
    { url: 42 },
    { url: "https://example.test/", offset: -1 },
    { url: "https://example.test/", offset: 1.5 },
    { url: "https://example.test/", maxChars: 0 },
    { url: "https://example.test/", maxChars: 2.5 },
    { url: "https://example.test/", format: "html" },
  ];
  for (const value of invalid) {
    assert.equal(Value.Check(webReadSchema, value), false, JSON.stringify(value));
  }
});

test("the tool is deferred, read-only and stays inside the description budget", () => {
  const harness = makeHarness();
  assert.equal(harness.tool.name, "web_read");
  assert.equal(harness.tool.exposure, "deferred");
  assert.deepEqual(harness.tool.annotations, {
    readOnlyHint: true,
    openWorldHint: true,
    idempotentHint: true,
  });
  assert.ok(WEB_READ_DESCRIPTION.length > 0);
  assert.ok(WEB_READ_DESCRIPTION.length <= 350, `${WEB_READ_DESCRIPTION.length} chars`);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("reads a public page and returns Markdown plus details", async () => {
  const harness = makeHarness();
  const result = success(await run(harness, { url: "https://example.test/docs/page" }));

  assert.equal(harness.pagesRequested, 1);
  assert.deepEqual(harness.pageKeys, ["read"], "a read must use its own work tab, not an engine tab");
  assert.deepEqual(harness.page.navigations(), ["https://example.test/docs/page"]);
  assert.equal(harness.page.callCount("html"), 0, "raw HTML must never be fetched");
  // 1: document.contentType (the PDF branch probe), 2: the readability pass.
  assert.equal(harness.page.callCount("evaluate"), 2);

  const text = textOf(result);
  assert.match(text, /^# Example page\n/);
  assert.ok(text.includes("Hello read world."));
  assert.ok(text.includes("[next](https://example.test/next)"));
  assert.ok(!/<[a-z]+[\s>]/i.test(text), "no HTML in the output");

  assert.equal(result.details.url, "https://example.test/docs/page");
  assert.equal(result.details.finalUrl, "https://example.test/docs/page");
  assert.equal(result.details.title, "Example page");
  assert.equal(result.details.format, "md");
  assert.equal(result.details.chars, text.length);
  assert.equal(result.details.truncated, false);
  assert.equal(result.details.nextOffset, undefined);
  assert.equal(result.details.byline, undefined);
  assert.equal(result.details.publishedAt, undefined);
});

test("byline and publishedAt are surfaced when the page has them", async () => {
  const harness = makeHarness({
    item: {
      ...DEFAULT_DOC,
      byline: "The Rust Release Team",
      publishedAt: "Sept. 5, 2024",
    },
  });
  const result = success(await run(harness, { url: "https://example.test/blog" }));
  assert.equal(result.details.byline, "The Rust Release Team");
  assert.equal(result.details.publishedAt, "Sept. 5, 2024");
});

// ---------------------------------------------------------------------------
// SSRF: before navigation
// ---------------------------------------------------------------------------

test("private, local and non-http URLs are refused before any side effect", async () => {
  const urls = [
    "http://127.0.0.1/admin",
    "http://10.1.2.3/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "file:///etc/passwd",
    "data:text/html,<h1>hi</h1>",
    "javascript:alert(1)",
    "https://user:secret-token@example.test/",
    "https://internal.example.test/",
  ];

  for (const url of urls) {
    const harness = makeHarness();
    const result = failure(await run(harness, { url }));
    assert.equal(result.details.code, "E_BLOCKED_URL", url);
    assert.equal(result.details.stage, "read", url);
    assert.equal(harness.pagesRequested, 0, `${url}: a tab must not be acquired`);
    assert.equal(harness.page.callCount("navigate"), 0, `${url}: navigation must not happen`);
    assert.equal(harness.page.callCount("evaluate"), 0, `${url}: the page must not be read`);
    assert.ok(!textOf(result).includes("secret-token"), "credentials must not leak into the result");
  }
});

// ---------------------------------------------------------------------------
// SSRF: redirect re-check
// ---------------------------------------------------------------------------

test("a redirect to a private address is blocked after navigation and before extraction", async () => {
  const page = new FakePage({ url: "about:blank", evaluate: () => DEFAULT_DOC });
  page.setNavigateHandler((_url, p) => {
    p.setUrl("http://192.168.1.10/private");
  });
  const harness = makeHarness({ page });

  const result = failure(await run(harness, { url: "https://example.test/start" }));
  assert.equal(result.details.code, "E_BLOCKED_URL");
  assert.equal(result.details.stage, "read");
  assert.equal(harness.page.callCount("navigate"), 1);
  assert.equal(harness.page.callCount("evaluate"), 0, "extraction must not run on a blocked landing page");
  assert.ok(!textOf(result).includes("Hello read world"));
  assert.match(textOf(result), /redirect/i);
});

test("a redirect to a hostname resolving private is blocked too", async () => {
  const page = new FakePage({ url: "about:blank", evaluate: () => DEFAULT_DOC });
  page.setNavigateHandler((_url, p) => {
    p.setUrl("https://internal.example.test/private");
  });
  const harness = makeHarness({ page });

  const result = failure(await run(harness, { url: "https://example.test/start" }));
  assert.equal(result.details.code, "E_BLOCKED_URL");
  assert.equal(result.details.stage, "read");
  assert.equal(harness.page.callCount("evaluate"), 0);
});

// ---------------------------------------------------------------------------
// Caps, offset and format
// ---------------------------------------------------------------------------

test("maxChars and offset walk a long page to the end", async () => {
  const harness = makeHarness({ item: longDoc() });
  // `renderReadableDocument` itself caps at the 20000 ceiling, so the whole
  // document is assembled from the known title + paragraph instead.
  const expected = `# Long page\n\n${LONG_TEXT.trimEnd()}`;

  const chunks: string[] = [];
  let offset: number | undefined = 0;
  let guard = 0;
  let truncated = true;

  while (truncated) {
    const result = success(
      await run(harness, { url: "https://example.test/long", offset, maxChars: 500 }),
    );
    assert.ok(result.details.chars <= 500, `window is ${result.details.chars} chars`);
    chunks.push(textOf(result));
    truncated = result.details.truncated;
    if (truncated) {
      assert.equal(typeof result.details.nextOffset, "number");
      assert.ok((result.details.nextOffset ?? 0) > (offset ?? 0), "nextOffset must move forward");
      offset = result.details.nextOffset;
    }
    guard += 1;
    assert.ok(guard < 100, "continuation did not terminate");
  }

  assert.equal(chunks.join(""), expected);
});

test("maxChars above the ceiling is clamped, not rejected", async () => {
  const harness = makeHarness({ item: longDoc() });
  const result = success(await run(harness, { url: "https://example.test/long", maxChars: 999_999 }));
  assert.ok(result.details.chars <= READ_MAX_CHARS_CEILING);
  assert.ok(result.details.chars > READ_MAX_CHARS_CEILING - 250, "the window must fill the ceiling");
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.nextOffset, result.details.chars);
  assert.ok(textOf(result).length <= READ_MAX_CHARS_CEILING);
});

test("config.read caps are honoured below the hard ceiling", async () => {
  const harness = makeHarness({
    item: longDoc(),
    config: (config) => {
      config.read.defaultMaxChars = 200;
      config.read.maxCharsCeiling = 300;
    },
  });

  const byDefault = success(await run(harness, { url: "https://example.test/long" }));
  assert.ok(byDefault.details.chars <= 200);
  assert.ok(byDefault.details.chars >= 180);
  assert.equal(byDefault.details.truncated, true);

  const clamped = success(await run(harness, { url: "https://example.test/long", maxChars: 5000 }));
  assert.ok(clamped.details.chars <= 300);
  assert.ok(clamped.details.chars >= 250);
  assert.equal(clamped.details.truncated, true);
});

test("format text omits Markdown syntax", async () => {
  const harness = makeHarness();
  const result = success(await run(harness, { url: "https://example.test/page", format: "text" }));
  const text = textOf(result);
  assert.equal(result.details.format, "text");
  assert.match(text, /^Example page\n/);
  assert.ok(!text.includes("]("));
  assert.ok(!text.startsWith("# "));
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("invalid arguments are rendered without touching the browser", async () => {
  const cases: unknown[] = [
    null,
    "https://example.test/",
    {},
    { url: "" },
    { url: "   " },
    { url: 42 },
    { url: "https://example.test/", offset: -1 },
    { url: "https://example.test/", offset: 1.5 },
    { url: "https://example.test/", maxChars: 0 },
    { url: "https://example.test/", maxChars: "100" },
    { url: "https://example.test/", format: "html" },
  ];

  for (const input of cases) {
    const harness = makeHarness();
    const result = failure(await run(harness, input));
    assert.equal(result.details.code, "E_CONFIG", JSON.stringify(input));
    assert.equal(result.details.stage, "config");
    assert.equal(harness.pagesRequested, 0);
    assert.equal(harness.page.callCount("navigate"), 0);
    assert.equal(harness.page.callCount("evaluate"), 0);
  }
});

test("an aborted call is cancelled before navigation", async () => {
  const harness = makeHarness();
  const controller = new AbortController();
  controller.abort();
  const result = failure(await run(harness, { url: "https://example.test/page" }, controller.signal));
  assert.equal(result.details.code, "E_CANCELLED");
  assert.equal(harness.page.callCount("navigate"), 0);
});

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

test("timeouts, in-page errors and empty pages keep the web_search taxonomy", async () => {
  const timeoutPage = new FakePage({
    url: "about:blank",
    evaluate: () => {
      throw new DOMException("slow", "TimeoutError");
    },
  });
  const timedOut = failure(
    await run(makeHarness({ page: timeoutPage }), { url: "https://example.test/page" }),
  );
  assert.equal(timedOut.details.code, "E_TIMEOUT");
  assert.equal(timedOut.details.stage, "extract");
  assert.equal(timedOut.details.retryable, true);

  const brokenPage = new FakePage({
    url: "about:blank",
    evaluate: () => {
      throw new Error("page exploded");
    },
  });
  const broken = failure(await run(makeHarness({ page: brokenPage }), { url: "https://example.test/page" }));
  assert.equal(broken.details.code, "E_PARSE");
  assert.equal(broken.details.stage, "extract");

  const nullPage = new FakePage({ url: "about:blank", evaluate: () => null });
  const nullResult = failure(await run(makeHarness({ page: nullPage }), { url: "https://example.test/page" }));
  assert.equal(nullResult.details.code, "E_PARSE");
  assert.equal(nullResult.details.stage, "extract");

  const emptyPage = new FakePage({ url: "about:blank", evaluate: () => ({ title: "Empty", blocks: [] }) });
  const empty = failure(await run(makeHarness({ page: emptyPage }), { url: "https://example.test/page" }));
  assert.equal(empty.details.code, "E_PARSE");
  assert.equal(empty.details.stage, "extract");
});

test("a navigation or connection failure is a CDP failure with a stage", async () => {
  const navPage = new FakePage({ url: "about:blank", evaluate: () => DEFAULT_DOC });
  navPage.setNavigateHandler(() => {
    throw new Error("socket dropped");
  });
  const navFailure = failure(
    await run(makeHarness({ page: navPage }), { url: "https://example.test/page" }),
  );
  assert.equal(navFailure.details.code, "E_CDP_DISCONNECTED");
  assert.equal(navFailure.details.stage, "navigate");

  const acquireFailure = failure(
    await run(makeHarness({ acquireError: new Error("no target") }), { url: "https://example.test/page" }),
  );
  assert.equal(acquireFailure.details.code, "E_CDP_DISCONNECTED");
  assert.equal(acquireFailure.details.stage, "connect");
});

test("a hostile extraction payload cannot smuggle unknown block kinds", async () => {
  const page = new FakePage({
    url: "about:blank",
    evaluate: () => ({
      title: "Hostile",
      blocks: [
        { kind: "script", code: "alert(1)" },
        { kind: "paragraph", inlines: [{ kind: "text", text: "safe text" }] },
        { kind: "table", rows: [["H"], [42, null]] },
      ],
    }),
  });
  const result = success(await run(makeHarness({ page }), { url: "https://example.test/page" }));
  const text = textOf(result);
  assert.ok(text.includes("safe text"));
  assert.ok(!text.includes("alert(1)"));
  assert.match(text, /^\| H \|$/m);
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

test("the read log records host and path but never the query string", async () => {
  const harness = makeHarness();
  const result = success(
    await run(harness, { url: "https://example.test/private/page?token=SECRET&q=personal" }),
  );

  assert.equal(harness.rows.length, 1);
  const row = harness.rows[0] as Record<string, unknown>;
  assert.equal(row.kind, "read");
  assert.equal(row.domain, "example.test/private/page");
  assert.equal(row.chars, result.details.chars);
  assert.equal(row.truncated, false);
  assert.ok(!JSON.stringify(row).includes("SECRET"));
  assert.ok(!JSON.stringify(row).includes("?"));
});

test("the log uses the landing page after a public redirect", async () => {
  const page = new FakePage({ url: "about:blank", evaluate: () => DEFAULT_DOC });
  page.setNavigateHandler((_url, p) => {
    p.setUrl("https://example.test/final?session=xyz");
  });
  const harness = makeHarness({ page });
  const result = success(await run(harness, { url: "https://example.test/start" }));

  assert.equal(result.details.finalUrl, "https://example.test/final?session=xyz");
  const row = harness.rows[0] as Record<string, unknown>;
  assert.equal(row.domain, "example.test/final");
  assert.ok(!JSON.stringify(row).includes("xyz"));
});

test("a logger failure never turns a successful read into an error", async () => {
  const harness = makeHarness();
  harness.deps.log = {
    async write() {
      throw new Error("disk full");
    },
    path: () => "/dev/null",
  };
  const result = await run(harness, { url: "https://example.test/page" });
  assert.equal(isFailure(result), false);
});

// ---------------------------------------------------------------------------
// P9-A — serialization (V9.1/V9.2)
// ---------------------------------------------------------------------------

/**
 * One page whose body follows the URL, plus a deliberate async gap in the
 * extractor. Without the per-slot lock both calls navigate before either
 * extracts, so both return the *last* body — the exact field regression.
 */
function racingPage(docs: Record<string, ReadableDocument>): {
  page: FakePage;
  extractionUrl: () => string;
} {
  let current = DEFAULT_DOC;
  let currentUrl = "about:blank";
  const page = new FakePage({ url: "about:blank" });
  page.setNavigateHandler((url) => {
    currentUrl = url;
    current = docs[url] ?? DEFAULT_DOC;
  });
  page.setEvaluateHandlers(async () => {
    // Yield twice: a parallel caller gets a window to navigate this same tab.
    await Promise.resolve();
    await Promise.resolve();
    return current;
  });
  return { page, extractionUrl: () => currentUrl };
}

function docFor(host: string): ReadableDocument {
  return {
    title: `Page ${host}`,
    blocks: [{ kind: "paragraph", inlines: [{ kind: "text", text: `body of ${host}` }] }],
  };
}

test("V9.1: two concurrent reads of different domains return their own bodies", async () => {
  const urls = ["https://alpha.test/page", "https://beta.test/page"];
  const { page } = racingPage({ [urls[0]!]: docFor("alpha.test"), [urls[1]!]: docFor("beta.test") });
  const harness = makeHarness({ page });

  const [first, second] = await Promise.all([
    run(harness, { url: urls[0] }),
    run(harness, { url: urls[1] }),
  ]);

  const firstText = textOf(first);
  const secondText = textOf(second);
  assert.match(firstText, /body of alpha\.test/);
  assert.match(secondText, /body of beta\.test/);
  assert.ok(!firstText.includes("beta.test"), "a read must never inherit the other caller's body");
  assert.ok(!secondText.includes("alpha.test"));
  assert.equal(harness.pageKeys[0], "read", "pool=1 keeps the historical single key");
});

test("V9.2: twelve concurrent reads complete without cross-contamination or a leaked lock", async () => {
  const urls = Array.from({ length: 12 }, (_, index) => `https://site${index}.test/page`);
  const docs: Record<string, ReadableDocument> = {};
  for (const url of urls) docs[url] = docFor(new URL(url).host);

  const { page } = racingPage(docs);
  const harness = makeHarness({ page });

  const results = await Promise.all(urls.map((url) => run(harness, { url })));
  for (const [index, result] of results.entries()) {
    const text = textOf(result);
    assert.match(text, new RegExp(`body of site${index}\\.test`));
    for (let other = 0; other < urls.length; other += 1) {
      if (other === index) continue;
      assert.ok(!text.includes(`body of site${other}.test`), `read ${index} leaked ${other}`);
    }
  }
  assert.equal(pageLockFor(harness.deps.cdp).pending(), 0, "no lock may survive the batch");
});

test("read.pool > 1 uses distinct slots and still serializes each slot", async () => {
  const urls = ["https://one.test/a", "https://two.test/b"];
  const first = racingPage({ [urls[0]!]: docFor("one.test") });
  const second = racingPage({ [urls[1]!]: docFor("two.test") });
  const harness = makeHarness({
    page: first.page,
    pagesByKey: { read: first.page, "read#2": second.page },
    config: (config) => (config.read.pool = 2),
  });

  const [one, two] = await Promise.all([
    run(harness, { url: urls[0] }),
    run(harness, { url: urls[1] }),
  ]);

  assert.deepEqual([...harness.pageKeys].sort(), ["read", "read#2"]);
  assert.match(textOf(one), /body of one\.test/);
  assert.match(textOf(two), /body of two\.test/);
  assert.equal(pageLockFor(harness.deps.cdp).pending(), 0);
});

test("a throwing read releases the next waiter (no poisoned queue)", async () => {
  const { page } = racingPage({ "https://ok.test/p": docFor("ok.test") });
  const harness = makeHarness({ page });
  const broken = await run(harness, { url: "https://internal.example.test/p" });
  assert.equal(failure(broken).details.code, "E_BLOCKED_URL");
  const ok = await run(harness, { url: "https://ok.test/p" });
  assert.match(textOf(ok), /body of ok\.test/);
  assert.equal(pageLockFor(harness.deps.cdp).pending(), 0);
});

// ---------------------------------------------------------------------------
// P9-B — post-navigate proof (E_NAVIGATION_MISMATCH)
// ---------------------------------------------------------------------------

test("a tab that changes document after navigation is a mismatch, not a stranger's page", async () => {
  const page = new FakePage({ url: "about:blank", evaluate: () => DEFAULT_DOC });
  let calls = 0;
  page.currentUrl = async (): Promise<string> => {
    calls += 1;
    return calls === 1 ? "https://example.test/page" : "https://other.test/page";
  };
  const harness = makeHarness({ page });

  const result = failure(await run(harness, { url: "https://example.test/page" }));
  assert.equal(result.details.code, "E_NAVIGATION_MISMATCH");
  assert.equal(result.details.stage, "read");
  assert.equal(result.details.retryable, true);
  assert.ok(!textOf(result).includes("Hello read world"));
});

test("a fragment-only change is the same document (no false mismatch)", async () => {
  const page = new FakePage({ url: "about:blank", evaluate: () => DEFAULT_DOC });
  let calls = 0;
  page.currentUrl = async (): Promise<string> => {
    calls += 1;
    return calls === 1 ? "https://example.test/page" : "https://example.test/page#section";
  };
  const harness = makeHarness({ page });
  const result = success(await run(harness, { url: "https://example.test/page" }));
  assert.match(textOf(result), /Hello read world/);
});

// ---------------------------------------------------------------------------
// P9-C — an artifact on every page-state failure (V9.3/V9.4)
// ---------------------------------------------------------------------------

function capturingArtifacts(root = "/tmp/opencode/p9-artifacts"): {
  artifacts: Artifacts;
  inputs: ArtifactInput[];
} {
  const inputs: ArtifactInput[] = [];
  return {
    inputs,
    artifacts: {
      async save(input: ArtifactInput): Promise<string> {
        inputs.push(input);
        return `${root}/artifact`;
      },
      async prune() {
        return { removed: 0, kept: 0, bytes: 0 };
      },
      async size() {
        return 0;
      },
      root: () => root,
    },
  };
}

test("V9.3: an induced E_PARSE leaves page.html/page.txt/meta.json writable", async () => {
  const page = new FakePage({ url: "about:blank", evaluate: () => ({ title: "broken", blocks: "nope" }) });
  const captured = capturingArtifacts();
  const harness = makeHarness({ page, artifacts: captured.artifacts });

  const result = failure(await run(harness, { url: "https://example.test/broken" }));
  assert.equal(result.details.code, "E_PARSE");
  assert.equal(result.details.artifact, "/tmp/opencode/p9-artifacts/artifact");
  const input = captured.inputs[0];
  assert.ok(input !== undefined, "the failure must be snapshotted");
  assert.equal(input.code, "E_PARSE");
  assert.equal(input.stage, "extract");
  assert.equal(input.page, page, "the writer needs the live page for html/txt/jpeg");
  assert.equal(input.url, "https://example.test/broken");
});

test("V9.4: a redirect to a blocked address produces an artifact and E_BLOCKED_URL", async () => {
  const page = new FakePage({ url: "about:blank", evaluate: () => DEFAULT_DOC });
  page.setNavigateHandler((_url, p) => {
    p.setUrl("http://192.168.1.10/private");
  });
  const captured = capturingArtifacts();
  const harness = makeHarness({ page, artifacts: captured.artifacts });

  const result = failure(await run(harness, { url: "https://example.test/start" }));
  assert.equal(result.details.code, "E_BLOCKED_URL");
  assert.equal(result.details.artifact, "/tmp/opencode/p9-artifacts/artifact");
  assert.equal(captured.inputs[0]?.code, "E_BLOCKED_URL");
  assert.equal(harness.page.callCount("evaluate"), 0, "the guard rejected the landing page before extraction");
});

test("a transport failure (no page state) does not invent an artifact", async () => {
  const captured = capturingArtifacts();
  const harness = makeHarness({
    artifacts: captured.artifacts,
    acquireError: fail("E_CDP_DISCONNECTED", "connect"),
  });
  const result = failure(await run(harness, { url: "https://example.test/page" }));
  assert.equal(result.details.code, "E_CDP_DISCONNECTED");
  assert.equal(result.details.artifact, undefined);
  assert.equal(captured.inputs.length, 0);
});

// ---------------------------------------------------------------------------
// P9-D — offset/maxChars truth (V9.5)
// ---------------------------------------------------------------------------

test("V9.5: an offset past the end is an explicit E_OFFSET_RANGE with the length", async () => {
  const harness = makeHarness({ item: longDoc() });
  const result = failure(await run(harness, { url: "https://example.test/long", offset: 10_000_000 }));
  assert.equal(result.details.code, "E_OFFSET_RANGE");
  assert.equal(result.details.stage, "render");
  assert.equal(result.details.retryable, false);
  assert.match(textOf(result), /offset is past the end/i);
  assert.match(result.details.message ?? "", /offset \d+ is past the end/i);
  assert.match(result.details.message ?? "", /\d+ chars/);
});

test("V9.5: maxChars over the ceiling is clamped and reported, never silent", async () => {
  const harness = makeHarness({ item: longDoc() });
  const result = success(await run(harness, { url: "https://example.test/long", maxChars: 99_999 }));
  assert.equal(result.details.maxChars, READ_MAX_CHARS_CEILING);
  assert.equal(result.details.clamped, true);
  assert.ok(result.details.totalChars > READ_MAX_CHARS_CEILING);

  const normal = success(await run(harness, { url: "https://example.test/long", maxChars: 500 }));
  assert.equal(normal.details.maxChars, 500);
  assert.equal(normal.details.clamped, false);
});


// ---------------------------------------------------------------------------
// P12: PDF branch
// ---------------------------------------------------------------------------

const PDF_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pdf");
const BASIC_PDF = readFileSync(join(PDF_FIXTURES, "basic.pdf"));
const SCANNED_PDF = readFileSync(join(PDF_FIXTURES, "scanned.pdf"));

function pdfPage(): FakePage {
  return new FakePage({
    url: "https://example.test/paper.pdf",
    title: "paper.pdf",
    evaluate: (expression: string) => (expression === "document.contentType" ? "application/pdf" : DEFAULT_DOC),
  });
}

function pdfHarness(
  bytes: Buffer,
  options: Partial<HarnessOptions> & { contentType?: string; fetchUrl?: string } = {},
): Harness {
  return makeHarness({
    page: pdfPage(),
    fetchBytes: async (url) => ({
      url: options.fetchUrl ?? url,
      status: 200,
      contentType: options.contentType ?? "application/pdf",
      bytes,
    }),
    ...options,
  });
}

test("a PDF is read as text with page markers, never through the readability pass (P12)", async () => {
  const harness = pdfHarness(BASIC_PDF);
  const result = success(await run(harness, { url: "https://example.test/paper.pdf" }));
  const text = textOf(result);

  assert.match(text, /^--- p\.1 ---\n/);
  assert.match(text, /Hello PDF world\./);
  assert.match(text, /--- p\.2 ---/);
  assert.match(text, /Page two answers\./);
  assert.deepEqual(result.details.pdf, { pageCount: 2, extractor: "in-tree" });
  assert.deepEqual(harness.releasedKeys, ["read"], "a PDF tab is released for the next read");
  assert.equal(result.details.title, "paper.pdf");
  assert.equal(result.details.chars, text.length);
  assert.equal(harness.page.callCount("evaluate"), 1, "only document.contentType is evaluated");
});

test("PDF offset past the end is E_OFFSET_RANGE with the rendered length", async () => {
  const harness = pdfHarness(BASIC_PDF);
  const result = failure(await run(harness, { url: "https://example.test/paper.pdf", offset: 999_999 }));
  assert.equal(result.details.code, "E_OFFSET_RANGE");
  assert.match(result.details.message ?? "", /rendered PDF is \d+ chars/);
});

test("a scanned PDF fails E_PDF_SCANNED with an artifact and no invented text (V12.3)", async () => {
  const harness = pdfHarness(SCANNED_PDF, {
    artifacts: {
      async save(input: ArtifactInput): Promise<string> {
        harnessArtifact = input;
        return "/tmp/opencode/pi-chrome-search/artifacts/scanned";
      },
      async prune() {
        return { removed: 0, kept: 0, bytes: 0 };
      },
      async size() {
        return 0;
      },
      root: () => "/tmp/opencode/pi-chrome-search/artifacts",
    },
  });
  const result = failure(await run(harness, { url: "https://example.test/scan.pdf" }));
  assert.equal(result.details.code, "E_PDF_SCANNED");
  assert.equal(result.details.artifact, "/tmp/opencode/pi-chrome-search/artifacts/scanned");
  assert.match(textOf(result), /E_PDF_SCANNED|scan/i);
  assert.doesNotMatch(textOf(result), /Hello PDF world/);
  assert.ok(harnessArtifact !== undefined, "the failure snapshot is written");
});

test("read.keepPdf keeps doc.pdf next to the text artifact (P12-A)", async () => {
  let saved: ArtifactInput | undefined;
  const harness = pdfHarness(BASIC_PDF, {
    config: (config) => {
      config.read.keepPdf = true;
    },
    artifacts: {
      async save(input: ArtifactInput): Promise<string> {
        saved = input;
        return "/tmp/opencode/pi-chrome-search/artifacts/pdf";
      },
      async prune() {
        return { removed: 0, kept: 0, bytes: 0 };
      },
      async size() {
        return 0;
      },
      root: () => "/tmp/opencode/pi-chrome-search/artifacts",
    },
  });
  const result = success(await run(harness, { url: "https://example.test/paper.pdf" }));
  assert.equal(result.details.artifact, "/tmp/opencode/pi-chrome-search/artifacts/pdf");
  assert.ok(saved?.files?.["doc.pdf"] !== undefined);
  assert.deepEqual(Buffer.from(saved.files["doc.pdf"]), BASIC_PDF);
});

test("a PDF redirect to a private address is blocked before extraction (V12.4)", async () => {
  const harness = pdfHarness(BASIC_PDF, { fetchUrl: "http://127.0.0.1/secret.pdf" });
  const result = failure(await run(harness, { url: "https://example.test/paper.pdf" }));
  assert.equal(result.details.code, "E_BLOCKED_URL");
  assert.match(textOf(result), /redirect target blocked|blocked address/i);
});

test("a PDF viewer with an HTML response is E_PDF_UNSUPPORTED", async () => {
  const harness = pdfHarness(BASIC_PDF, { contentType: "text/html" });
  const result = failure(await run(harness, { url: "https://example.test/paper.pdf" }));
  assert.equal(result.details.code, "E_PDF_UNSUPPORTED");
  assert.match(result.details.message ?? "", /text\/html/);
});

let harnessArtifact: ArtifactInput | undefined;


// ---------------------------------------------------------------------------
// P14 — the page gate composes with the P5 read gate
// ---------------------------------------------------------------------------

interface PageGateSpy extends Reflex {
  pageCalls: PageSubject[][];
  readGateCalls: number;
}

function pageGateSpy(options: {
  verdict?: PageVerdict | null;
  allows?: boolean;
} = {}): PageGateSpy {
  const spy: PageGateSpy = {
    pageCalls: [],
    readGateCalls: 0,
    async triage(_query, items) {
      return { keep: items.map((_, index) => index), scores: items.map(() => 1), flags: [] };
    },
    async gateRead() {
      spy.readGateCalls += 1;
      return options.allows ?? true;
    },
    async judgePages(_query, subjects) {
      spy.pageCalls.push([...subjects]);
      const verdict = options.verdict;
      return verdict === undefined ? null : verdict === null ? null : [verdict];
    },
    async coverage() {
      return { enough: true, next: "stop" };
    },
    async route() {
      return { engines: ["google"] };
    },
  };
  return spy;
}

test("P14 page gate: a slop verdict refuses the URL before a tab is acquired", async () => {
  const reflex = pageGateSpy({
    verdict: { worth: false, trust: 0.15, kind: "slop", reasons: ["host:farm"] },
  });
  const harness = makeHarness({ config: (config) => { config.reflex.enabled = true; } });
  harness.deps.reflex = reflex;

  const result = failure(await run(harness, { url: "https://sonnik.ru/kot/" }));

  assert.equal(result.details.code, "E_UNSUPPORTED");
  assert.match(result.details.message ?? "", /page gate declined/);
  assert.match(result.details.message ?? "", /slop/);
  assert.match(result.details.message ?? "", /host:farm/);
  assert.equal(harness.pagesRequested, 0, "a refused URL must not navigate");
  assert.deepEqual(reflex.pageCalls, [[{ url: "https://sonnik.ru/kot/" }]]);
  assert.equal(reflex.readGateCalls, 0, "the P14 gate replaced the P5 gate, not doubled it");
});

test("P14 page gate: an abstaining gate falls back to the P5 read gate", async () => {
  const reflex = pageGateSpy({ verdict: null, allows: false });
  const harness = makeHarness({ config: (config) => { config.reflex.enabled = true; } });
  harness.deps.reflex = reflex;

  const result = failure(await run(harness, { url: "https://example.test/page" }));

  assert.equal(result.details.code, "E_UNSUPPORTED");
  assert.match(result.details.message ?? "", /reflex read gate declined/);
  assert.equal(harness.pagesRequested, 0);
  assert.equal(reflex.readGateCalls, 1);
});

test("P14 page gate: an allowed page reads normally and is not gated twice", async () => {
  const reflex = pageGateSpy({ verdict: { worth: true, trust: 0.9, kind: "original", reasons: ["host:trusted"] } });
  const harness = makeHarness({ config: (config) => { config.reflex.enabled = true; } });
  harness.deps.reflex = reflex;

  const result = success(await run(harness, { url: "https://example.test/page" }));

  assert.ok(result.details.chars > 0);
  assert.equal(reflex.pageCalls.length, 1);
  assert.equal(reflex.readGateCalls, 0);
});

test("P14 page gate: reflex.pageGate turns the gate on without the rest of the reflex", async () => {
  const reflex = pageGateSpy({ verdict: { worth: false, trust: 0.15, kind: "slop", reasons: ["host:farm"] } });
  const harness = makeHarness();
  harness.deps.reflex = reflex;
  harness.deps.config.reflex.enabled = false;
  harness.deps.config.reflex.pageGate = true;

  const result = failure(await run(harness, { url: "https://sonnik.ru/kot/" }));

  assert.equal(result.details.code, "E_UNSUPPORTED");
  assert.equal(harness.pagesRequested, 0);
  assert.equal(reflex.pageCalls.length, 1);
  assert.equal(reflex.readGateCalls, 0, "the page gate replaced the P5 gate");
});

test("P14 page gate: a disabled reflex is never consulted", async () => {
  const reflex = pageGateSpy({ verdict: { worth: false, trust: 0, kind: "unsafe", reasons: ["url:punycode"] } });
  const harness = makeHarness({
    config: (config) => {
      config.reflex.enabled = false;
      config.reflex.pageGate = false;
    },
  });
  harness.deps.reflex = reflex;

  success(await run(harness, { url: "https://example.test/page" }));

  assert.equal(reflex.pageCalls.length, 0);
  assert.equal(reflex.readGateCalls, 0);
});
