/**
 * SPEC S6.3/A5: `web_doctor` and the CLI are one report builder, and
 * `node src/cli/doctor.ts --json` matches a schema file that really exists.
 *
 * Everything here is offline: an injected session, an injected probe, a fixed
 * clock and in-memory cache/artifacts. The schema is validated by the same
 * script the gate command pipes into, so the suite and the documented command
 * cannot drift.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { BrowserInfo, CdpEndpoint } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import { createDefaultRegistry } from "../../src/engines/index.ts";
import { parseDoctorArgs, runDoctorCli, type DoctorCliDeps } from "../../src/cli/doctor.ts";
import type { Session, SessionInfo } from "../../src/session/index.ts";
import { buildDoctorReport } from "../../src/runtime/doctor.ts";
import type { DoctorDeps } from "../../src/runtime/doctor.ts";
import { createWebDoctorTool } from "../../src/tools/web_doctor.ts";
import type { Artifacts } from "../../src/runtime/types.ts";
import { FakeClock } from "../helpers/fake-cdp.ts";
// The validator is a plain .mjs script on purpose: the gate runs it as a pipe.
import { SCHEMA_PATH, loadSchema, validate } from "../../scripts/validate-doctor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

/**
 * Only the three methods the doctor's CDP section reads. The cast is deliberate:
 * a full `Session` would fake tab ownership this test never exercises.
 */
interface SessionCalls {
  release: number;
}

function fakeSession(calls: SessionCalls = { release: 0 }): Session {
  const info: SessionInfo = {
    state: "ready",
    endpoint: FAKE_ENDPOINT,
    browser: FAKE_BROWSER,
    webdriver: false,
    windowId: 42,
    ownedTargets: [],
    focusedOnce: [],
    windowDegraded: false,
    locked: true,
  };
  return {
    isConnected: () => true,
    info: () => info,
    lockPath: () => "/tmp/pi-chrome-search-test/doctor.lock",
    releaseAll: async () => {
      calls.release += 1;
    },
  } as unknown as Session;
}

function stubArtifacts(): Artifacts {
  return {
    async save() {
      throw new Error("the doctor must not save an artifact");
    },
    async prune() {
      return { removed: 0, kept: 0, bytes: 0 };
    },
    async size() {
      return 1024;
    },
    root: () => "/tmp/pi-chrome-search-test/artifacts",
  };
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  report: unknown;
}

async function runCli(argv: readonly string[], overrides: DoctorCliDeps = {}): Promise<CliRun> {
  const clock = new FakeClock();
  const config: Config = structuredClone(DEFAULT_CONFIG);
  const stdout: string[] = [];
  const errors: string[] = [];
  const deps: DoctorCliDeps = {
    env: { PI_CODING_AGENT_DIR: "/tmp/pi-chrome-search-test" },
    clock,
    loadConfig: () => config,
    connector: fakeSession(),
    registry: createDefaultRegistry(config),
    artifacts: stubArtifacts(),
    limiter: { async acquire() {}, stats: (engine) => ({ engine, lastAt: null, today: 0 }) },
    write: (text) => stdout.push(text),
    writeError: (text) => errors.push(text),
    isTTY: false,
    ...overrides,
  };
  const code = await runDoctorCli(argv, deps);
  return { code, stdout: stdout.join(""), stderr: errors.join(""), report: parseJson(stdout.join("")) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function assertMatches(report: unknown): void {
  const errors = validate(loadSchema(), report) as string[];
  assert.deepEqual(errors, [], `schema violations:\n${errors.join("\n")}`);
}

// ---------------------------------------------------------------------------
// The schema file
// ---------------------------------------------------------------------------

test("S6.3: the usage text names a schema file that exists", async () => {
  const run = await runCli(["--help"]);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /tests\/fixtures\/doctor\.schema\.json/);
  assert.equal(existsSync(SCHEMA_PATH), true, `${SCHEMA_PATH} must exist`);
  assert.equal(SCHEMA_PATH, join(ROOT, "tests/fixtures/doctor.schema.json"));
});

test("S6.3: the schema is a draft-07 object schema with required keys", () => {
  const schema = loadSchema();
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.ok(Array.isArray(schema.required) && schema.required.includes("verdict"));
  assert.ok(validate(schema, {}).length > 0, "an empty document must not validate");
});

test("S6.3: the validator rejects unknown keys and missing required ones", () => {
  const schema = loadSchema();
  const report = { verdict: "ok" };
  const missing = validate(schema, report) as string[];
  assert.ok(missing.some((error) => error.includes("missing required key")), missing.join("\n"));

  const extra = validate(schema, { ...report, phantom: true }) as string[];
  assert.ok(extra.some((error) => error.includes("additional property")), extra.join("\n"));
});

// ---------------------------------------------------------------------------
// The CLI output
// ---------------------------------------------------------------------------

test("S6.3: --json --no-probe prints a schema-valid report and exits 0", async () => {
  const run = await runCli(["--json", "--no-probe"]);
  assert.equal(run.code, 0, run.stderr);
  assertMatches(run.report);

  const report = run.report as Record<string, unknown>;
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.verdict, "degraded", "probes were skipped, so the doctor is not healthy");
  assert.equal((report.cdp as Record<string, unknown>).status, "ok");
  const engines = report.engines as Array<Record<string, unknown>>;
  assert.equal(engines.length, 3);
  for (const engine of engines) assert.equal(engine.verdict, "skipped");
  assert.equal(run.stderr, "", "a JSON run keeps stdout parseable and stderr quiet");
});

test("S6.3: a probed report carries wall/canary/error shapes the schema allows", async () => {
  const run = await runCli(["--json"], {
    probe: async (id) => {
      if (id === "google") return { ms: 1200, results: 2, ai: true, canaries: { results: 2, ai: 1 } };
      if (id === "yandex") return { ms: 3000, results: 0, ai: false, wall: "captcha" };
      return { ms: 40, results: 0, ai: false, error: { code: "E_PARSE", stage: "extract", hint: "canary failed" } };
    },
  });
  assert.equal(run.code, 0, run.stderr);
  assertMatches(run.report);

  const engines = (run.report as Record<string, unknown>).engines as Array<Record<string, unknown>>;
  assert.deepEqual(
    engines.map((engine) => engine.verdict),
    ["ok", "layout_changed", "wall"],
  );
});

test("S6.3: --no-probe without a session still returns a schema-valid report", async () => {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  const report = await buildDoctorReport(
    {
      config,
      configPath: "/tmp/pi-chrome-search-test/web-search.json",
      registry: createDefaultRegistry(config),
      clock: new FakeClock(),
      artifacts: stubArtifacts(),
      env: { PI_CODING_AGENT_DIR: "/tmp/pi-chrome-search-test" },
    },
    { probe: false },
  );
  assertMatches(report);
  assert.equal(report.cdp.status, "unavailable");
  assert.equal(report.cdp.error?.code, "E_CDP_UNAVAILABLE");
  assert.equal(report.verdict, "blocked");
});

// ---------------------------------------------------------------------------
// Arguments and fix
// ---------------------------------------------------------------------------

test("S6.3: probe defaults on, fix defaults off, unknown flags are E_CONFIG", async () => {
  assert.deepEqual(parseDoctorArgs([]), { json: false, probe: true, fix: false, watch: false, help: false });
  assert.equal(parseDoctorArgs(["--fix"]).fix, true);
  assert.equal(parseDoctorArgs(["--no-probe"]).probe, false);

  const run = await runCli(["--json", "--nonsense"]);
  assert.equal(run.code, 2);
  assert.equal((run.report as Record<string, unknown>).code, "E_CONFIG");
});

test("S6.3: fix reports actions on stderr and re-probes, so stdout stays schema-valid", async () => {
  const probeCalls: string[] = [];
  const run = await runCli(["--json", "--fix"], {
    // Nothing is stale or owned: the safe set is a no-op here, but the call is
    // still allowed and the report must describe the post-fix state.
    probe: async (id) => {
      probeCalls.push(id);
      return { ms: 10, results: 1, ai: false };
    },
  });
  assert.equal(run.code, 0, run.stderr);
  assertMatches(run.report);
  assert.deepEqual(probeCalls, ["google", "duckduckgo", "yandex"], "fix re-probes every engine");
});


// ---------------------------------------------------------------------------
// The deferred tool shares the report builder
// ---------------------------------------------------------------------------

function doctorDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  return {
    config,
    configPath: "/tmp/pi-chrome-search-test/web-search.json",
    connector: fakeSession(),
    registry: createDefaultRegistry(config),
    cache: { get: () => undefined, set: () => {}, size: () => 0, clear: () => {} },
    artifacts: stubArtifacts(),
    clock: new FakeClock(),
    probe: async () => ({ ms: 25, results: 1, ai: false }),
    env: { PI_CODING_AGENT_DIR: "/tmp/pi-chrome-search-test" },
    ...overrides,
  };
}

test("S6.3: web_doctor returns compact text plus the report sections, not the whole JSON", async () => {
  const tool = createWebDoctorTool(() => doctorDeps());
  const result = await tool.execute("call-1", { probe: true, fix: false }, undefined, undefined);

  assert.equal("isError" in result, false);
  if ("isError" in result) return;

  assert.equal(result.details.verdict, "ok");
  assert.equal(result.details.cdp.status, "ok");
  assert.equal(result.details.engines.length, 3);
  const text = result.content.map((block) => block.text).join("\n");
  assert.match(text, /^web_doctor: ok — cdp ok/m);
  assert.match(text, /^ {2}google ok \(1 results, ai=no, 25ms\)$/m);
  assert.equal(text.includes('"schemaVersion"'), false, "the full report stays in the CLI");
});

test("S6.3: web_doctor fix runs the safe set and then re-probes", async () => {
  const calls: SessionCalls = { release: 0 };
  const probed: string[] = [];
  const tool = createWebDoctorTool(() =>
    doctorDeps({
      connector: fakeSession(calls),
      probe: async (id) => {
        probed.push(id);
        return { ms: 5, results: 1, ai: false };
      },
    }),
  );

  const result = await tool.execute("call-1", { probe: false, fix: true }, undefined, undefined);
  assert.equal("isError" in result, false);
  assert.equal(calls.release, 1, "fix released only the session's own state");
  assert.deepEqual(probed, ["google", "duckduckgo", "yandex"], "a fix re-probes the repaired session");
});

test("S6.3: web_doctor rejects non-boolean arguments as E_CONFIG", async () => {
  const tool = createWebDoctorTool(() => doctorDeps());
  const result = await tool.execute(
    "call-1",
    { probe: "yes" } as unknown as { probe: boolean },
    undefined,
    undefined,
  );

  assert.equal("isError" in result, true);
  if (!("isError" in result)) return;
  assert.equal(result.details.code, "E_CONFIG");
  const text = result.content.map((block) => block.text).join("\n");
  assert.match(text, /web_doctor arguments/);
});
