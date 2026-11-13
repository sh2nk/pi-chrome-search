#!/usr/bin/env node
/**
 * Generate the README tool table from the registered tool definitions (S13.3).
 *
 * Usage: `node scripts/gen-readme.mjs [--check]`.
 * `--check` exits 1 when README.md differs from the generated block; CI uses it
 * so a hand-edited table cannot drift from `createTools()`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTools } from "../src/tools/index.ts";
import { README_TOOLS_END, README_TOOLS_START, renderReadmeToolTable } from "../src/tools/surface.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  process.stderr.write("usage: node scripts/gen-readme.mjs [--check]\n");
  process.exit(2);
}

const tools = createTools({
  getDeps: () => {
    throw new Error("gen-readme: rendering the surface must not resolve tool dependencies");
  },
  getDoctorDeps: () => {
    throw new Error("gen-readme: rendering the surface must not resolve tool dependencies");
  },
});

const block = `${README_TOOLS_START}\n${renderReadmeToolTable(tools)}\n${README_TOOLS_END}`;
const current = readFileSync(README, "utf8");
const pattern = new RegExp(`${README_TOOLS_START}[\\s\\S]*?${README_TOOLS_END}`);
if (!pattern.test(current)) {
  process.stderr.write(`README.md is missing the ${README_TOOLS_START} block\n`);
  process.exit(1);
}
const next = current.replace(pattern, block);
if (next === current) process.exit(0);
if (check) {
  process.stderr.write("README.md tool table is stale; run node scripts/gen-readme.mjs\n");
  process.exit(1);
}
writeFileSync(README, next);
