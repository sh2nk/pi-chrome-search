#!/usr/bin/env node
/**
 * P6-B codemode bench — what the MODEL sees through three paths (SPEC §7.6,
 * PLAN P6-B / V6.4).
 *
 * A real codemode run needs an agent loop, and this repo has no model in the
 * offline bench. So this harness measures the only honest thing it can measure
 * without one: **deterministic output characters**, i.e. the text a model would
 * have to read after each path did the same job on the same recorded corpus.
 *
 * Nothing here calls a model, a socket or Chrome. Every path reuses production
 * code:
 *
 * - `direct`    — one `web_search` (n=5) rendered by `src/extract/compact.ts`
 *                 with the SPEC defaults, then two `web_read` calls on the top
 *                 results at the 6000-char default. Three agent-visible calls.
 * - `codemode`  — one script (`CODEMODE_SCRIPT` below) that calls the same tools
 *                 over `tools.web_search` / `tools.web_read` with
 *                 `Promise.allSettled`, filters client-side and returns a
 *                 compact JSON. Only that JSON plus the script text is charged
 *                 to the model; the nested tool payloads stay inside the script.
 *                 The equivalent logic runs in-process (`codemodeScript`) so the
 *                 measurement is deterministic.
 * - `research`  — one real `web_research` call (budget normal, plus quick/deep)
 *                 with injected seams, counting the rendered bundle.
 *
 * What this does NOT measure, and the report says so: model/agent thinking time,
 * network or browser latency, answer quality, or whether the filtered codemode
 * payload still contains the paragraph the answer needed. A codemode script
 * decides what to keep *blind* — that is the whole trade-off, and a char count
 * alone cannot price it.
 *
 * Read payload proxy: the SERP fixtures are synthetic and no page bodies were
 * recorded for their URLs, so each read is served one of the three committed
 * read fixtures (`tests/fixtures/read-{docs,blog,wiki}.html.gz`, real MDN / Rust
 * blog / RU Wikipedia captures) through the real readability pass
 * (`extractReadableDocument` + `renderReadableDocument`) at the requested cap.
 * The mapping is by domain (see `readProxyFor`). It measures the *cost shape* of
 * a real page read at 6000 chars (or at web_research's smaller per-read cap), not
 * the content of that exact URL. The DOM harness is `tests/helpers/dom.ts`, i.e.
 * the existing `linkedom` devDependency — this lane adds no dependency.
 *
 * Usage:
 *   node bench/codemode.ts              # markdown report on stdout
 *   node bench/codemode.ts --json       # same numbers, machine-readable
 *   node bench/codemode.ts --self-test  # corpus/consistency/determinism checks
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { CdpConnector } from "../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { EngineId, EngineRegistry, RawSerp } from "../src/engines/types.ts";
import { compactSerps, type CompactResult } from "../src/extract/compact.ts";
import {
  extractReadableDocument,
  renderReadableDocument,
  type ReadableDocument,
} from "../src/extract/read.ts";
import { domainOf } from "../src/extract/urls.ts";
import { fail } from "../src/runtime/errors.ts";
import type { Artifacts, Cache, Clock, Limiter, LimiterStats, Logger } from "../src/runtime/types.ts";
import type { ToolDeps } from "../src/tools/types.ts";
import {
  RESEARCH_BUDGETS,
  createWebResearchTool,
  type ResearchBudget,
  type WebResearchFailure,
  type WebResearchResult,
} from "../src/tools/web_research.ts";
import { fixtureDocument, runInPage } from "../tests/helpers/dom.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_QUERIES = join(HERE, "queries.jsonl");
const DEFAULT_FIXTURES = join(HERE, "fixtures");
const READ_FIXTURES = join(HERE, "..", "tests", "fixtures");

const SCHEMA = "pi-chrome-search/codemode@1";
const CLASSES = ["factual", "technical", "commercial", "news", "ambiguous"] as const;
type BenchClass = (typeof CLASSES)[number];
const ENGINES: readonly EngineId[] = ["google", "duckduckgo", "yandex"];

/** SPEC defaults, copied as literals for the same reason `bench/run.ts` does. */
const COMPACT_DEFAULTS = {
  summaryMaxChars: 1200,
  snippetMaxChars: 140,
  outputMaxChars: 2500,
} as const;

const DEFAULT_N = 5;
/** `web_read` default (SPEC §7.2) and the number of reads a careful agent does. */
const READ_MAX_CHARS = 6000;
const READ_TOP_K = 2;
/** web_research's rendered bundle cap is `config.search.outputMaxChars`. */
const RESEARCH_BUDGET: ResearchBudget = "normal";
const RESEARCH_BUDGETS_MEASURED: readonly ResearchBudget[] = ["quick", "normal", "deep"];

/** Codemode keeps at most this much of each read body (a documented assumption). */
const CODEMODE_READ_HEAD = 600;
/** Same-domain cap the script applies; mirrors `COMPACT_CAPS.perDomainLimit`. */
const CODEMODE_PER_DOMAIN = 2;
/** Snippet width the script keeps; the tool's own compaction cap is 140. */
const CODEMODE_SNIPPET = 140;

/**
 * The script an agent has to write once per research session to get the codemode
 * path. Its characters are charged to the model (see `runCodemode`): a tool call
 * argument stays in the transcript and is re-read on later turns. The constants
 * in the script are asserted against the code in `--self-test`, so this text and
 * the in-process equivalent cannot drift apart silently.
 */
const CODEMODE_SCRIPT = `// one codemode call per query; tools.* are the extension's own tools
const q = args.q;
const found = JSON.parse((await tools.web_search({ q, n: 5, format: "json" })).content[0].text);
const top = found.results.slice(0, 2);
const pages = await Promise.allSettled(
  top.map((r) => tools.web_read({ url: r.url, maxChars: 6000 })),
);
const per = new Map();
const results = [];
for (const r of found.results) {
  const seen = (per.get(r.domain) ?? 0) + 1;
  per.set(r.domain, seen);
  if (seen <= 2) results.push({ t: r.title, u: r.url, d: r.domain, s: r.snippet.slice(0, 140) });
}
const reads = pages.map((p, i) =>
  p.status === "fulfilled"
    ? { u: top[i].url, x: String(p.value.content[0].text).slice(0, 600) }
    : { u: top[i].url, x: "" },
);
return JSON.stringify({ q, results, reads });`;

const SPAM_DOMAIN = "spam-seo.example";

// ---------------------------------------------------------------------------
// Corpus loading (a small duplicate of bench/run.ts; that file is a CLI and
// cannot be imported without running it)
// ---------------------------------------------------------------------------

interface QueryRow {
  id: string;
  q: string;
  class: BenchClass;
  lang: "en" | "ru";
  goldenDomains: string[];
}

interface FixtureResult {
  title: string;
  url: string;
  snippet: string;
}

interface FixtureSerp {
  id: string;
  engine: EngineId;
  covers?: string[];
  ai?: { text: string; sources: string[] };
  results: FixtureResult[];
}

interface LoadedFixture extends FixtureSerp {
  class: BenchClass;
}

interface Corpus {
  queries: QueryRow[];
  fixtures: LoadedFixture[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isClass(value: string): value is BenchClass {
  return (CLASSES as readonly string[]).includes(value);
}

function isEngineId(value: string): value is EngineId {
  return (ENGINES as readonly string[]).includes(value);
}

function loadQueries(path: string): QueryRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw fail("E_CONFIG", "config", { hint: `cannot read query set ${path} (${code})` });
  }

  const queries: QueryRow[] = [];
  const seen = new Set<string>();
  raw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${index + 1} is not JSON: ${message}` });
    }
    queries.push(validateQuery(parsed, index + 1, seen));
  });
  if (queries.length === 0) {
    throw fail("E_CONFIG", "config", { hint: `query set ${path} is empty` });
  }
  return queries;
}

function validateQuery(value: unknown, line: number, seen: Set<string>): QueryRow {
  if (!isRecord(value)) {
    throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line} is not an object` });
  }
  const id = textOf(value.id);
  const q = textOf(value.q);
  const klass = textOf(value.class);
  const lang = textOf(value.lang);
  const goldens = value.goldenDomains;
  if (id === undefined || q === undefined || klass === undefined || lang === undefined) {
    throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line}: id, q, class, lang are required` });
  }
  if (!isClass(klass) || (lang !== "en" && lang !== "ru")) {
    throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line} (${id}): bad class or lang` });
  }
  if (!Array.isArray(goldens) || goldens.length < 2) {
    throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line} (${id}): goldenDomains needs 2+ entries` });
  }
  if (seen.has(id)) {
    throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line} repeats id ${id}` });
  }
  seen.add(id);
  const goldenDomains = goldens.map((golden) => {
    const domain = textOf(golden)?.trim().toLowerCase() ?? "";
    if (domain === "") {
      throw fail("E_CONFIG", "config", { hint: `queries.jsonl line ${line} (${id}): empty golden domain` });
    }
    return domain;
  });
  return { id, q, class: klass, lang, goldenDomains };
}

function loadFixtures(dir: string): LoadedFixture[] {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" }).map((entry) => ({
      name: entry.name,
      isFile: () => entry.isFile(),
    }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw fail("E_CONFIG", "config", { hint: `cannot read SERP source ${dir} (${code})` });
  }
  const fixtures: LoadedFixture[] = [];
  const seen = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(dir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw fail("E_CONFIG", "config", { hint: `SERP fixture ${path} is not JSON: ${message}` });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.serps)) {
      throw fail("E_CONFIG", "config", { hint: `SERP fixture ${path} must be an object with serps` });
    }
    const klass = textOf(parsed.class);
    if (klass === undefined || !isClass(klass)) {
      throw fail("E_CONFIG", "config", { hint: `SERP fixture ${path}: bad class` });
    }
    for (const rawSerp of parsed.serps) {
      const serp = validateFixtureSerp(rawSerp, klass, path);
      if (seen.has(serp.id)) {
        throw fail("E_CONFIG", "config", { hint: `SERP fixture id ${serp.id} appears twice` });
      }
      seen.add(serp.id);
      fixtures.push(serp);
    }
  }
  if (fixtures.length === 0) {
    throw fail("E_CONFIG", "config", { hint: `no SERP fixtures under ${dir}` });
  }
  return fixtures;
}

function validateFixtureSerp(value: unknown, klass: BenchClass, file: string): LoadedFixture {
  if (!isRecord(value)) {
    throw fail("E_CONFIG", "config", { hint: `SERP in ${file} is not an object` });
  }
  const id = textOf(value.id);
  const engine = textOf(value.engine);
  if (id === undefined || engine === undefined || !isEngineId(engine)) {
    throw fail("E_CONFIG", "config", { hint: `SERP in ${file}: id and a valid engine are required` });
  }
  if (!Array.isArray(value.results) || value.results.length === 0) {
    throw fail("E_CONFIG", "config", { hint: `SERP ${id}: results must be a non-empty array` });
  }
  const results: FixtureResult[] = value.results.map((raw) => {
    if (!isRecord(raw)) {
      throw fail("E_CONFIG", "config", { hint: `SERP ${id}: every result must be an object` });
    }
    const title = textOf(raw.title);
    const url = textOf(raw.url);
    const snippet = textOf(raw.snippet);
    if (title === undefined || url === undefined || snippet === undefined || domainOf(url) === "") {
      throw fail("E_CONFIG", "config", { hint: `SERP ${id}: every result needs title, url, snippet` });
    }
    return { title, url, snippet };
  });
  const covers = Array.isArray(value.covers)
    ? value.covers.filter((cover): cover is string => typeof cover === "string")
    : undefined;

  let ai: { text: string; sources: string[] } | undefined;
  if (value.ai !== undefined) {
    if (!isRecord(value.ai)) {
      throw fail("E_CONFIG", "config", { hint: `SERP ${id}: ai must be an object` });
    }
    const text = textOf(value.ai.text);
    if (text === undefined || text.trim() === "") {
      throw fail("E_CONFIG", "config", { hint: `SERP ${id}: ai.text is required` });
    }
    const sources = Array.isArray(value.ai.sources)
      ? value.ai.sources.filter((source): source is string => typeof source === "string")
      : [];
    ai = { text, sources };
  }

  return {
    id,
    engine,
    class: klass,
    results,
    ...(covers === undefined ? {} : { covers }),
    ...(ai === undefined ? {} : { ai }),
  };
}

function loadCorpus(queriesPath = DEFAULT_QUERIES, fixturesDir = DEFAULT_FIXTURES): Corpus {
  return { queries: loadQueries(queriesPath), fixtures: loadFixtures(fixturesDir) };
}

function domainMatches(domain: string, golden: string): boolean {
  const left = domain.toLowerCase();
  const right = golden.toLowerCase();
  return left === right || left.endsWith(`.${right}`);
}

/**
 * Same deterministic fixture choice as `bench/run.ts`: an explicit `covers` entry
 * wins, otherwise the SERP sharing the most golden domains, ties by fixture id.
 */
function pickFixture(query: QueryRow, fixtures: readonly LoadedFixture[]): LoadedFixture {
  const candidates = fixtures.filter((fixture) => fixture.class === query.class);
  if (candidates.length === 0) {
    throw fail("E_CONFIG", "config", { hint: `no fixture for class ${query.class} (query ${query.id})` });
  }
  const score = (fixture: LoadedFixture): number => {
    let value = fixture.covers?.includes(query.id) === true ? 5 : 0;
    const domains = fixture.results.map((result) => domainOf(result.url));
    for (const golden of query.goldenDomains) {
      if (domains.some((domain) => domainMatches(domain, golden))) value += 10;
    }
    return value;
  };
  let best = candidates[0] as LoadedFixture;
  let bestScore = score(best);
  for (const candidate of candidates.slice(1)) {
    const candidateScore = score(candidate);
    if (candidateScore > bestScore || (candidateScore === bestScore && candidate.id < best.id)) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  if (bestScore === 0) {
    throw fail("E_CONFIG", "config", { hint: `fixture ${best.id} shares no golden with query ${query.id}` });
  }
  return best;
}

// ---------------------------------------------------------------------------
// Read payload proxy
// ---------------------------------------------------------------------------

/**
 * Domain → recorded page. The point is the *size and shape* of a real read at a
 * given cap, not topical fidelity (a synthetic SERP has no page bodies). The
 * split is by content kind so a docs SERP gets a docs page.
 */
const DOC_DOMAINS = new Set([
  "developer.mozilla.org",
  "typescriptlang.org",
  "nodejs.org",
  "docs.docker.com",
  "docs.python.org",
  "postgresql.org",
  "man7.org",
  "ubuntu.com",
  "digitalocean.com",
  "web.dev",
  "css-tricks.com",
  "pganalyze.com",
  "stripe.com",
  "europa.eu",
]);

interface ReadPage {
  id: "docs" | "blog" | "wiki";
  document: ReadableDocument;
}

const READ_PAGES: Record<ReadPage["id"], { fixture: string; url: string }> = {
  docs: {
    fixture: "read-docs",
    url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions",
  },
  blog: { fixture: "read-blog", url: "https://blog.rust-lang.org/2024/09/05/Rust-1.81.0.html" },
  wiki: {
    fixture: "read-wiki",
    url: "https://ru.wikipedia.org/wiki/Трансформер_(модель_машинного_обучения)",
  },
};

const pageCache = new Map<string, ReadPage>();

function loadReadPage(id: ReadPage["id"]): ReadPage {
  const cached = pageCache.get(id);
  if (cached !== undefined) return cached;
  const spec = READ_PAGES[id];
  const html = gunzipSync(readFileSync(join(READ_FIXTURES, `${spec.fixture}.html.gz`))).toString("utf8");
  // `runInPage` executes the extractor the way `page.evaluate` does: a selector
  // or free variable that only works in the module fails here too.
  const document = runInPage(extractReadableDocument, fixtureDocument(html, spec.url), undefined);
  const page: ReadPage = { id, document };
  pageCache.set(id, page);
  return page;
}

function readProxyFor(domain: string): ReadPage["id"] {
  if (domain === "wikipedia.org" || domain.endsWith(".wikipedia.org")) return "wiki";
  if (DOC_DOMAINS.has(domain) || domain.startsWith("docs.")) return "docs";
  return "blog";
}

/** What `web_read` would return for this URL: one rendered window at `maxChars`. */
interface ProxyRead {
  text: string;
  title: string;
}

function readProxy(url: string, maxChars: number): ProxyRead {
  const page = loadReadPage(readProxyFor(domainOf(url)));
  const rendered = renderReadableDocument(page.document, { maxChars });
  return { text: rendered.text, title: page.document.title };
}

// ---------------------------------------------------------------------------
// Model-visible cost types
// ---------------------------------------------------------------------------

type PathId = "direct" | "codemode" | "research";

const PATHS: readonly PathId[] = ["direct", "codemode", "research"];

interface PathRun {
  chars: number;
  tokens: number;
  /** Calls the agent itself makes (1 codemode script, 3 direct calls, 1 research). */
  toolCalls: number;
  /** Tool executions inside a script/research loop (0 for direct). */
  nestedCalls: number;
  recallAt5: number;
  goldensHit: number;
  goldensTotal: number;
  domains: string[];
  latencyMs: number;
}

interface ResearchRun {
  budget: ResearchBudget;
  searches: number;
  reads: number;
  truncated: boolean;
  enough: boolean;
}

interface QueryRun {
  id: string;
  q: string;
  class: BenchClass;
  fixture: string;
  ai: boolean;
  paths: Record<PathId, PathRun>;
  research: ResearchRun;
  /** Codemode chars per read-head variant; used for the sensitivity table. */
  sensitivity: Record<string, number>;
}

interface PathMetrics {
  chars: number;
  tokens: number;
  toolCalls: number;
  nestedCalls: number;
  recallAt5: number;
  goldensHit: number;
  goldensTotal: number;
  latencyMs: number;
}

interface Measurement {
  schema: typeof SCHEMA;
  generatedAt: string;
  queries: number;
  n: number;
  readTopK: number;
  readMaxChars: number;
  codemodeReadHead: number;
  codemodeScriptChars: number;
  researchBudget: ResearchBudget;
  pathMetrics: Record<PathId, PathMetrics>;
  researchByBudget: Record<ResearchBudget, PathMetrics>;
  sensitivity: Array<{ variant: string; chars: number; tokens: number; note: string }>;
  queryRuns: QueryRun[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Path 1 — direct: web_search + 2 web_reads
// ---------------------------------------------------------------------------

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
  if (fixture.ai !== undefined) raw.ai = { text: fixture.ai.text, sources: fixture.ai.sources };
  return raw;
}

function compactFor(query: QueryRow, fixture: LoadedFixture, format: "md" | "json"): CompactResult {
  return compactSerps([toRawSerp(query, fixture)], {
    n: DEFAULT_N,
    summaryMaxChars: COMPACT_DEFAULTS.summaryMaxChars,
    snippetMaxChars: COMPACT_DEFAULTS.snippetMaxChars,
    outputMaxChars: COMPACT_DEFAULTS.outputMaxChars,
    format,
    cached: false,
    // The tool always stamps elapsed; "0.0s" is the same width as "1.4s", so the
    // measured header is char-identical to a live one.
    elapsedMs: 0,
  });
}

function recallOf(query: QueryRow, domains: readonly string[]): { hit: number; total: number; recall: number } {
  const top = domains.slice(0, DEFAULT_N);
  const hit = query.goldenDomains.filter((golden) => top.some((domain) => domainMatches(domain, golden))).length;
  return {
    hit,
    total: query.goldenDomains.length,
    recall: query.goldenDomains.length === 0 ? 0 : hit / query.goldenDomains.length,
  };
}

function runDirect(query: QueryRow, fixture: LoadedFixture): PathRun {
  const started = performance.now();
  const compact = compactFor(query, fixture, "md");
  const top = compact.items.slice(0, READ_TOP_K);
  const reads = top.map((item) => readProxy(item.url, READ_MAX_CHARS).text);

  const chars = compact.text.length + reads.reduce((sum, text) => sum + text.length, 0);
  const domains = compact.items.slice(0, DEFAULT_N).map((item) => item.domain);
  const recall = recallOf(query, domains);

  return {
    chars,
    tokens: Math.ceil(chars / 4),
    toolCalls: 1 + top.length,
    nestedCalls: 0,
    recallAt5: recall.recall,
    goldensHit: recall.hit,
    goldensTotal: recall.total,
    domains,
    latencyMs: performance.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Path 2 — codemode: one script, same tools, client-side filter
// ---------------------------------------------------------------------------

/**
 * The script's input payload: the `format:"json"` view of the same compaction.
 * The real tool caps this text at `outputMaxChars` by dropping tail results
 * (`serializeJsonWithin`); we mirror only the last step and the self-test
 * asserts it never triggers on this corpus, so the script sees exactly the five
 * results the markdown path shows.
 */
function searchJsonPayload(query: QueryRow, compact: CompactResult): { text: string; dropped: number } {
  const items = compact.items.map((item) => ({
    title: item.title,
    url: item.url,
    domain: item.domain,
    snippet: item.snippet,
  }));
  const build = (): string => {
    const data: Record<string, unknown> = {
      engine: compact.engineLabel,
      query: query.q,
      results: items,
      pageCarried: compact.pageCarried,
      chars: compact.text.length,
      truncated: compact.truncated,
    };
    if (compact.ai !== undefined) data.ai = { text: compact.ai.text, sources: [...compact.ai.sources] };
    return JSON.stringify(data);
  };
  let text = build();
  let dropped = 0;
  while (text.length > COMPACT_DEFAULTS.outputMaxChars && items.length > 0) {
    items.pop();
    dropped += 1;
    text = build();
  }
  return { text, dropped };
}

interface CodemodePayload {
  q: string;
  results: Array<{ t: string; u: string; d: string; s: string }>;
  reads: Array<{ u: string; x: string }>;
}

/**
 * The in-process equivalent of `CODEMODE_SCRIPT`, line for line. `search` and
 * `read` are the tool seams; whatever they return stays inside the script and is
 * never charged to the model.
 */
function codemodeScript(
  q: string,
  searchPayload: string,
  read: (url: string, maxChars: number) => string,
  headChars: number,
): CodemodePayload {
  const found = JSON.parse(searchPayload) as {
    results: Array<{ title: string; url: string; domain: string; snippet: string }>;
  };
  const top = found.results.slice(0, READ_TOP_K);
  const pages = top.map((item) => read(item.url, READ_MAX_CHARS));
  const per = new Map<string, number>();
  const results: CodemodePayload["results"] = [];
  for (const item of found.results) {
    const seen = (per.get(item.domain) ?? 0) + 1;
    per.set(item.domain, seen);
    if (seen <= CODEMODE_PER_DOMAIN) {
      results.push({
        t: item.title,
        u: item.url,
        d: item.domain,
        s: item.snippet.slice(0, CODEMODE_SNIPPET),
      });
    }
  }
  const reads = pages.map((text, index) => ({ u: top[index]?.url ?? "", x: text.slice(0, headChars) }));
  return { q, results, reads };
}

/**
 * Codemode cost = the returned JSON + the script text. The script is charged
 * **per query** (conservative: once written, its characters sit in the
 * transcript for the rest of the session); the sensitivity table also reports
 * the one-script-per-session reading.
 */
function runCodemode(
  query: QueryRow,
  fixture: LoadedFixture,
  headChars: number,
  scriptChars: number,
): { run: PathRun; payload: CodemodePayload } {
  const started = performance.now();
  const compact = compactFor(query, fixture, "json");
  const search = searchJsonPayload(query, compact);
  const payload = codemodeScript(query.q, search.text, (url, maxChars) => readProxy(url, maxChars).text, headChars);
  const returned = JSON.stringify(payload);
  const chars = returned.length + scriptChars;
  const domains = payload.results.map((item) => item.d);
  const recall = recallOf(query, domains);

  return {
    payload,
    run: {
      chars,
      tokens: Math.ceil(chars / 4),
      // One agent-visible call: the script. Inside it: 1 search + up to 2 reads.
      toolCalls: 1,
      nestedCalls: 1 + payload.reads.length,
      recallAt5: recall.recall,
      goldensHit: recall.hit,
      goldensTotal: recall.total,
      domains,
      latencyMs: performance.now() - started,
    },
  };
}

// ---------------------------------------------------------------------------
// Path 3 — web_research through its real seams
// ---------------------------------------------------------------------------

const EMPTY_CACHE: Cache = {
  get: () => undefined,
  set: () => undefined,
  size: () => 0,
  clear: () => undefined,
};

const NOOP_LIMITER: Limiter = {
  async acquire(): Promise<void> {},
  stats(engine: EngineId): LimiterStats {
    return { engine, lastAt: null, today: 0, dailyCap: 0 };
  },
};

const NOOP_ARTIFACTS: Artifacts = {
  async save(): Promise<string> {
    throw fail("E_UNSUPPORTED", "extract", { message: "the codemode bench never writes artifacts" });
  },
  async prune() {
    return { removed: 0, kept: 0, bytes: 0 };
  },
  async size() {
    return 0;
  },
  root: () => join(HERE, "..", ".bench-never-written"),
};

const NOOP_CDP: CdpConnector = {
  async connect() {
    throw fail("E_CDP_UNAVAILABLE", "connect", { message: "the codemode bench never opens a socket" });
  },
  async acquirePage() {
    throw fail("E_CDP_UNAVAILABLE", "connect", { message: "the codemode bench never opens a tab" });
  },
  async releaseAll(): Promise<void> {},
  isConnected: () => false,
  endpoint: () => null,
};

const NOOP_ENGINES: EngineRegistry = {
  get() {
    throw fail("E_UNSUPPORTED", "resolve", { message: "the codemode bench injects seams instead of engines" });
  },
  has: () => false,
  enabled: () => [],
  select: () => [],
};

const FIXED_CLOCK: Clock = {
  now: () => 0,
  async sleep(): Promise<void> {},
};

function benchDeps(config: Config): ToolDeps {
  const log: Logger = {
    async write(): Promise<void> {},
    path: () => "/dev/null",
  };
  return {
    config,
    engines: NOOP_ENGINES,
    cdp: NOOP_CDP,
    cache: EMPTY_CACHE,
    limiter: NOOP_LIMITER,
    artifacts: NOOP_ARTIFACTS,
    log,
    clock: FIXED_CLOCK,
  };
}

/** `isError` exists only on the failure shape; a predicate narrows for the rest of the function. */
function isResearchFailure(result: WebResearchResult): result is WebResearchFailure {
  return "isError" in result && result.isError === true;
}

async function runResearch(
  query: QueryRow,
  fixture: LoadedFixture,
  budget: ResearchBudget,
): Promise<{ run: PathRun; research: ResearchRun }> {
  const started = performance.now();
  // REFLEX OFF (V6.3): the default config has `reflex.enabled: false`, so no
  // classifier is built and the fixed order / fixed coverage rule apply.
  const config = structuredClone(DEFAULT_CONFIG);
  const deps = benchDeps(config);
  const tool = createWebResearchTool(() => deps, {
    search: async (q) => ({
      query: q,
      engines: [fixture.engine],
      // One recorded SERP per group: a refined query returns the same URLs, which
      // the tool de-duplicates. That is why `deep` cannot find more evidence here.
      hits: fixture.results.map((result) => ({ ...result, engine: fixture.engine })),
    }),
    read: async (url, maxChars) => {
      const page = readProxy(url, maxChars);
      return { url, title: page.title, text: page.text };
    },
  });

  const result: WebResearchResult = await tool.execute(
    `codemode-bench-${query.id}`,
    { q: query.q, budget },
    undefined,
    undefined,
  );
  const latencyMs = performance.now() - started;
  const text = result.content.map((block) => block.text).join("\n");

  if (isResearchFailure(result)) {
    throw fail("E_CONFIG", "config", {
      hint: `web_research failed for ${query.id}: ${JSON.stringify(result.details)}`,
    });
  }

  const details = result.details;
  const domains = [...new Set(details.evidence.citations.map((citation) => citation.domain))];
  for (const excerpt of details.evidence.excerpts) {
    const domain = domainOf(excerpt.url);
    if (domain !== "" && !domains.includes(domain)) domains.push(domain);
  }
  const recall = recallOf(query, domains);

  return {
    run: {
      chars: text.length,
      tokens: Math.ceil(text.length / 4),
      toolCalls: 1,
      nestedCalls: details.searches + details.reads,
      recallAt5: recall.recall,
      goldensHit: recall.hit,
      goldensTotal: recall.total,
      domains,
      latencyMs,
    },
    research: {
      budget,
      searches: details.searches,
      reads: details.reads,
      truncated: details.truncated,
      enough: details.coverage.enough,
    },
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const SENSITIVITY_HEADS: ReadonlyArray<{ variant: string; head: number; note: string }> = [
  { variant: "head-600", head: CODEMODE_READ_HEAD, note: "default: ~one lead paragraph per read" },
  { variant: "head-1200", head: 1200, note: "twice the default head" },
  { variant: "head-6000", head: READ_MAX_CHARS, note: "no body filtering: same text as direct" },
];

function emptyPathMetrics(): PathMetrics {
  return {
    chars: 0,
    tokens: 0,
    toolCalls: 0,
    nestedCalls: 0,
    recallAt5: 0,
    goldensHit: 0,
    goldensTotal: 0,
    latencyMs: 0,
  };
}

function addPath(metrics: PathMetrics, run: PathRun): void {
  metrics.chars += run.chars;
  metrics.tokens += run.tokens;
  metrics.toolCalls += run.toolCalls;
  metrics.nestedCalls += run.nestedCalls;
  metrics.goldensHit += run.goldensHit;
  metrics.goldensTotal += run.goldensTotal;
  metrics.latencyMs += run.latencyMs;
}

function finishPath(metrics: PathMetrics): PathMetrics {
  metrics.recallAt5 = metrics.goldensTotal === 0 ? 0 : metrics.goldensHit / metrics.goldensTotal;
  return metrics;
}

async function measure(corpus: Corpus): Promise<Measurement> {
  const runs: QueryRun[] = [];
  const pathMetrics: Record<PathId, PathMetrics> = {
    direct: emptyPathMetrics(),
    codemode: emptyPathMetrics(),
    research: emptyPathMetrics(),
  };
  const researchByBudget: Record<ResearchBudget, PathMetrics> = {
    quick: emptyPathMetrics(),
    normal: emptyPathMetrics(),
    deep: emptyPathMetrics(),
  };
  const sensitivityTotals = new Map<string, number>(SENSITIVITY_HEADS.map((entry) => [entry.variant, 0]));
  let jsonPayloadDrops = 0;

  for (const query of corpus.queries) {
    const fixture = pickFixture(query, corpus.fixtures);
    const direct = runDirect(query, fixture);
    const codemode = runCodemode(query, fixture, CODEMODE_READ_HEAD, CODEMODE_SCRIPT.length);

    const research: Record<ResearchBudget, { run: PathRun; research: ResearchRun }> = {
      quick: await runResearch(query, fixture, "quick"),
      normal: await runResearch(query, fixture, "normal"),
      deep: await runResearch(query, fixture, "deep"),
    };

    const sensitivity: Record<string, number> = {};
    for (const entry of SENSITIVITY_HEADS) {
      const variant = runCodemode(query, fixture, entry.head, CODEMODE_SCRIPT.length);
      sensitivity[entry.variant] = variant.run.chars;
      sensitivityTotals.set(entry.variant, (sensitivityTotals.get(entry.variant) ?? 0) + variant.run.chars);
    }
    if (searchJsonPayloadDrops(query, fixture) > 0) jsonPayloadDrops += 1;

    addPath(pathMetrics.direct, direct);
    addPath(pathMetrics.codemode, codemode.run);
    addPath(pathMetrics.research, research[RESEARCH_BUDGET].run);
    for (const budget of RESEARCH_BUDGETS_MEASURED) {
      addPath(researchByBudget[budget], research[budget].run);
    }

    runs.push({
      id: query.id,
      q: query.q,
      class: query.class,
      fixture: fixture.id,
      ai: direct.domains.length > 0 && fixture.ai !== undefined,
      paths: { direct, codemode: codemode.run, research: research[RESEARCH_BUDGET].run },
      research: research[RESEARCH_BUDGET].research,
      sensitivity,
    });
  }

  finishPath(pathMetrics.direct);
  finishPath(pathMetrics.codemode);
  finishPath(pathMetrics.research);
  for (const budget of RESEARCH_BUDGETS_MEASURED) finishPath(researchByBudget[budget]);

  // The default head variant charges the script once per query. Re-reading the
  // same total with one script for the whole session is just that minus the
  // extra copies; it is reported rather than assumed.
  const headDefault = sensitivityTotals.get(SENSITIVITY_HEADS[0]?.variant ?? "") ?? 0;
  const scriptOnce = headDefault - CODEMODE_SCRIPT.length * (corpus.queries.length - 1);

  const notes = [
    "offline only: no model, no network, no Chrome; every payload comes from committed fixtures",
    "chars/4 is a cheap estimate, not a tokenizer; aggregate tokens are summed per query (bench/run.ts convention)",
    "latency is harness wall time (compaction, JSON, string slices); it excludes model/agent thinking and browser time",
    `read payload proxy: ${READ_PAGES.docs.fixture}/${READ_PAGES.blog.fixture}/${READ_PAGES.wiki.fixture} ` +
      "rendered through src/extract/read.ts at the requested cap",
    "web_research ran with reflex off (fixed order, fixed coverage); the recorded corpus has one SERP per " +
      "group, so a refined query returns the same URLs and deep cannot beat normal",
    "the read pages are topically unrelated to the query, so web_research's coverage judge spends its " +
      "budget instead of stopping early: its measured cost is an upper bound on this corpus",
    `${jsonPayloadDrops} query/queries needed a codemode JSON result drop ` +
      `(0 expected: the script sees all ${DEFAULT_N} results)`,
    "not measured: answer quality, whether a 600-char head still holds the sentence the answer needs, " +
      "model thinking time",
  ];

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    queries: runs.length,
    n: DEFAULT_N,
    readTopK: READ_TOP_K,
    readMaxChars: READ_MAX_CHARS,
    codemodeReadHead: CODEMODE_READ_HEAD,
    codemodeScriptChars: CODEMODE_SCRIPT.length,
    researchBudget: RESEARCH_BUDGET,
    pathMetrics,
    researchByBudget,
    sensitivity: SENSITIVITY_HEADS.map((entry) => ({
      variant: entry.variant,
      chars: sensitivityTotals.get(entry.variant) ?? 0,
      tokens: Math.ceil((sensitivityTotals.get(entry.variant) ?? 0) / 4),
      note: entry.note,
    })).concat([
      {
        variant: "script-once",
        chars: scriptOnce,
        tokens: Math.ceil(scriptOnce / 4),
        note:
          `head-600 with one script for all ${corpus.queries.length} queries ` +
          `(subtract ${corpus.queries.length - 1} script copies)`,
      },
    ]),
    queryRuns: runs,
    notes,
  };
}

/** Zero-result self-test hook: the codemode JSON view must not need a drop. */
function searchJsonPayloadDrops(query: QueryRow, fixture: LoadedFixture): number {
  return searchJsonPayload(query, compactFor(query, fixture, "json")).dropped;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "n/a";
  const value = ((part - whole) / whole) * 100;
  return `${value <= 0 ? "" : "+"}${value.toFixed(1)}%`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function renderReport(measurement: Measurement): string {
  const { pathMetrics, researchByBudget } = measurement;
  const lines: string[] = [];
  const row = (cells: readonly (string | number)[]): string => `| ${cells.join(" | ")} |`;

  lines.push("codemode bench — what the model reads per path (offline, deterministic)");
  lines.push("");
  lines.push(
    `corpus: queries.jsonl (${measurement.queries} queries), bench/fixtures, ` +
      "read proxy read-docs/read-blog/read-wiki",
  );
  lines.push(
    `assumptions: direct = web_search n=${measurement.n} + ${measurement.readTopK} reads ` +
      `@${measurement.readMaxChars}; codemode = script (${measurement.codemodeScriptChars} chars ` +
      `charged per query) + filtered JSON with ${measurement.codemodeReadHead}-char read heads; ` +
      `research = web_research budget ${measurement.researchBudget}`,
  );
  lines.push("");
  lines.push(
    row(["path", "chars", "tokens", "agent calls", "nested calls", "recall@5", "wall ms"]),
  );
  lines.push(row(["---", "---:", "---:", "---:", "---:", "---:", "---:"]));
  for (const path of PATHS) {
    const metrics = pathMetrics[path];
    lines.push(
      row([
        path,
        metrics.chars,
        metrics.tokens,
        metrics.toolCalls,
        metrics.nestedCalls,
        metrics.recallAt5.toFixed(3),
        round(metrics.latencyMs, 1),
      ]),
    );
  }
  lines.push("");
  lines.push(
    `delta vs direct: codemode ${pct(pathMetrics.codemode.chars, pathMetrics.direct.chars)} chars, ` +
      `research ${pct(pathMetrics.research.chars, pathMetrics.direct.chars)} chars`,
  );
  lines.push("");
  lines.push("web_research by budget (same corpus, reflex off):");
  lines.push(row(["budget", "chars", "tokens", "searches+reads", "recall@5", "wall ms"]));
  lines.push(row(["---", "---:", "---:", "---:", "---:", "---:"]));
  for (const budget of RESEARCH_BUDGETS_MEASURED) {
    const metrics = researchByBudget[budget];
    lines.push(
      row([
        budget,
        metrics.chars,
        metrics.tokens,
        metrics.nestedCalls,
        metrics.recallAt5.toFixed(3),
        round(metrics.latencyMs, 1),
      ]),
    );
  }
  lines.push("");
  lines.push("codemode sensitivity (read-head size; the only free parameter):");
  lines.push(row(["variant", "chars", "tokens", "note"]));
  lines.push(row(["---", "---:", "---:", "---"]));
  for (const entry of measurement.sensitivity) {
    lines.push(row([entry.variant, entry.chars, entry.tokens, entry.note]));
  }
  lines.push("");
  lines.push("per query (chars; recall@5 in brackets):");
  lines.push(row(["id", "q", "direct", "codemode", "research", "recall d/c/r", "ai"]));
  lines.push(row(["---", "---", "---:", "---:", "---:", "---", "---"]));
  for (const run of measurement.queryRuns) {
    const recall = [run.paths.direct, run.paths.codemode, run.paths.research]
      .map((path) => path.recallAt5.toFixed(2))
      .join("/");
    lines.push(
      row([
        run.id,
        run.q.length > 34 ? `${run.q.slice(0, 33)}…` : run.q,
        run.paths.direct.chars,
        run.paths.codemode.chars,
        run.paths.research.chars,
        recall,
        run.ai ? "yes" : "no",
      ]),
    );
  }
  lines.push("");
  lines.push("notes:");
  for (const note of measurement.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push(
    `verdict input (numbers, not a model): codemode ` +
      `${pct(pathMetrics.codemode.chars, pathMetrics.direct.chars)}, research ` +
      `${pct(pathMetrics.research.chars, pathMetrics.direct.chars)} vs direct; recall d/c/r ` +
      `${pathMetrics.direct.recallAt5.toFixed(3)}/${pathMetrics.codemode.recallAt5.toFixed(3)}/` +
      `${pathMetrics.research.recallAt5.toFixed(3)}`,
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw fail("E_CONFIG", "config", { hint: "codemode self-test failed", message });
}

async function runSelfTest(corpus: Corpus): Promise<number> {
  const checks: Check[] = [];
  const check = async (name: string, fn: () => string | Promise<string>): Promise<void> => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name, ok: false, detail: message });
    }
  };

  let first: Measurement | undefined;
  /** The checks run after the measurement check; a missing value is a test bug, not a skip. */
  const measured = (): Measurement => {
    if (first === undefined) throw fail("E_CONFIG", "config", { hint: "self-test ran before measure()" });
    return first;
  };

  await check("corpus: every query has a fixture with a golden domain", () => {
    for (const query of corpus.queries) {
      const fixture = pickFixture(query, corpus.fixtures);
      const domains = fixture.results.map((result) => domainOf(result.url));
      const hit = query.goldenDomains.some((golden) => domains.some((domain) => domainMatches(domain, golden)));
      assert(hit, `${query.id}: fixture ${fixture.id} shares no golden domain`);
    }
    return `${corpus.queries.length} queries, ${corpus.fixtures.length} SERPs`;
  });

  await check("script and in-process equivalent agree on the parameters", () => {
    for (const token of [
      `n: ${DEFAULT_N}`,
      `maxChars: ${READ_MAX_CHARS}`,
      `results.slice(0, ${READ_TOP_K})`,
      `seen <= ${CODEMODE_PER_DOMAIN}`,
      `slice(0, ${CODEMODE_SNIPPET})`,
      `slice(0, ${CODEMODE_READ_HEAD})`,
    ]) {
      assert(CODEMODE_SCRIPT.includes(token), `script does not contain ${JSON.stringify(token)}`);
    }
    return `script ${CODEMODE_SCRIPT.length} chars; 6 parameter checks`;
  });

  await check("measurement: runs and is deterministic", async () => {
    first = await measure(corpus);
    const second = await measure(corpus);
    assert(first.queries === second.queries, "query count changed between runs");
    for (let index = 0; index < first.queryRuns.length; index += 1) {
      const left = first.queryRuns[index] as QueryRun;
      const right = second.queryRuns[index] as QueryRun;
      assert(left.id === right.id, `query order changed at ${index}`);
      for (const path of PATHS) {
        assert(
          left.paths[path].chars === right.paths[path].chars,
          `${left.id}/${path}: chars differ between runs (${left.paths[path].chars} vs ${right.paths[path].chars})`,
        );
      }
      for (const entry of SENSITIVITY_HEADS) {
        assert(
          left.sensitivity[entry.variant] === right.sensitivity[entry.variant],
          `${left.id}/${entry.variant}: sensitivity drifted`,
        );
      }
    }
    return `${first.queries} queries x 5 paths measured twice, identical`;
  });

  await check("caps: every payload respects its documented cap", () => {
    const measurement = measured();
    for (const run of measurement.queryRuns) {
      assert(run.paths.research.chars <= COMPACT_DEFAULTS.outputMaxChars, `${run.id}: research bundle over cap`);
      assert(run.paths.direct.chars > 0, `${run.id}: direct payload is empty`);
      assert(run.paths.codemode.chars > measurement.codemodeScriptChars, `${run.id}: codemode payload is empty`);
      assert(
        run.paths.research.nestedCalls <=
          RESEARCH_BUDGETS[RESEARCH_BUDGET].searches + RESEARCH_BUDGETS[RESEARCH_BUDGET].reads,
        `${run.id}: research exceeded its budget`,
      );
      assert(run.paths.direct.toolCalls === 1 + READ_TOP_K, `${run.id}: direct calls`);
    }
    return `research <= ${COMPACT_DEFAULTS.outputMaxChars}, direct = ${1 + READ_TOP_K} calls`;
  });

  await check("tokens: ceil(chars / 4) for every row", () => {
    const measurement = measured();
    for (const run of measurement.queryRuns) {
      for (const path of PATHS) {
        assert(run.paths[path].tokens === Math.ceil(run.paths[path].chars / 4), `${run.id}/${path}: token formula`);
      }
    }
    for (const path of PATHS) {
      const metrics = measurement.pathMetrics[path];
      assert(metrics.tokens > 0 && metrics.chars > 0, `${path}: empty aggregate`);
    }
    return "per-query tokens match chars/4";
  });

  await check("sensitivity: chars grow monotonically with the read head", () => {
    const measurement = measured();
    for (const run of measurement.queryRuns) {
      const small = run.sensitivity["head-600"] ?? 0;
      const medium = run.sensitivity["head-1200"] ?? 0;
      const large = run.sensitivity["head-6000"] ?? 0;
      assert(small <= medium, `${run.id}: 600 > 1200`);
      assert(medium <= large, `${run.id}: 1200 > 6000`);
    }
    return "head-600 <= head-1200 <= head-6000 on every query";
  });

  await check("honesty: no domain outside the recorded SERP appears in any payload", () => {
    const measurement = measured();
    const fixtureDomains = new Set(
      corpus.fixtures.flatMap((fixture) => fixture.results.map((result) => domainOf(result.url))),
    );
    for (const run of measurement.queryRuns) {
      for (const path of PATHS) {
        for (const domain of run.paths[path].domains) {
          assert(fixtureDomains.has(domain), `${run.id}/${path}: invented domain ${domain}`);
        }
      }
    }
    return `${fixtureDomains.size} recorded domains, all payload domains resolve`;
  });

  await check("recall is a fraction in [0, 1]", () => {
    const measurement = measured();
    for (const run of measurement.queryRuns) {
      for (const path of PATHS) {
        const value = run.paths[path].recallAt5;
        assert(value >= 0 && value <= 1, `${run.id}/${path}: recall ${value}`);
      }
    }
    return "0 <= recall@5 <= 1";
  });

  await check("spam item is visible to the paths, never invented", () => {
    const measurement = measured();
    let seen = 0;
    for (const run of measurement.queryRuns) {
      if (run.paths.direct.domains.includes(SPAM_DOMAIN)) seen += 1;
    }
    return `${seen}/${measurement.queries} direct payloads carry the synthetic spam domain (not filtered)`;
  });

  await check("corpus-level constraint: codemode JSON never needs a drop", () => {
    let dropped = 0;
    for (const query of corpus.queries) {
      dropped += searchJsonPayloadDrops(query, pickFixture(query, corpus.fixtures));
    }
    assert(dropped === 0, `${dropped} query/queries needed a JSON result drop; the script saw fewer than ${DEFAULT_N}`);
    return `0 drops (script sees all ${DEFAULT_N} results)`;
  });

  await check("wall time: full measurement under 8 s", async () => {
    const started = performance.now();
    await measure(corpus);
    const elapsed = performance.now() - started;
    assert(elapsed < 8000, `measurement took ${Math.round(elapsed)} ms`);
    return `${Math.round(elapsed)} ms for ${corpus.queries.length} queries x 5 paths (no network, no model)`;
  });

  const failed = checks.filter((entry) => !entry.ok);
  for (const entry of checks) {
    process.stdout.write(`${entry.ok ? "ok  " : "FAIL"} ${entry.name} — ${entry.detail}\n`);
  }
  process.stdout.write(
    `codemode self-test: ${checks.length - failed.length}/${checks.length} checks passed\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): string {
  return [
    "usage:",
    "  node bench/codemode.ts            # markdown report on stdout",
    "  node bench/codemode.ts --json     # same numbers as JSON",
    "  node bench/codemode.ts --self-test",
    "",
    "Offline only: recorded SERPs + recorded read pages, no network, no Chrome,",
    "no model. Measures output characters, not answer quality.",
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  let json = false;
  let selfTest = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (arg === "--json") json = true;
    else if (arg === "--self-test") selfTest = true;
    else throw fail("E_CONFIG", "config", { hint: `unknown argument ${JSON.stringify(arg)}; run with --help` });
  }

  const corpus = loadCorpus();
  if (selfTest) return runSelfTest(corpus);

  const measurement = await measure(corpus);
  process.stdout.write(json ? `${JSON.stringify(measurement, null, 2)}\n` : renderReport(measurement));
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
  const hint =
    details === undefined
      ? ""
      : ` (${String(details.code ?? "error")} at ${String(details.stage ?? "?")}: ` +
        `${String(details.hint ?? details.message ?? "")})`;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codemode bench: ${message}${hint}\n`);
  process.exitCode = 1;
}
