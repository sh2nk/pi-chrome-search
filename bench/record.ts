#!/usr/bin/env node
/**
 * Record real page-gate verdicts with the classifier (P14, live and paid).
 *
 * The offline bench can prove the *shape* of the classifier (batching, schema,
 * abstention) but not its accuracy: that needs the user's provider and a real
 * call. This script does the one live thing the phase needs — it asks pi's own
 * classifier for verdicts on the labelled corpus and writes them to a replay
 * fixture, so `bench/gate.ts` can then score the real judge offline and
 * deterministically, with the real usage/cost/latency attached.
 *
 * Credentials stay pi's business: a throwaway SDK session provides the model
 * registry, exactly like the extension's `ctx.modelRegistry`, and this script
 * never reads `auth.json`. Cost is bounded twice: `--budget-usd` (default 0.02)
 * stops the session, and `reflex.maxCallsPerSession` stops the classifier.
 *
 *   node bench/record.ts --limit 10        # smoke: one batch, prints the outcome
 *   node bench/record.ts                   # whole corpus → bench/slop-verdicts.jsonl
 *   node bench/record.ts --model ~typesafe/jev-latest --max-latency 1200
 *
 * The output is data, not code: one JSON object per batch (ids + verdicts +
 * usage/cost/latency). It contains no query text and no page content.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { ClassifyLogRow, ClassifyOutcome } from "../src/reflex/classifier.ts";
import { createClassifierReflex } from "../src/reflex/classifier.ts";
import { PAGE_BATCH_MAX, type PageSubject } from "../src/reflex/types.ts";
import { systemClock } from "../src/runtime/clock.ts";
import { isWebSearchError } from "../src/runtime/error-codes.ts";
import { fail } from "../src/runtime/errors.ts";
import { loadCorpus, type GateRow } from "./gate.ts";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = join(BENCH_DIR, "slop.jsonl");
const DEFAULT_OUT = join(BENCH_DIR, "slop-verdicts.jsonl");
const DEFAULT_MODEL = "~typesafe/jev-latest";

interface Options {
  corpusPath: string;
  out: string;
  model: string;
  maxLatencyMs: number;
  budgetUsd: number;
  limit: number | null;
  write: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    corpusPath: DEFAULT_CORPUS,
    out: DEFAULT_OUT,
    model: DEFAULT_MODEL,
    maxLatencyMs: DEFAULT_CONFIG.reflex.maxLatencyMs,
    budgetUsd: 0.02,
    limit: null,
    write: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw fail("E_CONFIG", "config", { hint: `${arg} needs a value` });
      }
      index += 1;
      return next;
    };
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "usage: node bench/record.ts [--corpus <file>] [--out <file>] [--model <id>]",
            "                            [--max-latency <ms>] [--budget-usd <usd>] [--limit <n>]",
            "                            [--no-write]",
            "",
            "Asks pi's classifier for page-gate verdicts on the labelled corpus (live, paid,",
            "capped) and writes a replay fixture for bench/gate.ts. No query text, no page text.",
          ].join("\n") + "\n",
        );
        process.exit(0);
        return options;
      case "--no-write":
        options.write = false;
        break;
      case "--corpus":
        options.corpusPath = resolve(value());
        break;
      case "--out":
        options.out = resolve(value());
        break;
      case "--model":
        options.model = value();
        break;
      case "--max-latency": {
        const parsed = Number(value());
        if (!Number.isInteger(parsed) || parsed < 100) {
          throw fail("E_CONFIG", "config", { hint: "--max-latency must be an integer ≥ 100 ms" });
        }
        options.maxLatencyMs = parsed;
        break;
      }
      case "--budget-usd": {
        const parsed = Number(value());
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 0.5) {
          throw fail("E_CONFIG", "config", { hint: "--budget-usd must be in (0, 0.5]" });
        }
        options.budgetUsd = parsed;
        break;
      }
      case "--limit": {
        const parsed = Number(value());
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw fail("E_CONFIG", "config", { hint: "--limit must be a positive integer" });
        }
        options.limit = parsed;
        break;
      }
      default:
        throw fail("E_CONFIG", "config", { hint: `unknown argument ${JSON.stringify(arg)}; run with --help` });
    }
  }
  return options;
}

function recorderConfig(options: Options): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.reflex.enabled = true;
  config.reflex.pageGate = true;
  config.reflex.backend = "openrouter";
  config.reflex.provider = "openrouter";
  config.reflex.model = options.model;
  config.reflex.localOnly = false;
  config.reflex.maxLatencyMs = options.maxLatencyMs;
  // A corpus run is one "session": cap calls and dollars explicitly instead of
  // inheriting the per-search budget.
  config.reflex.maxCallsPerSession = 40;
  config.reflex.maxUsdPerSession = options.budgetUsd;
  return config;
}

interface RecordedBatch {
  batch: number;
  query: string;
  ids: string[];
  provider: string | null;
  model: string | null;
  latencyMs: number;
  abstain: boolean;
  reason: string | null;
  errorMessage: string | null;
  calls: number;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  verdicts: Array<{ id: string; worth: boolean; trust: number | null; kind: string; reasons: string[] }>;
}

interface Recorder {
  rows: GateRow[];
  subjects: PageSubject[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function verdictRow(row: GateRow): PageSubject {
  return { url: row.url, title: row.title, snippet: row.snippet };
}

function describeOutcome(outcome: ClassifyOutcome | null): string {
  if (outcome === null) return "no outcome";
  const parts = [outcome.abstain ? `abstain:${outcome.reason ?? "?"}` : "ok"];
  parts.push(`judged=${outcome.judged}`);
  parts.push(`calls=${outcome.calls}`);
  parts.push(`latency=${outcome.latencyMs}ms`);
  if (outcome.stopReason !== undefined) parts.push(`stop=${outcome.stopReason}`);
  if (outcome.errorMessage !== undefined) parts.push(`error=${outcome.errorMessage}`);
  if (outcome.usage !== undefined) parts.push(`tokens=${outcome.usage.inputTokens}+${outcome.usage.outputTokens}`);
  if (outcome.costUsd !== undefined) parts.push(`cost=$${outcome.costUsd.toFixed(6)}`);
  return parts.join(" ");
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const all = loadCorpus(options.corpusPath);
  const rows = options.limit === null ? all : all.slice(0, options.limit);
  if (rows.length === 0) throw fail("E_CONFIG", "config", { hint: "the corpus selection is empty" });

  const logRows: ClassifyLogRow[] = [];
  const { session } = await createAgentSession({
    // A throwaway session in /tmp: no project extension discovery, no tools, no
    // conversation. We only need its authenticated model runtime.
    cwd: "/tmp",
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
  });

  try {
    const registry = new ModelRegistry(session.modelRuntime);
    const available = await registry.getAvailableOfType("classifier", "openrouter");
    if (available.length === 0) {
      throw fail("E_CONFIG", "config", {
        hint: "no OpenRouter classifier is authenticated in pi; run `pi` and log in, or pass --model",
      });
    }
    const picked = registry.findOfType("classifier", "openrouter", options.model);
    if (picked === undefined) {
      process.stderr.write(
        `model ${options.model} not offered by the registry; available: ${available.map((model) => model.id).join(", ")}\n`,
      );
    }

    const reflex = createClassifierReflex({
      config: recorderConfig(options),
      registry,
      clock: systemClock,
      log: (row) => {
        logRows.push(row);
      },
    });

    // A gate decision is per query: all pages in one `classify()` call share the
    // same question. Grouping by query is what makes "worth reading" meaningful
    // (the first recording used "" and the model correctly said most pages were
    // not worth reading for no question at all).
    const byQuery = new Map<string, GateRow[]>();
    for (const row of rows) {
      const group = byQuery.get(row.query) ?? [];
      group.push(row);
      byQuery.set(row.query, group);
    }
    const batches = [...byQuery.values()].flatMap((group) => chunk(group, PAGE_BATCH_MAX));
    const out: RecordedBatch[] = [];
    let totalCost = 0;
    let aborted = false;

    for (let index = 0; index < batches.length; index += 1) {
      if (aborted) break;
      const batch = batches[index] ?? [];
      const query = batch[0]?.query ?? "";
      const subjects = batch.map(verdictRow);
      const verdicts = await reflex.judgePages(query, subjects);
      const outcome = reflex.lastOutcome();
      const costUsd = outcome?.costUsd ?? 0;
      totalCost += costUsd;
      const recorded: RecordedBatch = {
        batch: index,
        query,
        ids: batch.map((row) => row.id),
        provider: outcome?.provider ?? null,
        model: outcome?.model ?? null,
        latencyMs: outcome?.latencyMs ?? 0,
        abstain: outcome?.abstain ?? true,
        reason: outcome?.reason ?? null,
        errorMessage: outcome?.errorMessage ?? null,
        calls: outcome?.calls ?? 0,
        costUsd,
        usage:
          outcome?.usage === undefined
            ? null
            : { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens },
        verdicts: verdicts.map((verdict, position) => ({
          id: batch[position]?.id ?? "",
          worth: verdict.worth,
          trust: verdict.trust,
          kind: verdict.kind,
          reasons: verdict.reasons,
        })),
      };
      out.push(recorded);
      process.stdout.write(
        `batch ${index + 1}/${batches.length}: ${subjects.length} pages, ${describeOutcome(outcome)}, keep=${verdicts.filter((v) => v.worth).length}/${verdicts.length}\n`,
      );
      if (outcome?.abstain === true) {
        process.stdout.write(`  abstain reason: ${outcome.reason ?? "?"}\n`);
      }
      if (totalCost >= options.budgetUsd) {
        process.stdout.write(`budget $${options.budgetUsd} reached after $${totalCost.toFixed(6)}; stopping\n`);
        aborted = true;
      }
    }

    const summary = {
      schema: "pi-chrome-search/slop-verdicts@1",
      generatedAt: new Date().toISOString(),
      model: out.find((batch) => batch.model !== null)?.model ?? options.model,
      provider: out.find((batch) => batch.provider !== null)?.provider ?? null,
      maxLatencyMs: options.maxLatencyMs,
      pages: rows.length,
      batches: out.length,
      totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
      batchesRecorded: out,
    };
    const jsonl = `${out.map((batch) => JSON.stringify(batch)).join("\n")}\n`;
    const manifest = JSON.stringify(
      {
        schema: summary.schema,
        generatedAt: summary.generatedAt,
        model: summary.model,
        provider: summary.provider,
        maxLatencyMs: summary.maxLatencyMs,
        pages: summary.pages,
        batches: summary.batches,
        totalCostUsd: summary.totalCostUsd,
      },
      null,
      2,
    );

    if (options.write) {
      writeFileSync(options.out, jsonl, "utf8");
      writeFileSync(`${options.out}.meta.json`, `${manifest}\n`, "utf8");
      process.stdout.write(`wrote ${options.out} (${out.length} batches) and ${options.out}.meta.json\n`);
    }
    process.stdout.write(
      `total: ${rows.length} pages, ${out.length} batches, $${totalCost.toFixed(6)}, model ${summary.model ?? "?"}\n`,
    );
    process.stdout.write(`${manifest}\n`);

    if (out.some((batch) => batch.provider === null && batch.abstain)) {
      process.stdout.write("warning: some batches recorded no provider/model; the replay will fall back to rules there\n");
    }
    return 0;
  } finally {
    session.dispose();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (isWebSearchError(error)) {
    process.stderr.write(
      `record failed [${error.details.code}] stage=${error.details.stage}: ${error.details.hint}\n`,
    );
    process.exitCode = 2;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`record failed: ${message}\n`);
    process.exitCode = 2;
  }
}
