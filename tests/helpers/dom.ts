/**
 * Fixture DOM harness for engine adapter tests (P3).
 *
 * Adapters extract from the *live* DOM, so they must run the same code in the
 * browser and in a test. The convention this harness enforces:
 *
 *   - an adapter exposes `extractFromDocument(doc, query)` as a self-contained
 *     function (no imports, no closures) returning plain JSON;
 *   - live code sends it with `page.evaluate(\`(${extractFromDocument})(document, …)\`)`,
 *     which only works because the function serialises with `toString()`;
 *   - tests here parse a captured fixture with linkedom and call the *same*
 *     source through `runInPage`, which stringifies it inside a `node:vm`
 *     context — so a fixture test fails when a selector or a free variable is
 *     wrong, exactly like the browser would.
 *
 * `linkedom` is a devDependency for tests only; nothing in `src/` imports it.
 * `innerText` is not implemented there, which is why extractors use
 * `textContent` plus explicit whitespace normalisation.
 */

import vm from "node:vm";

import { parseHTML } from "linkedom";

/**
 * Parse sanitized fixture HTML into a document the extractors can query.
 * `window` is provided for extractors that read `location` or `document`.
 */
export function fixtureDocument(html: string, url = "https://example.test/search"): Document {
  const { document, window } = parseHTML(html);
  // Keep the document addressable the way a live page is: extractors may need
  // `baseURI`/`location` to resolve relative links.
  Object.defineProperty(document, "baseURI", { value: url, configurable: true });
  Object.defineProperty(document, "URL", { value: url, configurable: true });
  if (window !== undefined && window !== null) {
    Object.defineProperty(window, "location", {
      value: new URL(url),
      configurable: true,
    });
  }
  return document as unknown as Document;
}

/**
 * Run an extractor the way the browser does: `fn` is stringified, so it may not
 * capture anything from its module. Throws if the function is not serialisable
 * (arrow functions with comments are fine; closures fail at call time).
 */
export function runInPage<T>(fn: (doc: Document, arg: unknown) => T, document: Document, arg: unknown): T {
  const source = `(${fn.toString()})`;
  const context = vm.createContext({
    document,
    window: (document as unknown as { defaultView?: unknown }).defaultView,
    location: (document as unknown as { location?: unknown }).location,
    Node: (document.defaultView as unknown as { Node?: unknown } | null)?.Node,
    Element: (document.defaultView as unknown as { Element?: unknown } | null)?.Element,
    HTMLElement: (document.defaultView as unknown as { HTMLElement?: unknown } | null)?.HTMLElement,
    URL,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    decodeURIComponent,
    encodeURIComponent,
  });
  const script = new vm.Script(
    `(${source})`,
    { filename: "extract-in-page.js" },
  );
  const callable = script.runInContext(context) as (doc: Document, value: unknown) => T;
  return callable(document, arg);
}
