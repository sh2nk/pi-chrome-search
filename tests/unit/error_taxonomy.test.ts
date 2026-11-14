/**
 * Error taxonomy v2 (S9.2, S9.3, S9.5).
 *
 * The code set is closed: a code thrown anywhere in `src/` must be documented,
 * and a documented code must either appear in a test or carry a phased
 * reservation. Hints are executable: every env name and config path they mention
 * must exist, and no hint may advertise a surface deleted by SPEC §15.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ENV_OVERRIDES } from "../../src/config/env.ts";
import {
  ERROR_CODES,
  ERROR_HINTS,
  RESERVED_CODES,
  STAGES,
} from "../../src/runtime/error-codes.ts";
import { renderErrorsDoc } from "../../src/runtime/errors-doc.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function filesUnder(dir: string, suffix = ".ts"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(relative, suffix));
    else if (entry.name.endsWith(suffix)) out.push(relative);
  }
  return out;
}

function textOf(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

const SRC = filesUnder("src").map(textOf).join("\n");
const TESTS = filesUnder("tests").map(textOf).join("\n");
const ERROR_DOC = textOf("docs/errors.md");

test("S9.5: docs/errors.md is generated from the taxonomy", () => {
  assert.equal(ERROR_DOC, renderErrorsDoc(), "docs/errors.md drifted; run node scripts/gen-errors-doc.mjs");
});

test("S9.5: every code mentioned in src is in the closed set", () => {
  const mentioned = new Set(
    (SRC.match(/\bE_[A-Z_]+\b/g) ?? []).filter((token) => !token.endsWith("_")),
  );
  for (const code of mentioned) {
    assert.ok(
      (ERROR_CODES as readonly string[]).includes(code),
      `${code} is used in src but missing from ERROR_CODES`,
    );
  }
});

test("S9.5: every documented code is exercised or reserved with a reason", () => {
  for (const code of ERROR_CODES) {
    assert.ok(ERROR_DOC.includes(`\`${code}\``), `${code} is missing from docs/errors.md`);
    if (TESTS.includes(code)) continue;
    const reason = RESERVED_CODES[code];
    assert.ok(reason !== undefined && reason.length > 0, `${code} has no test and no reservation`);
    assert.ok(ERROR_DOC.includes(code), `reserved ${code} must still be documented`);
  }
});

test("S9.2: every env override named in a hint exists", () => {
  const known = new Set(ENV_OVERRIDES.map((entry) => entry.name));
  for (const [code, hint] of Object.entries(ERROR_HINTS)) {
    for (const name of hint.match(/\bPI_[A-Z_]+\b/g) ?? []) {
      assert.ok(known.has(name), `${code} hint names unknown env ${name}`);
    }
  }
});

test("S9.2: every config path named in a hint exists in the schema", () => {
  const configDoc = textOf("docs/config.md");
  const keyPattern = /(?<![\w-])(?:cdp|window|engines|pacing|search|read|image|cache|artifacts|debug)\.[a-z][A-Za-z0-9.]*/g;
  for (const [code, hint] of Object.entries(ERROR_HINTS)) {
    for (const key of hint.match(keyPattern) ?? []) {
      assert.match(configDoc, new RegExp(`\\\`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\``), `${code} hint names unknown key ${key}`);
    }
  }
});

test("S9.3: hints do not advertise a surface deleted by SPEC §15", () => {
  for (const [code, hint] of Object.entries(ERROR_HINTS)) {
    assert.doesNotMatch(hint, /\bfreshness\b|\bdailyCap\b|\breflex\b|captcha\.|\bE_RATE_LIMITED\b/, code);
  }
  assert.equal(ERROR_CODES.includes("E_RATE_LIMITED" as never), false);
  assert.equal(ERROR_CODES.includes("E_EMPTY_PAGE"), true);
});

test("S9.3: E_PARSE and E_EMPTY_PAGE are disjoint actions", () => {
  assert.match(ERROR_HINTS.E_PARSE, /canary/);
  assert.doesNotMatch(ERROR_HINTS.E_PARSE, /no readable text/);
  assert.match(ERROR_HINTS.E_EMPTY_PAGE, /no readable text/);
  assert.doesNotMatch(ERROR_HINTS.E_EMPTY_PAGE, /canary/);
});

test("the stage set no longer contains the deleted reflex stage", () => {
  assert.equal((STAGES as readonly string[]).includes("reflex"), false);
});
