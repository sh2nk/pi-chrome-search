#!/usr/bin/env node
/**
 * Generate `docs/config.md` from the config schema (S13.3).
 *
 * Usage: `node scripts/gen-config-doc.mjs [--check]`.
 * `--check` exits 1 when the file differs from generator output; `npm run lint`
 * runs it through the audit, so a hand-edited table cannot drift.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderConfigDoc } from "../src/config/doc.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "docs/config.md");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  process.stderr.write("usage: node scripts/gen-config-doc.mjs [--check]\n");
  process.exit(2);
}

const next = renderConfigDoc();
let current = "";
try {
  current = readFileSync(TARGET, "utf8");
} catch {
  current = "";
}

if (next === current) process.exit(0);
if (check) {
  process.stderr.write("docs/config.md is stale; run node scripts/gen-config-doc.mjs\n");
  process.exit(1);
}
writeFileSync(TARGET, next);
