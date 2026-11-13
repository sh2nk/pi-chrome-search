/**
 * SPEC S13.4: every engine selector is backed by a sanitized fixture, and the
 * fixture set and `docs/engines.md` name the same files.
 *
 * This is the offline half of the selector contract: a new fixture that nobody
 * asserts, or a documented fixture that does not exist, fails here instead of in
 * the doctor on a live wall.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(ROOT, "tests/fixtures");
const DOC = readFileSync(join(ROOT, "docs/engines.md"), "utf8");

test("S13.4: every engine fixture is documented", () => {
  const files = readdirSync(FIXTURES).filter((name) => name.endsWith(".html.gz") && !name.startsWith("."));
  assert.ok(files.length >= 6, "the three adapters must keep their positive and wall fixtures");
  for (const file of files) {
    assert.ok(DOC.includes(`tests/fixtures/${file}`), `docs/engines.md does not list ${file}`);
  }
});

test("S13.4: every documented fixture exists", () => {
  for (const match of DOC.matchAll(/tests\/fixtures\/([\w.-]+\.html\.gz)/g)) {
    const name = match[1];
    assert.ok(name !== undefined);
    assert.doesNotThrow(
      () => readFileSync(join(FIXTURES, name)),
      `docs/engines.md names a missing fixture: ${name}`,
    );
  }
});

test("S13.4: every adapter test loads a fixture and every fixture is asserted", () => {
  const tests = ["google", "duckduckgo", "yandex"].map((engine) =>
    readFileSync(join(ROOT, `tests/unit/${engine}.test.ts`), "utf8"),
  );
  const corpus = tests.join("\n");
  for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".html.gz"))) {
    // Fixtures are loaded through `tests/helpers/fixtures.ts` by base name; the
    // assertion is the name appearing in an adapter test.
    const stem = file.replace(/\.html\.gz$/, "");
    assert.ok(
      corpus.includes(stem),
      `${file} is not referenced by any adapter test (a fixture without a test is dead weight)`,
    );
  }
  for (const engine of ["google", "duckduckgo", "yandex"]) {
    assert.match(
      corpus,
      new RegExp(`${engine}[\\s\\S]{0,4000}fixture`, "i"),
      `${engine} must load a fixture in its unit test`,
    );
  }
});
