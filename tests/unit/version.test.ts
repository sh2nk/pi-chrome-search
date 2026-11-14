/**
 * P0 (SPEC A5): the package manifest is the only source of the version.
 *
 * v1 shipped a hand-maintained `EXTENSION_VERSION = "0.1.0"`, so after the
 * 0.1.1 release the doctor and every artifact still reported 0.1.0. These tests
 * fail the moment the two disagree again.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EXTENSION_NAME, EXTENSION_VERSION } from "../../src/version.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name?: unknown; version?: unknown };

test("the extension version comes from the package manifest", () => {
  assert.equal(EXTENSION_VERSION, manifest.version);
});

test("the extension name matches the package name", () => {
  assert.equal(EXTENSION_NAME, manifest.name);
});

test("the reported version is semver", () => {
  assert.match(EXTENSION_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
