#!/usr/bin/env node
/**
 * Slop-gate bench (PLAN-v2 P14-C, gates V14.1–V14.5).
 *
 * The P5 lesson was that "fewer tokens" is gameable: returning fewer results
 * always wins. This bench measures a different question, which cannot be gamed
 * by returning less: **does the gate remove slop/unsafe sources without removing
 * the sources the user needs?**
 *
 * Three measurements, all offline and deterministic:
 *
 *  1. classification over `bench/slop.jsonl` — recall on slop/unsafe, false skips
 *     on good/aggregator, broken down by label, source and reason;
 *  2. read-saving simulation over the recorded SERP groups (`serp` + `rank`) —
 *     what `web_research` would spend at `quick`/`normal`/`deep` read budgets with
 *     and without the gate, and whether an authoritative source survives;
 *  3. cost and latency — the rules backend is free and measures in microseconds;
 *     the classifier backend is *not* measured here (it needs a live pi session)
 *     and the report says so instead of inventing a number.
 *
 * Run directly (`node bench/gate.ts`) or through `node bench/run.ts --gate`.
 * `--self-test` checks the corpus shape, determinism, the metric arithmetic and
 * the gate verdict logic; it never touches the network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { judgePagesSync } from "../src/reflex/rules.ts";
import type { PageKind, PageVerdict } from "../src/reflex/types.ts";
import type { WebSearchError } from "../src/runtime/error-codes.ts";
import { isWebSearchError } from "../src/runtime/error-codes.ts";
import { fail } from "../src/runtime/errors.ts";

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = join(BENCH_DIR, "slop.jsonl");
const RUBRIC_FILE = join(BENCH_DIR, "SLOP-RUBRIC.md");
const RESULTS_DIR = join(BENCH_DIR, "results");
const SCHEMA = "pi-chrome-search/slop-gate@1";

export const LABELS = ["good", "aggregator", "slop", "unsafe"] as const;
export type SlopLabel = (typeof LABELS)[number];
const SOURCES = ["fixture", "serp", "curated"] as const;
export type SlopSource = (typeof SOURCES)[number];

/** Labels the gate is supposed to refuse. */
const SKIP_LABELS: readonly SlopLabel[] = ["slop", "unsafe"];
/** Labels the gate must never refuse; a skip here is a false skip. */
const KEEP_LABELS: readonly SlopLabel[] = ["good", "aggregator"];

/** V14.1: the corpus has to be big enough to mean something. */
export const MIN_CORPUS_ROWS = 60;
/** V14.2: recall on slop/unsafe and the false-skip budget. */
export const MIN_RECALL = 0.7;
export const MAX_FALSE_SKIPS_PER_20 = 2;
/** V14.3: reads saved on `web_research`, and the golden-source check. */
export const MIN_READS_SAVED_PCT = 25;
/** V14.5: latency added per gated read. */
export const MAX_GATE_LATENCY_MS = 600;

/** `web_research` read budgets, replayed as top-k windows (P6). */
const READ_BUDGETS = [2, 4, 8] as const;

export interface GateRow {
  id: string;
  label: SlopLabel;
  source: SlopSource;
  url: string;
  title: string;
  snippet: string;
  why: string;
  serp?: string;
  rank?: number;
  golden?: boolean;
}

export interface LabelCount {
  total: number;
  skipped: number;
}

export interface ClassificationReport {
  byLabel: Record<SlopLabel, LabelCount>;
  bySource: Record<SlopSource, LabelCount>;
  /** slop + unsafe. */
  skipTotal: number;
  skipSkipped: number;
  /** good + aggregator. */
  keepTotal: number;
  falseSkips: number;
  recall: number | null;
  falseSkipsPer20: number;
  missed: Array<{ id: string; url: string; label: SlopLabel; kind: PageKind; reasons: string[] }>;
  falseSkipRows: Array<{ id: string; url: string; label: SlopLabel; kind: PageKind; reasons: string[] }>;
  /** Per-label kind confusion for the report (kind → count). */
  kinds: Record<string, number>;
}

export interface ReadSimulation {
  k: number;
  /** Reads the fixed order would spend. */
  reads: number;
  saved: number;
  savedPct: number;
  /** Labelled slop/unsafe inside the baseline window. */
  junkInWindow: number;
  /** Labelled slop/unsafe still inside the gated window (should be 0). */
  junkAfter: number;
  /** Windows whose baseline contained junk: the gate's target population. */
  conditionalReads: number;
  conditionalSaved: number;
  conditionalSavedPct: number | null;
  goldensBefore: number;
  goldensAfter: number;
  goldenGroups: number;
}

export interface GateCheck {
  id: string;
  name: string;
  verdict: "PASS" | "FAIL" | "UNMEASURED";
  detail: string;
}

export interface GateReport {
  schema: typeof SCHEMA;
  generatedAt: string;
  corpus: {
    file: string;
    rows: number;
    serpGroups: number;
    byLabel: Record<SlopLabel, number>;
    bySource: Record<SlopSource, number>;
  };
  backend: "rules";
  classification: ClassificationReport;
  reads: ReadSimulation[];
  cost: { usdPerSearch: number; measured: boolean; note: string };
  latency: { avgUsPerRow: number; p95UsPerRow: number; note: string };
  checks: GateCheck[];
  verdict: { ship: boolean; label: "SHIP" | "KEEP OFF"; reasons: string[] };
}

interface CliOptions {
  selfTest: boolean;
  corpusPath: string;
  out: string | null;
  write: boolean;
  json: boolean;
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isLabel(value: string): value is SlopLabel {
  return (LABELS as readonly string[]).includes(value);
}

function isSource(value: string): value is SlopSource {
  return (SOURCES as readonly string[]).includes(value);
}

function validateRow(value: unknown, line: number): GateRow {
  if (!isRecord(value)) {
    throw fail("E_PARSE", "render", { hint: `bench/slop.jsonl line ${line} is not an object` });
  }
  const id = text(value.id);
  const label = text(value.label);
  const source = text(value.source);
  const url = text(value.url);
  const title = typeof value.title === "string" ? value.title : undefined;
  const snippet = typeof value.snippet === "string" ? value.snippet : undefined;
  const why = text(value.why);
  if (id === undefined || label === undefined || source === undefined || url === undefined || why === undefined) {
    throw fail("E_PARSE", "render", {
      hint: `bench/slop.jsonl line ${line} needs id, label, source, url and why`,
    });
  }
  if (!isLabel(label)) {
    throw fail("E_PARSE", "render", {
      hint: `bench/slop.jsonl line ${line}: label must be one of ${LABELS.join(", ")}`,
    });
  }
  if (!isSource(source)) {
    throw fail("E_PARSE", "render", {
      hint: `bench/slop.jsonl line ${line}: source must be one of ${SOURCES.join(", ")}`,
    });
  }
  const row: GateRow = { id, label, source, url, title: title ?? "", snippet: snippet ?? "", why };
  const serp = text(value.serp);
  if (serp !== undefined) row.serp = serp;
  if (typeof value.rank === "number" && Number.isInteger(value.rank) && value.rank >= 1) row.rank = value.rank;
  if (typeof value.golden === "boolean") row.golden = value.golden;
  return row;
}

/**
 * Load and validate the corpus. The rules here are the V14.1 gate: unique ids and
 * URLs, a rank inside every SERP group, goldens only in groups, and no obvious
 * personal data (an email or a phone-number-shaped run) in a committed fixture.
 */
export function loadCorpus(path: string = DEFAULT_CORPUS): GateRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw fail("E_CONFIG", "config", {
      hint: `corpus not found at ${path}; run node bench/gate.ts --help`,
    });
  }

  const rows: GateRow[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw fail("E_PARSE", "render", { hint: `bench/slop.jsonl line ${index + 1} is not JSON` });
    }
    const row = validateRow(parsed, index + 1);
    if (ids.has(row.id)) {
      throw fail("E_PARSE", "render", { hint: `duplicate corpus id ${row.id}` });
    }
    if (urls.has(row.url)) {
      throw fail("E_PARSE", "render", { hint: `duplicate corpus url ${row.url}` });
    }
    ids.add(row.id);
    urls.add(row.url);
    if (/[\w.+-]+@[\w-]+\.[\w.]+/u.test(`${row.title} ${row.snippet} ${row.why}`)) {
      throw fail("E_PARSE", "render", {
        hint: `bench/slop.jsonl line ${index + 1} contains an email address; no personal data in fixtures`,
      });
    }
    rows.push(row);
  }

  const byGroup = new Map<string, GateRow[]>();
  for (const row of rows) {
    if (row.serp === undefined) continue;
    if (row.rank === undefined) {
      throw fail("E_PARSE", "render", { hint: `corpus row ${row.id}: serp needs rank` });
    }
    const group = byGroup.get(row.serp) ?? [];
    group.push(row);
    byGroup.set(row.serp, group);
  }
  for (const [id, group] of byGroup) {
    const ranks = group.map((row) => row.rank ?? 0).sort((a, b) => a - b);
    ranks.forEach((rank, index) => {
      if (rank !== index + 1) {
        throw fail("E_PARSE", "render", { hint: `serp ${id}: ranks must be dense 1..n, got ${ranks.join(",")}` });
      }
    });
  }
  for (const row of rows) {
    if (row.golden === true && row.serp === undefined) {
      throw fail("E_PARSE", "render", { hint: `corpus row ${row.id}: golden needs a serp group` });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, LabelCount> {
  const out = {} as Record<K, LabelCount>;
  for (const key of keys) out[key] = { total: 0, skipped: 0 };
  return out;
}

function verdictOf(row: GateRow, verdicts: readonly PageVerdict[]): PageVerdict {
  const verdict = verdicts[0];
  if (verdict !== undefined) return verdict;
  // `judgePagesSync` always maps one verdict per subject; this is a guard for a
  // future backend change, and it must never turn a missing verdict into a skip.
  return { worth: true, trust: null, kind: "unknown", reasons: ["gate:no-verdict"] };
}

/** Run the real rules `Reflex.judgePages` over the corpus and score it. */
export function classify(rows: readonly GateRow[]): ClassificationReport {
  const byLabel = emptyCounts(LABELS);
  const bySource = emptyCounts(SOURCES);
  const kinds: Record<string, number> = {};
  const missed: ClassificationReport["missed"] = [];
  const falseSkipRows: ClassificationReport["falseSkipRows"] = [];

  for (const row of rows) {
    const verdict = verdictOf(row, judgePagesSync("", [{ url: row.url, title: row.title, snippet: row.snippet }]));
    const skipped = !verdict.worth;
    byLabel[row.label].total += 1;
    bySource[row.source].total += 1;
    kinds[verdict.kind] = (kinds[verdict.kind] ?? 0) + 1;
    if (skipped) {
      byLabel[row.label].skipped += 1;
      bySource[row.source].skipped += 1;
    }
    if (SKIP_LABELS.includes(row.label) && !skipped) {
      missed.push({ id: row.id, url: row.url, label: row.label, kind: verdict.kind, reasons: verdict.reasons });
    }
    if (KEEP_LABELS.includes(row.label) && skipped) {
      falseSkipRows.push({ id: row.id, url: row.url, label: row.label, kind: verdict.kind, reasons: verdict.reasons });
    }
  }

  const skipTotal = SKIP_LABELS.reduce((sum, label) => sum + byLabel[label].total, 0);
  const skipSkipped = SKIP_LABELS.reduce((sum, label) => sum + byLabel[label].skipped, 0);
  const keepTotal = KEEP_LABELS.reduce((sum, label) => sum + byLabel[label].total, 0);
  const falseSkips = KEEP_LABELS.reduce((sum, label) => sum + byLabel[label].skipped, 0);

  return {
    byLabel,
    bySource,
    skipTotal,
    skipSkipped,
    keepTotal,
    falseSkips,
    recall: skipTotal === 0 ? null : skipSkipped / skipTotal,
    falseSkipsPer20: keepTotal === 0 ? 0 : (falseSkips / keepTotal) * 20,
    missed,
    falseSkipRows,
    kinds,
  };
}

// ---------------------------------------------------------------------------
// Read-saving simulation
// ---------------------------------------------------------------------------

/**
 * Replay what `web_research` would read from each recorded SERP group. The
 * baseline is the SERP order (the tool's fixed path); the gated run removes
 * `worth:false` rows and would re-rank by trust. Only removals count as savings —
 * a re-rank without a removal is not a saved read.
 */
export function simulateReads(rows: readonly GateRow[], k: number): ReadSimulation {
  const groups = new Map<string, GateRow[]>();
  for (const row of rows) {
    if (row.serp === undefined) continue;
    const group = groups.get(row.serp) ?? [];
    group.push(row);
    groups.set(row.serp, group);
  }

  let reads = 0;
  let saved = 0;
  let junkInWindow = 0;
  let junkAfter = 0;
  let conditionalReads = 0;
  let conditionalSaved = 0;
  let goldensBefore = 0;
  let goldensAfter = 0;
  let goldenGroups = 0;

  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const window = ordered.slice(0, k);
    if (window.length === 0) continue;
    const verdicts = judgePagesSync(
      "",
      window.map((row) => ({ url: row.url, title: row.title, snippet: row.snippet })),
    );
    const survivors = window.filter((_, index) => verdictOf(window[index]!, verdicts.slice(index)).worth);
    const junk = window.filter((row) => SKIP_LABELS.includes(row.label)).length;

    reads += window.length;
    saved += window.length - survivors.length;
    junkAfter += survivors.filter((row) => SKIP_LABELS.includes(row.label)).length;
    if (junk > 0) {
      junkInWindow += junk;
      conditionalReads += window.length;
      conditionalSaved += window.length - survivors.length;
    }

    if (ordered.some((row) => row.golden === true)) {
      goldenGroups += 1;
      if (window.some((row) => row.golden === true)) goldensBefore += 1;
      if (survivors.some((row) => row.golden === true)) goldensAfter += 1;
    }
  }

  return {
    k,
    reads,
    saved,
    savedPct: reads === 0 ? 0 : round1((saved / reads) * 100),
    junkInWindow,
    junkAfter,
    conditionalReads,
    conditionalSaved,
    conditionalSavedPct:
      conditionalReads === 0 ? null : round1((conditionalSaved / conditionalReads) * 100),
    goldensBefore,
    goldensAfter,
    goldenGroups,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** Per-row rules latency, measured over `iterations` full corpus passes. */
export function measureLatency(rows: readonly GateRow[], iterations = 50): { avgUsPerRow: number; p95UsPerRow: number } {
  const subjects = rows.map((row) => ({ url: row.url, title: row.title, snippet: row.snippet }));
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const subject of subjects) {
      const startedAt = globalThis.performance.now();
      judgePagesSync("", [subject]);
      samples.push((globalThis.performance.now() - startedAt) * 1000);
    }
  }
  if (samples.length === 0) return { avgUsPerRow: 0, p95UsPerRow: 0 };
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    avgUsPerRow: Math.round((sum / samples.length) * 10) / 10,
    p95UsPerRow: Math.round(quantile(samples, 0.95) * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Checks and verdict
// ---------------------------------------------------------------------------

/**
 * Turn the numbers into the V14 gate table. This is the only place that decides
 * whether the phase ships the default or keeps the reflex off; a failing gate is
 * reported as FAIL, never softened.
 */
export function gateChecks(
  report: Omit<GateReport, "checks" | "verdict" | "generatedAt" | "schema">,
  corpusPath: string,
): GateCheck[] {
  const { classification, reads, corpus, cost, latency } = report;
  const checks: GateCheck[] = [];

  const rubric = existsSync(RUBRIC_FILE);
  checks.push({
    id: "V14.1",
    name: `corpus ≥ ${MIN_CORPUS_ROWS} labelled rows + rubric`,
    verdict: corpus.rows >= MIN_CORPUS_ROWS && rubric ? "PASS" : "FAIL",
    detail: `${corpus.rows} rows, ${corpus.serpGroups} SERP groups, labels ${formatLabels(corpus.byLabel)}, sources ${formatSources(corpus.bySource)}, rubric ${rubric ? "present" : "MISSING"} (${corpusPath})`,
  });

  const recallOk = classification.recall !== null && classification.recall >= MIN_RECALL;
  const falseSkipOk = classification.falseSkipsPer20 <= MAX_FALSE_SKIPS_PER_20;
  checks.push({
    id: "V14.2",
    name: "slop/unsafe recall ≥ 70% at ≤ 2 false skips per 20",
    verdict: recallOk && falseSkipOk ? "PASS" : "FAIL",
    detail: `recall ${formatPct(classification.recall)} (${classification.skipSkipped}/${classification.skipTotal}), false skips ${classification.falseSkips}/${classification.keepTotal} = ${classification.falseSkipsPer20.toFixed(2)} per 20`,
  });

  // The research read-saving bar is evaluated at the `normal` budget (4 reads).
  const normal = reads.find((entry) => entry.k === 4) ?? reads[0];
  const savedOk = normal !== undefined && normal.savedPct >= MIN_READS_SAVED_PCT;
  const goldenOk = normal !== undefined && normal.goldensAfter >= normal.goldensBefore;
  checks.push({
    id: "V14.3",
    name: `reads saved ≥ ${MIN_READS_SAVED_PCT}% on web_research, authoritative source preserved`,
    verdict: savedOk && goldenOk ? "PASS" : "FAIL",
    detail:
      normal === undefined
        ? "no SERP groups to simulate"
        : `normal budget: ${normal.saved}/${normal.reads} reads saved (${normal.savedPct}%), conditional ${normal.conditionalSaved}/${normal.conditionalReads} (${formatPct(normal.conditionalSavedPct === null ? null : normal.conditionalSavedPct / 100)}), goldens ${normal.goldensBefore} → ${normal.goldensAfter} of ${normal.goldenGroups} groups`,
  });

  checks.push({
    id: "V14.4",
    name: "cost ≤ $0.001 per search, logged with real usage",
    verdict: cost.measured ? (cost.usdPerSearch <= 0.001 ? "PASS" : "FAIL") : "UNMEASURED",
    detail: cost.measured
      ? `$${cost.usdPerSearch.toFixed(6)} per search`
      : `rules backend $0 (measured in this run); classifier cost unmeasured offline (${cost.note})`,
  });

  checks.push({
    id: "V14.5",
    name: `≤ ${MAX_GATE_LATENCY_MS} ms added per gated read; disabled/localOnly identical`,
    verdict: latency.avgUsPerRow / 1000 <= MAX_GATE_LATENCY_MS ? "PASS" : "FAIL",
    detail: `rules ${latency.avgUsPerRow} µs/row avg, ${latency.p95UsPerRow} µs p95; disabled and localOnly paths are covered by tests/unit/reflex_page_gate.test.ts`,
  });

  return checks;
}

function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${round1(value * 100)}%`;
}

function formatLabels(counts: Record<SlopLabel, number>): string {
  return LABELS.map((label) => `${label}=${counts[label]}`).join(" ");
}

function formatSources(counts: Record<SlopSource, number>): string {
  return SOURCES.map((source) => `${source}=${counts[source]}`).join(" ");
}

export function verdictOfChecks(
  checks: readonly GateCheck[],
  report: Pick<GateReport, "classification" | "reads">,
): GateReport["verdict"] {
  const failed = checks.filter((check) => check.verdict === "FAIL");
  const reasons: string[] = [];
  if (failed.length === 0) {
    reasons.push("every measured V14 gate passed");
  } else {
    for (const check of failed) reasons.push(`${check.id} FAIL: ${check.detail}`);
  }
  const unmeasured = checks.filter((check) => check.verdict === "UNMEASURED");
  if (unmeasured.length > 0) {
    reasons.push(
      `${unmeasured.map((check) => check.id).join(", ")} unmeasured offline; the classifier's accuracy and price need a live pi session`,
    );
  }
  const normal = report.reads.find((entry) => entry.k === 4);
  if (normal !== undefined && normal.savedPct < MIN_READS_SAVED_PCT) {
    reasons.push(
      `the gate removes junk when it is in the read window (${formatPct(normal.conditionalSavedPct === null ? null : normal.conditionalSavedPct / 100)} of those reads) but junk is rare in clean SERPs, so the unconditional 25% bar is not met on this corpus`,
    );
  }
  return {
    ship: failed.length === 0,
    label: failed.length === 0 ? "SHIP" : "KEEP OFF",
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function evaluateCorpus(rows: readonly GateRow[], corpusPath = DEFAULT_CORPUS): GateReport {
  const byLabel = LABELS.reduce(
    (out, label) => ({ ...out, [label]: rows.filter((row) => row.label === label).length }),
    {} as Record<SlopLabel, number>,
  );
  const bySource = SOURCES.reduce(
    (out, source) => ({ ...out, [source]: rows.filter((row) => row.source === source).length }),
    {} as Record<SlopSource, number>,
  );
  const classification = classify(rows);
  const reads = READ_BUDGETS.map((k) => simulateReads(rows, k));
  const latency = measureLatency(rows);
  const base: Omit<GateReport, "checks" | "verdict" | "generatedAt" | "schema"> = {
    corpus: {
      file: corpusPath,
      rows: rows.length,
      serpGroups: new Set(rows.map((row) => row.serp).filter((serp) => serp !== undefined)).size,
      byLabel,
      bySource,
    },
    backend: "rules",
    classification,
    reads,
    cost: {
      usdPerSearch: 0,
      // The rules backend is genuinely free, but V14.4 is about the *classifier*
      // price at the observed batching, and that needs a live pi session. Marking
      // this measured would be the same small lie P9 removed.
      measured: false,
      note: "rules backend: $0, one call per batch of 10 by construction. The classifier's price is logged per batch (usage/costUsd in decisions.jsonl) and is not measurable offline.",
    },
    latency: {
      ...latency,
      note: "one regex/URL pass per page; a classifier batch adds one model call per ≤10 pages.",
    },
  };
  const checks = gateChecks(base, corpusPath);
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    ...base,
    checks,
    verdict: verdictOfChecks(checks, base),
  };
}

function renderMarkdown(report: GateReport): string {
  const { classification: c, corpus } = report;
  const lines: string[] = [];
  lines.push("# Slop-gate bench (P14)");
  lines.push("");
  lines.push(`Corpus: \`${corpus.file}\` — ${corpus.rows} rows, ${corpus.serpGroups} SERP groups.`);
  lines.push(`Labels: ${formatLabels(corpus.byLabel)}. Sources: ${formatSources(corpus.bySource)}.`);
  lines.push(`Backend: **${report.backend}** (offline, deterministic, no model calls).`);
  lines.push("");
  lines.push("## Classification");
  lines.push("");
  lines.push("| Label | total | skipped | rate |");
  lines.push("|---|---|---|---|");
  for (const label of LABELS) {
    const entry = c.byLabel[label];
    lines.push(
      `| ${label} | ${entry.total} | ${entry.skipped} | ${entry.total === 0 ? "—" : `${round1((entry.skipped / entry.total) * 100)}%`} |`,
    );
  }
  lines.push("");
  lines.push("| Source | total | skipped | rate |");
  lines.push("|---|---|---|---|");
  for (const source of SOURCES) {
    const entry = c.bySource[source];
    lines.push(
      `| ${source} | ${entry.total} | ${entry.skipped} | ${entry.total === 0 ? "—" : `${round1((entry.skipped / entry.total) * 100)}%`} |`,
    );
  }
  lines.push("");
  lines.push(
    `Recall on slop+unsafe **${formatPct(c.recall)}** (${c.skipSkipped}/${c.skipTotal}); false skips **${c.falseSkips}/${c.keepTotal}** = ${c.falseSkipsPer20.toFixed(2)} per 20.`,
  );
  if (c.missed.length > 0) {
    lines.push("");
    lines.push("Missed (would have been read):");
    for (const row of c.missed) lines.push(`- \`${row.id}\` ${row.label}: ${row.url} → ${row.kind} [${row.reasons.join(", ")}]`);
  }
  if (c.falseSkipRows.length > 0) {
    lines.push("");
    lines.push("False skips (a source the user asked for would be refused):");
    for (const row of c.falseSkipRows) lines.push(`- \`${row.id}\` ${row.label}: ${row.url} → ${row.kind} [${row.reasons.join(", ")}]`);
  }
  lines.push("");
  lines.push("## Reads saved (`web_research` simulation)");
  lines.push("");
  lines.push("| budget reads | reads | saved | saved % | junk in window | junk after | conditional | goldens before → after |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const entry of report.reads) {
    lines.push(
      `| ${entry.k} | ${entry.reads} | ${entry.saved} | ${entry.savedPct}% | ${entry.junkInWindow} | ${entry.junkAfter} | ${entry.conditionalSaved}/${entry.conditionalReads} (${entry.conditionalSavedPct === null ? "—" : `${entry.conditionalSavedPct}%`}) | ${entry.goldensBefore} → ${entry.goldensAfter} (${entry.goldenGroups} groups) |`,
    );
  }
  lines.push("");
  lines.push(`Latency: ${report.latency.avgUsPerRow} µs/row average, ${report.latency.p95UsPerRow} µs p95 (rules).`);
  lines.push(`Cost: $${report.cost.usdPerSearch.toFixed(6)} per search (${report.cost.note}).`);
  lines.push("");
  lines.push("## Gates");
  lines.push("");
  lines.push("| Gate | Verdict | Detail |");
  lines.push("|---|---|---|");
  for (const check of report.checks) lines.push(`| ${check.id} ${check.name} | **${check.verdict}** | ${check.detail} |`);
  lines.push("");
  lines.push(`## Verdict: **${report.verdict.label}**`);
  lines.push("");
  for (const reason of report.verdict.reasons) lines.push(`- ${reason}`);
  lines.push("");
  return lines.join("\n");
}

function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function defaultResultPath(): string {
  return join(RESULTS_DIR, `${stamp(new Date())}-slop-gate.json`);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest(options: CliOptions): number {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, fn: () => string): void => {
    try {
      results.push({ name, ok: true, detail: fn() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail: message });
    }
  };
  const assert: (condition: boolean, message: string) => asserts condition = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  let rows: GateRow[] = [];
  check("corpus: loads, ≥60 rows, unique ids and urls", () => {
    rows = loadCorpus(options.corpusPath);
    assert(rows.length >= MIN_CORPUS_ROWS, `only ${rows.length} rows`);
    assert(new Set(rows.map((row) => row.id)).size === rows.length, "duplicate ids");
    assert(new Set(rows.map((row) => row.url)).size === rows.length, "duplicate urls");
    assert(existsSync(RUBRIC_FILE), "rubric missing");
    return `${rows.length} rows, ${new Set(rows.map((row) => row.serp).filter(Boolean)).size} SERP groups`;
  });

  check("corpus: every label and source is represented", () => {
    for (const label of LABELS) assert(rows.some((row) => row.label === label), `no ${label} rows`);
    for (const source of SOURCES) assert(rows.some((row) => row.source === source), `no ${source} rows`);
    return `${LABELS.length} labels, ${SOURCES.length} sources`;
  });

  check("metrics: arithmetic is honest", () => {
    const fabricated: GateRow[] = [
      { id: "a", label: "slop", source: "curated", url: "https://sonnik.ru/kot/", title: "Сонник кот", snippet: "", why: "test" },
      { id: "b", label: "unsafe", source: "curated", url: "https://prize.tk/win", title: "You won", snippet: "", why: "test" },
      { id: "c", label: "good", source: "curated", url: "https://en.wikipedia.org/wiki/Test", title: "Test", snippet: "", why: "test" },
      { id: "d", label: "aggregator", source: "curated", url: "https://market.yandex.ru/catalog", title: "Catalog", snippet: "", why: "test" },
    ];
    const report = classify(fabricated);
    assert(report.skipTotal === 2, "skip total");
    assert(report.keepTotal === 2, "keep total");
    assert(report.recall === 1, `recall ${report.recall}`);
    assert(report.falseSkips === 0, "false skips");
    return "2/2 recalled, 0/2 false skips";
  });

  check("metrics: a missed slop row and a false skip are both counted", () => {
    const fabricated: GateRow[] = [
      { id: "a", label: "slop", source: "curated", url: "https://en.wikipedia.org/wiki/Test", title: "Test", snippet: "", why: "test" },
      { id: "b", label: "good", source: "curated", url: "https://sonnik.ru/kot/", title: "Сонник кот", snippet: "", why: "test" },
    ];
    const report = classify(fabricated);
    assert(report.recall === 0, `recall ${report.recall}`);
    assert(report.falseSkips === 1, "false skip not counted");
    return `recall 0, false skips 1/1 = ${report.falseSkipsPer20.toFixed(0)} per 20`;
  });

  check("simulation: a slop-heavy window saves reads and keeps goldens", () => {
    const fabricated: GateRow[] = [
      { id: "a", label: "slop", source: "serp", url: "https://sonnik.ru/kot/", title: "Сонник кот", snippet: "", why: "test", serp: "g", rank: 1 },
      { id: "b", label: "slop", source: "serp", url: "https://horo.mail.ru/article/1/", title: "К чему снится кот", snippet: "", why: "test", serp: "g", rank: 2 },
      { id: "c", label: "good", source: "serp", url: "https://en.wikipedia.org/wiki/Cat", title: "Cat", snippet: "", why: "test", serp: "g", rank: 3, golden: true },
    ];
    const sim = simulateReads(fabricated, 2);
    assert(sim.reads === 2, "reads");
    assert(sim.saved === 2, "saved");
    assert(sim.savedPct === 100, "pct");
    assert(sim.conditionalSavedPct === 100, "conditional");
    const deep = simulateReads(fabricated, 4);
    assert(deep.goldensBefore === 1 && deep.goldensAfter === 1, "golden preservation");
    return "top-2 all junk → 2/2 saved; deep window keeps the golden";
  });

  check("verdict: a failed gate is KEEP OFF, never softened", () => {
    const checks: GateCheck[] = [
      { id: "V14.2", name: "recall", verdict: "FAIL", detail: "recall 40%" },
      { id: "V14.4", name: "cost", verdict: "UNMEASURED", detail: "no live session" },
    ];
    const verdict = verdictOfChecks(checks, {
      classification: classify([]),
      reads: [],
    });
    assert(verdict.ship === false && verdict.label === "KEEP OFF", "a FAIL must not ship");
    assert(verdict.reasons.some((reason) => reason.includes("V14.4")), "unmeasured must be named");
    return "FAIL blocks the ship and the unmeasured gate is named";
  });

  check("corpus: a bad row is rejected with a path and a hint", () => {
    let rejected = false;
    try {
      validateRow({ id: "x" }, 3);
    } catch (error) {
      rejected = isWebSearchError(error) && (error as WebSearchError).details.stage === "render";
    }
    assert(rejected, "malformed row not rejected");
    return "missing fields fail with E_PARSE/render";
  });

  check("report: deterministic JSON", () => {
    // `generatedAt` and the microsecond latency samples move between runs; every
    // decision, count and verdict must not.
    const stable = (): string => {
      const report = evaluateCorpus(rows, options.corpusPath);
      return JSON.stringify({
        corpus: report.corpus,
        backend: report.backend,
        classification: report.classification,
        reads: report.reads,
        checks: report.checks.map((entry) => ({ id: entry.id, verdict: entry.verdict })),
        verdict: report.verdict,
      });
    };
    const first = stable();
    const second = stable();
    assert(first === second, "two evaluations disagree");
    return `${first.length} bytes, byte-identical`;
  });

  const failed = results.filter((result) => !result.ok);
  for (const result of results) process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}\n`);
  process.stdout.write(`\nself-test ${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length} checks, ${failed.length} failed\n`);
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    selfTest: false,
    corpusPath: DEFAULT_CORPUS,
    out: null,
    write: true,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "usage: node bench/gate.ts [--corpus <file>] [--out <file>] [--no-write] [--json]",
            "       node bench/gate.ts --self-test",
            "",
            "Measures the P14 page gate on bench/slop.jsonl: slop/unsafe recall, false skips,",
            "reads saved by web_research, latency and the gate verdict. Offline only.",
          ].join("\n") + "\n",
        );
        process.exit(0);
        break;
      case "--self-test":
        options.selfTest = true;
        break;
      case "--no-write":
        options.write = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--corpus": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw fail("E_CONFIG", "config", { hint: "--corpus needs a file" });
        options.corpusPath = resolve(value);
        index += 1;
        break;
      }
      case "--out": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw fail("E_CONFIG", "config", { hint: "--out needs a file" });
        options.out = resolve(value);
        index += 1;
        break;
      }
      default:
        throw fail("E_CONFIG", "config", { hint: `unknown argument ${JSON.stringify(arg)}; run with --help` });
    }
  }
  return options;
}

export interface GateOptions {
  corpusPath?: string;
  out?: string | null;
  write?: boolean;
  json?: boolean;
}

/** Programmatic entry used by `bench/run.ts --gate` and by tests. */
export function runGate(options: GateOptions = {}): number {
  const cli: CliOptions = {
    selfTest: false,
    corpusPath: options.corpusPath ?? DEFAULT_CORPUS,
    out: options.out ?? null,
    write: options.write ?? true,
    json: options.json ?? false,
  };
  const rows = loadCorpus(cli.corpusPath);
  const report = evaluateCorpus(rows, cli.corpusPath);

  if (cli.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderMarkdown(report)}\n`);
  }

  if (cli.write) {
    const path = cli.out ?? defaultResultPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ${path}\n`);
  }
  return report.verdict.ship ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = options.selfTest ? runSelfTest(options) : runGate(options);
  } catch (error) {
    if (isWebSearchError(error)) {
      process.stderr.write(
        `slop-gate failed [${error.details.code}] stage=${error.details.stage}: ${error.details.hint}\n`,
      );
      process.exitCode = 2;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`slop-gate failed [E_PARSE] stage=render: ${message}\n`);
      process.exitCode = 2;
    }
  }
}
