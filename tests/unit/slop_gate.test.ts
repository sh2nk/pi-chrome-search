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
  loadVerdicts,
  simulateReads,
  verdictOfChecks,
  type GateCheck,
  type GateRow,
  type VerdictSet,
} from "../../bench/gate.ts";

const CORPUS = new URL("../../bench/slop.jsonl", import.meta.url).pathname;
const VERDICTS = new URL("../../bench/slop-verdicts.jsonl", import.meta.url).pathname;

function row(overrides: Partial<GateRow>): GateRow {
  return {
    id: "x",
    label: "good",
    source: "curated",
    query: "q",
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

test("V14.2: the recorded classifier reaches the recall and false-skip bar", () => {
  const rows = loadCorpus(CORPUS);
  const verdicts = loadVerdicts(VERDICTS);
  const report = classify(rows, verdicts);

  assert.equal(report.judgedBy, "classifier");
  assert.ok(report.recall !== null && report.recall >= 0.7, `recall ${report.recall}`);
  assert.ok(report.falseSkipsPer20 <= 2, `false skips ${report.falseSkipsPer20} per 20`);
  assert.equal(report.falseSkipRows.length, report.falseSkips, "the false-skip list must match the count");
  assert.equal(report.missed.length, report.skipTotal - report.skipSkipped, "the missed list must match the count");
  assert.ok(verdicts.batches > 0 && verdicts.byId.size >= rows.length - 20, "the replay covers the corpus");

  // The safety floor is measured separately and must be stricter than the model.
  const floor = classify(rows);
  assert.equal(floor.judgedBy, "rules");
  assert.equal(floor.byLabel.unsafe.skipped, floor.byLabel.unsafe.total, "unsafe must never survive the floor");
  assert.equal(floor.falseSkips, 0, "the floor must not refuse a good source");
});

test("V14.3: the observed-SERP population saves reads and never loses a golden source", () => {
  const rows = loadCorpus(CORPUS);
  const verdicts = loadVerdicts(VERDICTS);
  const normal = simulateReads(rows, 4, "serp", verdicts);
  assert.equal(normal.groups, 3, "the live population is the three observed SERPs");
  assert.ok(normal.savedPct >= 25, `saved ${normal.savedPct}% of observed reads`);
  assert.ok(normal.goldensAfter >= normal.goldensBefore, "a golden source was lost");

  // The aggregate is context, not the gate: it averages in synthetic fixtures
  // that contain no real slop, so it must stay visible and unmodified.
  const aggregate = simulateReads(rows, 4, undefined, verdicts);
  assert.equal(aggregate.groups, 18);
  assert.ok(aggregate.savedPct <= normal.savedPct, "the synthetic fixtures can only dilute the saving");
  for (const k of [2, 4, 8]) {
    const simulation = simulateReads(rows, k, undefined, verdicts);
    assert.equal(simulation.k, k);
    assert.ok(simulation.saved <= simulation.reads, "saved cannot exceed reads");
    assert.ok(simulation.junkAfter <= simulation.junkInWindow, `k=${k}: the gate added junk`);
    assert.ok(simulation.junkAfter <= 2, `k=${k}: ${simulation.junkAfter} junk rows survived`);
    assert.ok(simulation.goldensAfter >= simulation.goldensBefore, `k=${k}: a golden source was lost`);
    if (simulation.conditionalReads > 0) {
      assert.ok(
        (simulation.conditionalSavedPct ?? 0) >= 40,
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
  const junkVerdicts: VerdictSet = {
    file: "memory",
    schema: "pi-chrome-search/slop-verdicts@1",
    model: "fake",
    provider: "fake",
    batches: 1,
    pages: 3,
    totalCostUsd: 0,
    latencyPerPageMs: [10],
    latencyOnePageMs: [],
    byId: new Map([
      ["a", { id: "a", worth: false, kind: "slop", abstain: false }],
      ["b", { id: "b", worth: false, kind: "slop", abstain: false }],
      ["c", { id: "c", worth: true, kind: "original", abstain: false }],
    ]),
  };
  const clean: GateRow[] = [
    row({ id: "d", label: "good", source: "serp", url: "https://www.rtings.com/laptop/reviews", title: "Reviews", serp: "h", rank: 1, golden: true }),
    row({ id: "e", label: "good", source: "serp", url: "https://www.pcmag.com/picks/laptops", title: "Picks", serp: "h", rank: 2, golden: true }),
  ];

  const junk = simulateReads(slopHeavy, 2, undefined, junkVerdicts);
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
  const rows = loadCorpus(CORPUS);
  const verdicts = loadVerdicts(VERDICTS);
  const report = evaluateCorpus(rows, CORPUS, verdicts);
  const v143 = report.checks.find((check) => check.id === "V14.3");
  assert.ok(v143);
  assert.equal(v143.verdict, "PASS");
  assert.match(v143.detail, /observed-SERP population/);
  assert.equal(report.readsContext.aggregate.length, 3, "the aggregate stays in the report");
  const cost = report.checks.find((check) => check.id === "V14.4");
  assert.ok(cost);
  assert.equal(cost.verdict, "PASS", "the replay carries real usage and cost");
  assert.ok(report.cost.usdPerDecision <= 0.001 && report.cost.measured);
  const latency = report.checks.find((check) => check.id === "V14.5");
  assert.ok(latency);
  assert.equal(latency.verdict, "PASS");
  assert.ok(report.latency.p95PerPageMs <= 600, `classifier p95 ${report.latency.p95PerPageMs} ms/page`);
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
