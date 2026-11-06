/**
 * Readability pass for `web_read` (SPEC §7.2, PLAN P4-A).
 *
 * The extraction itself must run *inside the page*: `web_read` navigates the
 * user's real Chrome and serialises the result over CDP. So
 * `extractReadableDocument` is written the way the engine adapters are: no
 * imports and no module closures, because the live path does
 *
 *   page.evaluate(`(${extractReadableDocument})(document)`)
 *
 * and `Function.prototype.toString` would leave any captured variable
 * undefined in the browser. The fixtures suite proves this by running the same
 * source through `tests/helpers/dom.ts#runInPage`.
 *
 * Two rules keep the output honest and cheap:
 * - navigation, sidebars, cookie/consent banners, share bars and comment blocks
 *   are dropped by tag, ARIA role and *class/id token* (never by a hashed CSS
 *   class we would have to guess);
 * - the article title is emitted once by the renderer, so an `<h1>` equal to it
 *   is not repeated as a heading.
 *
 * The in-page function returns plain JSON (`ReadableDocument`); Markdown/text
 * rendering and the offset window are pure TypeScript below, which is what the
 * unit tests exercise without a browser.
 */

export type ReadBlockKind = "heading" | "paragraph" | "listItem" | "quote" | "code" | "table";

export interface ReadInline {
  kind: "text" | "code" | "link";
  text: string;
  /** Absolute http(s) destination; set only for `link`. */
  href?: string;
}

export interface ReadBlock {
  kind: ReadBlockKind;
  /** 1..6, headings only. */
  level?: number;
  /** Inline content for headings, paragraphs, list items and quotes. */
  inlines?: ReadInline[];
  /** Whitespace-preserved source for `code`. */
  code?: string;
  /** `language-js` / `data-lang` hint for `code`. */
  language?: string;
  /** Table rows; the first row is the header. */
  rows?: string[][];
  /** 1-based marker for ordered list items. */
  marker?: number;
  /** List nesting depth (0 = top level). */
  depth?: number;
}

export interface ReadableDocument {
  title: string;
  byline?: string;
  publishedAt?: string;
  blocks: ReadBlock[];
}

/** SPEC §7.2 default; `config.read.defaultMaxChars` mirrors it. */
export const READ_DEFAULT_MAX_CHARS = 6000;
/** Hard ceiling from SPEC §7.2 / config.read.maxCharsCeiling. */
export const READ_MAX_CHARS_CEILING = 20000;

// ---------------------------------------------------------------------------
// In-page extraction (must stay self-contained)
// ---------------------------------------------------------------------------

/**
 * Collapse a document into title/byline/blocks. Self-contained by contract:
 * every helper and constant lives inside this function body.
 */
export function extractReadableDocument(doc: Document): ReadableDocument {
  const SKIP_TAGS: Record<string, boolean> = {
    NAV: true,
    HEADER: true,
    FOOTER: true,
    ASIDE: true,
    FORM: true,
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEMPLATE: true,
    SVG: true,
    INPUT: true,
    SELECT: true,
    TEXTAREA: true,
    IFRAME: true,
    CANVAS: true,
    VIDEO: true,
    AUDIO: true,
    OBJECT: true,
    EMBED: true,
  };

  /** Block elements handled separately; inline collection never walks into them. */
  const BLOCK_TAGS: Record<string, boolean> = {
    TABLE: true,
    PRE: true,
    UL: true,
    OL: true,
    FIGURE: true,
    DL: true,
  };

  const INLINE_SKIP_TAGS: Record<string, boolean> = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEMPLATE: true,
    SVG: true,
    INPUT: true,
    SELECT: true,
    TEXTAREA: true,
    BUTTON: true,
    IFRAME: true,
    CANVAS: true,
    VIDEO: true,
    AUDIO: true,
    OBJECT: true,
    EMBED: true,
    TABLE: true,
    PRE: true,
    UL: true,
    OL: true,
    FIGURE: true,
    DL: true,
  };

  const CONSENT_CI = /(^|[-_ ])(cookie|consent|gdpr|cmp|onetrust|truste)([-_ ]|$)/;
  const CONSENT_TEXT = /(cookie|consent|gdpr|принять|согласие|согласен)/i;
  const BANNER_CI = /(banner|dialog|modal|notice|popup|overlay)/;
  const FURNITURE_CI =
    /(^|[-_ ])(sidebar|breadcrumbs?|pagination|pager|prev-next|toc|table-of-contents)([-_ ]|$)/;
  const FOOTER_CI = /(^|[-_ ])(site[-_])?footer([-_ ]|$)/;
  const ARTICLE_FOOTER_CI = /(^|[-_ ])(article[-_])?footer([-_ ]|$)/;
  const SHARE_CI = /(^|[-_ ])(share|sharing|sharedaddy)([-_ ]|$)/;
  const COMMENTS_CI =
    /(^|[-_ ])(comments?|comment-?(list|section|area|body|form)|respond|disqus)([-_ ]|$)/;
  const UTILITY_CI = /(^|[-_ ])(mw-editsection|noprint|printfooter)([-_ ]|$)/;
  const CATEGORY_CI = /(^|[-_ ])(catlinks|navbox)([-_ ]|$)/;

  function attr(el: Element, name: string): string {
    const value = el.getAttribute(name);
    return value === null ? "" : value;
  }

  function tagOf(el: Element): string {
    return (el.tagName || "").toUpperCase();
  }

  function norm(value: string | null | undefined): string {
    return String(value === null || value === undefined ? "" : value)
      .replace(/[\s\u00a0\u200b\ufeff]+/g, " ")
      .trim();
  }

  function classAndId(el: Element): string {
    return `${attr(el, "id")} ${attr(el, "class")}`.toLowerCase();
  }

  function isSkipped(el: Element): boolean {
    if (SKIP_TAGS[tagOf(el)] === true) return true;
    if (attr(el, "role").toLowerCase() === "navigation") return true;
    if (attr(el, "aria-hidden").toLowerCase() === "true") return true;

    const ci = classAndId(el);
    const role = attr(el, "role").toLowerCase();
    const modal = attr(el, "aria-modal").toLowerCase() === "true";
    const style = attr(el, "style").toLowerCase();
    const pinned =
      /position\s*:\s*(?:fixed|sticky)/.test(style) || /(^|[-_ ])(?:fixed|sticky)([-_ ]|$)/.test(ci);
    if (CONSENT_CI.test(ci) || role === "dialog" || modal || pinned) {
      // Class names alone are not enough: a recipe page can have a
      // `cookie-recipe` card. The banner must also look like a banner, carry
      // consent text, or be an actual (possibly pinned) dialog.
      if (CONSENT_TEXT.test(norm(el.textContent)) || BANNER_CI.test(ci) || role === "dialog" || modal) {
        return true;
      }
    }

    if (FURNITURE_CI.test(ci)) return true;
    if (FOOTER_CI.test(ci)) return true;
    if (ARTICLE_FOOTER_CI.test(ci)) return true;
    if (SHARE_CI.test(ci)) return true;
    if (COMMENTS_CI.test(ci)) return true;
    if (UTILITY_CI.test(ci)) return true;
    if (CATEGORY_CI.test(ci)) return true;
    return false;
  }

  function hasSkippedAncestor(el: Element, stop: Element | null): boolean {
    let node: Element | null = el;
    while (node !== null && node !== stop) {
      if (isSkipped(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function paragraphChars(el: Element): number {
    let total = 0;
    const nodes = el.querySelectorAll("p, li, blockquote, pre");
    for (let i = 0; i < nodes.length; i += 1) total += norm(nodes[i]?.textContent).length;
    return total;
  }

  function linkChars(el: Element): number {
    let total = 0;
    const links = el.querySelectorAll("a");
    for (let i = 0; i < links.length; i += 1) total += norm(links[i]?.textContent).length;
    return total;
  }

  /**
   * `<article>` / `<main>` / `[role=main]` are explicit signals and win over
   * scoring. The largest of the matching elements is used (a page may carry a
   * tiny unrelated `<article>` card before the real content).
   */
  function chooseExplicit(doc: Document): Element | null {
    const selectors = ["article", "main", "[role=main]"];
    for (let s = 0; s < selectors.length; s += 1) {
      const nodes = doc.querySelectorAll(selectors[s] as string);
      let best: Element | null = null;
      let bestText = 0;
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i] as Element;
        if (isSkipped(el)) continue;
        const text = paragraphChars(el);
        if (text > bestText) {
          bestText = text;
          best = el;
        }
      }
      if (best !== null && bestText >= 120) return best;
    }
    return null;
  }

  /**
   * Fallback for pages without semantic landmarks (the Rust blog is a
   * `<section>` of paragraphs): score every paragraph, add it to its parent and
   * half to its grandparent, then climb while an ancestor is still comparable.
   * That keeps a single long paragraph from being mistaken for the article.
   */
  function chooseScored(doc: Document): Element | null {
    const scores = new Map<Element, number>();
    const add = (el: Element | null, score: number): void => {
      if (el === null) return;
      scores.set(el, (scores.get(el) || 0) + score);
    };

    const paragraphs = doc.querySelectorAll("p, li, blockquote, pre");
    for (let i = 0; i < paragraphs.length; i += 1) {
      const p = paragraphs[i] as Element;
      if (hasSkippedAncestor(p, doc.documentElement)) continue;
      const text = norm(p.textContent);
      if (text.length < 25) continue;
      const density = linkChars(p) / text.length;
      if (density > 0.5) continue;
      const commas = (text.match(/[,;:]/g) || []).length;
      let score = 1 + commas + Math.min(3, text.length / 100);
      score *= 1 - Math.min(1, density);
      const parent = p.parentElement;
      add(parent, score);
      add(parent === null ? null : parent.parentElement, score / 2);
    }

    let best: Element | null = null;
    let bestScore = 0;
    scores.forEach((score, el) => {
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
    if (best === null || bestScore < 4) return null;

    let current: Element = best;
    while (current.parentElement !== null && current.parentElement !== doc.documentElement) {
      const parentScore = scores.get(current.parentElement) || 0;
      if (parentScore < bestScore * 0.8) break;
      current = current.parentElement;
    }
    return current;
  }

  function stripTitleSuffix(value: string): string {
    let text = norm(value);
    if (text === "") return "";
    const separators = [" | ", " — ", " – ", " · "];
    for (let i = 0; i < separators.length; i += 1) {
      const sep = separators[i] as string;
      const index = text.lastIndexOf(sep);
      if (index > 12 && text.length - index <= 60) {
        text = text.slice(0, index).trim();
        break;
      }
    }
    if (text === norm(value)) {
      const dash = text.lastIndexOf(" - ");
      if (dash > 12 && text.length - dash <= 45) text = text.slice(0, dash).trim();
    }
    return text.length > 220 ? `${text.slice(0, 217)}...` : text;
  }

  function chooseTitle(doc: Document, root: Element): string {
    const scopes: Element[] = [root, doc.documentElement];
    for (let s = 0; s < scopes.length; s += 1) {
      const headings = scopes[s]?.querySelectorAll("h1");
      if (headings === undefined) continue;
      for (let i = 0; i < headings.length; i += 1) {
        const heading = headings[i] as Element;
        if (isSkipped(heading)) continue;
        const text = norm(heading.textContent);
        if (text !== "") return stripTitleSuffix(text);
      }
    }
    const og = doc.querySelector('meta[property="og:title"], meta[name="og:title"]');
    if (og !== null) {
      const text = stripTitleSuffix(attr(og, "content"));
      if (text !== "") return text;
    }
    return stripTitleSuffix(norm(doc.title));
  }

  function metaContent(doc: Document, selector: string): string {
    const el = doc.querySelector(selector);
    return el === null ? "" : norm(attr(el, "content"));
  }

  function cap(value: string, max: number): string {
    const text = norm(value);
    return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
  }

  function firstVisible(root: Element, selector: string): Element | null {
    const nodes = root.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i] as Element;
      if (!hasSkippedAncestor(el, root)) return el;
    }
    return null;
  }

  function extractMetadata(doc: Document, root: Element): { byline: string; publishedAt: string } {
    let byline = "";
    let publishedAt = "";

    const time = firstVisible(root, "time[datetime]");
    if (time !== null) publishedAt = norm(attr(time, "datetime")) || norm(time.textContent);

    // `publish-date-author` is one element on the Rust blog, so a middle dot
    // splits the human date from the author instead of pretending they are one.
    const author = firstVisible(
      root,
      '[rel="author"], [itemprop="author"], [class*="author"], [class*="byline"], [class*="publish-date"]',
    );
    if (author !== null) {
      const text = norm(author.textContent);
      const ci = classAndId(author);
      if (text.includes("·")) {
        const index = text.indexOf("·");
        const date = norm(text.slice(0, index));
        const rest = norm(text.slice(index + 1));
        if (publishedAt === "" && date !== "") publishedAt = date;
        if (rest !== "") byline = rest;
      } else if (/author|byline/.test(ci) || attr(author, "rel") === "author") {
        byline = text;
      }
    }

    if (byline === "") byline = metaContent(doc, 'meta[name="author"]');
    if (publishedAt === "") {
      publishedAt = metaContent(
        doc,
        'meta[property="article:published_time"], meta[name="article:published_time"], meta[name="date"]',
      );
    }

    return { byline: cap(byline, 120), publishedAt: cap(publishedAt, 80) };
  }

  const base = norm(doc.baseURI) || norm(doc.URL);

  function absoluteHref(raw: string): string | null {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "" || value.startsWith("#")) return null;
    try {
      const url = new URL(value, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function appendText(out: ReadInline[], raw: string | null): void {
    if (raw === null || raw === "") return;
    const text = raw.replace(/[\s\u00a0\u200b]+/g, " ");
    if (text === "") return;
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === "text") last.text += text;
    else out.push({ kind: "text", text });
  }

  function appendInlines(node: Node, out: ReadInline[]): void {
    if (node.nodeType === 3) {
      appendText(out, node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;

    const el = node as Element;
    const tag = tagOf(el);
    if (INLINE_SKIP_TAGS[tag] === true) return;
    if (attr(el, "aria-hidden").toLowerCase() === "true") return;
    const ci = classAndId(el);
    if (/(^|[-_ ])(reference|mw-ref|mw-editsection)([-_ ]|$)/.test(ci)) return;

    if (tag === "BR") {
      appendText(out, " ");
      return;
    }
    if (tag === "A") {
      const href = absoluteHref(attr(el, "href"));
      const text = norm(el.textContent);
      if (href !== null && text !== "") {
        out.push({ kind: "link", text, href });
        return;
      }
      // Fragments, javascript: and unusable wrappers contribute only their text.
      for (let i = 0; i < el.childNodes.length; i += 1) appendInlines(el.childNodes[i] as Node, out);
      return;
    }
    if (tag === "CODE") {
      const text = norm(el.textContent);
      if (text !== "") out.push({ kind: "code", text });
      return;
    }
    if (tag === "IMG") {
      const alt = norm(attr(el, "alt"));
      if (alt !== "") appendText(out, alt);
      return;
    }

    for (let i = 0; i < el.childNodes.length; i += 1) appendInlines(el.childNodes[i] as Node, out);
  }

  function normalizeInlines(raw: ReadInline[]): ReadInline[] {
    const merged: ReadInline[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const inline = raw[i] as ReadInline;
      const text = inline.kind === "text" ? inline.text.replace(/[\s\u00a0\u200b]+/g, " ") : inline.text;
      if (text === "") continue;
      const last = merged[merged.length - 1];
      if (inline.kind === "text" && last !== undefined && last.kind === "text") {
        last.text = `${last.text}${text}`.replace(/[\s\u00a0\u200b]+/g, " ");
      } else {
        merged.push({ kind: inline.kind, text, href: inline.href });
      }
    }

    if (merged.length > 0) {
      const first = merged[0] as ReadInline;
      first.text = first.text.replace(/^\s+/, "");
      if (first.text === "") merged.shift();
    }
    if (merged.length > 0) {
      const last = merged[merged.length - 1] as ReadInline;
      last.text = last.text.replace(/\s+$/, "");
      if (last.text === "") merged.pop();
    }
    return merged.filter((inline) => inline.text !== "" || inline.kind === "link");
  }

  function collectInlines(el: Element): ReadInline[] {
    const out: ReadInline[] = [];
    for (let i = 0; i < el.childNodes.length; i += 1) appendInlines(el.childNodes[i] as Node, out);
    return normalizeInlines(out);
  }

  const blocks: ReadBlock[] = [];
  const seen = new Set<string>();

  function plainOf(block: ReadBlock): string {
    if (block.kind === "code") return norm(block.code);
    if (block.kind === "table") {
      const rows = block.rows || [];
      return norm(rows.map((row) => row.join(" ")).join(" "));
    }
    const inlines = block.inlines || [];
    return norm(inlines.map((inline) => inline.text).join(""));
  }

  function pushBlock(block: ReadBlock): void {
    const plain = plainOf(block);
    if (plain === "") return;
    if (block.kind === "heading" && title !== "" && plain.toLowerCase() === title.toLowerCase()) {
      // The renderer emits the title once, so every heading repeating it is
      // redundant (an `<h1>` plus a section heading with the same text).
      return;
    }
    const key = `${block.kind}|${block.level === undefined ? "" : block.level}|${block.depth === undefined ? "" : block.depth}|${plain}`;
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push(block);
  }

  function pushHeading(el: Element): void {
    const level = Number.parseInt(tagOf(el).slice(1), 10);
    pushBlock({
      kind: "heading",
      level: Number.isFinite(level) ? Math.min(6, Math.max(1, level)) : 1,
      inlines: collectInlines(el),
    });
  }

  function pushParagraph(el: Element): void {
    pushBlock({ kind: "paragraph", inlines: collectInlines(el) });
  }

  function trimCode(value: string): string {
    const lines = String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""));
    while (lines.length > 0 && (lines[0] as string).trim() === "") lines.shift();
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === "") lines.pop();
    return lines.join("\n");
  }

  function pushCode(el: Element): void {
    const inner = el.querySelector("code");
    const codeEl = inner === null ? el : inner;
    const code = trimCode(el.textContent || "");
    if (code === "") return;

    let language = "";
    const classes = `${attr(el, "class")} ${attr(codeEl, "class")}`.toLowerCase();
    const match = /(?:^|\s)language-([a-z0-9+#._-]+)/.exec(classes);
    if (match !== null) language = match[1] as string;
    if (language === "") {
      const hint = attr(codeEl, "data-lang") || attr(el, "data-lang") || attr(el, "data-language");
      if (/^[a-z0-9+#._-]{1,24}$/i.test(hint)) language = hint.toLowerCase();
    }

    const block: ReadBlock = { kind: "code", code };
    if (language !== "") block.language = language;
    pushBlock(block);
  }

  function pushTable(el: Element): void {
    const rows: string[][] = [];
    const trs = el.querySelectorAll("tr");
    for (let i = 0; i < trs.length; i += 1) {
      const cells = (trs[i] as Element).querySelectorAll("th, td");
      const row: string[] = [];
      for (let j = 0; j < cells.length; j += 1) row.push(norm((cells[j] as Element).textContent));
      if (row.length > 0) rows.push(row);
    }
    if (rows.length === 0) return;
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const normalized = rows.map((row) => {
      const copy = row.slice();
      while (copy.length < width) copy.push("");
      return copy;
    });
    pushBlock({ kind: "table", rows: normalized });
  }

  function pushQuote(el: Element): void {
    pushBlock({ kind: "quote", inlines: collectInlines(el) });
  }

  function pushList(list: Element, depth: number): void {
    const ordered = tagOf(list) === "OL";
    const start = Number.parseInt(attr(list, "start") || "1", 10);
    let index = Number.isFinite(start) && start > 0 ? start : 1;
    const items = list.children;

    for (let i = 0; i < items.length; i += 1) {
      const li = items[i] as Element;
      if (tagOf(li) !== "LI") continue;

      const inlines = collectInlines(li);
      if (norm(inlines.map((inline) => inline.text).join("")) !== "") {
        const block: ReadBlock = { kind: "listItem", inlines };
        if (ordered) block.marker = index;
        if (depth > 0) block.depth = depth;
        pushBlock(block);
      }
      if (ordered) index += 1;

      for (let j = 0; j < li.children.length; j += 1) {
        const child = li.children[j] as Element;
        const childTag = tagOf(child);
        if (childTag === "UL" || childTag === "OL") pushList(child, depth + 1);
      }
    }
  }

  function pushDefinitionList(el: Element, depth: number): void {
    for (let i = 0; i < el.children.length; i += 1) {
      const child = el.children[i] as Element;
      if (isSkipped(child)) continue;
      const tag = tagOf(child);
      if (tag === "DT") pushParagraph(child);
      else visitElement(child, depth);
    }
  }

  function pushFigure(el: Element, depth: number): void {
    for (let i = 0; i < el.children.length; i += 1) {
      const child = el.children[i] as Element;
      if (isSkipped(child)) continue;
      if (tagOf(child) === "FIGCAPTION") pushParagraph(child);
      else visitElement(child, depth);
    }
  }

  function visitElement(el: Element, depth: number): void {
    const tag = tagOf(el);
    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") {
      pushHeading(el);
      return;
    }
    if (tag === "P") {
      pushParagraph(el);
      return;
    }
    if (tag === "UL" || tag === "OL") {
      pushList(el, depth);
      return;
    }
    if (tag === "DL") {
      pushDefinitionList(el, depth);
      return;
    }
    if (tag === "BLOCKQUOTE") {
      pushQuote(el);
      return;
    }
    if (tag === "PRE") {
      pushCode(el);
      return;
    }
    if (tag === "TABLE") {
      pushTable(el);
      return;
    }
    if (tag === "FIGURE") {
      pushFigure(el, depth);
      return;
    }
    if (tag === "HR" || tag === "BR") return;
    visit(el, depth);
  }

  function visit(container: Element, depth: number): void {
    for (let i = 0; i < container.children.length; i += 1) {
      const child = container.children[i] as Element;
      if (isSkipped(child)) continue;
      visitElement(child, depth);
    }
  }

  const root = chooseExplicit(doc) ?? chooseScored(doc) ?? doc.body ?? doc.documentElement;
  const title = chooseTitle(doc, root);
  // Metadata lives outside the scored container as often as inside it (the Rust
  // blog's byline is a sibling of the post div), so only skipped ancestors —
  // page footers, sidebars — keep a date or author out.
  const metadata = extractMetadata(doc, doc.documentElement);

  visit(root, 0);

  const result: ReadableDocument = { title, blocks };
  if (metadata.byline !== "") result.byline = metadata.byline;
  if (metadata.publishedAt !== "") result.publishedAt = metadata.publishedAt;
  return result;
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

export interface ReadRenderOptions {
  format?: "md" | "text";
  offset?: number;
  maxChars?: number;
}

export interface ReadRender {
  text: string;
  /** Length of `text` (never above `maxChars`). */
  chars: number;
  truncated: boolean;
  /** Character offset to pass back when `truncated` is true. */
  nextOffset?: number;
  /** Length of the whole rendered document, before slicing. */
  totalChars: number;
}

function clampLevel(level: number | undefined): number {
  if (level === undefined || !Number.isFinite(level)) return 1;
  return Math.min(6, Math.max(1, Math.floor(level)));
}

function codeSpan(text: string): string {
  const value = text === "" ? " " : text;
  const runs = value.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function escapeLinkText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** Parentheses/whitespace are legal in a URL but break the Markdown target. */
function encodeHref(href: string): string {
  return href
    .replace(/\s/g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

function renderInlines(inlines: readonly ReadInline[] | undefined, format: "md" | "text"): string {
  const list = inlines || [];
  const parts: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const inline = list[i] as ReadInline;
    if (format === "text") {
      parts.push(inline.text);
      continue;
    }
    if (inline.kind === "code") {
      parts.push(codeSpan(inline.text));
      continue;
    }
    if (inline.kind === "link") {
      const href = typeof inline.href === "string" ? inline.href : "";
      const label = inline.text === "" ? href : inline.text;
      parts.push(`[${escapeLinkText(label)}](${encodeHref(href)})`);
      continue;
    }
    parts.push(inline.text);
  }
  return parts.join("").replace(/[ \t]+$/gm, "").trim();
}

function codeFence(code: string): string {
  const runs = code.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function renderCode(block: ReadBlock): string {
  const code = (block.code || "").replace(/\s+$/, "");
  if (code === "") return "";
  const fence = codeFence(code);
  const language = typeof block.language === "string" ? block.language.replace(/[^a-z0-9+#._-]/gi, "") : "";
  return `${fence}${language}\n${code}\n${fence}`;
}

function renderTable(rows: readonly string[][], format: "md" | "text"): string {
  if (rows.length === 0) return "";
  const clean = (value: string): string => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  if (format === "text") return rows.map((row) => row.map(clean).join(" | ")).join("\n");

  const header = rows[0] as string[];
  const line = `| ${header.map(clean).join(" | ")} |`;
  const separator = `| ${header.map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map((row) => `| ${header.map((_, index) => clean(row[index] || "")).join(" | ")} |`);
  return [line, separator, ...body].join("\n");
}

function renderBlock(block: ReadBlock, format: "md" | "text"): string {
  if (block.kind === "code") {
    if (format === "text") return (block.code || "").trim();
    return renderCode(block);
  }
  if (block.kind === "table") return renderTable(block.rows || [], format);

  const text = renderInlines(block.inlines, format);
  if (text === "") return "";

  if (block.kind === "heading") {
    if (format === "text") return text;
    return `${"#".repeat(clampLevel(block.level))} ${text}`;
  }
  if (block.kind === "listItem") {
    const depth = Math.max(0, Math.min(5, Math.floor(block.depth || 0)));
    const indent = "  ".repeat(depth);
    const marker = block.marker === undefined ? "-" : `${block.marker}.`;
    return `${indent}${marker} ${text}`;
  }
  if (block.kind === "quote" && format === "md") {
    return text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  return text;
}

function joinBlocks(blocks: readonly ReadBlock[], format: "md" | "text"): string {
  let out = "";
  let previousKind: ReadBlockKind | null = null;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i] as ReadBlock;
    const piece = renderBlock(block, format).replace(/^\n+|\n+$/g, "");
    if (piece === "") continue;
    if (out === "") out = piece;
    else if (block.kind === "listItem" && previousKind === "listItem") out += `\n${piece}`;
    else out += `\n\n${piece}`;
    previousKind = block.kind;
  }
  return out;
}

export function blocksToMarkdown(blocks: readonly ReadBlock[]): string {
  return joinBlocks(blocks, "md");
}

export function blocksToText(blocks: readonly ReadBlock[]): string {
  return joinBlocks(blocks, "text");
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return READ_DEFAULT_MAX_CHARS;
  return Math.min(READ_MAX_CHARS_CEILING, Math.max(1, Math.floor(value)));
}

/**
 * Cut one window out of the rendered document. When the cut is not at the end,
 * back off (at most 200 chars / a quarter of the window) to a whitespace
 * boundary so a word or a link is not split; `nextOffset` is the *actual* cut
 * position, so concatenating every window reproduces the document exactly.
 */
function windowText(full: string, offset: number, maxChars: number): ReadRender {
  const totalChars = full.length;
  const start = Math.min(offset, totalChars);
  const end = Math.min(start + maxChars, totalChars);
  let cut = end;

  if (end < totalChars) {
    const floor = Math.max(start + 1, end - Math.min(200, Math.floor(maxChars / 4)));
    let index = end;
    while (index > floor && !/\s/.test(full.charAt(index - 1))) index -= 1;
    if (index > floor) cut = index;
  }

  const text = full.slice(start, cut);
  const truncated = cut < totalChars;
  const result: ReadRender = { text, chars: text.length, truncated, totalChars };
  if (truncated) result.nextOffset = cut;
  return result;
}

/**
 * Render a `ReadableDocument` to Markdown or plain text and return exactly one
 * `offset` window of it. All cap arithmetic lives here so the tool and the
 * fixture tests cannot drift apart.
 */
export function renderReadableDocument(
  data: ReadableDocument,
  options: ReadRenderOptions = {},
): ReadRender {
  const format = options.format === "text" ? "text" : "md";
  const title = typeof data.title === "string" ? data.title.replace(/\s+/g, " ").trim() : "";
  const body = format === "text" ? blocksToText(data.blocks) : blocksToMarkdown(data.blocks);
  const header = title === "" ? "" : format === "text" ? title : `# ${title}`;
  const full = header === "" ? body : body === "" ? header : `${header}\n\n${body}`;

  return windowText(full, normalizeOffset(options.offset), normalizeMaxChars(options.maxChars));
}
