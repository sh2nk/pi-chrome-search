/**
 * P1-E: doctor report, CLI and command handlers.
 *
 * Everything here is offline: a fake `Connector` (no socket), a fake probe, an
 * in-memory cache and fixed clock. The JSON schema lives in
 * `tests/fixtures/doctor.schema.json` and is validated by the small draft-07
 * subset validator below (no dependency, no network `$ref` resolution).
 *
 *   node --test tests/unit/doctor.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { Connector, ConnectorInfo } from "../../src/cdp/browser.ts";
import type { BrowserInfo, CdpConnectionInfo, CdpEndpoint, CdpPage } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import type { Config } from "../../src/config.ts";
import { createEngineRegistry } from "../../src/engines/index.ts";
import type { EngineId, EngineRegistry } from "../../src/engines/types.ts";
import { parseDoctorArgs, runDoctorCli } from "../../src/cli/doctor.ts";
import { handleDoctorCommand } from "../../src/commands/doctor.ts";
import { handleFocusCommand } from "../../src/commands/focus.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { buildDoctorReport, renderDoctorText } from "../../src/runtime/doctor.ts";
import type {
  DoctorDeps,
  DoctorReport,
  EngineProbe,
  EngineProbeResult,
} from "../../src/runtime/doctor.ts";
import { fail } from "../../src/runtime/errors.ts";
import { WebSearchError } from "../../src/runtime/error-codes.ts";
import type { Cache } from "../../src/runtime/types.ts";
import { FakeClock } from "../helpers/clock.ts";

// ---------------------------------------------------------------------------
// JSON-schema subset validator (draft-07: type|type[], const, enum, required,
// properties, additionalProperties, items, minItems, minimum, maximum,
// minLength). Deliberately tiny: the point is to catch a shape regression, not
// to reimplement ajv.
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

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateSchema(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((type) => typeof type === "string" && matchesType(type, value))) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${typeOf(value)}`);
      return errors;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
    }
  }

  if (typeof value === "string" && typeof schema.minLength === "number") {
    if ([...value].length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
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

test("doctor schema fixture is a draft-07 object schema", () => {
  assert.equal(SCHEMA.type, "object");
  assert.ok(Array.isArray(SCHEMA.required));
  assert.deepEqual(validateSchema(SCHEMA, {}, "report").length > 0, true);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEMP_ROOT = mkdtempSync(join(tmpdir(), "pi-doctor-"));
after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

let counter = 0;
function tempPath(name: string): string {
  counter += 1;
  return join(TEMP_ROOT, `${name}-${counter}`);
}

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

interface FakeConnectorOptions {
  webdriver?: boolean;
  windowId?: number | null;
  windowDegraded?: boolean;
  /** Reject `connect()` this many times before succeeding (use a large number to always fail). */
  connectFailures?: number;
  connectError?: WebSearchError;
  lockPath?: string;
}

class FakeConnector implements Connector {
  connectCalls = 0;
  releaseCalls = 0;
  focusCalls = 0;
  acquireCalls = 0;
  webdriver: boolean;
  windowId: number | null;
  windowDegraded: boolean;
  connectFailures: number;
  connectError: WebSearchError | undefined;
  throwOnInfo = false;

  #connected = false;
  #owned: string[] = [];
  #lockPath: string;

  constructor(options: FakeConnectorOptions = {}) {
    this.webdriver = options.webdriver ?? false;
    this.windowId = options.windowId === undefined ? 42 : options.windowId;
    this.windowDegraded = options.windowDegraded ?? false;
    this.connectFailures = options.connectFailures ?? 0;
    this.connectError = options.connectError;
    this.#lockPath = options.lockPath ?? tempPath("web-search.lock");
  }

  async connect(): Promise<CdpConnectionInfo> {
    this.connectCalls += 1;
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      throw (
        this.connectError ??
        fail("E_CDP_UNAVAILABLE", "connect", { message: "fake connector refuses to connect" })
      );
    }
    this.#connected = true;
    this.#owned = ["owned-anchor"];
    // A real connect acquires the lock; mirror it so the report's lock line is honest.
    writeFileSync(
      this.#lockPath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        sessionId: "fake-doctor-session",
        startedAt: 1,
        heartbeatAt: 1,
      }),
      "utf8",
    );
    return { endpoint: FAKE_ENDPOINT, browser: FAKE_BROWSER, webdriver: this.webdriver };
  }

  async acquirePage(): Promise<CdpPage> {
    this.acquireCalls += 1;
    throw fail("E_UNSUPPORTED", "resolve", { message: "the doctor never acquires a page directly" });
  }

  async releaseAll(): Promise<void> {
    this.releaseCalls += 1;
    this.#connected = false;
    this.#owned = [];
    rmSync(this.#lockPath, { force: true });
  }

  isConnected(): boolean {
    return this.#connected;
  }

  endpoint(): CdpEndpoint | null {
    return this.#connected ? FAKE_ENDPOINT : null;
  }

  info(): ConnectorInfo | null {
    if (this.throwOnInfo) throw new Error("fake info() exploded");
    if (!this.#connected) return null;
    return {
      endpoint: FAKE_ENDPOINT,
      browser: FAKE_BROWSER,
      webdriver: this.webdriver,
      windowId: this.windowId,
      ownedTargets: this.#owned.map((targetId) => ({
        targetId,
        engine: null,
        url: "about:blank",
      })),
      focusedOnce: [],
      windowDegraded: this.windowDegraded,
      locked: true,
    };
  }

  ownedTargets(): string[] {
    return [...this.#owned];
  }

  lockPath(): string {
    return this.#lockPath;
  }

  async focus(): Promise<void> {
    this.focusCalls += 1;
    if (!this.#connected) {
      throw fail("E_CDP_DISCONNECTED", "connect", { message: "focus before connect" });
    }
  }
}

const ALL_ENGINES: readonly EngineId[] = ["google", "duckduckgo", "yandex"];

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

const OK_PROBE: EngineProbeResult = {
  ms: 120,
  results: 5,
  ai: true,
  canaries: { organic: 5, aiBlock: 1 },
};

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

function reportSize(report: DoctorReport): number {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

// ---------------------------------------------------------------------------
// buildDoctorReport
// ---------------------------------------------------------------------------

test("ok: attached connector and three healthy probes", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy();
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe: probe.fn }),
  );

  assertSchemaValid(report);
  assert.equal(report.verdict, "ok");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.cdp.status, "ok");
  assert.equal(report.cdp.webdriver, false);
  assert.equal(report.cdp.windowId, 42);
  assert.equal(report.cdp.browser?.product, "Chrome/157.0.8103.38");
  assert.equal(report.cdp.endpoint?.source, "devtools-active-port");
  assert.equal(report.cdp.lock.locked, true);
  assert.equal(report.cdp.lock.owner, "self");
  assert.deepEqual(report.engines.map((engine) => engine.id), [...ALL_ENGINES]);
  assert.deepEqual(report.engines.map((engine) => engine.verdict), ["ok", "ok", "ok"]);
  assert.deepEqual(probe.calls, [...ALL_ENGINES]);
  assert.equal(report.engines[0].probe?.results, 5);
  assert.equal(report.engines[0].probe?.ai, true);
  assert.equal(report.cache, null);
  assert.equal(report.artifacts, null);
  assert.equal(report.reflex.classifier, "disabled");
  assert.ok(reportSize(report) < 4000, `report grew to ${reportSize(report)} bytes`);
});

test("pre-P3: no adapters means unavailable, and the probe is never called", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy();
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry([]), probe: probe.fn }),
  );

  assertSchemaValid(report);
  assert.equal(report.verdict, "degraded");
  assert.equal(report.cdp.status, "ok");
  assert.equal(probe.calls.length, 0);
  for (const engine of report.engines) {
    assert.equal(engine.enabled, true);
    assert.equal(engine.verdict, "unavailable");
    assert.match(engine.note ?? "", /no adapter registered/);
    assert.equal(engine.probe, undefined, "canaries must not be invented");
  }
});

test("registered adapters without an injected probe are unavailable, not ok", async () => {
  const connector = new FakeConnector();
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES) }),
  );

  assertSchemaValid(report);
  assert.equal(report.verdict, "degraded");
  for (const engine of report.engines) {
    assert.equal(engine.verdict, "unavailable");
    assert.match(engine.note ?? "", /no probe configured/);
  }
});

test("disabled engines are unavailable with an explicit note", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy();
  const config = configWith((cfg) => {
    cfg.engines.duckduckgo.enabled = false;
  });
  const report = await buildDoctorReport(
    depsFor({ config, connector, registry: fakeRegistry(ALL_ENGINES), probe: probe.fn }),
  );

  assertSchemaValid(report);
  const ddg = report.engines.find((engine) => engine.id === "duckduckgo");
  assert.equal(ddg?.enabled, false);
  assert.equal(ddg?.verdict, "unavailable");
  assert.match(ddg?.note ?? "", /disabled in config/);
  assert.deepEqual(probe.calls, ["google", "yandex"]);
});

test("a captcha wall is reported as wall and degrades the verdict", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy({
    yandex: { ms: 900, results: 0, ai: false, wall: "captcha" },
  });
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe: probe.fn }),
  );

  assertSchemaValid(report);
  assert.equal(report.verdict, "degraded");
  const yandex = report.engines.find((engine) => engine.id === "yandex");
  assert.equal(yandex?.verdict, "wall");
  assert.equal(yandex?.probe?.wall, "captcha");
  assert.match(yandex?.note ?? "", /never automate/);
  assert.equal(report.cdp.status, "ok");
});

test("all-zero canaries mean layout_changed", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy({
    google: { ms: 100, results: 0, ai: false, canaries: { organic: 0, aiBlock: 0 } },
  });
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe: probe.fn }),
  );

  assertSchemaValid(report);
  const google = report.engines.find((engine) => engine.id === "google");
  assert.equal(google?.verdict, "layout_changed");
  assert.match(google?.note ?? "", /canary returned 0/);
  assert.equal(report.verdict, "degraded");
});

test("E_PARSE from a probe is layout_changed, E_CDP_* is blocked", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy({
    google: {
      ms: 80,
      results: 0,
      ai: false,
      error: { code: "E_PARSE", stage: "extract", hint: "selector canary failed (results=0)" },
    },
    duckduckgo: {
      ms: 0,
      results: 0,
      ai: false,
      error: { code: "E_CDP_UNAVAILABLE", stage: "connect", hint: "no endpoint" },
    },
  });
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe: probe.fn }),
  );

  assertSchemaValid(report);
  const byId = new Map(report.engines.map((engine) => [engine.id, engine]));
  assert.equal(byId.get("google")?.verdict, "layout_changed");
  assert.equal(byId.get("duckduckgo")?.verdict, "blocked");
  assert.equal(byId.get("yandex")?.verdict, "ok");
  assert.equal(report.verdict, "degraded");
});

test("a throwing probe becomes blocked without inventing probe data", async () => {
  const connector = new FakeConnector();
  const probe: EngineProbe = async (id) => {
    if (id === "google") throw fail("E_PARSE", "extract", { message: "boom" });
    return OK_PROBE;
  };
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe }),
  );

  assertSchemaValid(report);
  const google = report.engines.find((engine) => engine.id === "google");
  assert.equal(google?.verdict, "layout_changed");
  assert.equal(google?.probe, undefined);
  assert.match(google?.note ?? "", /E_PARSE/);
});

test("E_CDP_UNAVAILABLE connector: blocked report, no throw, actionable hint", async () => {
  const connector = new FakeConnector({
    connectFailures: 99,
    connectError: fail("E_CDP_UNAVAILABLE", "discover", { message: "no CDP endpoint found" }),
  });
  const report = await buildDoctorReport(depsFor({ connector, registry: fakeRegistry(ALL_ENGINES) }));

  assertSchemaValid(report);
  assert.equal(report.verdict, "blocked");
  assert.equal(report.cdp.status, "unavailable");
  assert.equal(report.cdp.error?.code, "E_CDP_UNAVAILABLE");
  assert.match(report.cdp.error?.hint ?? "", /chrome:\/\/inspect/);
  assert.equal(report.cdp.endpoint, null);
  assert.equal(report.cdp.browser, null);
});

test("no connector at all is an honest unavailable report", async () => {
  const report = await buildDoctorReport(depsFor());

  assertSchemaValid(report);
  assert.equal(report.cdp.status, "unavailable");
  assert.equal(report.cdp.error?.code, "E_CDP_UNAVAILABLE");
  assert.equal(report.cdp.lock.locked, false);
  assert.equal(report.verdict, "blocked");
});

test("a foreign lock is reported as busy with its pid, and never cleared", async () => {
  const lockPath = tempPath("web-search.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({ version: 1, pid: 4242, sessionId: "other-session", startedAt: 1, heartbeatAt: 2 }),
    "utf8",
  );
  const connector = new FakeConnector({
    lockPath,
    connectFailures: 99,
    connectError: fail("E_BUSY", "connect", { message: "another pi session holds the lock" }),
  });
  const report = await buildDoctorReport(depsFor({ connector, registry: fakeRegistry(ALL_ENGINES) }));

  assertSchemaValid(report);
  assert.equal(report.cdp.status, "busy");
  assert.equal(report.cdp.lock.locked, true);
  assert.equal(report.cdp.lock.owner, "other");
  assert.equal(report.cdp.lock.pid, 4242);
  assert.equal(report.verdict, "blocked");
  // The doctor only reads the lock file; the foreign holder is still there.
  assert.match(readFileSync(lockPath, "utf8"), /other-session/);
});

test("webdriver true is blocked with an explicit hint", async () => {
  const connector = new FakeConnector({ webdriver: true });
  const report = await buildDoctorReport(depsFor({ connector, registry: fakeRegistry(ALL_ENGINES) }));

  assertSchemaValid(report);
  assert.equal(report.verdict, "blocked");
  assert.equal(report.cdp.status, "error");
  assert.equal(report.cdp.webdriver, true);
  assert.match(report.cdp.error?.hint ?? "", /navigator\.webdriver/);
  assert.match(report.cdp.error?.hint ?? "", /inspect/);
});

test("cache and artifacts are reported only when wired", async () => {
  const connector = new FakeConnector();
  const clock = new FakeClock();
  const cache = createCache({ maxEntries: 10, clock });
  cache.set("a", { value: 1 }, 1000);
  cache.set("b", { value: 2 }, 1000);

  const withData = await buildDoctorReport(
    depsFor({ connector, cache, artifacts: fakeArtifacts(), registry: fakeRegistry(ALL_ENGINES) }),
  );
  assertSchemaValid(withData);
  assert.deepEqual(withData.cache, { entries: 2 });
  assert.deepEqual(withData.artifacts, {
    dir: "/home/tester/.pi/agent/web-search/artifacts",
    bytes: 4096,
  });

  const bare = await buildDoctorReport(depsFor({ connector: new FakeConnector() }));
  assertSchemaValid(bare);
  assert.equal(bare.cache, null);
  assert.equal(bare.artifacts, null);
});

test("reflex reports disabled off and unavailable (no probe yet) when on", async () => {
  const off = await buildDoctorReport(depsFor({ connector: new FakeConnector() }));
  assert.equal(off.reflex.classifier, "disabled");
  assert.equal(off.reflex.enabled, false);

  const config = configWith((cfg) => {
    cfg.reflex.enabled = true;
    cfg.reflex.backend = "rules";
  });
  const on = await buildDoctorReport(depsFor({ config, connector: new FakeConnector() }));
  assert.equal(on.reflex.classifier, "unavailable");
  assert.equal(on.reflex.backend, "rules");
});

test("report carries no cookies, HTML or non-loopback address", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy({
    google: { ms: 10, results: 1, ai: false, canaries: { organic: 1 } },
  });
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe: probe.fn }),
  );
  const text = JSON.stringify(report);

  const addresses = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
  assert.deepEqual(
    addresses.filter((address) => address !== "127.0.0.1"),
    [],
    "the report must not contain a non-loopback address",
  );
  assert.doesNotMatch(text, /<html|<\/div>|<a\s+href=/i);
  assert.doesNotMatch(text, /cookie/i);
  assert.doesNotMatch(text, /document\./);
});

test("generatedAt is ISO and derived from the injected clock", async () => {
  const clock = new FakeClock({ now: Date.UTC(2026, 10, 6, 12, 0, 0) });
  const report = await buildDoctorReport(depsFor({ clock, connector: new FakeConnector() }));
  assert.equal(report.generatedAt, "2026-11-06T12:00:00.000Z");
});

// ---------------------------------------------------------------------------
// renderDoctorText
// ---------------------------------------------------------------------------

test("renderDoctorText is human-readable and keeps the verdict visible", async () => {
  const connector = new FakeConnector();
  const report = await buildDoctorReport(
    depsFor({ connector, registry: fakeRegistry(ALL_ENGINES), probe: probeSpy().fn }),
  );
  const text = renderDoctorText(report);

  assert.match(text, /^pi-chrome-search 0\.1\.0-test — doctor/);
  assert.match(text, /config: \/home\/tester\/\.pi\/agent\/web-search\.json/);
  assert.match(text, /cdp: ok — Chrome\/157/);
  assert.match(text, /webdriver: false/);
  assert.match(text, /lock: .*web-search\.lock/);
  assert.match(text, /engines:/);
  assert.match(text, /google\s+ok \(5 results, ai=yes, 120ms\)/);
  assert.match(text, /reflex: disabled/);
  assert.match(text, /verdict: ok\n$/);
});

test("renderDoctorText surfaces a blocked CDP error", async () => {
  const connector = new FakeConnector({ connectFailures: 99 });
  const report = await buildDoctorReport(depsFor({ connector }));
  const text = renderDoctorText(report);

  assert.match(text, /^cdp: unavailable/m);
  assert.match(text, /error \[E_CDP_UNAVAILABLE\] connect:/);
  assert.match(text, /verdict: blocked/);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  argv: string[],
  options: {
    connector?: FakeConnector;
    probe?: EngineProbe;
    registry?: EngineRegistry;
    config?: Config;
    cache?: Cache;
    artifacts?: ReturnType<typeof fakeArtifacts>;
    loadConfig?: (opts: { path?: string; env: NodeJS.ProcessEnv }) => Config;
  } = {},
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDoctorCli(argv, {
    env: { PI_CODING_AGENT_DIR: TEMP_ROOT },
    clock: new FakeClock(),
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
    loadConfig: options.loadConfig ?? (() => options.config ?? DEFAULT_CONFIG),
    ...(options.connector === undefined ? {} : { connector: options.connector }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

test("CLI parses flags strictly", () => {
  assert.deepEqual(parseDoctorArgs([]), { json: false, probe: true, fix: false, help: false });
  assert.deepEqual(parseDoctorArgs(["--json", "--no-probe", "--fix"]), {
    json: true,
    probe: false,
    fix: true,
    help: false,
  });
  assert.equal(parseDoctorArgs(["--config", "/tmp/x.json"]).configPath, "/tmp/x.json");
  assert.throws(() => parseDoctorArgs(["--config"]), (error: unknown) => isCode(error, "E_CONFIG"));
  assert.throws(() => parseDoctorArgs(["--nope"]), (error: unknown) => isCode(error, "E_CONFIG"));
});

test("CLI --json prints a schema-valid report and exits 0 for degraded", async () => {
  const connector = new FakeConnector();
  const run = await runCli(["--json", "--no-probe"], {
    connector,
    registry: fakeRegistry(ALL_ENGINES),
  });

  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  const report = JSON.parse(run.stdout) as DoctorReport;
  assertSchemaValid(report);
  assert.equal(report.verdict, "degraded");
  assert.equal(connector.releaseCalls, 1, "the doctor closes the window it opened");
});

test("CLI --no-probe makes zero probe calls", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy();
  const run = await runCli(["--json", "--no-probe"], {
    connector,
    probe: probe.fn,
    registry: fakeRegistry(ALL_ENGINES),
  });

  const report = JSON.parse(run.stdout) as DoctorReport;
  assertSchemaValid(report);
  assert.equal(probe.calls.length, 0);
  for (const engine of report.engines) {
    assert.equal(engine.verdict, "unavailable");
    assert.match(engine.note ?? "", /--no-probe/);
  }
});

test("CLI --json produces text and the same exit code as --json for ok", async () => {
  const connector = new FakeConnector();
  const run = await runCli([], {
    connector,
    probe: probeSpy().fn,
    registry: fakeRegistry(ALL_ENGINES),
  });

  assert.equal(run.code, 0);
  assert.match(run.stdout, /verdict: ok/);
  assert.match(run.stdout, /engines:/);
});

test("CLI reports E_CDP_UNAVAILABLE as blocked JSON and exit 2", async () => {
  const connector = new FakeConnector({
    connectFailures: 99,
    connectError: fail("E_CDP_UNAVAILABLE", "discover", { message: "no CDP endpoint found" }),
  });
  const run = await runCli(["--json"], { connector, registry: fakeRegistry(ALL_ENGINES) });

  assert.equal(run.code, 2);
  const report = JSON.parse(run.stdout) as DoctorReport;
  assertSchemaValid(report);
  assert.equal(report.verdict, "blocked");
  assert.equal(report.cdp.error?.code, "E_CDP_UNAVAILABLE");
  assert.match(report.cdp.error?.hint ?? "", /chrome:\/\/inspect/);
});

test("CLI --config passes the path to the config loader", async () => {
  const seen: Array<string | undefined> = [];
  const run = await runCli(["--json", "--config", "/tmp/other-config.json"], {
    connector: new FakeConnector(),
    loadConfig: (opts) => {
      seen.push(opts.path);
      return DEFAULT_CONFIG;
    },
  });

  assert.equal(run.code, 0);
  assert.deepEqual(seen, ["/tmp/other-config.json"]);
  const report = JSON.parse(run.stdout) as DoctorReport;
  assert.equal(report.config.path, "/tmp/other-config.json");
});

test("CLI --fix reconnects, releases owned tabs and never kills a process", async () => {
  const connector = new FakeConnector();
  const probe = probeSpy();

  const realKill = process.kill;
  let kills = 0;
  process.kill = ((..._args: Parameters<typeof process.kill>) => {
    kills += 1;
    return true;
  }) as typeof process.kill;

  try {
    const run = await runCli(["--fix", "--json"], {
      connector,
      probe: probe.fn,
      registry: fakeRegistry(ALL_ENGINES),
    });
    assert.equal(run.code, 0);
    assert.match(run.stderr, /^fix: /, "--fix notes go to stderr so stdout stays schema-valid");
    assert.match(run.stderr, /reconnected after release/);
    assert.ok(connector.connectCalls >= 2, `connect calls: ${connector.connectCalls}`);
    assert.ok(connector.releaseCalls >= 1, `release calls: ${connector.releaseCalls}`);
    assert.equal(probe.calls.length, ALL_ENGINES.length, "--fix must still probe once per engine");
  } finally {
    process.kill = realKill;
  }

  assert.equal(kills, 0, "the doctor must never kill the user's Chrome");
});

test("CLI --fix clears a foreign lock only by leaving it alone", async () => {
  const lockPath = tempPath("web-search.lock");
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
  const run = await runCli(["--fix", "--json"], { connector });

  assert.equal(run.code, 2);
  assert.match(readFileSync(lockPath, "utf8"), /foreign/, "a live foreign lock must survive --fix");
  const report = JSON.parse(run.stdout) as DoctorReport;
  assert.equal(report.cdp.status, "busy");
  assert.equal(report.cdp.lock.pid, 777);
});

test("CLI config errors exit 2 without a crash", async () => {
  const run = await runCli(["--json"], {
    loadConfig: () => {
      throw fail("E_CONFIG", "config", { message: "config.engines.google: unknown key" });
    },
  });
  assert.equal(run.code, 2);
  assert.match(run.stdout, /"code": "E_CONFIG"/);
});

// ---------------------------------------------------------------------------
// /web-doctor and /web-focus
// ---------------------------------------------------------------------------

interface Notify {
  message: string;
  type?: "info" | "warning" | "error";
}

function captureContext(): { ctx: { ui: { notify: (message: string, type?: Notify["type"]) => void } }; notes: Notify[] } {
  const notes: Notify[] = [];
  return {
    ctx: {
      ui: {
        notify: (message, type) => {
          notes.push({ message, ...(type === undefined ? {} : { type }) });
        },
      },
    },
    notes,
  };
}

test("/web-doctor notifies a compact summary without throwing", async () => {
  const { ctx, notes } = captureContext();
  await handleDoctorCommand("", ctx, () =>
    depsFor({
      connector: new FakeConnector(),
      registry: fakeRegistry(ALL_ENGINES),
      probe: probeSpy().fn,
    }),
  );

  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /^web-doctor: ok — cdp ok, webdriver false/);
  assert.match(notes[0].message, /google=ok, duckduckgo=ok, yandex=ok/);
  assert.equal(notes[0].type, "info");
});

test("/web-doctor --json names the canonical CLI instead of building deps", async () => {
  const { ctx, notes } = captureContext();
  await handleDoctorCommand("--json", ctx, () => {
    throw fail("E_CONFIG", "config", { message: "depsFactory must not run for --json" });
  });

  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /node src\/cli\/doctor\.ts --json/);
  assert.equal(notes[0].type, "warning");
});

test("/web-doctor never throws when the deps factory fails", async () => {
  const { ctx, notes } = captureContext();
  await handleDoctorCommand("", ctx, () => {
    throw fail("E_CONFIG", "config", { message: "no config" });
  });

  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /^web-doctor failed \[E_CONFIG\]/);
  assert.equal(notes[0].type, "error");
});

test("/web-doctor reports a blocked CDP with the hint", async () => {
  const { ctx, notes } = captureContext();
  await handleDoctorCommand("--no-probe", ctx, () =>
    depsFor({ connector: new FakeConnector({ connectFailures: 99 }) }),
  );

  assert.ok(notes.length >= 2);
  assert.match(notes[0].message, /^web-doctor: blocked/);
  assert.match(notes[1].message, /\[E_CDP_UNAVAILABLE\]/);
  assert.equal(notes[0].type, "error");
});

test("/web-focus connects when needed and brings the window forward", async () => {
  const { ctx, notes } = captureContext();
  const connector = new FakeConnector();
  await handleFocusCommand(ctx, () => ({ connector }));

  assert.equal(connector.connectCalls, 1);
  assert.equal(connector.focusCalls, 1);
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /^web-focus: brought/);
  assert.equal(notes[0].type, "info");
});

test("/web-focus without a connector warns and does not throw", async () => {
  const { ctx, notes } = captureContext();
  await handleFocusCommand(ctx, () => ({}));

  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /no browser connector/);
  assert.equal(notes[0].type, "warning");
});

test("/web-focus maps a connect failure onto the error taxonomy", async () => {
  const { ctx, notes } = captureContext();
  const connector = new FakeConnector({
    connectFailures: 99,
    connectError: fail("E_CDP_UNAVAILABLE", "connect", { message: "no endpoint" }),
  });
  await handleFocusCommand(ctx, () => ({ connector }));

  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /^web-focus failed \[E_CDP_UNAVAILABLE\]/);
  assert.equal(notes[0].type, "error");
});

function isCode(error: unknown, code: string): boolean {
  return error instanceof WebSearchError && error.details.code === code;
}

function fakeArtifacts(): {
  save: () => Promise<string>;
  prune: () => Promise<{ removed: number; kept: number; bytes: number }>;
  size: () => Promise<number>;
  root: () => string;
} {
  return {
    save: async () => {
      throw fail("E_CONFIG", "config", { message: "the doctor never writes artifacts" });
    },
    prune: async () => ({ removed: 2, kept: 3, bytes: 100 }),
    size: async () => 4096,
    root: () => "/home/tester/.pi/agent/web-search/artifacts",
  };
}
