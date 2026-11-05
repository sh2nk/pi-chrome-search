/**
 * The fixture-DOM harness itself must be real: a broken harness would make
 * every adapter test a green rubber stamp.
 *
 * P3 lanes rely on three guarantees:
 *  1. `fixtureDocument` parses the sanitized captures (including the largest
 *     Google page) and answers selector queries;
 *  2. `runInPage` executes the *stringified* extractor, so module-scope
 *     captures fail here instead of in production;
 *  3. `isSelfContained` rejects a closure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture } from "../helpers/load-fixture.ts";
import { fixtureDocument, runInPage } from "../helpers/dom.ts";

test("fixtureDocument parses a live Google capture and supports selectors", () => {
  const fixture = loadFixture("google-no-ai");
  const document = fixtureDocument(fixture.html, "https://www.google.com/search?q=rust");

  const anchors = document.querySelectorAll("a h3").length;
  assert.ok(anchors >= 5, `expected organics in the fixture, found ${anchors}`);
  assert.ok(document.querySelector("#search") !== null, "#search container must exist");
  const first = document.querySelector("a h3");
  assert.ok(first !== null && (first.textContent ?? "").trim().length > 0);
});

test("fixtureDocument resolves the AI fixture text without innerText", () => {
  const fixture = loadFixture("google-ai");
  const document = fixtureDocument(fixture.html, "https://www.google.com/search?q=transformer");
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
  assert.match(text, /Обзор от ИИ|AI Overview/);
});

test("runInPage executes the stringified extractor against the fixture", () => {
  const document = fixtureDocument("<main><h3>Alpha</h3><h3>Beta</h3></main>");

  function collect(doc: Document): string[] {
    return Array.from(doc.querySelectorAll("h3")).map((node) => (node.textContent ?? "").trim());
  }

  assert.deepEqual(runInPage(collect, document, null), ["Alpha", "Beta"]);
  // The same function called directly must agree with the in-page run.
  assert.deepEqual(collect(document), ["Alpha", "Beta"]);
});

test("runInPage fails on a closure, which the browser would also fail to run", () => {
  const prefix = "captured-from-module-scope";
  function broken(doc: Document): string {
    return prefix + (doc.title ?? "");
  }

  const document = fixtureDocument("<title>t</title>");
  assert.throws(() => runInPage(broken, document, null), /prefix|not defined/i);
});
