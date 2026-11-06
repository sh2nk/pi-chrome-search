/**
 * Read pipeline: readability → Markdown windows, and the PDF ladder (in-tree
 * parser, optional installed binary, honest scanned/unsupported verdicts).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractPdfText, renderPdfWindow } from "../../src/extract/pdf.ts";
import { READ_MAX_CHARS_CEILING, type ReadableDocument, blocksToMarkdown, blocksToText, extractReadableDocument, renderReadableDocument } from "../../src/extract/read.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { fixtureDocument, runInPage } from "../helpers/fixtures.ts";

// ---------------------------------------------------------------------------
// from tests/unit/read.test.ts
// ---------------------------------------------------------------------------
{
/**
 * P4-A unit tests: the readability pass and its renderers (SPEC §7.2, PLAN V4.1).
 *
 * The fixture captures are the real thing (MDN docs, the Rust blog, Russian
 * Wikipedia), and the extractor is executed through `runInPage` — stringified
 * into a `node:vm` context like `page.evaluate` does — so a selector or a free
 * variable that only works in the module fails here exactly as it would in
 * Chrome.
 *
 * The assertions target what a reader notices: navigation/footer/consent text
 * is gone, code and tables survive, Russian text is intact, links are absolute
 * and well formed, no raw HTML leaks, the title appears once, and `offset`
 * windows tile the document exactly.
 */



const BLOG_URL = "https://blog.rust-lang.org/2024/09/05/Rust-1.81.0.html";

/** A real article shape: nav/footer furniture, a byline, a fenced code block. */
const ARTICLE_HTML = `<!doctype html><html><head><title>Announcing Rust 1.81.0 | Rust Blog</title></head><body>
<nav><a href="https://blog.rust-lang.org/">Rust Blog</a> · Get help!</nav>
<main><article>
<h1>Announcing Rust 1.81.0</h1>
<p class="byline">by The Rust Release Team · Sept. 5, 2024</p>
<p>The Rust team is happy to announce a new version of Rust, 1.81.0. Rust is a programming language empowering everyone to build reliable and efficient software.</p>
<pre><code class="language-plain">$ rustup update stable</code></pre>
<p>Use <code>rustup default beta</code> to switch. See the <a href="https://blog.rust-lang.org/2024/09/05/Rust-1.81.0.html">release notes</a>.</p>
</article></main>
<footer>Terms and policies</footer></body></html>`;

function articleDocument(url = BLOG_URL): ReadableDocument {
  return runInPage(extractReadableDocument, fixtureDocument(ARTICLE_HTML, url), undefined);
}

function extractInline(html: string, url = "https://example.test/article"): ReadableDocument {
  return runInPage(extractReadableDocument, fixtureDocument(html, url), undefined);
}

function fullMarkdown(data: ReadableDocument): string {
  return renderReadableDocument(data, { maxChars: READ_MAX_CHARS_CEILING }).text;
}

/** Every `](…)` must be a real, absolute http(s) target with no whitespace. */
function assertWellFormedLinks(markdown: string): void {
  let index = markdown.indexOf("](");
  while (index !== -1) {
    const open = markdown.lastIndexOf("[", index);
    assert.ok(open !== -1 && open < index, `link target without an opening bracket at ${index}`);
    const close = markdown.indexOf(")", index);
    assert.ok(close > index + 2, `unterminated link target at ${index}`);
    const href = markdown.slice(index + 2, close);
    assert.match(href, /^https?:\/\//, `non-absolute link: ${href}`);
    assert.ok(!/\s/.test(href), `whitespace in link target: ${href}`);
    index = markdown.indexOf("](", close);
  }
  assert.equal(
    (markdown.match(/\[/g) ?? []).length,
    (markdown.match(/\]/g) ?? []).length,
    "square brackets must stay balanced",
  );
  assert.ok(!/<(?:div|span|p|a|nav|footer|table|script)\b/i.test(markdown), "raw HTML leaked into Markdown");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

test("an article becomes clean Markdown with its code and without furniture", () => {
  const data = articleDocument();
  assert.equal(data.title, "Announcing Rust 1.81.0");

  const markdown = fullMarkdown(data);
  assert.match(markdown, /^# Announcing Rust 1\.81\.0\n/);
  assert.ok(markdown.includes("```plain"), "the fenced code block survives");
  assert.ok(markdown.includes("$ rustup update stable"));
  assert.ok(markdown.includes("`rustup default beta`"), "inline code keeps backticks");
  assert.ok(!markdown.includes("Get help!"), "site navigation leaked");
  assert.ok(!markdown.includes("Terms and policies"), "site footer leaked");
  assert.ok(!markdown.includes("Rust Blog"), "the site brand leaked into the article");
  assert.equal(markdown.split("Announcing Rust 1.81.0").length - 1, 1, "title appears once");
  assertWellFormedLinks(markdown);

  // Cyrillic prose is not mangled.
  const ru = extractInline(
    `<html><body><article><h1>Трансформер</h1><p>Трансфо́рмер — архитектура нейронных сетей.</p></article></body></html>`,
  );
  assert.ok(fullMarkdown(ru).includes("архитектура нейронных сетей"));
});

test("the default window truncates honestly and windows tile without gaps", () => {
  const paragraph = "word ".repeat(3000).trim();
  const data: ReadableDocument = {
    title: "Long",
    blocks: [{ kind: "paragraph", inlines: [{ kind: "text", text: paragraph }] }],
  };

  const rendered = renderReadableDocument(data);
  assert.ok(rendered.totalChars > 6000);
  assert.ok(rendered.chars <= 6000, `${rendered.chars} chars`);
  assert.ok(rendered.chars > 5000, `window looks too small (${rendered.chars})`);
  assert.equal(rendered.truncated, true);
  assert.equal(rendered.nextOffset, rendered.chars);

  const full = renderReadableDocument(data, { maxChars: READ_MAX_CHARS_CEILING });
  assert.equal(full.truncated, false);
  assert.equal(full.nextOffset, undefined);

  const chunks: string[] = [];
  let offset = 0;
  let truncated = true;
  let guard = 0;
  while (truncated) {
    const window = renderReadableDocument(data, { offset, maxChars: 1000 });
    assert.ok(window.chars <= 1000, `window ${guard} is ${window.chars} chars`);
    chunks.push(window.text);
    truncated = window.truncated;
    if (truncated) {
      assert.equal(typeof window.nextOffset, "number");
      assert.ok((window.nextOffset ?? 0) > offset, "nextOffset must move forward");
      offset = window.nextOffset as number;
    }
    guard += 1;
    assert.ok(guard < 100, "continuation did not terminate");
  }
  assert.equal(chunks.join(""), full.text, "concatenated windows must reproduce the document");
});

test("offset beyond the end yields an empty, non-truncated window", () => {
  const data: ReadableDocument = {
    title: "Tiny",
    blocks: [{ kind: "paragraph", inlines: [{ kind: "text", text: "Only a few words." }] }],
  };
  const rendered = renderReadableDocument(data, { offset: 10_000, maxChars: 100 });
  assert.equal(rendered.text, "");
  assert.equal(rendered.chars, 0);
  assert.equal(rendered.truncated, false);
  assert.equal(rendered.nextOffset, undefined);
});

test("maxChars is clamped to the 20000 ceiling", () => {
  const paragraph = "word ".repeat(10_000).trim();
  const data: ReadableDocument = {
    title: "Long",
    blocks: [{ kind: "paragraph", inlines: [{ kind: "text", text: paragraph }] }],
  };

  const rendered = renderReadableDocument(data, { maxChars: 999_999 });
  assert.ok(rendered.totalChars > READ_MAX_CHARS_CEILING);
  assert.ok(rendered.chars <= READ_MAX_CHARS_CEILING);
  assert.ok(rendered.chars > READ_MAX_CHARS_CEILING - 100, "the window must fill the ceiling");
  assert.equal(rendered.truncated, true);
  assert.equal(rendered.nextOffset, rendered.chars);
  assert.ok(rendered.text.length <= READ_MAX_CHARS_CEILING);
});

// ---------------------------------------------------------------------------
// Inline fixtures: furniture, links, title, tables, code
// ---------------------------------------------------------------------------

const FURNITURE_HTML = `<!doctype html>
<html><head><title>Fallback title</title></head><body>
  <nav><a href="https://example.test/nav">Navigation junk</a></nav>
  <main>
    <article>
      <h1>Real Title</h1>
      <p>First paragraph with a <a href="/relative">relative link</a> and a <a href="#fragment">fragment</a>.</p>
      <div class="cookie-consent" role="dialog">We use cookies. Принять</div>
      <div style="position: fixed; bottom: 0"><p>We use cookies to track you</p><button>Принять</button></div>
      <div class="sticky"><p>Cookie notice: согласие на обработку</p></div>
      <div class="share-bar"><a href="https://example.test/share">Share on X</a><a href="https://example.test/share2">Share on Y</a></div>
      <section id="comments"><p>A comment that must vanish.</p></section>
      <footer>Footer junk</footer>
      <aside>Aside junk</aside>
      <ul><li>Alpha</li><li>Beta<ul><li>Nested gamma</li></ul></li></ul>
      <pre class="language-js"><code>const x = 1;</code></pre>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <p>First paragraph with a <a href="/relative">relative link</a> and a <a href="#fragment">fragment</a>.</p>
    </article>
  </main>
  <footer><p>Site footer junk</p></footer>
</body></html>`;

test("navigation, consent banners, share bars, comments and footers are stripped", () => {
  const data = extractInline(FURNITURE_HTML);
  const markdown = blocksToMarkdown(data.blocks);

  for (const junk of [
    "Navigation junk",
    "We use cookies",
    "We use cookies to track you",
    "Cookie notice: согласие",
    "Принять",
    "Share on X",
    "A comment that must vanish",
    "Footer junk",
    "Aside junk",
    "Site footer junk",
  ]) {
    assert.ok(!markdown.includes(junk), `junk leaked: ${junk}`);
  }

  assert.ok(markdown.includes("First paragraph"));
  assert.ok(markdown.includes("[relative link](https://example.test/relative)"));
  assert.ok(markdown.includes("fragment"), "a fragment link keeps its text");
  assert.ok(!markdown.includes("[fragment]("), "a fragment is not a usable target");
  assert.match(markdown, /^- Alpha$/m);
  assert.match(markdown, /^- Beta$/m);
  assert.match(markdown, /^ {2}- Nested gamma$/m);
  assert.match(markdown, /^```js\nconst x = 1;\n```$/m);
  assert.match(markdown, /^\| A \| B \|$/m);
  assert.match(markdown, /^\| --- \| --- \|$/m);
  assert.match(markdown, /^\| 1 \| 2 \|$/m);
  assertWellFormedLinks(markdown);
});

test("the title is rendered once even when the page repeats it as an h1", () => {
  const data = extractInline(`<html><body><article>
    <h1>One Title</h1>
    <p>One body paragraph.</p>
    <h1>One Title</h1>
  </article></body></html>`);
  assert.equal(data.title, "One Title");

  const markdown = blocksToMarkdown(data.blocks);
  assert.equal(markdown.split("One Title").length - 1, 0, "the duplicate h1 must be dropped from the body");
  assert.equal(renderReadableDocument(data, { maxChars: 2000 }).text.split("One Title").length - 1, 1);
});

test("duplicate blocks are dropped", () => {
  const data = extractInline(`<html><body><article>
    <h1>Repeat</h1>
    <p>We use cookies to improve the site.</p>
    <p>We use cookies to improve the site.</p>
  </article></body></html>`);
  const markdown = blocksToMarkdown(data.blocks);
  assert.equal(markdown.split("We use cookies").length - 1, 1);
});

test("Markdown hrefs with parentheses stay clickable", () => {
  const data = extractInline(`<html><body><article>
    <p>See <a href="https://ru.wikipedia.org/wiki/Трансформер_(модель_машинного_обучения)">the article</a>.</p>
  </article></body></html>`);
  const markdown = blocksToMarkdown(data.blocks);
  assert.match(markdown, /\(https:\/\/ru\.wikipedia\.org\/wiki\/[^\s)]+%28[^\s)]+%29\)/);
  assertWellFormedLinks(markdown);
});

test("text mode drops Markdown syntax but keeps the prose", () => {
  const data = extractInline(`<html><body><article>
    <h1>Plain</h1>
    <p>Read <a href="https://example.test/x">this</a> and <code>that</code>.</p>
    <ul><li>Item</li></ul>
    <pre>code line</pre>
  </article></body></html>`);

  const text = renderReadableDocument(data, { format: "text", maxChars: 2000 }).text;
  assert.match(text, /^Plain\n/);
  assert.ok(text.includes("Read this and that."));
  assert.ok(text.includes("- Item"));
  assert.ok(text.includes("code line"));
  assert.ok(!text.includes("]("));
  assert.ok(!text.includes("```"));
  assert.ok(!text.includes("# Plain"));

  assert.ok(blocksToText(data.blocks).includes("Read this and that."));
});

test("an empty document renders an empty string", () => {
  const data: ReadableDocument = { title: "", blocks: [] };
  const rendered = renderReadableDocument(data);
  assert.equal(rendered.text, "");
  assert.equal(rendered.chars, 0);
  assert.equal(rendered.truncated, false);
});
}

// ---------------------------------------------------------------------------
// from tests/unit/pdf.test.ts
// ---------------------------------------------------------------------------
{
/**
 * P12-B unit tests: the in-tree PDF extractor and the window renderer.
 *
 * The fixtures are three tiny license-free PDFs committed under
 * `tests/fixtures/pdf/`: a two-page classic-xref file, the same file rewritten
 * with PDF 1.5 object streams (qpdf), and an image-only page. Nothing here
 * touches the network, Chrome or a real `pdftotext`: the binary rungs are
 * exercised through the injected capability/runner seams.
 */



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
}
