/**
 * P4-C: live doctor probes, canary aggregation, safe `--fix` and the deferred
 * `web_doctor` tool (SPEC §10.3, PLAN V4.4, D11).
 *
 * Fully offline: a fake connector hands out in-memory `FakePage`s, stub engines
 * answer extract/wall/canaries, and the CLI runs with injected seams. No socket,
 * no Chrome, no network, no process signal.
 *
 *   node --test tests/unit/doctor_engines.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { Connector, ConnectorInfo, ConnectorOptions } from "../../src/cdp/browser.ts";
import type { BrowserInfo, CdpConnectionInfo, CdpEndpoint, CdpPage } from "../../src/cdp/types.ts";
import { runDoctorCli } from "../../src/cli/doctor.ts";
import { handleDoctorCommand } from "../../src/commands/doctor.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import type { Config } from "../../src/config.ts";
import { toDoctorDeps } from "../../src/index.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import type {
  Engine,
  EngineId,
  EngineRegistry,
  Query,
  RawSerp,
  SerpItem,
  Wall,
} from "../../src/engines/types.ts";
import {
  applyDoctorFix,
  buildDoctorReport,
  createEngineProbe,
  DOCTOR_PROBE_QUERY,
} from "../../src/runtime/doctor.ts";
import type { DoctorDeps, EngineProbe, EngineProbeResult } from "../../src/runtime/doctor.ts";
import { fail } from "../../src/runtime/errors.ts";
import type { WebSearchError } from "../../src/runtime/error-codes.ts";
import type { Artifacts, Limiter } from "../../src/runtime/types.ts";
import { createWebDoctorTool, WEB_DOCTOR_DESCRIPTION } from "../../src/tools/web_doctor.ts";
import type { WebDoctorFailure, WebDoctorInput, WebDoctorSuccess } from "../../src/tools/web_doctor.ts";
import { FakeClock } from "../helpers/clock.ts";
import { FakePage } from "../helpers/fake-page.ts";

// ---------------------------------------------------------------------------
// JSON-schema subset validator (same draft-07 subset as doctor.test.ts: type,
// type[], const, enum, required, properties, additionalProperties, items,
// minItems, minimum, maximum, minLength). No dependency, no remote resolution.
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function validateSchema(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((type) => typeof type === "string" && matchesType(type, value))) {
      errors.push(`${path}: unexpected type ${typeof value}`);
      return errors;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: not in enum`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: below minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: above maximum`);
    }
  }
  if (typeof value === "string" && typeof schema.minLength === "number") {
    if ([...value].length < schema.minLength) errors.push(`${path}: shorter than minLength`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} item(s)`);
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(schema.items as JsonSchema, item, `${path}[${index}]`));
      });
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          errors.push(`${path}.${key}: missing required key`);
        }
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const property = properties[key];
      if (property === undefined) {
        if (schema.additionalProperties === false) {
          errors.push(`${path}.${key}: additional property not allowed`);
        } else if (isPlainObject(schema.additionalProperties)) {
          errors.push(...validateSchema(schema.additionalProperties, item, `${path}.${key}`));
        }
        continue;
      }
      errors.push(...validateSchema(property as JsonSchema, item, `${path}.${key}`));
    }
  }

  return errors;
}

const SCHEMA = JSON.parse(
  readFileSync(new URL("../fixtures/doctor.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

function assertSchemaValid(report: unknown): void {
  const errors = validateSchema(SCHEMA, report, "report");
  assert.deepEqual(errors, [], `schema violations:\n${errors.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEMP_ROOT = mkdtempSync(join(tmpdir(), "pi-doctor-engines-"));
after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

const FAKE_ENDPOINT: CdpEndpoint = {
  port: 9222,
  wsUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
  source: "devtools-active-port",
  profileDir: "/home/tester/.config/google-chrome",
};

const FAKE_BROWSER: BrowserInfo = {
  product: "Chrome/157.0.8103.38",
  protocolVersion: "1.3",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/157.0.8103.38",
  revision: "@fake",
  jsVersion: "13.0",
};

const ALL_ENGINES: readonly EngineId[] = ["google", "duckduckgo", "yandex"];
const OK_PROBE: EngineProbeResult = {
  ms: 120,
  results: 5,
  ai: true,
  canaries: { organic: 5, aiBlock: 1 },
};

interface FakeConnectorOptions {
  connectFailures?: number;
  connectError?: WebSearchError;
  lockPath?: string;
  pages?: Partial<Record<EngineId, CdpPage>>;
}

class FakeConnector implements Connector {
  connectCalls = 0;
  releaseCalls = 0;
  focusCalls = 0;
  acquireCalls: EngineId[] = [];
  owned: string[] = ["owned-anchor"];
  readonly foreign: string[] = ["user-tab-1", "user-tab-2"];
  closed: string[] = [];
  connectFailures: number;
  connectError: WebSearchError | undefined;

  #connected = false;
  #lockPath: string;
  #pages: Partial<Record<EngineId, CdpPage>>;

  constructor(options: FakeConnectorOptions = {}) {
    this.connectFailures = options.connectFailures ?? 0;
    this.connectError = options.connectError;
    this.#lockPath = options.lockPath ?? join(TEMP_ROOT, `web-search-${Math.random().toString(16).slice(2)}.lock`);
    this.#pages = options.pages ?? {};
  }

  async connect(): Promise<CdpConnectionInfo> {
    this.connectCalls += 1;
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      throw this.connectError ?? fail("E_CDP_UNAVAILABLE", "connect", { message: "fake connector refuses" });
    }
    this.#connected = true;
    return { endpoint: FAKE_ENDPOINT, browser: FAKE_BROWSER, webdriver: false };
  }

  async acquirePage(engine: EngineId): Promise<CdpPage> {
    this.acquireCalls.push(engine);
    const page = this.#pages[engine];
    if (page === undefined) throw fail("E_UNSUPPORTED", "resolve", { engine });
    return page;
  }

  async releaseAll(): Promise<void> {
    this.releaseCalls += 1;
    if (this.#connected) {
      // Only the connector's own targets can ever be closed (AGENTS §2, rule 2).
      for (const targetId of this.owned) this.closed.push(targetId);
    }
    this.owned = [];
    this.#connected = false;
  }

  isConnected(): boolean {
    return this.#connected;
  }

  endpoint(): CdpEndpoint | null {
    return this.#connected ? FAKE_ENDPOINT : null;
  }

  info(): ConnectorInfo | null {
    if (!this.#connected) return null;
    return {
      endpoint: FAKE_ENDPOINT,
      browser: FAKE_BROWSER,
      webdriver: false,
      windowId: 7,
      ownedTargets: this.owned.map((targetId) => ({ targetId, engine: null, url: "about:blank" })),
      focusedOnce: [],
      windowDegraded: false,
      locked: true,
    };
  }

  ownedTargets(): string[] {
    return [...this.owned];
  }

  lockPath(): string {
    return this.#lockPath;
  }

  async focus(): Promise<void> {
    this.focusCalls += 1;
  }
}

interface StubEngineOptions {
  results?: number;
  ai?: string;
  canaries?: Record<string, number>;
  wall?: Wall | null;
  settleError?: Error;
  extractError?: Error;
}

interface StubEngine {
  engine: Engine;
  queries: Query[];
  settles: number;
  extracts: number;
}

function stubEngine(id: EngineId, options: StubEngineOptions = {}): StubEngine {
  const queries: Query[] = [];
  const items: SerpItem[] = Array.from({ length: options.results ?? 3 }, (_, index) => ({
    title: `result ${index + 1}`,
    url: `https://example.test/${id}/${index + 1}`,
    snippet: "snippet",
  }));
  const state: StubEngine = {
    queries,
    settles: 0,
    extracts: 0,
    engine: undefined as never,
  };

  state.engine = {
    id,
    buildUrl(query) {
      queries.push(query);
      return `https://${id}.example.test/search?q=${encodeURIComponent(query.text)}`;
    },
    async settle() {
      state.settles += 1;
      if (options.settleError !== undefined) throw options.settleError;
    },
    async detectWall() {
      return options.wall ?? null;
    },
    async extract(_page, query) {
      state.extracts += 1;
      if (options.extractError !== undefined) throw options.extractError;
      const serp: RawSerp = {
        engine: id,
        query: query.text,
        results: items,
        pageCarried: false,
        timings: {},
      };
      if (options.ai !== undefined) serp.ai = { text: options.ai, sources: [] };
      return serp;
    },
    async canaries() {
      return options.canaries ?? {};
    },
  };
  return state;
}

function fakeRegistry(ids: readonly EngineId[]): EngineRegistry {
  return {
    has: (id: EngineId) => ids.includes(id),
    enabled: () => [...ids],
    select: () => [...ids],
    get: (id: EngineId): never => {
      throw fail("E_UNSUPPORTED", "resolve", { engine: id });
    },
  };
}

function configWith(mutate: (config: Config) => void): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  mutate(config);
  return config;
}

function depsFor(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    config: DEFAULT_CONFIG,
    configPath: "/home/tester/.pi/agent/web-search.json",
    registry: fakeRegistry([]),
    clock: new FakeClock(),
    env: { PI_CODING_AGENT_DIR: TEMP_ROOT },
    extensionVersion: "0.1.0-test",
    nodeVersion: "v26.13.0",
    ...overrides,
  };
}

interface LimiterSpy {
  acquires: EngineId[];
  /** `connector.acquireCalls.length` observed at each acquire: must still be the pre-page count. */
  pagesAtAcquire: number[];
  limiter: Limiter;
}

/** Records pacing without sleeping; `reject` simulates the daily cap / an abort. */
function limiterSpy(connector: FakeConnector, reject?: () => unknown): LimiterSpy {
  const acquires: EngineId[] = [];
  const pagesAtAcquire: number[] = [];
  return {
    acquires,
    pagesAtAcquire,
    limiter: {
      async acquire(engine: EngineId): Promise<void> {
        acquires.push(engine);
        pagesAtAcquire.push(connector.acquireCalls.length);
        if (reject !== undefined) throw reject();
      },
      stats(engine: EngineId) {
        return { engine, lastAt: null, today: 0, dailyCap: 0 };
      },
    },
  };
}

interface ProbeSpy {
  calls: EngineId[];
  fn: EngineProbe;
}

function probeSpy(
  results: Partial<Record<EngineId, EngineProbeResult>> = {},
  fallback: EngineProbeResult = OK_PROBE,
): ProbeSpy {
  const calls: EngineId[] = [];
  const fn: EngineProbe = async (id) => {
    calls.push(id);
    return results[id] ?? fallback;
  };
  return { calls, fn };
}

/** Same seam the CLI uses; keeps every run offline and deterministic. */
interface CliOptions {
  connector: FakeConnector;
  registry?: EngineRegistry;
  probe?: EngineProbe;
  artifacts?: Artifacts;
  limiter?: Limiter;
  alive?: (pid: number) => boolean;
}

async function runCli(
  argv: readonly string[],
  options: CliOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runDoctorCli(argv, {
    env: { PI_CODING_AGENT_DIR: TEMP_ROOT },
    clock: new FakeClock(),
    write: (text) => stdout.push(text),
    writeError: (text) => stderr.push(text),
    loadConfig: () => DEFAULT_CONFIG,
    connector: options.connector,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.alive === undefined ? {} : { alive: options.alive }),
    // A real factory must never be reached when a connector is injected.
    createConnector: (_options: ConnectorOptions): Connector => {
      throw fail("E_CONFIG", "config", { message: "the doctor must not build a second connector" });
    },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

// ---------------------------------------------------------------------------
// createEngineProbe: one cheap search through the injected runtime
// ---------------------------------------------------------------------------

test("createEngineProbe runs one n=1, summary-off search and reports results/AI/canaries", async () => {
  const google = stubEngine("google", {
    results: 4,
    ai: "AI overview",
    canaries: { organic: 4, aiBlock: 1 },
  });
  const page = new FakePage();
  const connector = new FakeConnector({ pages: { google: page } });
  const registry = createEngineRegistry({ google: google.engine }, DEFAULT_CONFIG);

  const result = await createEngineProbe({
    config: DEFAULT_CONFIG,
    connector,
    registry,
    clock: new FakeClock(),
  })("google");

  assert.equal(result.results, 4);
  assert.equal(result.ai, true);
  assert.deepEqual(result.canaries, { organic: 4, aiBlock: 1 });
  assert.equal(result.wall, undefined);
  assert.equal(result.error, undefined);
  assert.ok(result.ms >= 0);

  assert.equal(google.queries.length, 1);
  assert.equal(google.queries[0]?.n, 1, "the probe must ask for exactly one result");
  assert.equal(google.queries[0]?.summary, false, "the probe must not request an AI summary");
  assert.equal(google.queries[0]?.text, DOCTOR_PROBE_QUERY);
  assert.deepEqual(page.navigations(), [google.engine.buildUrl(google.queries[0] as Query)]);
  assert.deepEqual(connector.acquireCalls, ["google"]);
});

test("a detected wall wins over extraction and never fabricates results", async () => {
  const yandex = stubEngine("yandex", {
    results: 9,
    wall: { kind: "captcha", url: "https://yandex.ru/showcaptcha", markers: ["Я не робот"] },
  });
  const connector = new FakeConnector({ pages: { yandex: new FakePage() } });
  const registry = createEngineRegistry({ yandex: yandex.engine }, DEFAULT_CONFIG);

  const result = await createEngineProbe({
    config: DEFAULT_CONFIG,
    connector,
    registry,
    clock: new FakeClock(),
  })("yandex");

  assert.equal(result.wall, "captcha");
  assert.equal(result.results, 0);
  assert.equal(result.ai, false);
  assert.equal(yandex.extracts, 0, "extraction must not run behind a wall");
});

test("a wall that failed settle (E_TIMEOUT) is still reported as wall", async () => {
  const google = stubEngine("google", {
    settleError: fail("E_TIMEOUT", "settle", { message: "result marker never appeared" }),
    wall: { kind: "sorry", url: "https://www.google.com/sorry/index", markers: ["unusual traffic"] },
  });
  const connector = new FakeConnector({ pages: { google: new FakePage() } });
  const registry = createEngineRegistry({ google: google.engine }, DEFAULT_CONFIG);

  const result = await createEngineProbe({
    config: DEFAULT_CONFIG,
    connector,
    registry,
    clock: new FakeClock(),
  })("google");

  assert.equal(result.wall, "sorry");
  assert.equal(result.results, 0);
});

test("a transport/extract failure becomes a structured probe error, never a throw", async () => {
  const google = stubEngine("google", {
    settleError: fail("E_CDP_DISCONNECTED", "connect", { message: "socket died" }),
  });
  const duckduckgo = stubEngine("duckduckgo", {
    extractError: fail("E_PARSE", "extract", { message: "canary results=0" }),
  });
  const connector = new FakeConnector({
    pages: { google: new FakePage(), duckduckgo: new FakePage() },
  });
  const registry = createEngineRegistry(
    { google: google.engine, duckduckgo: duckduckgo.engine },
    DEFAULT_CONFIG,
  );
  const probe = createEngineProbe({
    config: DEFAULT_CONFIG,
    connector,
    registry,
    clock: new FakeClock(),
  });

  const blocked = await probe("google");
  assert.equal(blocked.error?.code, "E_CDP_DISCONNECTED");
  assert.equal(blocked.results, 0);
  assert.ok(blocked.error?.hint.includes("CDP") === true);

  const parse = await probe("duckduckgo");
  assert.equal(parse.error?.code, "E_PARSE");
  assert.ok((parse.error?.hint.length ?? 0) > 0);
});

test("the probe paces once per engine, before it acquires a page", async () => {
  const pages = {
    google: new FakePage(),
    duckduckgo: new FakePage(),
    yandex: new FakePage(),
  };
  const connector = new FakeConnector({ pages });
  const engines = {
    google: stubEngine("google", { results: 3, canaries: { organic: 3 } }),
    duckduckgo: stubEngine("duckduckgo", { results: 2, canaries: { organic: 2 } }),
    yandex: stubEngine("yandex", { results: 1, canaries: { organic: 1 } }),
  };
  const registry = createEngineRegistry(
    {
      google: engines.google.engine,
      duckduckgo: engines.duckduckgo.engine,
      yandex: engines.yandex.engine,
    },
    DEFAULT_CONFIG,
  );
  const limiter = limiterSpy(connector);
  const probe = createEngineProbe({
    config: DEFAULT_CONFIG,
    connector,
    registry,
    clock: new FakeClock(),
    limiter: limiter.limiter,
  });

  for (const id of ALL_ENGINES) assert.equal((await probe(id)).error, undefined);

  assert.deepEqual(limiter.acquires, [...ALL_ENGINES], "exactly one acquire per engine, in order");
  assert.deepEqual(
    limiter.pagesAtAcquire,
    [0, 1, 2],
    "pacing must happen before the page is acquired, not after",
  );
  assert.deepEqual(connector.acquireCalls, [...ALL_ENGINES]);
});

test("a limiter rejection is a blocked probe with its code and no navigation", async () => {
  const google = stubEngine("google", { results: 3 });
  const page = new FakePage();
  const connector = new FakeConnector({ pages: { google: page } });
  const registry = createEngineRegistry({ google: google.engine }, DEFAULT_CONFIG);
  const capped = limiterSpy(connector, () =>
    fail("E_RATE_LIMITED", "navigate", { message: "daily cap 0 for google reached" }),
  );
  const probe = createEngineProbe({
    config: DEFAULT_CONFIG,
    connector,
    registry,
    clock: new FakeClock(),
    limiter: capped.limiter,
  });

  const blocked = await probe("google");
  assert.equal(blocked.error?.code, "E_RATE_LIMITED");
  assert.equal(blocked.results, 0);
  assert.equal(blocked.ai, false);
  assert.ok((blocked.error?.hint.length ?? 0) > 0);
  assert.deepEqual(capped.acquires, ["google"]);
  assert.deepEqual(connector.acquireCalls, [], "a paced-out probe must not touch the browser");
  assert.deepEqual(page.navigations(), [], "a paced-out probe must not navigate");
  assert.equal(google.queries.length, 0, "a paced-out probe must not even build a URL");

  // The report owns the interpretation: a limiter error is a blocked engine.
  const report = await buildDoctorReport(
    depsFor({ connector, registry, probe }),
  );
  assertSchemaValid(report);
  const entry = report.engines.find((engine) => engine.id === "google");
  assert.equal(entry?.verdict, "blocked");
  assert.match(entry?.note ?? "", /E_RATE_LIMITED during navigate/);
});

test("a non-WebSearchError limiter failure still reports E_RATE_LIMITED", async () => {
  const google = stubEngine("google");
  const connector = new FakeConnector({ pages: { google: new FakePage() } });
  const registry = createEngineRegistry({ google: google.engine }, DEFAULT_CONFIG);
  const limiter = limiterSpy(connector, () => new Error("state file is broken"));

  const result = await createEngineProbe({
    config: DEFAULT_CONFIG,
    connector,
    registry,
    clock: new FakeClock(),
    limiter: limiter.limiter,
  })("google");

  assert.equal(result.error?.code, "E_RATE_LIMITED");
  assert.deepEqual(connector.acquireCalls, []);
});

test("the extension wires a real probe + the runtime limiter into the doctor deps", async () => {
  // The HIGH-severity regression this guards: `getDoctorDeps` shipping no probe
  // made every engine "unavailable" in the real extension, and a probe built
  // without the limiter fired three unthrottled searches on the user's profile.
  const google = stubEngine("google", { results: 2, canaries: { organic: 2 } });
  const connector = new FakeConnector({ pages: { google: new FakePage() } });
  const registry = createEngineRegistry({ google: google.engine }, DEFAULT_CONFIG);
  const limiter = limiterSpy(connector);

  const deps = toDoctorDeps({
    config: DEFAULT_CONFIG,
    configPath: "/home/tester/.pi/agent/web-search.json",
    clock: new FakeClock(),
    cache: {
      get: () => undefined,
      set: () => undefined,
      size: () => 0,
      clear: () => undefined,
    },
    log: { write: async () => undefined, path: () => join(TEMP_ROOT, "decisions.jsonl") },
    limiter: limiter.limiter,
    artifacts: {
      save: async () => "",
      prune: async () => ({ removed: 0, kept: 0, bytes: 0 }),
      size: async () => 0,
      root: () => join(TEMP_ROOT, "artifacts"),
    },
    connector,
    registry,
  });

  assert.equal(typeof deps.probe, "function", "the shipped doctor must receive a probe");
  assert.equal(deps.limiter, limiter.limiter);

  const result = await deps.probe?.("google");
  assert.equal(result?.error, undefined);
  assert.deepEqual(limiter.acquires, ["google"], "the shipped probe must be paced");
  assert.deepEqual(connector.acquireCalls, ["google"]);
});

// ---------------------------------------------------------------------------
// Verdict mapping + canary aggregation
// ---------------------------------------------------------------------------

test("probe verdicts map ok / wall / layout_changed / blocked honestly", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy({
    google: { ms: 90, results: 5, ai: true, canaries: { organic: 5, aiBlock: 1 } },
    duckduckgo: { ms: 80, results: 0, ai: false, wall: "consent" },
    yandex: { ms: 70, results: 0, ai: false, canaries: { organic: 0, neuro: 0 } },
  });
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe: probe.fn }),
  );

  assertSchemaValid(report);
  const byId = new Map(report.engines.map((engine) => [engine.id, engine]));
  assert.equal(byId.get("google")?.verdict, "ok");
  assert.equal(byId.get("duckduckgo")?.verdict, "wall");
  assert.equal(byId.get("yandex")?.verdict, "layout_changed");
  assert.equal(report.verdict, "degraded");

  const blockedProbe = probeSpy({
    google: {
      ms: 30,
      results: 0,
      ai: false,
      error: { code: "E_TIMEOUT", stage: "settle", hint: "deadline exceeded" },
    },
    duckduckgo: {
      ms: 20,
      results: 0,
      ai: false,
      error: { code: "E_PARSE", stage: "extract", hint: "selector moved" },
    },
  });
  const blocked = await buildDoctorReport(
    depsFor({ connector: new FakeConnector(), registry: fakeRegistry(ALL_ENGINES), probe: blockedProbe.fn }),
  );
  assertSchemaValid(blocked);
  assert.equal(blocked.engines.find((engine) => engine.id === "google")?.verdict, "blocked");
  assert.equal(blocked.engines.find((engine) => engine.id === "duckduckgo")?.verdict, "layout_changed");
});

test("canary aggregation: every canary 0 is layout_changed, one non-zero is ok", async () => {
  const config = configWith((cfg) => {
    cfg.engines.duckduckgo.enabled = false;
    cfg.engines.yandex.enabled = false;
  });

  const allZero = probeSpy({ google: { ms: 10, results: 0, ai: false, canaries: { a: 0, b: 0 } } });
  const broken = await buildDoctorReport(
    depsFor({
      config,
      connector: new FakeConnector(),
      registry: fakeRegistry(ALL_ENGINES),
      probe: allZero.fn,
    }),
  );
  assertSchemaValid(broken);
  const brokenGoogle = broken.engines.find((engine) => engine.id === "google");
  assert.equal(brokenGoogle?.verdict, "layout_changed");
  assert.match(brokenGoogle?.note ?? "", /canary returned 0/);

  const oneAlive = probeSpy({ google: { ms: 10, results: 2, ai: false, canaries: { a: 0, b: 2 } } });
  const healthy = await buildDoctorReport(
    depsFor({
      config,
      connector: new FakeConnector(),
      registry: fakeRegistry(ALL_ENGINES),
      probe: oneAlive.fn,
    }),
  );
  assertSchemaValid(healthy);
  assert.equal(healthy.engines.find((engine) => engine.id === "google")?.verdict, "ok");
});

test("probes run once per engine, serialized, in canonical order", async () => {
  let active = 0;
  let maxActive = 0;
  const order: EngineId[] = [];
  const probe: EngineProbe = async (id) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(id);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    active -= 1;
    return OK_PROBE;
  };

  const report = await buildDoctorReport(
    depsFor({ connector: new FakeConnector(), registry: fakeRegistry(ALL_ENGINES), probe }),
  );

  assertSchemaValid(report);
  assert.deepEqual(order, [...ALL_ENGINES]);
  assert.equal(maxActive, 1, "the doctor must never probe two engines at once");
  assert.deepEqual(
    report.engines.map((engine) => engine.probe?.ms),
    [120, 120, 120],
  );
});

test("a blocked CDP skips every probe and says why", async () => {
  const connector = new FakeConnector({
    connectFailures: 99,
    connectError: fail("E_CDP_UNAVAILABLE", "discover", { message: "no endpoint" }),
  });
  const probe = probeSpy();

  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe: probe.fn }),
  );

  assertSchemaValid(report);
  assert.equal(report.cdp.status, "unavailable");
  assert.equal(probe.calls.length, 0, "no probe may run without a live CDP session");
  assert.equal(connector.acquireCalls.length, 0);
  for (const engine of report.engines) {
    assert.equal(engine.verdict, "unavailable");
    assert.equal(engine.note, "probe skipped: CDP is unavailable");
  }
});

test("a report built from the real probe factory is schema-valid", async () => {
  const engines = {
    google: stubEngine("google", { results: 5, ai: "overview", canaries: { organic: 5 } }),
    duckduckgo: stubEngine("duckduckgo", { results: 4, canaries: { organic: 4 } }),
    yandex: stubEngine("yandex", { results: 3, canaries: { organic: 3 } }),
  };
  const connector = new FakeConnector({
    pages: { google: new FakePage(), duckduckgo: new FakePage(), yandex: new FakePage() },
  });
  const registry = createEngineRegistry(
    {
      google: engines.google.engine,
      duckduckgo: engines.duckduckgo.engine,
      yandex: engines.yandex.engine,
    },
    DEFAULT_CONFIG,
  );

  const report = await buildDoctorReport(
    depsFor({
      connector,
      registry,
      probe: createEngineProbe({ config: DEFAULT_CONFIG, connector, registry, clock: new FakeClock() }),
    }),
  );

  assertSchemaValid(report);
  assert.equal(report.verdict, "ok");
  assert.deepEqual(
    report.engines.map((engine) => engine.verdict),
    ["ok", "ok", "ok"],
  );
  assert.equal(report.engines[0]?.probe?.ai, true);
  assert.deepEqual(report.engines[0]?.probe?.canaries, { organic: 5 });
});

// ---------------------------------------------------------------------------
// CLI: --no-probe and safe --fix
// ---------------------------------------------------------------------------

test("--no-probe performs zero probe calls and never touches a page", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy();
  const run = await runCli(["--json", "--no-probe"], {
    connector,
    registry: fakeRegistry(ALL_ENGINES),
    probe: probe.fn,
  });

  assert.equal(run.code, 0);
  assertSchemaValid(JSON.parse(run.stdout) as unknown);
  assert.equal(probe.calls.length, 0);
  assert.deepEqual(connector.acquireCalls, []);
});

test("CLI wires the default probe from the injected connector + registry", async () => {
  const google = stubEngine("google", { results: 3, canaries: { organic: 3 } });
  const connector = new FakeConnector({ pages: { google: new FakePage() } });
  const registry = createEngineRegistry({ google: google.engine }, DEFAULT_CONFIG);
  const limiter = limiterSpy(connector);

  // No `probe` in the CLI deps: production wiring must build it from the same
  // connector/registry the tools use, and pace it through the injected limiter.
  const run = await runCli(["--json"], { connector, registry, limiter: limiter.limiter });

  assert.equal(run.code, 0);
  const report = JSON.parse(run.stdout) as {
    engines: Array<{ id: EngineId; verdict: string }>;
  };
  assertSchemaValid(report);
  assert.equal(report.engines.find((engine) => engine.id === "google")?.verdict, "ok");
  assert.equal(google.queries.length, 1);
  assert.deepEqual(connector.acquireCalls, ["google"]);
  assert.deepEqual(limiter.acquires, ["google"], "the CLI probe must be paced, not unthrottled");
});

test("/web-doctor wires the default probe when the deps factory omits one", async () => {
  const google = stubEngine("google", { results: 2, canaries: { organic: 2 } });
  const connector = new FakeConnector({ pages: { google: new FakePage() } });
  const registry = createEngineRegistry({ google: google.engine }, DEFAULT_CONFIG);
  const limiter = limiterSpy(connector);
  const notes: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const ctx = {
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error"): void => {
        notes.push({ message, ...(type === undefined ? {} : { type }) });
      },
    },
  };

  await handleDoctorCommand("", ctx, () => depsFor({ connector, registry, limiter: limiter.limiter }));

  assert.equal(google.queries.length, 1, "the command must use the real probe factory");
  assert.deepEqual(limiter.acquires, ["google"], "the command probe must be paced too");
  assert.match(notes[0]?.message ?? "", /google=ok/);
});

test("--fix reconnects, closes only owned tabs, prunes artifacts and clears a dead lock", async () => {
  const lockPath = join(TEMP_ROOT, "fix-stale.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({ version: 1, pid: 2_000_001, sessionId: "dead-session", startedAt: 1, heartbeatAt: 1 }),
    "utf8",
  );

  const connector = new FakeConnector({ lockPath });
  const pruneCalls: number[] = [];
  const artifacts: Artifacts = {
    save: async () => "",
    prune: async () => {
      pruneCalls.push(1);
      return { removed: 2, kept: 3, bytes: 100 };
    },
    size: async () => 100,
    root: () => join(TEMP_ROOT, "artifacts"),
  };

  const realKill = process.kill;
  let kills = 0;
  process.kill = ((..._args: Parameters<typeof process.kill>) => {
    kills += 1;
    return true;
  }) as typeof process.kill;

  try {
    const run = await runCli(["--fix", "--json", "--no-probe"], {
      connector,
      registry: fakeRegistry(ALL_ENGINES),
      artifacts,
      alive: () => false,
    });

    assert.equal(run.code, 0);
    assertSchemaValid(JSON.parse(run.stdout) as unknown);
    assert.match(run.stderr, /fix: connected to CDP/);
    assert.match(run.stderr, /fix: closed 1 owned tab\(s\)/);
    assert.match(run.stderr, /fix: pruned artifacts: 2 removed, 3 kept/);
    assert.match(run.stderr, /fix: cleared stale lock \(pid 2000001 is not running\)/);
    assert.match(
      run.stderr,
      /reconnected after release/,
      "the post-release reconnect is labelled distinctly from the retry",
    );
  } finally {
    process.kill = realKill;
  }

  assert.equal(kills, 0, "the doctor must never signal the user's Chrome");
  assert.ok(connector.connectCalls >= 2, `connect calls: ${connector.connectCalls}`);
  assert.ok(connector.releaseCalls >= 1, `release calls: ${connector.releaseCalls}`);
  assert.deepEqual(connector.closed, ["owned-anchor"]);
  for (const foreign of connector.foreign) {
    assert.equal(connector.closed.includes(foreign), false, `must never close ${foreign}`);
  }
  assert.equal(pruneCalls.length, 1);
  assert.equal(existsSync(lockPath), false, "a lock whose pid is provably dead is reclaimed");
});

test("--fix labels the post-release reconnect once, distinctly from the retry", async () => {
  // First connect fails, the retry succeeds, then release + reconnect: the two
  // reconnects must not both claim "once".
  const connector = new FakeConnector({ connectFailures: 1 });
  const run = await runCli(["--fix", "--json", "--no-probe"], {
    connector,
    registry: fakeRegistry(ALL_ENGINES),
    alive: () => true,
  });

  assert.equal(run.code, 0);
  assertSchemaValid(JSON.parse(run.stdout) as unknown);
  assert.match(run.stderr, /fix: connect failed: E_CDP_UNAVAILABLE/);
  assert.equal((run.stderr.match(/reconnected to CDP once/g) ?? []).length, 1);
  assert.equal((run.stderr.match(/reconnected after release/g) ?? []).length, 1);
});

test("applyDoctorFix leaves a live foreign lock alone even when its pid is unprovable", async () => {
  const lockPath = join(TEMP_ROOT, "fix-foreign.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({ version: 1, pid: 777, sessionId: "foreign", startedAt: 1, heartbeatAt: 2 }),
    "utf8",
  );
  const connector = new FakeConnector({
    lockPath,
    connectFailures: 99,
    connectError: fail("E_BUSY", "connect", { message: "another pi session holds the lock" }),
  });

  const actions = await applyDoctorFix(
    {
      ...depsFor({ connector, registry: fakeRegistry(ALL_ENGINES) }),
    },
    { alive: () => false },
  );

  assert.ok(actions.some((action) => action.startsWith("connect failed: E_BUSY")));
  assert.deepEqual(
    actions.filter((action) => action.includes("stale lock")),
    [],
    "E_BUSY is the connector's own liveness verdict; --fix must not override it",
  );
  assert.match(readFileSync(lockPath, "utf8"), /foreign/);
});

test("applyDoctorFix never reclaims a lock whose foreign owner is alive", async () => {
  // The E_BUSY test above reaches the `busy` short-circuit, not the liveness
  // predicate. Here the connector fails for an unrelated reason, so `!alive()`
  // is the only thing standing between a live session and a deleted lock file.
  const lockPath = join(TEMP_ROOT, "fix-live.lock");
  const bytes = `${JSON.stringify({
    version: 1,
    pid: 4242,
    sessionId: "live-foreign",
    startedAt: 1,
    heartbeatAt: 2,
  })}\n`;
  writeFileSync(lockPath, bytes, "utf8");
  const connector = new FakeConnector({
    lockPath,
    connectFailures: 99,
    connectError: fail("E_CDP_UNAVAILABLE", "connect", { message: "socket closed" }),
  });

  const asked: number[] = [];
  const actions = await applyDoctorFix(depsFor({ connector, registry: fakeRegistry(ALL_ENGINES) }), {
    alive: (pid: number) => {
      asked.push(pid);
      return true;
    },
  });

  assert.ok(actions.some((action) => action.startsWith("connect failed: E_CDP_UNAVAILABLE")));
  assert.deepEqual(asked, [4242], "the liveness predicate must be consulted for a foreign pid");
  assert.deepEqual(
    actions.filter((action) => action.includes("stale lock")),
    [],
    "a provably live foreign lock is never reclaimed",
  );
  assert.equal(readFileSync(lockPath, "utf8"), bytes, "the lock file must be byte-identical");
});

test("applyDoctorFix leaves a lock whose pid the default liveness check reports live", async () => {
  // pid 1 exists in every /proc namespace, so the real `pidAlive` path is
  // exercised without signalling anything (and without child_process).
  const lockPath = join(TEMP_ROOT, "fix-pid1.lock");
  const bytes = `${JSON.stringify({
    version: 1,
    pid: 1,
    sessionId: "init",
    startedAt: 1,
    heartbeatAt: 2,
  })}\n`;
  writeFileSync(lockPath, bytes, "utf8");
  const connector = new FakeConnector({
    lockPath,
    connectFailures: 99,
    connectError: fail("E_CDP_DISCONNECTED", "connect", { message: "socket closed" }),
  });

  const actions = await applyDoctorFix(depsFor({ connector, registry: fakeRegistry(ALL_ENGINES) }));

  assert.deepEqual(
    actions.filter((action) => action.includes("stale lock")),
    [],
  );
  assert.equal(readFileSync(lockPath, "utf8"), bytes);
});

// ---------------------------------------------------------------------------
// Deferred web_doctor tool
// ---------------------------------------------------------------------------

function okDeps(): DoctorDeps {
  return depsFor({
    connector: new FakeConnector(),
    registry: fakeRegistry(ALL_ENGINES),
    probe: probeSpy().fn,
  });
}

test("web_doctor is a deferred tool, open-world, not read-only, with a short description", async () => {
  const tool = createWebDoctorTool(async () => okDeps());

  assert.equal(tool.name, "web_doctor");
  assert.equal(tool.exposure, "deferred");
  // `fix: true` closes owned tabs and prunes artifacts: claiming read-only would
  // let a caller batch a mutating tool with inert ones.
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    openWorldHint: true,
    idempotentHint: true,
  });
  assert.equal(tool.description, WEB_DOCTOR_DESCRIPTION);
  assert.ok(tool.description.length <= 350, `description is ${tool.description.length} chars`);
  assert.equal(tool.description.includes("\n"), false);
  assert.equal(tool.parameters.type, "object");
});

test("web_doctor returns compact text plus {verdict, cdp, engines}, never the report JSON", async () => {
  const tool = createWebDoctorTool(async () => okDeps());
  const result = await tool.execute("call-1", {}, undefined, undefined);

  assert.equal("isError" in result, false);
  const success = result as WebDoctorSuccess;
  assert.deepEqual(Object.keys(success.details), ["verdict", "cdp", "engines"]);
  assert.equal(success.details.verdict, "ok");
  assert.deepEqual(
    success.details.engines.map((engine) => engine.id),
    [...ALL_ENGINES],
  );

  const text = success.content[0]?.text ?? "";
  assert.match(text, /^web_doctor: ok — cdp ok/);
  assert.match(text, /google ok \(5 results, ai=yes, 120ms\)/);
  assert.doesNotMatch(text, /schemaVersion|"cdp"|"engines"/);
  assert.throws(() => JSON.parse(text), "the tool must not return a JSON envelope");
  assert.ok(Buffer.byteLength(text, "utf8") < 2500, `tool text is ${Buffer.byteLength(text)} bytes`);
});

test("web_doctor rejects invalid params instead of coercing them", async () => {
  const tool = createWebDoctorTool(async () => okDeps());

  const notBoolean = (await tool.execute(
    "call-2",
    { probe: "yes" } as unknown as WebDoctorInput,
    undefined,
    undefined,
  )) as WebDoctorFailure;
  assert.equal(notBoolean.isError, true);
  assert.equal(notBoolean.details.code, "E_CONFIG");
  assert.match(notBoolean.content[0]?.text ?? "", /probe: expected a boolean/);
  assert.match(notBoolean.details.message ?? "", /probe: expected a boolean/);

  const notObject = (await tool.execute(
    "call-3",
    "probe" as unknown as WebDoctorInput,
    undefined,
    undefined,
  )) as WebDoctorFailure;
  assert.equal(notObject.isError, true);
  assert.equal(notObject.details.code, "E_CONFIG");
});

test("web_doctor probe:false skips probes; fix:true reports the safe actions", async () => {
  const probe = probeSpy();
  const connector = new FakeConnector();
  const deps = depsFor({
    connector,
    registry: fakeRegistry(ALL_ENGINES),
    probe: probe.fn,
  });
  const tool = createWebDoctorTool(async () => deps);

  const noProbe = (await tool.execute(
    "call-4",
    { probe: false },
    undefined,
    undefined,
  )) as WebDoctorSuccess;
  assert.equal(probe.calls.length, 0);
  assert.match(noProbe.content[0]?.text ?? "", /--no-probe/);

  const fixed = await tool.execute("call-5", { probe: false, fix: true }, undefined, undefined);
  const fixedSuccess = fixed as WebDoctorSuccess;
  assert.match(fixedSuccess.content[0]?.text ?? "", /fix: closed 1 owned tab\(s\)/);
  assert.ok(connector.releaseCalls >= 1);
});
