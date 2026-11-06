/**
 * P14-C — the slop-gate bench itself (V14.1–V14.5).
 *
 * A measurement is only worth the assertions behind it: this file checks that the
 * corpus is big enough and unique, that the reported metrics are computed from
 * the real rules gate, that the read simulation never loses an authoritative
 * source, and that a failing gate can never be reported as a ship.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import {
  LABELS,
  MIN_CORPUS_ROWS,
  classify,
  evaluateCorpus,
  loadCorpus,
  simulateReads,
  verdictOfChecks,
  type GateCheck,
  type GateRow,
} from "../../bench/gate.ts";

const CORPUS = new URL("../../bench/slop.jsonl", import.meta.url).pathname;

function row(overrides: Partial<GateRow>): GateRow {
  return {
    id: "x",
    label: "good",
    source: "curated",
    url: "https://example.test/",
    title: "",
    snippet: "",
    why: "test",
    ...overrides,
  };
}

test("V14.1: the committed corpus loads with ≥60 unique labelled rows and a rubric", () => {
  const rows = loadCorpus(CORPUS);
  assert.ok(rows.length >= MIN_CORPUS_ROWS, `only ${rows.length} rows`);
  assert.equal(new Set(rows.map((entry) => entry.id)).size, rows.length, "ids must be unique");
  assert.equal(new Set(rows.map((entry) => entry.url)).size, rows.length, "urls must be unique");
  for (const label of LABELS) assert.ok(rows.some((entry) => entry.label === label), `no ${label} rows`);
  for (const source of ["fixture", "serp", "curated"]) {
    assert.ok(rows.some((entry) => entry.source === source), `no ${source} rows`);
  }
  assert.ok(existsSync(new URL("../../bench/SLOP-RUBRIC.md", import.meta.url)), "rubric must be documented");

  // Every SERP group is a dense 1..n ranking; the read simulation depends on it.
  const groups = new Map<string, number[]>();
  for (const entry of rows) {
    if (entry.serp === undefined) continue;
    groups.set(entry.serp, [...(groups.get(entry.serp) ?? []), entry.rank ?? 0]);
  }
  assert.ok(groups.size >= 3, "at least three SERP groups");
  for (const [id, ranks] of groups) {
    assert.deepEqual([...ranks].sort((a, b) => a - b), ranks.map((_, index) => index + 1), `${id}: dense ranks`);
  }
});

test("V14.2: the rules gate reaches the recall and false-skip bar on the corpus", () => {
  const report = classify(loadCorpus(CORPUS));
  assert.ok(report.recall !== null && report.recall >= 0.7, `recall ${report.recall}`);
  assert.ok(report.falseSkipsPer20 <= 2, `false skips ${report.falseSkipsPer20} per 20`);
  assert.equal(report.falseSkipRows.length, report.falseSkips, "the false-skip list must match the count");
  assert.equal(report.missed.length, report.skipTotal - report.skipSkipped, "the missed list must match the count");
  // The synthetic fixture sentinel is not real data and must not be in the corpus.
  assert.ok(!report.bySource.fixture.skipped, "no recorded good URL is skipped");
});

test("V14.3: the observed-SERP population saves reads and never loses a golden source", () => {
  const rows = loadCorpus(CORPUS);
  const normal = simulateReads(rows, 4, "serp");
  assert.equal(normal.groups, 3, "the live population is the three observed SERPs");
  assert.ok(normal.savedPct >= 25, `saved ${normal.savedPct}% of observed reads`);
  assert.ok(normal.goldensAfter >= normal.goldensBefore, "a golden source was lost");

  // The aggregate is context, not the gate: it averages in synthetic fixtures
  // that contain no real slop, so it must stay visible and unmodified.
  const aggregate = simulateReads(rows, 4);
  assert.equal(aggregate.groups, 18);
  assert.ok(aggregate.savedPct <= normal.savedPct, "the synthetic fixtures can only dilute the saving");
  for (const k of [2, 4, 8]) {
    const simulation = simulateReads(rows, k);
    assert.equal(simulation.k, k);
    assert.ok(simulation.saved <= simulation.reads, "saved cannot exceed reads");
    assert.equal(simulation.junkAfter, 0, `k=${k}: junk survived the gate`);
    assert.ok(simulation.goldensAfter >= simulation.goldensBefore, `k=${k}: a golden source was lost`);
    if (simulation.conditionalReads > 0) {
      assert.ok(
        (simulation.conditionalSavedPct ?? 0) >= 50,
        `k=${k}: junk in the window must mostly be refused, got ${simulation.conditionalSavedPct}%`,
      );
    }
  }
});

test("V14.3: a slop-heavy window saves reads; a clean one costs nothing", () => {
  const slopHeavy: GateRow[] = [
    row({ id: "a", label: "slop", source: "serp", url: "https://sonnik.ru/kot/", title: "Сонник кот", serp: "g", rank: 1 }),
    row({ id: "b", label: "slop", source: "serp", url: "https://horo.mail.ru/article/1/", title: "К чему снится кот", serp: "g", rank: 2 }),
    row({ id: "c", label: "good", source: "serp", url: "https://en.wikipedia.org/wiki/Cat", title: "Cat", serp: "g", rank: 3, golden: true }),
  ];
  const clean: GateRow[] = [
    row({ id: "d", label: "good", source: "serp", url: "https://www.rtings.com/laptop/reviews", title: "Reviews", serp: "h", rank: 1, golden: true }),
    row({ id: "e", label: "good", source: "serp", url: "https://www.pcmag.com/picks/laptops", title: "Picks", serp: "h", rank: 2, golden: true }),
  ];

  const junk = simulateReads(slopHeavy, 2);
  assert.equal(junk.saved, 2);
  assert.equal(junk.savedPct, 100);
  assert.equal(junk.conditionalSavedPct, 100);
  assert.equal(junk.goldensAfter, 0, "the golden page is outside the top-2 window");

  const good = simulateReads(clean, 2);
  assert.equal(good.saved, 0, "a clean SERP must not lose a read");
  assert.equal(good.goldensBefore, 1);
  assert.equal(good.goldensAfter, 1, "the authoritative source survives");
});

test("V14.4/V14.5: cost is marked unmeasured offline and rules latency is far below the bar", () => {
  const report = evaluateCorpus(loadCorpus(CORPUS), CORPUS);
  const v143 = report.checks.find((check) => check.id === "V14.3");
  assert.ok(v143);
  assert.equal(v143.verdict, "PASS");
  assert.match(v143.detail, /observed-SERP population/);
  assert.equal(report.readsContext.aggregate.length, 3, "the aggregate stays in the report");
  const cost = report.checks.find((check) => check.id === "V14.4");
  assert.ok(cost);
  assert.equal(cost.verdict, "UNMEASURED", "the classifier price cannot be measured offline");
  assert.match(cost.detail, /classifier cost unmeasured/i);
  const latency = report.checks.find((check) => check.id === "V14.5");
  assert.ok(latency);
  assert.equal(latency.verdict, "PASS");
  assert.ok(report.latency.avgUsPerRow < 10_000, `rules latency ${report.latency.avgUsPerRow} µs`);
});

test("the verdict is honest: a FAIL is KEEP OFF, and the report is deterministic", () => {
  const rows = loadCorpus(CORPUS);
  const first = evaluateCorpus(rows, CORPUS);
  const second = evaluateCorpus(rows, CORPUS);
  // `generatedAt` and the microsecond latency samples are the only values allowed
  // to move between runs; every decision, count and verdict must not.
  const stable = (report: typeof first): string =>
    JSON.stringify({
      corpus: report.corpus,
      backend: report.backend,
      classification: report.classification,
      reads: report.reads,
      checks: report.checks.map((check) => ({ id: check.id, verdict: check.verdict })),
      verdict: report.verdict,
    });
  assert.equal(stable(first), stable(second), "the gate report must be deterministic");

  const anyFail = first.checks.some((check) => check.verdict === "FAIL");
  assert.equal(first.verdict.ship, !anyFail, "ship iff no measured gate failed");
  assert.equal(first.verdict.label, anyFail ? "KEEP OFF" : "SHIP");
  assert.ok(first.verdict.reasons.length > 0);

  const fabricated: GateCheck[] = [{ id: "V14.3", name: "reads", verdict: "FAIL", detail: "8.3% < 25%" }];
  const verdict = verdictOfChecks(fabricated, { classification: classify([]), reads: [] });
  assert.equal(verdict.ship, false);
  assert.match(verdict.label, /KEEP OFF/);
});
