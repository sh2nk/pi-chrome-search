#!/usr/bin/env node
/**
 * Slop-gate bench (PLAN-v2 P14-C, gates V14.1–V14.5).
 *
 * The P5 lesson was that "fewer tokens" is gameable: returning fewer results
 * always wins. This bench measures a different question, which cannot be gamed
 * by returning less: **does the gate remove slop/off-topic sources without
 * removing the sources the user needs?**
 *
 * Two judges are measured, never mixed up:
 *
 *  - the **rules floor** (`src/reflex/rules.ts`) — offline, free, safety-shaped:
 *    it must refuse every unsafe URL and never refuse a good source;
 *  - the **classifier** — the quality judge — replayed from
 *    `bench/slop-verdicts.jsonl`, which `bench/record.ts` produces in one live,
 *    capped, paid session. Replay keeps this bench deterministic and offline
 *    while measuring the real model's verdicts, cost and latency.
 *
 * The read-saving simulation replays `web_research` over the recorded SERPs
 * (`serp` + `rank`), at `quick`/`normal`/`deep` budgets, and checks that an
 * authoritative source survives. V14.3 is scored on the observed live SERPs;
 * the synthetic P5 fixtures are reported as context because they contain no real
 * slop and averaging them in would measure the corpus, not the gate.
 *
 * Run directly (`node bench/gate.ts`) or through `node bench/run.ts --gate`.
 * `--self-test` checks the corpus shape, determinism, the metric arithmetic and
 * the verdict logic; it never touches the network.
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
const DEFAULT_VERDICTS = join(BENCH_DIR, "slop-verdicts.jsonl");
const RUBRIC_FILE = join(BENCH_DIR, "SLOP-RUBRIC.md");
const RESULTS_DIR = join(BENCH_DIR, "results");
const SCHEMA = "pi-chrome-search/slop-gate@2";

export const LABELS = ["good", "aggregator", "slop", "unsafe", "offtopic"] as const;
export type SlopLabel = (typeof LABELS)[number];
const SOURCES = ["fixture", "serp", "curated"] as const;
export type SlopSource = (typeof SOURCES)[number];
const PAGE_KINDS: readonly PageKind[] = ["original", "aggregator", "forum", "slop", "unsafe", "unknown"];

/** V14.2 quality recall: farms and deception. */
const SKIP_LABELS: readonly SlopLabel[] = ["slop", "unsafe"];
/** Everything the gate is supposed to refuse, including a good page that does not answer this query. */
const JUNK_LABELS: readonly SlopLabel[] = ["slop", "unsafe", "offtopic"];
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
  /**
   * The query the page was judged against. A page is only "worth reading" for a
   * question; the page gate receives the research query (and, in `web_read`, the
   * URL itself). The three live SERPs used generic topics, never personal ones.
   */
  query: string;
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
  /** Which judge produced these numbers: the offline floor or the recorded classifier. */
  judgedBy: "rules" | "classifier";
  /** Rows whose batch abstained and therefore fell back to the rules floor. */
  abstained: number;
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
  /** A high-quality page that does not answer this query: the gate *should* skip it. */
  offtopic: LabelCount;
  missed: Array<{ id: string; url: string; label: SlopLabel; kind: PageKind; reasons: string[] }>;
  falseSkipRows: Array<{ id: string; url: string; label: SlopLabel; kind: PageKind; reasons: string[] }>;
  /** Per-kind counts for the report (kind → count). */
  kinds: Record<string, number>;
}

export interface ReadSimulation {
  k: number;
  /** SERP groups in this population (a group with no window counts as none). */
  groups: number;
  /** Reads the fixed order would spend. */
  reads: number;
  saved: number;
  savedPct: number;
  /** Labelled junk (slop/unsafe/off-topic) inside the baseline window. */
  junkInWindow: number;
  /** Junk still inside the gated window (should be 0). */
  junkAfter: number;
  /** Windows whose baseline contained junk: the gate's target population. */
  conditionalReads: number;
  conditionalSaved: number;
  conditionalSavedPct: number | null;
  goldensBefore: number;
  goldensAfter: number;
  goldenGroups: number;
}

export interface RecordedVerdict {
  id: string;
  worth: boolean;
  kind: PageKind;
  /** True when the whole batch abstained; the row then falls back to rules. */
  abstain: boolean;
}

export interface VerdictSet {
  file: string;
  schema: string;
  model: string | null;
  provider: string | null;
  batches: number;
  pages: number;
  totalCostUsd: number;
  /** Milliseconds per page, one sample per batch (`latencyMs / pages`). */
  latencyPerPageMs: number[];
  /** Milliseconds for single-page batches: the `web_read` case. */
  latencyOnePageMs: number[];
  byId: Map<string, RecordedVerdict>;
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
  /** The judge the numbers below describe. */
  backend: "rules" | "classifier";
  verdicts: {
    file: string;
    model: string | null;
    provider: string | null;
    batches: number;
    pages: number;
    totalCostUsd: number;
    costPerDecisionUsd: number;
    p95PerPageMs: number;
    p95OnePageMs: number;
  } | null;
  /** The shipped judge (classifier when a replay exists, rules otherwise). */
  classification: ClassificationReport;
  /** The offline safety floor, measured on every run. */
  rules: ClassificationReport;
  /**
   * V14.3 population: the observed live SERPs only. The P5 fixture SERPs are
   * synthetic layouts without real slop, so averaging them into a *read-saving*
   * number measures the corpus, not the gate. Both numbers are reported.
   */
  reads: ReadSimulation[];
  readsRules: ReadSimulation[];
  readsContext: { aggregate: ReadSimulation[]; fixture: ReadSimulation[] };
  cost: { usdPerDecision: number; usdPerPage: number; measured: boolean; note: string };
  latency: {
    p95PerPageMs: number;
    p95OnePageMs: number;
    avgOnePageMs: number;
    measured: boolean;
    note: string;
    avgUsPerRow: number;
    p95UsPerRow: number;
  };
  checks: GateCheck[];
  verdict: { ship: boolean; label: "SHIP" | "KEEP OFF"; reasons: string[] };
}

interface CliOptions {
  selfTest: boolean;
  corpusPath: string;
  verdictsPath: string | null;
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

function isPageKind(value: unknown): value is PageKind {
  return typeof value === "string" && (PAGE_KINDS as readonly string[]).includes(value);
}

function validateRow(value: unknown, line: number): GateRow {
  if (!isRecord(value)) {
    throw fail("E_PARSE", "render", { hint: `bench/slop.jsonl line ${line} is not an object` });
  }
  const id = text(value.id);
  const label = text(value.label);
  const source = text(value.source);
  const query = text(value.query);
  const url = text(value.url);
  const title = typeof value.title === "string" ? value.title : undefined;
  const snippet = typeof value.snippet === "string" ? value.snippet : undefined;
  const why = text(value.why);
  if (
    id === undefined ||
    label === undefined ||
    source === undefined ||
    query === undefined ||
    url === undefined ||
    why === undefined
  ) {
    throw fail("E_PARSE", "render", {
      hint: `bench/slop.jsonl line ${line} needs id, label, source, query, url and why`,
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
  const row: GateRow = { id, label, source, query, url, title: title ?? "", snippet: snippet ?? "", why };
  const serp = text(value.serp);
  if (serp !== undefined) row.serp = serp;
  if (typeof value.rank === "number" && Number.isInteger(value.rank) && value.rank >= 1) row.rank = value.rank;
  if (typeof value.golden === "boolean") row.golden = value.golden;
  return row;
}

/**
 * Load and validate the corpus. The rules here are the V14.1 gate: unique ids and
 * URLs, a dense rank inside every SERP group, goldens only in groups, and no
 * obvious personal data (an email or a phone-number-shaped run) in a committed
 * fixture.
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
// Recorded classifier verdicts (replay)
// ---------------------------------------------------------------------------

/**
 * Load `bench/slop-verdicts.jsonl`, written by `bench/record.ts`. The file is a
 * real classifier transcript: one JSON object per batch, with the ids, verdicts,
 * usage/cost and latency of that call. A batch with `abstain:true` is treated as
 * "no model verdict" (the rows fall back to rules), which is what ships.
 */
export function loadVerdicts(path: string = DEFAULT_VERDICTS): VerdictSet {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw fail("E_CONFIG", "config", {
      hint: `verdict replay not found at ${path}; run node bench/record.ts (live, capped) first`,
    });
  }

  const byId = new Map<string, RecordedVerdict>();
  const latencyPerPageMs: number[] = [];
  const latencyOnePageMs: number[] = [];
  let model: string | null = null;
  let provider: string | null = null;
  let batches = 0;
  let pages = 0;
  let totalCostUsd = 0;

  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index] ?? "");
    } catch {
      throw fail("E_PARSE", "render", { hint: `bench/slop-verdicts.jsonl line ${index + 1} is not JSON` });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.verdicts) || !Array.isArray(parsed.ids)) {
      throw fail("E_PARSE", "render", {
        hint: `bench/slop-verdicts.jsonl line ${index + 1}: needs ids[] and verdicts[]`,
      });
    }
    const batchLatency =
      typeof parsed.latencyMs === "number" && Number.isFinite(parsed.latencyMs) ? parsed.latencyMs : 0;
    const abstain = parsed.abstain === true;
    const ids = parsed.ids.filter((id): id is string => typeof id === "string" && id !== "");
    if (ids.length === 0) continue;
    batches += 1;
    pages += ids.length;
    latencyPerPageMs.push(batchLatency / ids.length);
    if (ids.length === 1) latencyOnePageMs.push(batchLatency);
    if (typeof parsed.costUsd === "number" && Number.isFinite(parsed.costUsd)) totalCostUsd += parsed.costUsd;
    if (model === null && typeof parsed.model === "string") model = parsed.model;
    if (provider === null && typeof parsed.provider === "string") provider = parsed.provider;

    for (const verdict of parsed.verdicts) {
      if (!isRecord(verdict) || typeof verdict.id !== "string" || typeof verdict.worth !== "boolean") continue;
      if (!isPageKind(verdict.kind)) continue;
      if (!ids.includes(verdict.id)) continue;
      if (byId.has(verdict.id)) {
        throw fail("E_PARSE", "render", { hint: `verdict replay has duplicate id ${verdict.id}` });
      }
      byId.set(verdict.id, { id: verdict.id, worth: verdict.worth, kind: verdict.kind, abstain });
    }
  }

  if (byId.size === 0) {
    throw fail("E_PARSE", "render", {
      hint: `verdict replay at ${path} contains no usable verdicts; re-run node bench/record.ts`,
    });
  }

  return {
    file: path,
    schema: "pi-chrome-search/slop-verdicts@1",
    model,
    provider,
    batches,
    pages,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    latencyPerPageMs,
    latencyOnePageMs,
    byId,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, LabelCount> {
  const out = {} as Record<K, LabelCount>;
  for (const key of keys) out[key] = { total: 0, skipped: 0 };
  return out;
}

function rulesVerdict(row: GateRow): PageVerdict {
  const verdict = judgePagesSync([{ url: row.url, title: row.title, snippet: row.snippet }])[0];
  // `judgePagesSync` always maps one verdict per subject; this guard must never
  // turn a missing verdict into a skip.
  return verdict ?? { worth: true, trust: null, kind: "unknown", reasons: ["gate:no-verdict"] };
}

/** The verdict the shipped gate would act on: the recorded model answer, or rules on abstain. */
function shippedVerdict(row: GateRow, verdicts: VerdictSet | null): PageVerdict {
  const recorded = verdicts?.byId.get(row.id);
  if (recorded !== undefined && !recorded.abstain) {
    return { worth: recorded.worth, trust: null, kind: recorded.kind, reasons: [`model:${recorded.kind}`] };
  }
  return rulesVerdict(row);
}

/** Run one judge over the corpus and score it. */
export function classify(rows: readonly GateRow[], verdicts: VerdictSet | null = null): ClassificationReport {
  const byLabel = emptyCounts(LABELS);
  const bySource = emptyCounts(SOURCES);
  const kinds: Record<string, number> = {};
  const missed: ClassificationReport["missed"] = [];
  const falseSkipRows: ClassificationReport["falseSkipRows"] = [];
  let abstainedRows = 0;

  for (const row of rows) {
    const recorded = verdicts?.byId.get(row.id);
    if (recorded?.abstain === true) abstainedRows += 1;
    const verdict = shippedVerdict(row, verdicts);
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
    judgedBy: verdicts === null ? "rules" : "classifier",
    abstained: abstainedRows,
    byLabel,
    bySource,
    skipTotal,
    skipSkipped,
    keepTotal,
    falseSkips,
    recall: skipTotal === 0 ? null : skipSkipped / skipTotal,
    falseSkipsPer20: keepTotal === 0 ? 0 : (falseSkips / keepTotal) * 20,
    offtopic: byLabel.offtopic,
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
 * a re-rank without a removal is not a saved read. Each row is judged against
 * its own query: the fixture groups mix two topics on purpose.
 */
export function simulateReads(
  rows: readonly GateRow[],
  k: number,
  source?: SlopSource,
  verdicts: VerdictSet | null = null,
): ReadSimulation {
  const groups = new Map<string, GateRow[]>();
  for (const row of rows) {
    if (row.serp === undefined) continue;
    if (source !== undefined && row.source !== source) continue;
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
  let groupCount = 0;

  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const window = ordered.slice(0, k);
    if (window.length === 0) continue;
    groupCount += 1;
    const survivors = window.filter((row) => shippedVerdict(row, verdicts).worth);
    const junk = window.filter((row) => JUNK_LABELS.includes(row.label)).length;

    reads += window.length;
    saved += window.length - survivors.length;
    junkAfter += survivors.filter((row) => JUNK_LABELS.includes(row.label)).length;
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
    groups: groupCount,
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

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Latency (rules)
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
      judgePagesSync([subject]);
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

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(quantile(sorted, 0.95));
}

function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  return Math.round(samples.reduce((total, value) => total + value, 0) / samples.length);
}

// ---------------------------------------------------------------------------
// Checks and verdict
// ---------------------------------------------------------------------------

/**
 * Turn the numbers into the V14 gate table. This is the only place that decides
 * whether the phase ships the default or keeps the gate off; a failing gate is
 * reported as FAIL, never softened. A gate that cannot be measured offline is
 * UNMEASURED and named in the verdict, never guessed.
 */
export function gateChecks(
  report: Omit<GateReport, "checks" | "verdict" | "generatedAt" | "schema">,
  corpusPath: string,
): GateCheck[] {
  const { classification, rules, reads, corpus, cost, latency, verdicts } = report;
  const checks: GateCheck[] = [];

  const rubric = existsSync(RUBRIC_FILE);
  checks.push({
    id: "V14.1",
    name: `corpus ≥ ${MIN_CORPUS_ROWS} labelled rows + rubric`,
    verdict: corpus.rows >= MIN_CORPUS_ROWS && rubric ? "PASS" : "FAIL",
    detail: `${corpus.rows} rows, ${corpus.serpGroups} SERP groups, labels ${formatLabels(corpus.byLabel)}, sources ${formatSources(corpus.bySource)}, rubric ${rubric ? "present" : "MISSING"} (${corpusPath})`,
  });

  checks.push({
    id: "V14.2a",
    name: "rules safety floor: every unsafe URL refused, no good source refused",
    verdict: rules.byLabel.unsafe.total > 0 && rules.byLabel.unsafe.skipped === rules.byLabel.unsafe.total && rules.falseSkips === 0 ? "PASS" : "FAIL",
    detail: `unsafe ${rules.byLabel.unsafe.skipped}/${rules.byLabel.unsafe.total} refused, false skips ${rules.falseSkips}/${rules.keepTotal}, slop ${rules.byLabel.slop.skipped}/${rules.byLabel.slop.total} (quality is the classifier's job)`,
  });

  if (verdicts === null) {
    checks.push({
      id: "V14.2b",
      name: "classifier quality: slop/unsafe recall ≥ 70% at ≤ 2 false skips per 20",
      verdict: "UNMEASURED",
      detail:
        "no bench/slop-verdicts.jsonl replay; run node bench/record.ts (live, capped) to measure the real judge",
    });
  } else {
    const recallOk = classification.recall !== null && classification.recall >= MIN_RECALL;
    const falseSkipOk = classification.falseSkipsPer20 <= MAX_FALSE_SKIPS_PER_20;
    checks.push({
      id: "V14.2b",
      name: "classifier quality: slop/unsafe recall ≥ 70% at ≤ 2 false skips per 20",
      verdict: recallOk && falseSkipOk ? "PASS" : "FAIL",
      detail: `${classification.judgedBy} replay (${verdicts.model ?? "?"}, ${verdicts.batches} batches, ${classification.abstained} abstained rows): recall ${formatPct(classification.recall)} (${classification.skipSkipped}/${classification.skipTotal}), false skips ${classification.falseSkips}/${classification.keepTotal} = ${classification.falseSkipsPer20.toFixed(2)} per 20; off-topic ${classification.offtopic.skipped}/${classification.offtopic.total} refused`,
    });
  }

  const normal = reads.find((entry) => entry.k === 4) ?? reads[0];
  if (verdicts === null || normal === undefined) {
    checks.push({
      id: "V14.3",
      name: `reads saved ≥ ${MIN_READS_SAVED_PCT}% on web_research, authoritative source preserved`,
      verdict: "UNMEASURED",
      detail: "needs the classifier replay; the rules floor refuses too little to measure read savings",
    });
  } else {
    const savedOk = normal.savedPct >= MIN_READS_SAVED_PCT;
    const goldenOk = normal.goldensAfter >= normal.goldensBefore;
    checks.push({
      id: "V14.3",
      name: `reads saved ≥ ${MIN_READS_SAVED_PCT}% on web_research, authoritative source preserved`,
      verdict: savedOk && goldenOk ? "PASS" : "FAIL",
      detail: `observed-SERP population (${normal.groups} groups), normal budget: ${normal.saved}/${normal.reads} reads saved (${normal.savedPct}%), conditional ${normal.conditionalSaved}/${normal.conditionalReads} (${formatPct(normal.conditionalSavedPct === null ? null : normal.conditionalSavedPct / 100)}), goldens ${normal.goldensBefore} → ${normal.goldensAfter} of ${normal.goldenGroups} groups; aggregate incl. synthetic fixtures: see report`,
    });
  }

  checks.push({
    id: "V14.4",
    name: "cost ≤ $0.001 per search, logged with real usage",
    verdict: verdicts === null ? "UNMEASURED" : cost.usdPerDecision <= 0.001 ? "PASS" : "FAIL",
    detail:
      verdicts === null
        ? "classifier cost needs the replay (live session); the rules floor costs $0"
        : `$${cost.usdPerDecision.toFixed(6)} per gate decision (one batch), $${cost.usdPerPage.toFixed(6)} per page, real usage from ${verdicts.file} (${verdicts.batches} batches, $${verdicts.totalCostUsd.toFixed(6)} total)`,
  });

  checks.push({
    id: "V14.5",
    name: `≤ ${MAX_GATE_LATENCY_MS} ms added per gated read; disabled/localOnly identical`,
    verdict:
      verdicts === null ? "UNMEASURED" : latency.p95PerPageMs <= MAX_GATE_LATENCY_MS ? "PASS" : "FAIL",
    detail:
      verdicts === null
        ? `rules are ${report.latency.note}; classifier latency needs the replay`
        : `classifier p95 ${latency.p95PerPageMs} ms/page amortized over ${verdicts.batches} batches (${latency.p95OnePageMs} ms for the recorded 1-page batches; web_read is rules-only by design), rules ${report.latency.p95UsPerRow} µs/page; enabled:false + pageGate:false is the unchanged path (tests)`,
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
      `${unmeasured.map((check) => check.id).join(", ")} unmeasured offline; the classifier half needs a recorded replay`,
    );
  }
  const normal = report.reads.find((entry) => entry.k === 4);
  if (normal !== undefined && normal.savedPct < MIN_READS_SAVED_PCT) {
    reasons.push(
      `observed SERPs: the gate saves ${formatPct(normal.savedPct / 100)} of reads (${formatPct(normal.conditionalSavedPct === null ? null : normal.conditionalSavedPct / 100)} when junk is in the window), below the ${MIN_READS_SAVED_PCT}% bar`,
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

export function evaluateCorpus(
  rows: readonly GateRow[],
  corpusPath = DEFAULT_CORPUS,
  verdicts: VerdictSet | null = null,
): GateReport {
  const byLabel = LABELS.reduce(
    (out, label) => ({ ...out, [label]: rows.filter((row) => row.label === label).length }),
    {} as Record<SlopLabel, number>,
  );
  const bySource = SOURCES.reduce(
    (out, source) => ({ ...out, [source]: rows.filter((row) => row.source === source).length }),
    {} as Record<SlopSource, number>,
  );

  const rules = classify(rows, null);
  const classification = classify(rows, verdicts);
  // V14.3 population: the observed live SERPs. The synthetic P5 fixtures stay in
  // `readsContext` so the population choice is visible and cannot be changed
  // quietly; the aggregate is context, not a gate.
  const reads = READ_BUDGETS.map((k) => simulateReads(rows, k, "serp", verdicts));
  const readsRules = READ_BUDGETS.map((k) => simulateReads(rows, k, "serp", null));
  const readsContext = {
    aggregate: READ_BUDGETS.map((k) => simulateReads(rows, k, undefined, verdicts)),
    fixture: READ_BUDGETS.map((k) => simulateReads(rows, k, "fixture", verdicts)),
  };
  const latency = measureLatency(rows);

  const verdictMeta =
    verdicts === null
      ? null
      : {
          file: verdicts.file,
          model: verdicts.model,
          provider: verdicts.provider,
          batches: verdicts.batches,
          pages: verdicts.pages,
          totalCostUsd: verdicts.totalCostUsd,
          costPerDecisionUsd: round6(verdicts.totalCostUsd / Math.max(1, verdicts.batches)),
          p95PerPageMs: p95(verdicts.latencyPerPageMs),
          p95OnePageMs: p95(verdicts.latencyOnePageMs),
        };

  const base: Omit<GateReport, "checks" | "verdict" | "generatedAt" | "schema"> = {
    corpus: {
      file: corpusPath,
      rows: rows.length,
      serpGroups: new Set(rows.map((row) => row.serp).filter((serp) => serp !== undefined)).size,
      byLabel,
      bySource,
    },
    backend: verdicts === null ? "rules" : "classifier",
    verdicts: verdictMeta,
    classification,
    rules,
    reads,
    readsRules,
    readsContext,
    cost: {
      usdPerDecision: verdictMeta?.costPerDecisionUsd ?? 0,
      usdPerPage: verdictMeta === null ? 0 : round6(verdictMeta.totalCostUsd / Math.max(1, verdictMeta.pages)),
      measured: verdicts !== null,
      note:
        verdicts === null
          ? "rules floor only: $0, no model call. The classifier price is recorded by bench/record.ts and measured from the replay."
          : `recorded with ${verdictMeta?.model ?? "?"} (${verdictMeta?.provider ?? "?"}): $${verdictMeta?.totalCostUsd.toFixed(6)} for ${verdicts.pages} pages in ${verdicts.batches} batches`,
    },
    latency: {
      p95PerPageMs: verdictMeta?.p95PerPageMs ?? 0,
      p95OnePageMs: verdictMeta?.p95OnePageMs ?? 0,
      avgOnePageMs: verdicts === null ? 0 : mean(verdicts.latencyOnePageMs),
      measured: verdicts !== null,
      note: `${latency.avgUsPerRow} µs/row average, ${latency.p95UsPerRow} µs p95 for the rules floor`,
      avgUsPerRow: latency.avgUsPerRow,
      p95UsPerRow: latency.p95UsPerRow,
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
  const { classification: c, rules, corpus } = report;
  const lines: string[] = [];
  lines.push("# Slop-gate bench (P14)");
  lines.push("");
  lines.push(`Corpus: \`${corpus.file}\` — ${corpus.rows} rows, ${corpus.serpGroups} SERP groups.`);
  lines.push(`Labels: ${formatLabels(corpus.byLabel)}. Sources: ${formatSources(corpus.bySource)}.`);
  lines.push(
    `Judge: **${report.backend}**${report.verdicts === null ? " (no classifier replay; rules floor only)" : ` replay from \`${report.verdicts.file}\` (${report.verdicts.model ?? "?"}, ${report.verdicts.batches} batches)`}.`,
  );
  lines.push("");
  lines.push("## Classification");
  lines.push("");
  lines.push("| Label | rows | classifier skipped | rules-floor skipped |");
  lines.push("|---|---|---|---|");
  for (const label of LABELS) {
    const entry = c.byLabel[label];
    const floor = rules.byLabel[label];
    lines.push(
      `| ${label} | ${entry.total} | ${entry.skipped} | ${floor.skipped} |`,
    );
  }
  lines.push("");
  lines.push(
    `Classifier: recall on slop+unsafe **${formatPct(c.recall)}** (${c.skipSkipped}/${c.skipTotal}), false skips **${c.falseSkips}/${c.keepTotal}** = ${c.falseSkipsPer20.toFixed(2)} per 20, off-topic refused ${c.offtopic.skipped}/${c.offtopic.total}, ${c.abstained} abstained rows.`,
  );
  lines.push(
    `Rules floor: unsafe ${rules.byLabel.unsafe.skipped}/${rules.byLabel.unsafe.total} refused, false skips ${rules.falseSkips}/${rules.keepTotal}, slop ${rules.byLabel.slop.skipped}/${rules.byLabel.slop.total}.`,
  );
  if (c.missed.length > 0) {
    lines.push("");
    lines.push("Missed by the classifier (would have been read):");
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
  lines.push("V14.3 population: the **observed live SERPs** (fixture SERPs are synthetic and carry no real slop).");
  lines.push("");
  lines.push("| budget reads | groups | reads | saved | saved % | junk in window | junk after | conditional | goldens before → after |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const entry of [...report.reads, ...report.readsContext.aggregate]) {
    const label = report.reads.includes(entry) ? `${entry.k}` : `${entry.k} (aggregate)`;
    lines.push(
      `| ${label} | ${entry.groups} | ${entry.reads} | ${entry.saved} | ${entry.savedPct}% | ${entry.junkInWindow} | ${entry.junkAfter} | ${entry.conditionalSaved}/${entry.conditionalReads} (${entry.conditionalSavedPct === null ? "—" : `${entry.conditionalSavedPct}%`}) | ${entry.goldensBefore} → ${entry.goldensAfter} (${entry.goldenGroups} groups) |`,
    );
  }
  lines.push("");
  lines.push(
    `Rules floor on the same population: ${report.readsRules.map((entry) => `k=${entry.k} ${entry.savedPct}%`).join(", ")}.`,
  );
  lines.push(
    `Latency: classifier p95 ${report.latency.p95OnePageMs} ms per 1-page gate, ${report.latency.p95PerPageMs} ms/page amortized; rules ${report.latency.p95UsPerRow} µs/page p95.`,
  );
  lines.push(
    `Cost: $${report.cost.usdPerDecision.toFixed(6)} per gate decision, $${report.cost.usdPerPage.toFixed(6)} per page (${report.cost.note}).`,
  );
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
    assert(rows.every((row) => row.query.trim() !== ""), "a row has no query");
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
      { id: "a", label: "unsafe", source: "curated", query: "q", url: "https://prize.tk/win", title: "You won", snippet: "", why: "test" },
      { id: "b", label: "unsafe", source: "curated", query: "q", url: "https://best-casino-bonus.com/play", title: "Bonus", snippet: "", why: "test" },
      { id: "c", label: "good", source: "curated", query: "q", url: "https://en.wikipedia.org/wiki/Test", title: "Test", snippet: "", why: "test" },
      { id: "d", label: "aggregator", source: "curated", query: "q", url: "https://market.yandex.ru/catalog", title: "Catalog", snippet: "", why: "test" },
      { id: "e", label: "offtopic", source: "curated", query: "q", url: "https://example.test/volga", title: "Volga", snippet: "", why: "test" },
    ];
    const report = classify(fabricated);
    assert(report.judgedBy === "rules", "rules classification");
    assert(report.skipTotal === 2, "skip total");
    assert(report.keepTotal === 2, "keep total");
    assert(report.recall === 1, `recall ${report.recall}`);
    assert(report.falseSkips === 0, "false skips");
    assert(report.offtopic.total === 1, "offtopic total");
    return "2/2 recalled, 0/2 false skips, off-topic counted separately";
  });

  check("replay: a recorded verdict can be a false skip or a missed slop", () => {
    const fabricated: GateRow[] = [
      { id: "a", label: "slop", source: "curated", query: "q", url: "https://sonnik.ru/kot/", title: "Сонник кот", snippet: "", why: "test" },
      { id: "b", label: "good", source: "curated", query: "q", url: "https://example.test/page", title: "Page", snippet: "", why: "test" },
      { id: "c", label: "unsafe", source: "curated", query: "q", url: "https://prize.tk/win", title: "You won", snippet: "", why: "test" },
    ];
    const verdicts: VerdictSet = {
      file: "memory",
      schema: "pi-chrome-search/slop-verdicts@1",
      model: "fake",
      provider: "fake",
      batches: 1,
      pages: 3,
      totalCostUsd: 0.0001,
      latencyPerPageMs: [100],
      latencyOnePageMs: [],
      byId: new Map([
        ["a", { id: "a", worth: true, kind: "slop", abstain: false }],
        ["b", { id: "b", worth: false, kind: "slop", abstain: false }],
        ["c", { id: "c", worth: true, kind: "unknown", abstain: false }],
      ]),
    };
    const report = classify(fabricated, verdicts);
    assert(report.judgedBy === "classifier", "classifier classification");
    assert(report.skipSkipped === 0, "a kept slop row is missed");
    assert(report.falseSkips === 1, "a skipped good row is a false skip");
    assert(report.missed.length === 2, "both slop and unsafe kept");
    return "1 false skip, 2 missed, no silent pass";
  });

  check("simulation: a junk-heavy window saves reads and keeps goldens", () => {
    const fabricated: GateRow[] = [
      { id: "a", label: "slop", source: "serp", query: "q", url: "https://sonnik.ru/kot/", title: "Сонник кот", snippet: "", why: "test", serp: "g", rank: 1 },
      { id: "b", label: "offtopic", source: "serp", query: "q", url: "https://example.test/volga", title: "Volga", snippet: "", why: "test", serp: "g", rank: 2 },
      { id: "c", label: "good", source: "serp", query: "q", url: "https://en.wikipedia.org/wiki/Cat", title: "Cat", snippet: "", why: "test", serp: "g", rank: 3, golden: true },
    ];
    const verdicts: VerdictSet = {
      file: "memory",
      schema: "pi-chrome-search/slop-verdicts@1",
      model: "fake",
      provider: "fake",
      batches: 1,
      pages: 3,
      totalCostUsd: 0,
      latencyPerPageMs: [100],
      latencyOnePageMs: [],
      byId: new Map([
        ["a", { id: "a", worth: false, kind: "slop", abstain: false }],
        ["b", { id: "b", worth: false, kind: "slop", abstain: false }],
        ["c", { id: "c", worth: true, kind: "original", abstain: false }],
      ]),
    };
    const sim = simulateReads(fabricated, 2, undefined, verdicts);
    assert(sim.reads === 2, "reads");
    assert(sim.saved === 2, "saved");
    assert(sim.savedPct === 100, "pct");
    assert(sim.conditionalSavedPct === 100, "conditional");
    const deep = simulateReads(fabricated, 4, undefined, verdicts);
    assert(deep.goldensBefore === 1 && deep.goldensAfter === 1, "golden preservation");
    return "top-2 all junk → 2/2 saved; deep window keeps the golden";
  });

  check("verdict: a failed gate is KEEP OFF, never softened", () => {
    const checks: GateCheck[] = [
      { id: "V14.2b", name: "recall", verdict: "FAIL", detail: "recall 40%" },
      { id: "V14.4", name: "cost", verdict: "UNMEASURED", detail: "no replay" },
    ];
    const verdict = verdictOfChecks(checks, { classification: classify([]), reads: [] });
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
      const report = evaluateCorpus(rows, options.corpusPath, null);
      return JSON.stringify({
        corpus: report.corpus,
        backend: report.backend,
        classification: report.classification,
        rules: report.rules,
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

  if (options.verdictsPath !== null && existsSync(options.verdictsPath)) {
    check("replay: the recorded verdict file loads and scores", () => {
      const verdicts = loadVerdicts(options.verdictsPath ?? DEFAULT_VERDICTS);
      assert(verdicts.batches > 0 && verdicts.byId.size > 0, "empty replay");
      const report = evaluateCorpus(rows, options.corpusPath, verdicts);
      assert(report.backend === "classifier", "backend");
      assert(report.checks.some((entry) => entry.id === "V14.2b" && entry.verdict !== "UNMEASURED"), "V14.2b");
      return `${verdicts.batches} batches, ${verdicts.byId.size} verdicts, ${report.checks.filter((entry) => entry.verdict === "PASS").length} gates pass`;
    });
  }

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
    verdictsPath: existsSync(DEFAULT_VERDICTS) ? DEFAULT_VERDICTS : null,
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
            "usage: node bench/gate.ts [--corpus <file>] [--verdicts <file>|--no-verdicts] [--out <file>]",
            "                       [--no-write] [--json]",
            "       node bench/gate.ts --self-test",
            "",
            "Measures the P14 page gate on bench/slop.jsonl: the rules safety floor",
            "and, when bench/slop-verdicts.jsonl exists, the recorded classifier replay",
            "(recall, false skips, reads saved by web_research, latency, cost). Offline.",
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
      case "--no-verdicts":
        options.verdictsPath = null;
        break;
      case "--corpus": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw fail("E_CONFIG", "config", { hint: "--corpus needs a file" });
        options.corpusPath = resolve(value);
        index += 1;
        break;
      }
      case "--verdicts": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw fail("E_CONFIG", "config", { hint: "--verdicts needs a file" });
        options.verdictsPath = resolve(value);
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
  verdictsPath?: string | null;
  out?: string | null;
  write?: boolean;
  json?: boolean;
}

/** Programmatic entry used by `bench/run.ts --gate` and by tests. */
export function runGate(options: GateOptions = {}): number {
  const cli: CliOptions = {
    selfTest: false,
    corpusPath: options.corpusPath ?? DEFAULT_CORPUS,
    verdictsPath: options.verdictsPath === undefined ? (existsSync(DEFAULT_VERDICTS) ? DEFAULT_VERDICTS : null) : options.verdictsPath,
    out: options.out ?? null,
    write: options.write ?? true,
    json: options.json ?? false,
  };
  const rows = loadCorpus(cli.corpusPath);
  const verdicts = cli.verdictsPath === null ? null : loadVerdicts(cli.verdictsPath);
  const report = evaluateCorpus(rows, cli.corpusPath, verdicts);

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
