#!/usr/bin/env node
/**
 * Generate `docs/errors.md` from the closed error taxonomy (S9.5, S13.3).
 *
 * Usage: `node scripts/gen-errors-doc.mjs [--check]`.
 * `--check` exits 1 when the file differs from generator output; CI and the
 * audit run it so a hand-edited table cannot drift from `ERROR_CODES`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderErrorsDoc } from "../src/runtime/errors-doc.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "docs/errors.md");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  process.stderr.write("usage: node scripts/gen-errors-doc.mjs [--check]\n");
  process.exit(2);
}

const next = renderErrorsDoc();
let current = "";
try {
  current = readFileSync(TARGET, "utf8");
} catch {
  current = "";
}

if (next === current) process.exit(0);
if (check) {
  process.stderr.write("docs/errors.md is stale; run node scripts/gen-errors-doc.mjs\n");
  process.exit(1);
}
writeFileSync(TARGET, next);
