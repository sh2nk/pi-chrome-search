#!/usr/bin/env node
/**
 * Bench harness (SPEC §9.4, PLAN P5-A / V5.6).
 *
 * Default is **offline replay**: recorded SERPs from `bench/fixtures/**` go
 * through the real compaction layer (`src/extract/compact.ts`) with the SPEC
 * defaults, so recall/token numbers are deterministic, need no network and no
 * Chrome, and finish in milliseconds. A live run is opt-in (`--live` plus
 * `PI_CHROME_LIVE=1`), one query at a time, and stops at the first wall instead
 * of retrying it: the whole point of this project is to keep the profile out of
 * captcha jail.
 *
 * The reflex layer does not exist yet in P5-A, so `abstainRate` is an honest
 * placeholder and `reads` is 0 unless a result file from a later phase carries
 * it. `--compare` reads two result files and applies the SPEC §9.4 ship rule
 * without knowing which code produced them.
 *
 * Usage:
 *   node bench/run.ts                      # offline replay, writes results/<ts>-offline.json
 *   node bench/run.ts --no-write           # offline replay, print only
 *   node bench/run.ts --self-test          # fixture + metric + verdict self-checks
 *   PI_CHROME_LIVE=1 node bench/run.ts --live --limit 1
 *   node bench/run.ts --compare a.json b.json
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { EngineId, EngineSelection, RawSerp } from "../src/engines/types.ts";
import { compactSerps } from "../src/extract/compact.ts";
import { domainOf } from "../src/extract/urls.ts";
import { isWebSearchError } from "../src/runtime/error-codes.ts";
import { fail } from "../src/runtime/errors.ts";

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_QUERIES = join(BENCH_DIR, "queries.jsonl");
const DEFAULT_FIXTURES = join(BENCH_DIR, "fixtures");
const RESULTS_DIR = join(BENCH_DIR, "results");
const SCHEMA = "pi-chrome-search/bench@1";
const COMPARE_SCHEMA = "pi-chrome-search/bench-compare@1";

/**
 * SPEC defaults, copied as literals instead of reading the user's config: an
 * offline run must not change because someone edited `~/.pi/agent/web-search.json`.
 * Live mode uses the real config, because that is what the agent will see.
 */
const COMPACT_DEFAULTS = {
  summaryMaxChars: 1200,
  snippetMaxChars: 140,
  outputMaxChars: 2500,
} as const;
const DEFAULT_N = 5;
const MAX_N = 10;
const DEFAULT_LIVE_CAP = 5;
const LIVE_GAP_MS = 1_200;
const SPAM_DOMAIN = "spam-seo.example";
const SPAM_MARKER = "[synthetic spam]";
const SPAM_MARKER_COUNT = 1;

const CLASSES = ["factual", "technical", "commercial", "news", "ambiguous"] as const;
type BenchClass = (typeof CLASSES)[number];
const LANGS = ["en", "ru"] as const;
type BenchLang = (typeof LANGS)[number];
const ENGINES: readonly EngineId[] = ["google", "duckduckgo", "yandex"];

interface QueryRow {
  id: string;
  q: string;
  class: BenchClass;
  lang: BenchLang;
  engines?: EngineId[] | "auto";
  goldenDomains: string[];
  notes?: string;
}

interface FixtureResult {
  title: string;
  url: string;
  snippet: string;
}

interface FixtureAi {
  text: string;
  sources?: string[];
}

interface FixtureSerp {
  id: string;
  engine: EngineId;
  query?: string;
  covers?: string[];
  ai?: FixtureAi;
  results: FixtureResult[];
}

interface LoadedFixture extends FixtureSerp {
  class: BenchClass;
  file: string;
}

interface QueryRun {
  id: string;
  q: string;
  class: BenchClass;
  lang: BenchLang;
  engines: EngineSelection;
  /** Fixture id in offline mode; `null` for live runs. */
  fixture: string | null;
  ok: boolean;
  recallAt5: number;
  goldensHit: number;
  goldensTotal: number;
  chars: number;
  tokens: number;
  latencyMs: number;
  results: number;
  ai: boolean;
  cached: boolean;
  topDomains: string[];
  spam: "caught" | "leaked" | "absent";
  reads?: number;
  error?: { code: string; stage: string; hint?: string };
}

interface Metrics {
  queries: number;
  ok: number;
  recallAt5: number;
  goldensHit: number;
  goldensTotal: number;
  chars: number;
  tokens: number;
  avgChars: number;
  avgTokens: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  reads: number;
  abstainRate: number;
  spam: { checked: number; leaked: number; caught: number; caughtRate: number | null };
}

interface BenchReport {
  schema: typeof SCHEMA;
  mode: "offline" | "live";
  render: "md" | "json";
  generatedAt: string;
  queriesFile: string;
  serpSource: string;
  n: number;
  limit: number | null;
  engineOverride: EngineId | null;
  queries: QueryRun[];
  metrics: Metrics;
  stopped: { at: string; code: string; stage: string } | null;
  notes: string[];
}

interface Verdict {
  recallDelta: number;
  tokenDeltaPct: number | null;
  readsDeltaPct: number | null;
  ship: boolean;
  reasons: string[];
}

interface Comparison {
  schema: typeof COMPARE_SCHEMA;
  baseline: { file: string; mode: string; metrics: Metrics };
  reflex: { file: string; mode: string; metrics: Metrics };
  verdict: Verdict;
}

interface CliOptions {
  mode: "offline" | "live" | "compare" | "self-test";
  queriesPath: string;
  serpSource: string;
  out: string | null;
  write: boolean;
  n: number;
  limit: number | null;
  allowMore: boolean;
  classFilter: BenchClass | null;
  engine: EngineId | null;
  compare: [string, string] | null;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function usage(): string {
  return [
    "usage:",
    "  node bench/run.ts [--queries <file>] [--serp-source <dir>] [--n 5]",
    "                    [--class factual|technical|commercial|news|ambiguous]",
    "                    [--out <file>] [--no-write]",
    "  node bench/run.ts --self-test [--serp-source <dir>] [--queries <file>]",
    "  PI_CHROME_LIVE=1 node bench/run.ts --live --limit <1..30> [--allow-more]",
    "                    [--engine google|duckduckgo|yandex] [--n 5] [--out <file>]",
    "  node bench/run.ts --compare <baseline.json> <reflex.json>",
    "",
    "offline replay is the default and never touches the network or Chrome.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    mode: "offline",
    queriesPath: DEFAULT_QUERIES,
    serpSource: DEFAULT_FIXTURES,
    out: null,
    write: true,
    n: DEFAULT_N,
    limit: null,
    allowMore: false,
    classFilter: null,
    engine: null,
    compare: null,
  };

  let live = false;
  let selfTest = false;

  const valueAfter = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw fail("E_CONFIG", "config", {
        hint: `${flag} needs a value; run with --help for the full usage`,
      });
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      case "--self-test":
        selfTest = true;
        break;
      case "--live":
        live = true;
        break;
      case "--allow-more":
        options.allowMore = true;
        break;
      case "--no-write":
        options.write = false;
        break;
      case "--queries":
        options.queriesPath = resolve(valueAfter(arg, index));
        index += 1;
        break;
      case "--serp-source":
        options.serpSource = resolve(valueAfter(arg, index));
        index += 1;
        break;
      case "--out":
        options.out = resolve(valueAfter(arg, index));
        index += 1;
        break;
      case "--n": {
        const raw = valueAfter(arg, index);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_N) {
          throw fail("E_CONFIG", "config", {
            hint: `--n must be an integer between 1 and ${MAX_N}`,
          });
        }
        options.n = parsed;
        index += 1;
        break;
      }
      case "--limit": {
        const raw = valueAfter(arg, index);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw fail("E_CONFIG", "config", { hint: "--limit must be a positive integer" });
        }
        options.limit = parsed;
        index += 1;
        break;
      }
      case "--class": {
        const raw = valueAfter(arg, index);
        if (!isClass(raw)) {
          throw fail("E_CONFIG", "config", {
            hint: `--class must be one of ${CLASSES.join(", ")}`,
          });
        }
        options.classFilter = raw;
        index += 1;
        break;
      }
      case "--engine": {
        const raw = valueAfter(arg, index);
        if (!isEngineId(raw)) {
          throw fail("E_CONFIG", "config", {
            hint: `--engine must be one of ${ENGINES.join(", ")}`,
          });
        }
        options.engine = raw;
        index += 1;
        break;
      }
      case "--compare": {
        const left = valueAfter(arg, index);
        const right = argv[index + 2];
        if (right === undefined || right.startsWith("--")) {
          throw fail("E_CONFIG", "config", {
            hint: "--compare needs two result files: --compare <baseline.json> <reflex.json>",
          });
        }
        options.compare = [resolve(left), resolve(right)];
        index += 2;
        break;
      }
      default:
        throw fail("E_CONFIG", "config", {
          hint: `unknown argument ${JSON.stringify(arg)}; run with --help`,
        });
    }
  }

  if (selfTest && live) {
    throw fail("E_CONFIG", "config", { hint: "--self-test and --live are mutually exclusive" });
  }
  if (selfTest) options.mode = "self-test";
  else if (options.compare !== null) options.mode = "compare";
  else if (live) options.mode = "live";

  if (options.mode !== "live" && options.limit !== null) {
    throw fail("E_CONFIG", "config", { hint: "--limit only applies to --live" });
  }
  if (options.mode !== "live" && options.allowMore) {
    throw fail("E_CONFIG", "config", { hint: "--allow-more only applies to --live" });
  }
  if (options.mode !== "live" && options.engine !== null) {
    throw fail("E_CONFIG", "config", { hint: "--engine only applies to --live" });
  }
  if (options.mode === "compare" && options.out !== null) {
    throw fail("E_CONFIG", "config", { hint: "--compare prints to stdout; --out is not used" });
  }

  return options;
}

function isClass(value: string): value is BenchClass {
  return (CLASSES as readonly string[]).includes(value);
}

function isEngineId(value: string): value is EngineId {
  return (ENGINES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readJsonFile(path: string, what: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw fail("E_CONFIG", "config", {
      hint: `cannot read ${what} ${displayPath(path)} (${code})`,
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw fail("E_CONFIG", "config", {
      hint: `${what} ${displayPath(path)} is not valid JSON: ${message}`,
    });
  }
}

function loadQueries(path: string): QueryRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw fail("E_CONFIG", "config", {
      hint: `cannot read query set ${displayPath(path)} (${code})`,
    });
  }

  const rows: QueryRow[] = [];
  const seen = new Set<string>();
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw fail("E_CONFIG", "config", {
        hint: `queries.jsonl line ${index + 1} is not valid JSON: ${message}`,
      });
    }
    const row = validateQuery(parsed, index + 1);
    if (seen.has(row.id)) {
      throw fail("E_CONFIG", "config", {
        hint: `queries.jsonl line ${index + 1} repeats id ${row.id}`,
      });
    }
    seen.add(row.id);
    rows.push(row);
  }

  if (rows.length === 0) {
    throw fail("E_CONFIG", "config", { hint: `query set ${displayPath(path)} is empty` });
  }
  return rows;
}

function validateQuery(value: unknown, line: number): QueryRow {
  if (!isRecord(value)) {
    throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line} is not an object` });
  }
  const id = textOf(value.id);
  const q = textOf(value.q);
  const klass = textOf(value.class);
  const lang = textOf(value.lang);
  const goldens = value.goldenDomains;
  if (id === undefined || id.length === 0) {
    throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line}: id is required` });
  }
  if (q === undefined || q.length === 0) {
    throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line} (${id}): q is required` });
  }
  if (klass === undefined || !isClass(klass)) {
    throw fail("E_CONFIG", "config", {
      hint: `queries.jsonl line ${line} (${id}): class must be one of ${CLASSES.join(", ")}`,
    });
  }
  if (lang === undefined || !(LANGS as readonly string[]).includes(lang)) {
    throw fail("E_CONFIG", "config", {
      hint: `queries.jsonl line ${line} (${id}): lang must be en or ru`,
    });
  }
  if (!Array.isArray(goldens) || goldens.length < 2 || goldens.length > 4) {
    throw fail("E_CONFIG", "config", {
      hint: `queries.jsonl line ${line} (${id}): goldenDomains needs 2-4 entries`,
    });
  }
  const goldenDomains: string[] = [];
  for (const golden of goldens) {
    const domain = textOf(golden)?.trim().toLowerCase() ?? "";
    if (domain.length === 0 || domain.includes(" ")) {
      throw fail("E_CONFIG", "config", {
        hint: `queries.jsonl line ${line} (${id}): golden domains must be bare hostnames`,
      });
    }
    goldenDomains.push(domain);
  }

  let engines: EngineId[] | "auto" | undefined;
  if (value.engines !== undefined) {
    if (value.engines === "auto") {
      engines = "auto";
    } else if (Array.isArray(value.engines) && value.engines.length > 0) {
      const list: EngineId[] = [];
      for (const engine of value.engines) {
        if (typeof engine !== "string" || !isEngineId(engine)) {
          throw fail("E_CONFIG", "config", {
            hint: `queries.jsonl line ${line} (${id}): engines must be "auto" or engine ids`,
          });
        }
        list.push(engine);
      }
      engines = list;
    } else {
      throw fail("E_CONFIG", "config", {
        hint: `queries.jsonl line ${line} (${id}): engines must be "auto" or a non-empty array`,
      });
    }
  }

  const notes = textOf(value.notes);
  return {
    id,
    q,
    class: klass,
    lang: lang as BenchLang,
    ...(engines === undefined ? {} : { engines }),
    goldenDomains,
    ...(notes === undefined ? {} : { notes }),
  };
}

function walkJsonFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw fail("E_CONFIG", "config", {
      hint: `cannot read SERP source ${displayPath(dir)} (${code}); pass a fixture directory with --serp-source`,
    });
  }
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
  }
  return out;
}

function loadFixtures(dir: string): LoadedFixture[] {
  const files = walkJsonFiles(dir);
  if (files.length === 0) {
    throw fail("E_CONFIG", "config", {
      hint: `no SERP fixtures under ${displayPath(dir)}; expected bench/fixtures/<class>.json`,
    });
  }

  const fixtures: LoadedFixture[] = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    const parsed = readJsonFile(file, "SERP fixture");
    if (!isRecord(parsed)) {
      throw fail("E_CONFIG", "config", {
        hint: `SERP fixture ${displayPath(file)} must be an object with class + serps`,
      });
    }
    const klass = textOf(parsed.class);
    if (klass === undefined || !isClass(klass)) {
      throw fail("E_CONFIG", "config", {
        hint: `SERP fixture ${displayPath(file)}: class must be one of ${CLASSES.join(", ")}`,
      });
    }
    const serps = parsed.serps;
    if (!Array.isArray(serps) || serps.length === 0) {
      throw fail("E_CONFIG", "config", {
        hint: `SERP fixture ${displayPath(file)}: serps must be a non-empty array`,
      });
    }
    for (const rawSerp of serps) {
      const serp = validateFixtureSerp(rawSerp, klass, file);
      if (seenIds.has(serp.id)) {
        throw fail("E_CONFIG", "config", {
          hint: `SERP fixture id ${serp.id} appears twice (${displayPath(file)})`,
        });
      }
      seenIds.add(serp.id);
      fixtures.push(serp);
    }
  }
  return fixtures;
}

function validateFixtureSerp(value: unknown, klass: BenchClass, file: string): LoadedFixture {
  if (!isRecord(value)) {
    throw fail("E_CONFIG", "config", {
      hint: `SERP in ${displayPath(file)} is not an object`,
    });
  }
  const id = textOf(value.id);
  const engine = textOf(value.engine);
  if (id === undefined || id.length === 0) {
    throw fail("E_CONFIG", "config", { hint: `SERP in ${displayPath(file)} has no id` });
  }
  if (engine === undefined || !isEngineId(engine)) {
    throw fail("E_CONFIG", "config", {
      hint: `SERP ${id} in ${displayPath(file)}: engine must be one of ${ENGINES.join(", ")}`,
    });
  }

  const rawResults = value.results;
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    throw fail("E_CONFIG", "config", {
      hint: `SERP ${id} in ${displayPath(file)}: results must be a non-empty array`,
    });
  }
  const results: FixtureResult[] = [];
  for (const rawResult of rawResults) {
    if (!isRecord(rawResult)) {
      throw fail("E_CONFIG", "config", { hint: `SERP ${id}: every result must be an object` });
    }
    const title = textOf(rawResult.title);
    const url = textOf(rawResult.url);
    const snippet = textOf(rawResult.snippet);
    if (title === undefined || url === undefined || snippet === undefined) {
      throw fail("E_CONFIG", "config", {
        hint: `SERP ${id}: every result needs title, url and snippet strings`,
      });
    }
    if (domainOf(url) === "") {
      throw fail("E_CONFIG", "config", {
        hint: `SERP ${id}: ${url} is not an http(s) URL`,
      });
    }
    results.push({ title, url, snippet });
  }

  let ai: FixtureAi | undefined;
  if (value.ai !== undefined) {
    if (!isRecord(value.ai)) {
      throw fail("E_CONFIG", "config", { hint: `SERP ${id}: ai must be an object` });
    }
    const text = textOf(value.ai.text);
    if (text === undefined || text.trim().length === 0) {
      throw fail("E_CONFIG", "config", { hint: `SERP ${id}: ai.text is required when ai is present` });
    }
    const rawSources = value.ai.sources;
    const sources = Array.isArray(rawSources)
      ? rawSources.filter((source): source is string => typeof source === "string")
      : undefined;
    ai = { text, ...(sources === undefined ? {} : { sources }) };
  }

  const covers = Array.isArray(value.covers)
    ? value.covers.filter((cover): cover is string => typeof cover === "string")
    : undefined;

  return {
    id,
    engine,
    class: klass,
    file: displayPath(file),
    ...(textOf(value.query) === undefined ? {} : { query: textOf(value.query) }),
    ...(covers === undefined ? {} : { covers }),
    ...(ai === undefined ? {} : { ai }),
    results,
  };
}

// ---------------------------------------------------------------------------
// Offline replay
// ---------------------------------------------------------------------------

function domainMatches(domain: string, golden: string): boolean {
  const left = domain.toLowerCase();
  const right = golden.toLowerCase();
  return left === right || left.endsWith(`.${right}`);
}

function scoreFixture(query: QueryRow, fixture: LoadedFixture): number {
  let score = 0;
  if (fixture.covers?.includes(query.id) === true) score += 5;
  const fixtureDomains = fixture.results.map((result) => domainOf(result.url));
  for (const golden of query.goldenDomains) {
    if (fixtureDomains.some((domain) => domainMatches(domain, golden))) score += 10;
  }
  return score;
}

/**
 * Deterministic fixture choice: an explicit `covers` entry wins, otherwise the
 * SERP that shares the most golden domains; ties break on the fixture id so two
 * replays never disagree.
 */
function pickFixture(query: QueryRow, fixtures: readonly LoadedFixture[]): LoadedFixture {
  const candidates = fixtures.filter((fixture) => fixture.class === query.class);
  if (candidates.length === 0) {
    throw fail("E_CONFIG", "config", {
      hint: `no fixture for class ${query.class} (query ${query.id}); add one under bench/fixtures/`,
    });
  }
  let best = candidates[0] as LoadedFixture;
  let bestScore = scoreFixture(query, best);
  for (const candidate of candidates.slice(1)) {
    const score = scoreFixture(query, candidate);
    if (score > bestScore || (score === bestScore && candidate.id < best.id)) {
      best = candidate;
      bestScore = score;
    }
  }
  if (bestScore === 0) {
    throw fail("E_CONFIG", "config", {
      hint: `fixture ${best.id} shares no golden domain with query ${query.id}; add a plausible SERP`,
    });
  }
  return best;
}

function toRawSerp(query: QueryRow, fixture: LoadedFixture): RawSerp {
  const raw: RawSerp = {
    engine: fixture.engine,
    query: query.q,
    results: fixture.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    })),
    pageCarried: false,
    timings: {},
  };
  if (fixture.ai !== undefined) {
    raw.ai = { text: fixture.ai.text, sources: fixture.ai.sources ?? [] };
  }
  return raw;
}

function replayQuery(query: QueryRow, fixture: LoadedFixture, n: number): QueryRun {
  const started = performance.now();
  const compact = compactSerps([toRawSerp(query, fixture)], {
    n,
    summaryMaxChars: COMPACT_DEFAULTS.summaryMaxChars,
    snippetMaxChars: COMPACT_DEFAULTS.snippetMaxChars,
    outputMaxChars: COMPACT_DEFAULTS.outputMaxChars,
    format: "md",
    cached: false,
    elapsedMs: 0,
  });
  const latencyMs = performance.now() - started;

  const topDomains = compact.items.slice(0, n).map((item) => item.domain);
  const goldensHit = query.goldenDomains.filter((golden) =>
    topDomains.some((domain) => domainMatches(domain, golden)),
  ).length;
  const fixtureHasSpam = fixture.results.some((result) => domainOf(result.url) === SPAM_DOMAIN);
  const spamLeaked =
    topDomains.includes(SPAM_DOMAIN) || compact.items.some((item) => item.title.includes(SPAM_MARKER));

  return {
    id: query.id,
    q: query.q,
    class: query.class,
    lang: query.lang,
    engines: query.engines ?? "auto",
    fixture: fixture.id,
    ok: true,
    recallAt5: query.goldenDomains.length === 0 ? 0 : goldensHit / query.goldenDomains.length,
    goldensHit,
    goldensTotal: query.goldenDomains.length,
    chars: compact.chars,
    tokens: Math.ceil(compact.chars / 4),
    latencyMs,
    results: compact.items.length,
    ai: compact.ai !== undefined,
    cached: false,
    topDomains,
    spam: fixtureHasSpam ? (spamLeaked ? "leaked" : "caught") : "absent",
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] as number;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarise(runs: readonly QueryRun[]): Metrics {
  const okRuns = runs.filter((run) => run.ok);
  const goldensHit = okRuns.reduce((sum, run) => sum + run.goldensHit, 0);
  const goldensTotal = okRuns.reduce((sum, run) => sum + run.goldensTotal, 0);
  const chars = okRuns.reduce((sum, run) => sum + run.chars, 0);
  const tokens = okRuns.reduce((sum, run) => sum + run.tokens, 0);
  const reads = okRuns.reduce((sum, run) => sum + (run.reads ?? 0), 0);
  const latencies = okRuns.map((run) => run.latencyMs).sort((left, right) => left - right);

  const checkedRuns = okRuns.filter((run) => run.spam !== "absent");
  const leaked = checkedRuns.filter((run) => run.spam === "leaked").length;
  const caught = checkedRuns.length - leaked;

  return {
    queries: runs.length,
    ok: okRuns.length,
    recallAt5: goldensTotal === 0 ? 0 : round(goldensHit / goldensTotal, 4),
    goldensHit,
    goldensTotal,
    chars,
    tokens,
    avgChars: okRuns.length === 0 ? 0 : round(chars / okRuns.length, 1),
    avgTokens: okRuns.length === 0 ? 0 : round(tokens / okRuns.length, 1),
    latencyP50Ms: round(quantile(latencies, 0.5), 2),
    latencyP95Ms: round(quantile(latencies, 0.95), 2),
    reads,
    abstainRate: 0,
    spam: {
      checked: checkedRuns.length,
      leaked,
      caught,
      caughtRate: checkedRuns.length === 0 ? null : round(caught / checkedRuns.length, 4),
    },
  };
}

function compareMetrics(baseline: Metrics, reflex: Metrics): Verdict {
  const recallDelta = round((reflex.recallAt5 - baseline.recallAt5) * 100, 2);
  const tokenDeltaPct =
    baseline.tokens > 0 ? round(((reflex.tokens - baseline.tokens) / baseline.tokens) * 100, 1) : null;
  const readsDeltaPct =
    baseline.reads > 0 ? round(((reflex.reads - baseline.reads) / baseline.reads) * 100, 1) : null;

  const recallOk = recallDelta >= -2;
  const tokenOk = tokenDeltaPct !== null && tokenDeltaPct <= -20;
  const readsOk = readsDeltaPct !== null && readsDeltaPct <= -30;
  const ship = recallOk && (tokenOk || readsOk);

  const reasons: string[] = [];
  reasons.push(
    recallOk
      ? `recall within 2 points (${recallDelta >= 0 ? "+" : ""}${recallDelta} pts)`
      : `recall dropped ${Math.abs(recallDelta)} points (limit 2)`,
  );
  if (tokenDeltaPct === null) reasons.push("baseline returned no tokens; token delta unavailable");
  else if (tokenOk) reasons.push(`tokens cut ${Math.abs(tokenDeltaPct)}% (need >=20%)`);
  else reasons.push(`tokens changed ${tokenDeltaPct}% (need <=-20%)`);

  if (readsDeltaPct === null) reasons.push("baseline recorded no reads; reads delta unavailable");
  else if (readsOk) reasons.push(`reads cut ${Math.abs(readsDeltaPct)}% (need >=30%)`);
  else reasons.push(`reads changed ${readsDeltaPct}% (need <=-30%)`);

  return { recallDelta, tokenDeltaPct, readsDeltaPct, ship, reasons };
}

// ---------------------------------------------------------------------------
// Reports and files
// ---------------------------------------------------------------------------

function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join("-");
}

function displayPath(path: string): string {
  const relativePath = relative(BENCH_DIR, path);
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relative(BENCH_DIR, path) : path;
}

function defaultResultPath(mode: "offline" | "live"): string {
  return join(RESULTS_DIR, `${stamp(new Date())}-${mode}.json`);
}

function writeReport(report: BenchReport, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw fail("E_CONFIG", "config", {
      hint: `cannot write bench result ${displayPath(path)} (${code})`,
    });
  }
}

function filterQueries(queries: readonly QueryRow[], klass: BenchClass | null): QueryRow[] {
  if (klass === null) return [...queries];
  return queries.filter((query) => query.class === klass);
}

// ---------------------------------------------------------------------------
// Offline mode
// ---------------------------------------------------------------------------

function runOffline(options: CliOptions): number {
  const queries = filterQueries(loadQueries(options.queriesPath), options.classFilter);
  if (queries.length === 0) {
    throw fail("E_CONFIG", "config", {
      hint: `no queries of class ${options.classFilter ?? "(any)"} in ${displayPath(options.queriesPath)}`,
    });
  }
  const fixtures = loadFixtures(options.serpSource);

  const runs: QueryRun[] = [];
  const started = performance.now();
  for (const query of queries) {
    const fixture = pickFixture(query, fixtures);
    runs.push(replayQuery(query, fixture, options.n));
  }
  const elapsedMs = performance.now() - started;
  const metrics = summarise(runs);

  const report: BenchReport = {
    schema: SCHEMA,
    mode: "offline",
    render: "md",
    generatedAt: new Date().toISOString(),
    queriesFile: displayPath(options.queriesPath),
    serpSource: displayPath(options.serpSource),
    n: options.n,
    limit: null,
    engineOverride: null,
    queries: runs,
    metrics,
    stopped: null,
    notes: [
      "offline replay: recorded SERPs through src/extract/compact.ts with SPEC defaults",
      "abstainRate is a placeholder (0) until the reflex layer lands in P5-B/C",
      "reads is 0 offline; reflex gate numbers must come from a live/reflex result file",
    ],
  };

  if (options.write) {
    const out = options.out ?? defaultResultPath("offline");
    writeReport(report, out);
    process.stdout.write(`written: ${displayPath(out)}\n`);
  }

  const spam =
    metrics.spam.checked === 0
      ? "spam n/a"
      : `spam leaked ${metrics.spam.leaked}/${metrics.spam.checked}`;
  process.stdout.write(
    [
      `bench offline: ${metrics.queries} queries (${metrics.ok} ok) in ${Math.round(elapsedMs)} ms`,
      `recall@5 ${metrics.recallAt5.toFixed(3)} (${metrics.goldensHit}/${metrics.goldensTotal} goldens in top 5)`,
      `tokens ${metrics.tokens} (chars ${metrics.chars}, avg ${metrics.avgTokens}/query)`,
      `latency p50 ${metrics.latencyP50Ms} ms / p95 ${metrics.latencyP95Ms} ms`,
      spam,
    ].join("\n") + "\n",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Live mode (opt-in, one query at a time, stops at a wall)
// ---------------------------------------------------------------------------

const STOP_CODES = new Set([
  "E_WALL",
  "E_BUSY",
  "E_RATE_LIMITED",
  "E_CDP_UNAVAILABLE",
  "E_CDP_DISCONNECTED",
  "E_TARGET_LOST",
]);

function validateLiveLimit(
  limit: number | null,
  allowMore: boolean,
  total: number,
): number {
  if (limit === null) {
    throw fail("E_CONFIG", "config", {
      hint: "live mode requires --limit N (start with --limit 1); it never runs the whole set by default",
    });
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw fail("E_CONFIG", "config", { hint: "--limit must be a positive integer" });
  }
  if (limit > DEFAULT_LIVE_CAP && !allowMore) {
    throw fail("E_CONFIG", "config", {
      hint: `--limit above ${DEFAULT_LIVE_CAP} needs --allow-more; one wall costs the profile more than one bench run`,
    });
  }
  return Math.min(limit, total);
}

/**
 * Round-robin across classes so a five-query live run covers five topics instead
 * of five trivia questions. Deterministic: no shuffling, no personal queries.
 */
function selectLiveQueries(
  queries: readonly QueryRow[],
  limit: number,
  klass: BenchClass | null,
): QueryRow[] {
  if (klass !== null) return queries.filter((query) => query.class === klass).slice(0, limit);
  const buckets = CLASSES.map((name) => queries.filter((query) => query.class === name));
  const selected: QueryRow[] = [];
  let added = true;
  while (selected.length < limit && added) {
    added = false;
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next === undefined) continue;
      selected.push(next);
      added = true;
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function domainsFromSearchText(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = null;
  }
  if (isRecord(parsed) && Array.isArray(parsed.results)) {
    const domains: string[] = [];
    for (const item of parsed.results) {
      if (!isRecord(item)) continue;
      const declared = textOf(item.domain);
      const fromUrl = textOf(item.url);
      const domain = declared ?? (fromUrl === undefined ? "" : domainOf(fromUrl));
      if (domain.length > 0) domains.push(domain.toLowerCase());
    }
    return domains;
  }
  // Fallback for a truncated JSON render: scrape links in document order.
  const domains: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
    const domain = domainOf(match[0]);
    if (domain.length > 0) domains.push(domain);
  }
  return domains;
}

function detailString(details: unknown, key: string): string | undefined {
  if (!isRecord(details)) return undefined;
  return textOf(details[key]);
}

async function runLive(options: CliOptions): Promise<number> {
  if (process.env.PI_CHROME_LIVE !== "1") {
    throw fail("E_CONFIG", "config", {
      hint: "live mode is opt-in: set PI_CHROME_LIVE=1 and enable CDP in chrome://inspect",
    });
  }

  const allQueries = filterQueries(loadQueries(options.queriesPath), options.classFilter);
  const limit = validateLiveLimit(options.limit, options.allowMore, allQueries.length);
  const queries = selectLiveQueries(allQueries, limit, options.classFilter);
  if (queries.length === 0) {
    throw fail("E_CONFIG", "config", {
      hint: `no live queries selected from ${displayPath(options.queriesPath)}`,
    });
  }

  // Same runtime wiring as `research/probes/08-live-search.mjs`: the bench calls
  // the real registered tool, not a reimplementation, so pacing/cache/fallback
  // are exactly what the agent gets. Imports are dynamic so offline mode never
  // loads the CDP stack.
  const { loadConfig, resolveConfigPath } = await import("../src/config.ts");
  const { discoverEndpoint } = await import("../src/cdp/discovery.ts");
  const { createConnector } = await import("../src/cdp/browser.ts");
  const { createCache } = await import("../src/runtime/cache.ts");
  const { createSystemClock } = await import("../src/runtime/clock.ts");
  const { createLimiter } = await import("../src/runtime/limiter.ts");
  const { createArtifacts } = await import("../src/runtime/artifacts.ts");
  const { createLogger } = await import("../src/runtime/log.ts");
  const { createDefaultRegistry } = await import("../src/engines/index.ts");
  const { createTools } = await import("../src/tools/index.ts");
  type ToolDeps = import("../src/tools/types.ts").ToolDeps;
  type DoctorDeps = import("../src/runtime/doctor.ts").DoctorDeps;

  const env = process.env;
  const config = loadConfig({ env });
  const configPath = resolveConfigPath(env);
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const stateDir = join(agentDir, "web-search");
  const clock = createSystemClock();
  const log = createLogger({ path: join(stateDir, "decisions.jsonl"), clock });
  const cache = createCache({ maxEntries: config.cache.maxEntries, clock });
  const limiter = createLimiter({ config, clock, statePath: join(stateDir, "state.json") });
  const artifacts = createArtifacts({ config, clock });
  const connector = createConnector({
    config,
    clock,
    log,
    discover: () =>
      discoverEndpoint({
        ports: config.cdp.ports,
        ws: config.cdp.ws,
        timeoutMs: config.cdp.connectTimeoutMs,
      }),
  });
  const registry = createDefaultRegistry(config);

  const deps: ToolDeps = {
    config,
    engines: registry,
    cdp: connector,
    cache,
    limiter,
    artifacts,
    log,
    clock,
  };
  const doctorDeps: DoctorDeps = {
    config,
    configPath,
    connector,
    registry,
    cache,
    artifacts,
    clock,
    limiter,
  };
  // `createTools` returns a heterogeneous array, so index 0 is the union of
  // every tool type. Narrow to the one tool this bench calls.
  type WebSearchTool = import("../src/tools/web_search.ts").WebSearchTool;
  type WebSearchDetails = import("../src/tools/web_search.ts").WebSearchDetails;
  const tool = createTools({ getDeps: () => deps, getDoctorDeps: () => doctorDeps })[0] as WebSearchTool;

  const runs: QueryRun[] = [];
  let stopped: BenchReport["stopped"] = null;

  try {
    for (let index = 0; index < queries.length; index += 1) {
      const query = queries[index] as QueryRow;
      if (index > 0) await delay(LIVE_GAP_MS);

      const started = performance.now();
      const outcome = await tool.execute(
        `bench-${query.id}`,
        {
          q: query.q,
          n: options.n,
          engines: options.engine ?? query.engines ?? "auto",
          format: "json",
        },
        undefined,
        undefined,
      );
      const latencyMs = performance.now() - started;
      const text = outcome.content.map((block) => block.text).join("");

      if ("isError" in outcome && outcome.isError === true) {
        const code = detailString(outcome.details, "code") ?? "E_PARSE";
        const stage = detailString(outcome.details, "stage") ?? "extract";
        const hint = detailString(outcome.details, "hint");
        runs.push({
          id: query.id,
          q: query.q,
          class: query.class,
          lang: query.lang,
          engines: options.engine ?? query.engines ?? "auto",
          fixture: null,
          ok: false,
          recallAt5: 0,
          goldensHit: 0,
          goldensTotal: query.goldenDomains.length,
          chars: 0,
          tokens: 0,
          latencyMs,
          results: 0,
          ai: false,
          cached: false,
          topDomains: [],
          spam: "absent",
          error: { code, stage, ...(hint === undefined ? {} : { hint }) },
        });
        process.stderr.write(`live ${query.id}: ${code} at ${stage}\n`);
        if (STOP_CODES.has(code)) {
          stopped = { at: query.id, code, stage };
          process.stderr.write(
            `stopped: ${code}; solve it in the visible window, then rerun later (never retry in a loop)\n`,
          );
          break;
        }
        continue;
      }

      const topDomains = domainsFromSearchText(text).slice(0, options.n);
      const details = outcome.details as WebSearchDetails;
      const goldensHit = query.goldenDomains.filter((golden) =>
        topDomains.some((domain) => domainMatches(domain, golden)),
      ).length;
      runs.push({
        id: query.id,
        q: query.q,
        class: query.class,
        lang: query.lang,
        engines: options.engine ?? query.engines ?? "auto",
        fixture: null,
        ok: true,
        recallAt5: query.goldenDomains.length === 0 ? 0 : goldensHit / query.goldenDomains.length,
        goldensHit,
        goldensTotal: query.goldenDomains.length,
        chars: text.length,
        tokens: Math.ceil(text.length / 4),
        latencyMs,
        results: typeof details.results === "number" ? details.results : topDomains.length,
        ai: details.ai === true,
        cached: details.cached === true,
        topDomains,
        spam: "absent",
      });
    }
  } finally {
    await connector.releaseAll().catch(() => {});
  }

  const metrics = summarise(runs);
  const report: BenchReport = {
    schema: SCHEMA,
    mode: "live",
    render: "json",
    generatedAt: new Date().toISOString(),
    queriesFile: displayPath(options.queriesPath),
    serpSource: "live-chrome",
    n: options.n,
    limit,
    engineOverride: options.engine,
    queries: runs,
    metrics,
    stopped,
    notes: [
      "live run: real web_search through the extension stack, one query at a time",
      "no wall retry; a stop code ends the run and the window is left for the user",
      "spam is not injected live, so the spam metric is null here",
      "cache hits are reported per query; a cached run is fast but not a fresh SERP",
    ],
  };

  const out = options.out ?? defaultResultPath("live");
  if (options.write) {
    writeReport(report, out);
    process.stdout.write(`written: ${displayPath(out)}\n`);
  }

  process.stdout.write(
    [
      `bench live: ${metrics.queries} queries (${metrics.ok} ok)${stopped === null ? "" : `, stopped at ${stopped.at} (${stopped.code})`}`,
      `recall@5 ${metrics.recallAt5.toFixed(3)} (${metrics.goldensHit}/${metrics.goldensTotal})`,
      `tokens ${metrics.tokens}, latency p50 ${metrics.latencyP50Ms} ms / p95 ${metrics.latencyP95Ms} ms`,
      `cached runs: ${runs.filter((run) => run.cached).length}`,
    ].join("\n") + "\n",
  );
  return stopped !== null && stopped.code === "E_WALL" ? 3 : 0;
}

// ---------------------------------------------------------------------------
// Compare mode
// ---------------------------------------------------------------------------

function loadReport(path: string): BenchReport {
  const parsed = readJsonFile(path, "bench result");
  if (!isRecord(parsed)) {
    throw fail("E_CONFIG", "config", { hint: `${displayPath(path)} is not a bench result object` });
  }
  if (parsed.schema !== SCHEMA) {
    throw fail("E_CONFIG", "config", {
      hint: `${displayPath(path)} has schema ${JSON.stringify(parsed.schema)}; expected ${SCHEMA}`,
    });
  }
  if (!isRecord(parsed.metrics)) {
    throw fail("E_CONFIG", "config", { hint: `${displayPath(path)} has no metrics object` });
  }
  if (!Array.isArray(parsed.queries)) {
    throw fail("E_CONFIG", "config", { hint: `${displayPath(path)} has no queries array` });
  }
  for (const key of ["recallAt5", "tokens", "reads"] as const) {
    const value = parsed.metrics[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw fail("E_CONFIG", "config", {
        hint: `${displayPath(path)}: metrics.${key} must be a non-negative number`,
      });
    }
  }
  return parsed as unknown as BenchReport;
}

function runCompare(options: CliOptions): number {
  const pair = options.compare;
  if (pair === null) {
    throw fail("E_CONFIG", "config", { hint: "--compare needs two result files" });
  }
  const baseline = loadReport(pair[0]);
  const reflex = loadReport(pair[1]);
  const verdict = compareMetrics(baseline.metrics, reflex.metrics);

  // A verdict is only meaningful like-for-like: same mode, same render, same
  // query set. Crossing any of those silently would make a number look like a win.
  const baselineIds = baseline.queries.map((run) => run.id).join(",");
  const reflexIds = reflex.queries.map((run) => run.id).join(",");
  if (baseline.mode !== reflex.mode) {
    verdict.ship = false;
    verdict.reasons.push(`mode differs (${baseline.mode} vs ${reflex.mode}); compare like with like`);
  }
  if (baseline.render !== reflex.render) {
    verdict.ship = false;
    verdict.reasons.push(`render differs (${baseline.render} vs ${reflex.render}); token delta is indicative only`);
  }
  if (baselineIds !== reflexIds) {
    verdict.ship = false;
    verdict.reasons.push(
      `query sets differ (baseline ${baseline.queries.length}, reflex ${reflex.queries.length}); a partial run cannot ship`,
    );
  }

  const comparison: Comparison = {
    schema: COMPARE_SCHEMA,
    baseline: { file: pair[0], mode: baseline.mode, metrics: baseline.metrics },
    reflex: { file: pair[1], mode: reflex.mode, metrics: reflex.metrics },
    verdict,
  };
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  process.stdout.write(
    `verdict: ${verdict.ship ? "SHIP" : "KEEP OFF"} (recall ${verdict.recallDelta} pts, tokens ${verdict.tokenDeltaPct ?? "n/a"}%, reads ${verdict.readsDeltaPct ?? "n/a"}%)\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const PERSONAL_MARKERS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /sh2nk/i,
  /kaluga/i,
  /rostelecom/i,
];

function runSelfTest(options: CliOptions): number {
  const results: CheckResult[] = [];
  const check = (name: string, fn: () => string): void => {
    try {
      results.push({ name, ok: true, detail: fn() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail: message });
    }
  };
  const assert: (condition: boolean, message: string) => asserts condition = (condition, message) => {
    if (!condition) {
      throw fail("E_CONFIG", "config", { hint: "self-test assertion failed", message });
    }
  };

  let queries: QueryRow[] = [];
  let fixtures: LoadedFixture[] = [];

  check("queries: structure and no personal data", () => {
    queries = loadQueries(options.queriesPath);
    assert(queries.length >= 28 && queries.length <= 32, `expected ~30 queries, found ${queries.length}`);
    const ids = new Set<string>();
    for (const query of queries) {
      assert(!ids.has(query.id), `duplicate id ${query.id}`);
      ids.add(query.id);
      assert(query.goldenDomains.length >= 2 && query.goldenDomains.length <= 4, `${query.id}: goldens`);
      for (const marker of PERSONAL_MARKERS) {
        assert(!marker.test(query.q), `${query.id}: personal marker ${marker} in the query text`);
      }
    }
    return `${queries.length} queries, unique ids`;
  });

  check("queries: class and language mix", () => {
    for (const klass of CLASSES) {
      const count = queries.filter((query) => query.class === klass).length;
      assert(count >= 5, `${klass}: only ${count} queries`);
    }
    for (const lang of LANGS) {
      const count = queries.filter((query) => query.lang === lang).length;
      assert(count >= 10, `${lang}: only ${count} queries`);
    }
    return CLASSES.map(
      (klass) => `${klass}=${queries.filter((query) => query.class === klass).length}`,
    ).join(" ");
  });

  check("fixtures: load and spam sentinel", () => {
    fixtures = loadFixtures(options.serpSource);
    for (const klass of CLASSES) {
      const count = fixtures.filter((fixture) => fixture.class === klass).length;
      assert(count >= 2, `${klass}: only ${count} fixture SERPs`);
    }
    for (const fixture of fixtures) {
      const spamCount = fixture.results.filter((result) => domainOf(result.url) === SPAM_DOMAIN).length;
      assert(
        spamCount === SPAM_MARKER_COUNT,
        `${fixture.id}: expected exactly one ${SPAM_DOMAIN} result, found ${spamCount}`,
      );
      assert(fixture.results.length >= 4, `${fixture.id}: needs at least 4 results`);
    }
    return `${fixtures.length} SERPs, ${fixtures.reduce((sum, fixture) => sum + fixture.results.length, 0)} results`;
  });

  check("fixtures: every query has a plausible SERP", () => {
    for (const query of queries) {
      const fixture = pickFixture(query, fixtures);
      const fixtureDomains = fixture.results.map((result) => domainOf(result.url));
      const overlap = query.goldenDomains.filter((golden) =>
        fixtureDomains.some((domain) => domainMatches(domain, golden)),
      );
      assert(overlap.length > 0, `${query.id}: chosen fixture ${fixture.id} has no golden domain`);
    }
    return `${queries.length} queries covered`;
  });

  let runs: QueryRun[] = [];
  let elapsedMs = 0;
  check("replay: deterministic and capped", () => {
    const first = queries.map((query) => replayQuery(query, pickFixture(query, fixtures), options.n));
    const second = queries.map((query) => replayQuery(query, pickFixture(query, fixtures), options.n));
    const key = (run: QueryRun): string =>
      JSON.stringify({
        id: run.id,
        recallAt5: run.recallAt5,
        chars: run.chars,
        tokens: run.tokens,
        spam: run.spam,
        topDomains: run.topDomains,
      });
    assert(
      first.map(key).join("\n") === second.map(key).join("\n"),
      "two replays of the same corpus disagree",
    );
    for (const run of first) {
      assert(run.chars <= COMPACT_DEFAULTS.outputMaxChars, `${run.id}: ${run.chars} chars over cap`);
      assert(run.results <= options.n, `${run.id}: ${run.results} results over n=${options.n}`);
      assert(run.tokens === Math.ceil(run.chars / 4), `${run.id}: token estimate drift`);
      assert(run.recallAt5 >= 0 && run.recallAt5 <= 1, `${run.id}: recall out of range`);
    }
    runs = first;
    return `${queries.length} replays identical, all <= ${COMPACT_DEFAULTS.outputMaxChars} chars`;
  });

  check("replay: under 2 s wall clock", () => {
    const started = performance.now();
    for (const query of queries) replayQuery(query, pickFixture(query, fixtures), options.n);
    elapsedMs = performance.now() - started;
    assert(elapsedMs < 2_000, `offline replay took ${Math.round(elapsedMs)} ms`);
    return `${Math.round(elapsedMs)} ms for ${queries.length} queries`;
  });

  check("metrics: spam and abstain placeholders are honest", () => {
    const metrics = summarise(runs);
    assert(metrics.queries === queries.length, "query count drift");
    assert(metrics.spam.checked === queries.length, "every replay should carry one synthetic spam sentinel");
    assert(metrics.spam.leaked >= 1, "fixtures never leak spam, so the metric cannot be trusted");
    assert(metrics.spam.caught + metrics.spam.leaked === metrics.spam.checked, "spam totals do not add up");
    assert(metrics.abstainRate === 0, "abstain must stay a placeholder until P5-B/C");
    assert(metrics.reads === 0, "offline runs must not invent reads");
    return `spam leaked ${metrics.spam.leaked}/${metrics.spam.checked}, abstain 0 (placeholder)`;
  });

  check("verdict: SPEC 9.4 ship rule", () => {
    const baseline = summarise(runs);
    const same = compareMetrics(baseline, baseline);
    assert(same.ship === false, "identical results must not ship");

    const tokenCut: Metrics = { ...baseline, tokens: Math.round(baseline.tokens * 0.75) };
    assert(compareMetrics(baseline, tokenCut).ship === true, "25% token cut with equal recall should ship");

    const recallDrop: Metrics = {
      ...tokenCut,
      recallAt5: round(baseline.recallAt5 - 0.025, 4),
    };
    assert(compareMetrics(baseline, recallDrop).ship === false, "2.5 point recall drop must block");

    const noReads: Metrics = { ...baseline, tokens: Math.round(baseline.tokens * 1.05) };
    // A reads baseline only exists when a gate was recorded; fabricate one.
    const withReads: Metrics = { ...baseline, reads: 100 };
    const fewerReads: Metrics = { ...baseline, reads: 65, tokens: Math.round(baseline.tokens * 1.05) };
    assert(compareMetrics(withReads, fewerReads).ship === true, "35% reads cut should ship");
    assert(compareMetrics(baseline, noReads).ship === false, "shrinking nothing must not ship");

    const tight: Metrics = { ...baseline, tokens: Math.round(baseline.tokens * 0.8) };
    assert(compareMetrics(baseline, tight).ship === true, "exactly 20% token cut should ship");
    const tiny: Metrics = { ...baseline, tokens: Math.round(baseline.tokens * 0.81) };
    assert(compareMetrics(baseline, tiny).ship === false, "19% token cut must not ship");
    return "4 negative cases + 3 positive cases";
  });

  check("live: limit guard", () => {
    assert(validateLiveLimit(1, false, 30) === 1, "limit 1 must pass");
    assert(validateLiveLimit(5, false, 30) === 5, "limit 5 must pass");
    assert(validateLiveLimit(6, true, 30) === 6, "explicit allow-more must pass");
    assert(validateLiveLimit(40, true, 30) === 30, "limit must clamp to the query count");
    let refused = false;
    try {
      validateLiveLimit(6, false, 30);
    } catch {
      refused = true;
    }
    assert(refused, "limit 6 without --allow-more must be refused");
    let missing = false;
    try {
      validateLiveLimit(null, false, 30);
    } catch {
      missing = true;
    }
    assert(missing, "live mode without --limit must be refused");
    return "requires --limit, caps at 5 unless --allow-more, clamps to set size";
  });

  check("report: JSON shape round-trips", () => {
    const metrics = summarise(runs);
    const report: BenchReport = {
      schema: SCHEMA,
      mode: "offline",
      render: "md",
      generatedAt: new Date(0).toISOString(),
      queriesFile: displayPath(options.queriesPath),
      serpSource: displayPath(options.serpSource),
      n: options.n,
      limit: null,
      engineOverride: null,
      queries: runs,
      metrics,
      stopped: null,
      notes: [],
    };
    const roundTripped = JSON.parse(JSON.stringify(report)) as unknown;
    assert(isRecord(roundTripped), "report did not round-trip");
    assert(roundTripped.schema === SCHEMA, "schema lost");
    assert(isRecord(roundTripped.metrics), "metrics lost");
    assert(Array.isArray(roundTripped.queries), "queries lost");
    return `${JSON.stringify(report).length} bytes serialized`;
  });

  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}\n`);
  }
  process.stdout.write(
    `\nself-test ${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length} checks, ${failed.length} failed\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  switch (options.mode) {
    case "self-test":
      return runSelfTest(options);
    case "compare":
      return runCompare(options);
    case "live":
      return runLive(options);
    case "offline":
      return runOffline(options);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (isWebSearchError(error)) {
    process.stderr.write(
      `bench failed [${error.details.code}] stage=${error.details.stage}: ${error.details.hint}\n`,
    );
    process.exitCode = error.details.code === "E_WALL" ? 3 : 2;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`bench failed [E_PARSE] stage=render: ${message}\n`);
    process.exitCode = 2;
  }
}
