/**
 * P12-B unit tests: the in-tree PDF extractor and the window renderer.
 *
 * The fixtures are three tiny license-free PDFs committed under
 * `tests/fixtures/pdf/`: a two-page classic-xref file, the same file rewritten
 * with PDF 1.5 object streams (qpdf), and an image-only page. Nothing here
 * touches the network, Chrome or a real `pdftotext`: the binary rungs are
 * exercised through the injected capability/runner seams.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { extractPdfText, renderPdfWindow } from "../../src/extract/pdf.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pdf");

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

const NO_BINARIES = (): string | null => null;

test("in-tree rung reads a classic-xref PDF with no external binary (V12.2)", async (t) => {
  const result = await extractPdfText(fixture("basic.pdf"), { capability: NO_BINARIES });
  assert.equal(result.extractor, "in-tree");
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages.length, 2);
  assert.match(result.pages[0] ?? "", /Hello PDF world\./);
  assert.match(result.pages[0] ?? "", /Second line on page one\./);
  assert.match(result.pages[1] ?? "", /Page two answers\./);
  assert.match(result.pages[1] ?? "", /2026 and 42/);
  // cp1252 high half: no mojibake and no dropped accents.
  assert.match(result.pages[0] ?? "", /Café résumé naïve\./);
  assert.ok(result.attempted.length === 0, "a successful in-tree read attempts no binary");
  t.diagnostic(`in-tree: ${result.chars} chars, ${result.pageCount} pages, no capability resolver`);
});

test("in-tree rung expands PDF 1.5 object streams", async () => {
  const result = await extractPdfText(fixture("basic-objstm.pdf"), { capability: NO_BINARIES });
  assert.equal(result.extractor, "in-tree");
  assert.equal(result.pageCount, 2);
  assert.match(result.pages[0] ?? "", /Hello PDF world\./);
  assert.match(result.pages[1] ?? "", /Page two answers\./);
});

test("an image-only PDF is E_PDF_SCANNED, never invented text (V12.3)", async () => {
  await assert.rejects(
    () => extractPdfText(fixture("scanned.pdf"), { capability: NO_BINARIES }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error), `expected a taxonomy error, got ${String(error)}`);
      assert.equal(error.details.code, "E_PDF_SCANNED");
      assert.equal(error.details.stage, "extract");
      assert.match(error.details.hint, /scan/i);
      assert.match(error.details.message ?? "", /image-only|no text layer/i);
      return true;
    },
  );
});

test("page markers and the per-page cap are visible in the rendered window", async () => {
  const result = await extractPdfText(fixture("basic.pdf"), {
    capability: NO_BINARIES,
    pageMaxChars: 12,
  });
  assert.ok(result.truncatedPages >= 1, "a 12-char page cap must mark the page as truncated");
  const window = renderPdfWindow(result, { maxChars: 10_000 });
  assert.match(window.text, /^--- p\.1 ---\n/);
  assert.match(window.text, /--- p\.2 ---/);
  assert.match(window.text, /\[…\]/);
});

test("renderPdfWindow honours offset and reports the next offset", async () => {
  const result = await extractPdfText(fixture("basic.pdf"), { capability: NO_BINARIES });
  const first = renderPdfWindow(result, { maxChars: 20 });
  assert.equal(first.chars, 20);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 20);
  const second = renderPdfWindow(result, { offset: 20, maxChars: 20 });
  assert.equal(second.text, first.text.length === 0 ? "" : renderPdfWindow(result, { maxChars: 40 }).text.slice(20, 40));
  const all = renderPdfWindow(result, { maxChars: 100_000 });
  assert.equal(all.truncated, false);
  assert.equal(all.nextOffset, undefined);
});

test("a text-less PDF falls through to the injected pdftotext rung", async () => {
  // No page tree at all: the in-tree rung cannot produce text, and the fake
  // binary supplies a form-feed-separated transcript.
  const hollow = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
  const calls: string[] = [];
  const result = await extractPdfText(hollow, {
    capability: (name) => (name === "pdftotext" ? "/fake/pdftotext" : null),
    runBinary: async (command, args, input) => {
      calls.push(`${command} ${args.join(" ")} ${input.length}`);
      assert.equal(command, "/fake/pdftotext");
      assert.deepEqual(args, ["-layout", "-enc", "UTF-8", "-", "-"]);
      return "alpha beta gamma delta epsilon zeta\fsecond page text here\n";
    },
  });
  assert.equal(result.extractor, "pdftotext");
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pages, ["alpha beta gamma delta epsilon zeta", "second page text here"]);
  assert.equal(calls.length, 1);
  assert.ok(result.attempted.includes("in-tree:empty"));
});

test("no capability and no text is E_PDF_UNSUPPORTED, with the rungs that were tried", async () => {
  const hollow = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
  await assert.rejects(
    () => extractPdfText(hollow, { capability: NO_BINARIES }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_PDF_UNSUPPORTED");
      assert.match(error.details.message ?? "", /pdftotext:unavailable/);
      assert.match(error.details.hint, /HTML version|pdftotext/);
      return true;
    },
  );
});

test("a non-PDF payload is refused before parsing", async () => {
  await assert.rejects(
    () => extractPdfText(Buffer.from("<html>not a pdf</html>"), { capability: NO_BINARIES }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_PDF_UNSUPPORTED");
      return true;
    },
  );
});
