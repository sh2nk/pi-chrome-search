#!/usr/bin/env node
/**
 * Headless doctor. The canonical gate output is `--json` (PLAN.md V1.3).
 *
 * P0 ships an honest placeholder: it proves the entry point runs without
 * pretending to know the browser. P1-E replaces the body with the real report.
 */

import { EXTENSION_NAME, EXTENSION_VERSION } from "../version.ts";

const json = process.argv.includes("--json");

const report = {
  status: "stub",
  phase: "P0",
  extension: EXTENSION_NAME,
  version: EXTENSION_VERSION,
  node: process.version,
  message: "doctor probes are implemented in P1 (M0); no browser state was inspected",
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${EXTENSION_NAME} ${EXTENSION_VERSION} — doctor stub (P0)\n`);
  process.stdout.write(`${report.message}\n`);
}
