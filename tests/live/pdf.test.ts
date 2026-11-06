/**
 * Opt-in live gate for P12 (binary payloads).
 *
 * `PI_CHROME_LIVE=1 npm run test:live` — three PDFs, one live image attach.
 * Never retried in a loop: a wall or a dead URL reports and the user re-runs
 * later. Without the env var the test skips, so `npm test` stays offline.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConnector } from "../../src/cdp/browser.ts";
import { discoverEndpoint } from "../../src/cdp/discovery.ts";
import { loadConfig } from "../../src/config.ts";
import { createDefaultRegistry } from "../../src/engines/index.ts";
import { createArtifacts } from "../../src/runtime/artifacts.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { createSystemClock } from "../../src/runtime/clock.ts";
import { createLimiter } from "../../src/runtime/limiter.ts";
import { createLogger } from "../../src/runtime/log.ts";
import {
  createImageSearchTool,
  type ImageSearchResult,
  type ImageSearchSuccess,
} from "../../src/tools/image_search.ts";
import {
  createWebReadTool,
  type WebReadFailure,
  type WebReadResult,
  type WebReadSuccess,
} from "../../src/tools/web_read.ts";
import type { ToolDeps } from "../../src/tools/types.ts";

const LIVE = process.env.PI_CHROME_LIVE === "1";

/**
 * A live gate must not fight the interactive pi session for
 * `~/.pi/agent/web-search.lock`, and it must not write artifacts into the
 * user's state. Each run owns a throwaway agent dir: its own lock, its own
 * artifacts, its own decision log. The browser tabs it creates are closed by
 * `releaseAll()` in every test's `t.after`.
 */
function throwawayDir(): string {
  return mkdtempSync(join(tmpdir(), "p12-live-"));
}

const ARXIV = "https://arxiv.org/pdf/2211.17192";
// 18 KB, unencrypted, text-only, stable since 2015 (the previous table-heavy URL
// stalled after 16 KB from this network, so it was replaced — see evidence).
const TABLES = "https://pdfobject.com/pdf/sample.pdf";
const SCANNED = "https://nlsblog.org/wp-content/uploads/2020/06/image-based-pdf-sample.pdf";

function textOf(result: WebReadResult): string {
  return result.content.map((block) => block.text).join("\n");
}

function isFailure(result: WebReadResult | ImageSearchResult): boolean {
  return "isError" in result && result.isError === true;
}

function readSuccess(result: WebReadResult): WebReadSuccess {
  assert.equal(isFailure(result), false, `read failed: ${JSON.stringify(result.details)}`);
  return result as WebReadSuccess;
}

function readFailure(result: WebReadResult): WebReadFailure {
  assert.equal(isFailure(result), true, "expected a rendered failure");
  return result as WebReadFailure;
}

function imageSuccess(result: ImageSearchResult): ImageSearchSuccess {
  assert.equal(isFailure(result), false, `image_search failed: ${JSON.stringify(result.details)}`);
  return result as ImageSearchSuccess;
}

function makeDeps(overrides: { read?: Record<string, unknown> } = {}): ToolDeps {
  const env = { ...process.env, PI_CODING_AGENT_DIR: throwawayDir() };
  const config = loadConfig({ env });
  if (overrides.read !== undefined) Object.assign(config.read, overrides.read);
  const stateDir = join(env.PI_CODING_AGENT_DIR, "web-search");
  const clock = createSystemClock();
  const log = createLogger({ path: join(stateDir, "decisions.jsonl"), clock });
  const connector = createConnector({
    config,
    clock,
    log,
    lockPath: join(stateDir, "web-search.lock"),
    discover: () =>
      discoverEndpoint({ ports: config.cdp.ports, ws: config.cdp.ws, timeoutMs: config.cdp.connectTimeoutMs }),
  });
  return {
    config,
    engines: createDefaultRegistry(config),
    cdp: connector,
    cache: createCache({ maxEntries: config.cache.maxEntries, clock }),
    limiter: createLimiter({ config, clock, statePath: join(stateDir, "state.json") }),
    artifacts: createArtifacts({ config, clock }),
    log,
    clock,
  };
}

test(
  "live P12: academic, modern-layout and scanned PDFs",
  { skip: LIVE ? false : "set PI_CHROME_LIVE=1 to run the live PDF gate" },
  async (t) => {
    const deps = makeDeps();
    const tool = createWebReadTool(() => deps);
    t.after(async () => {
      await deps.cdp.releaseAll();
    });

    const academic = readSuccess(await tool.execute("live-p12-a", { url: ARXIV, maxChars: 600 }, undefined, undefined));
    const academicText = textOf(academic);
    assert.ok(academic.details.pdf !== undefined, "arxiv must take the PDF branch");
    assert.equal(academic.details.pdf?.extractor, "in-tree");
    assert.ok((academic.details.pdf?.pageCount ?? 0) >= 10, `page count ${academic.details.pdf?.pageCount}`);
    assert.ok(academicText.length > 400);
    t.diagnostic(`arxiv: pages=${academic.details.pdf?.pageCount} chars=${academic.details.chars}`);
    t.diagnostic(`arxiv first 600:\n${academicText.slice(0, 600)}`);

    const tables = readSuccess(await tool.execute("live-p12-b", { url: TABLES, maxChars: 600 }, undefined, undefined));
    assert.ok(tables.details.pdf !== undefined);
    t.diagnostic(
      `tables: pages=${tables.details.pdf?.pageCount} extractor=${tables.details.pdf?.extractor} chars=${tables.details.chars}`,
    );
    t.diagnostic(`tables first 600:\n${textOf(tables).slice(0, 600)}`);

    const scanned = readFailure(await tool.execute("live-p12-c", { url: SCANNED }, undefined, undefined));
    assert.equal(scanned.details.code, "E_PDF_SCANNED");
    assert.equal(scanned.details.artifact !== undefined, true, "the scanned failure keeps an artifact");
    t.diagnostic(`scanned: ${scanned.details.code} artifact=${scanned.details.artifact}`);
  },
);

test(
  "live P12: read.pdfMaxBytes refuses an oversized PDF before the body",
  { skip: LIVE ? false : "set PI_CHROME_LIVE=1 to run the live size gate" },
  async (t) => {
    const deps = makeDeps({ read: { pdfMaxBytes: 100_000 } });
    const tool = createWebReadTool(() => deps);
    t.after(async () => {
      await deps.cdp.releaseAll();
    });
    const started = Date.now();
    const result = readFailure(await tool.execute("live-p12-size", { url: ARXIV }, undefined, undefined));
    const elapsed = Date.now() - started;
    assert.equal(result.details.code, "E_UNSUPPORTED");
    assert.match(String(result.details.message), /over the .*ceiling/);
    t.diagnostic(`oversized: ${result.details.code} in ${elapsed} ms: ${result.details.message}`);
  },
);

test(
  "live P12: image_search attach:\"bytes\" emits real, unmodified image blocks",
  { skip: LIVE ? false : "set PI_CHROME_LIVE=1 to run the live image attach gate" },
  async (t) => {
    const deps = makeDeps();
    const tool = createImageSearchTool(() => deps);
    t.after(async () => {
      await deps.cdp.releaseAll();
    });
    const result = imageSuccess(
      await tool.execute(
        "live-p12-img",
        { q: "red panda", n: 2, engine: "google", attach: "bytes" },
        undefined,
        undefined,
      ),
    );
    const images = result.content.filter((block) => block.type === "image");
    assert.ok(images.length > 0 && images.length <= 4, `image blocks: ${images.length}`);
    assert.equal(images.length, result.details.attachedImages);
    for (const [index, block] of images.entries()) {
      assert.match(block.mimeType, /^image\//);
      const bytes = Buffer.from(block.data, "base64");
      assert.ok(bytes.length > 200, "a real thumbnail, not an error page");
      const magic = bytes.subarray(0, 3);
      const isJpeg = magic[0] === 0xff && magic[1] === 0xd8;
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const isWebp = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
      assert.ok(isJpeg || isPng || isWebp, `unexpected thumbnail magic ${bytes.subarray(0, 8).toString("hex")}`);
      t.diagnostic(
        `image ${index + 1}: ${block.mimeType} ${bytes.length} B sha256=${createHash("sha256").update(bytes).digest("hex")}`,
      );
    }
    t.diagnostic(`attached ${result.details.attachedImages} of 4, failed ${result.details.attachFailed}`);
  },
);
