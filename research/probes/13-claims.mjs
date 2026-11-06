#!/usr/bin/env node
/**
 * P13 V13.1 probe: does the top claim carry the answer fact?
 *
 * Offline and deterministic. The fixture (`tests/fixtures/claims-qa.json`) has
 * ten queries with a known answer string and the pages `web_research` would
 * read, in read order.
 *
 *   node research/probes/13-claims.mjs --baseline   # shipped P6 lead sentence
 *   node research/probes/13-claims.mjs             # src/extract/claims.ts
 *
 * The baseline is a byte-for-byte copy of the shipped rule (`leadSentence` in
 * `src/tools/web_research.ts` before P13): skip headings/lists/tables/quotes,
 * then take the first sentence of >= 30 chars. It is kept here on purpose —
 * a target without a measured baseline is not a gate.
 */

import { readFileSync } from "node:fs";

const FIXTURE = new URL("../../tests/fixtures/claims-qa.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

// --- the shipped baseline (copied, not imported: P13 replaces the original) ---
const SKIPPED_LINE = /^[#>*|!]|^\d+[.)]\s|^[-+*]\s/;
const CLAIM_MIN_CHARS = 30;
const CLAIM_MAX_CHARS = 200;

function collapse(text) {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text, maxChars) {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function leadSentence(text) {
  for (const line of text.split(/\n+/)) {
    const clean = line.trim();
    if (clean === "" || SKIPPED_LINE.test(clean)) continue;
    for (const part of clean.split(/(?<=[.!?…])\s+/u)) {
      const sentence = collapse(part);
      if (sentence.length < CLAIM_MIN_CHARS) continue;
      return truncate(sentence, CLAIM_MAX_CHARS);
    }
  }
  return null;
}

function baselineTop(entry) {
  for (const page of entry.pages) {
    const text = leadSentence(page.text);
    if (text !== null) return { text, sourceUrl: page.url };
  }
  return null;
}

// --- current implementation -------------------------------------------------
const baseline = process.argv.includes("--baseline");
let selectClaims = null;
if (!baseline) ({ selectClaims } = await import("../../src/extract/claims.ts"));

let hits = 0;
const rows = [];
for (const entry of fixture.cases) {
  const top = baseline
    ? baselineTop(entry)
    : selectClaims(entry.pages, { query: entry.query, maxClaims: 2 })[0];
  const text = top?.text ?? "";
  const hit = text.toLowerCase().includes(entry.answer.toLowerCase());
  if (hit) hits += 1;
  rows.push({ id: entry.id, hit, text, answer: entry.answer, source: top?.sourceUrl ?? "" });
}

const mode = baseline ? "baseline" : "current";
console.log(`claims-qa · ${mode} · top-claim answers ${hits}/${fixture.cases.length}`);
for (const row of rows) {
  console.log(`${row.hit ? "HIT " : "MISS"} ${row.id} (${row.answer})`);
  console.log(`     ${row.text || "<no claim>"}`);
}
process.exitCode = hits >= 8 ? 0 : 1;
