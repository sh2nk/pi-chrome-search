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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import {
  READ_MAX_CHARS_CEILING,
  blocksToMarkdown,
  blocksToText,
  extractReadableDocument,
  renderReadableDocument,
  type ReadableDocument,
} from "../../src/extract/read.ts";
import { fixtureDocument, runInPage } from "../helpers/dom.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

const DOCS_URL = "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions";
const BLOG_URL = "https://blog.rust-lang.org/2024/09/05/Rust-1.81.0.html";
const WIKI_URL = "https://ru.wikipedia.org/wiki/Трансформер_(модель_машинного_обучения)";

function loadFixture(name: string, url: string): ReadableDocument {
  const html = gunzipSync(readFileSync(join(FIXTURES, `${name}.html.gz`))).toString("utf8");
  const doc = fixtureDocument(html, url);
  return runInPage(extractReadableDocument, doc, undefined);
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

test("MDN docs fixture becomes clean Markdown", () => {
  const data = loadFixture("read-docs", DOCS_URL);
  assert.equal(data.title, "Regular expressions");

  const markdown = fullMarkdown(data);
  assert.match(markdown, /^# Regular expressions\n/);
  assert.ok(markdown.includes("`/abc/`"), "inline code keeps its backticks");
  assert.ok(markdown.includes("`exec()`"), "method names stay code spans");
  assert.ok(markdown.includes("| Object |"), "the results table survives as Markdown rows");

  // TOC, pager, article footer and the right/left sidebars are page furniture.
  assert.ok(!markdown.includes("In this article"), "the TOC nav leaked");
  assert.ok(!markdown.includes("Help improve MDN"), "the article footer leaked");
  assert.ok(!markdown.includes("View this page on GitHub"));
  assert.ok(!markdown.includes("Previous"), "the pager nav leaked");
  assert.ok(!markdown.includes("Next"), "the pager nav leaked");

  assertWellFormedLinks(markdown);
  assert.ok(markdown.length <= READ_MAX_CHARS_CEILING);
});

test("Rust blog fixture keeps its fenced code and byline", () => {
  const data = loadFixture("read-blog", BLOG_URL);
  assert.equal(data.title, "Announcing Rust 1.81.0");
  assert.equal(data.byline, "The Rust Release Team");
  assert.equal(data.publishedAt, "Sept. 5, 2024");

  const markdown = fullMarkdown(data);
  assert.match(markdown, /^# Announcing Rust 1\.81\.0\n/);
  assert.ok(markdown.includes("```plain"));
  assert.ok(markdown.includes("$ rustup update stable"));
  assert.ok(markdown.includes("`rustup default beta`"), "inline code keeps backticks");

  assert.ok(!markdown.includes("Get help!"), "site footer leaked");
  assert.ok(!markdown.includes("Terms and policies"), "site footer leaked");
  assert.ok(!markdown.includes("Rust Blog"), "the site brand leaked into the article");

  const titleOccurrences = markdown.split("Announcing Rust 1.81.0").length - 1;
  assert.equal(titleOccurrences, 1, "the title must appear exactly once");

  assertWellFormedLinks(markdown);
});

test("Russian Wikipedia fixture keeps the Russian prose", () => {
  const data = loadFixture("read-wiki", WIKI_URL);
  assert.match(data.title, /Трансформер/);

  const markdown = fullMarkdown(data);
  assert.ok(markdown.includes("Трансфо́рмер"));
  assert.ok(markdown.includes("архитектура"));
  assert.ok(markdown.includes("нейронных сетей"));

  // Vector chrome, edit links, the "material from Wikipedia" subtitle and the
  // category/printfooter tail are all furniture.
  assert.ok(!markdown.includes("Содержание"), "the table of contents leaked");
  assert.ok(!markdown.includes("Материал из Википедии"), "siteSub leaked");
  assert.ok(!markdown.includes("править"), "edit links leaked");
  assert.ok(!markdown.includes("Источник —"), "printfooter leaked");

  assertWellFormedLinks(markdown);
});

test("all three fixtures respect the default 6000-char window", () => {
  for (const [name, url] of [
    ["read-docs", DOCS_URL],
    ["read-blog", BLOG_URL],
    ["read-wiki", WIKI_URL],
  ] as const) {
    const rendered = renderReadableDocument(loadFixture(name, url));
    assert.ok(rendered.totalChars > 6000, `${name}: fixture is too small to test truncation`);
    assert.ok(rendered.chars <= 6000, `${name}: ${rendered.chars} chars`);
    assert.ok(rendered.chars > 5000, `${name}: window looks too small (${rendered.chars})`);
    assert.equal(rendered.truncated, true);
    assert.equal(rendered.nextOffset, rendered.chars);
    assert.ok(!/<\/?(?:div|span|p|nav|footer)\b/i.test(rendered.text));
  }
});

// ---------------------------------------------------------------------------
// Continuation window
// ---------------------------------------------------------------------------

test("offset windows tile the whole document without gaps or overlaps", () => {
  const data = loadFixture("read-docs", DOCS_URL);
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
