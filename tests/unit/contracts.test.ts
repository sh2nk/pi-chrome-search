import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DEFAULT_CONFIG,
  applyEnv,
  loadConfig,
  parseConfig,
  resolveConfigPath,
} from "../../src/config.ts";
import {
  ERROR_CODES,
  ERROR_HINTS,
  RETRYABLE,
  STAGES,
  WebSearchError,
  isErrorCode,
  isWebSearchError,
} from "../../src/runtime/error-codes.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-chrome-search-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function expectConfigError(fn: () => unknown, needle: string): WebSearchError {
  try {
    fn();
  } catch (error) {
    assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
    assert.equal(error.details.code, "E_CONFIG");
    assert.equal(error.details.stage, "config");
    assert.equal(error.details.retryable, false);
    assert.ok(error.details.hint.includes(needle), `hint "${error.details.hint}" lacks "${needle}"`);
    return error;
  }
  assert.fail("expected a thrown E_CONFIG");
}

test("every error code has a hint, a retryable flag and a unique entry", () => {
  const codes = new Set(ERROR_CODES);
  assert.equal(codes.size, ERROR_CODES.length);
  for (const code of ERROR_CODES) {
    const hint = ERROR_HINTS[code];
    assert.equal(typeof hint, "string");
    assert.ok(hint.length >= 10, `${code} hint is too short`);
    assert.equal(typeof RETRYABLE[code], "boolean");
    assert.ok(isErrorCode(code));
  }
  assert.equal(isErrorCode("E_NOT_A_CODE"), false);
  assert.ok(STAGES.includes("extract"));
});

test("WebSearchError carries structured details", () => {
  const error = new WebSearchError({
    code: "E_PARSE",
    engine: "google",
    stage: "extract",
    retryable: false,
    hint: "inspect the artifact",
  });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "WebSearchError");
  assert.equal(error.details.engine, "google");
  assert.match(error.message, /E_PARSE during extract/);
});

test("defaults load when the config file is missing", () => {
  const dir = tempDir();
  const config = loadConfig({ path: join(dir, "absent.json"), env: {} });
  assert.deepEqual(config.engines.google, DEFAULT_CONFIG.engines.google);
  assert.equal(config.mode, "attach");
  assert.equal(config.reflex.enabled, false);
});

test("P14 reflex.pageGate defaults on and parses independently of reflex.enabled", () => {
  assert.equal(DEFAULT_CONFIG.reflex.pageGate, true);
  const off = parseConfig({ reflex: { pageGate: false } });
  assert.equal(off.reflex.pageGate, false);
  assert.equal(off.reflex.enabled, false, "the gate flag must not switch the whole reflex on");
});

test("unknown top-level key is rejected with the key path", () => {
  expectConfigError(() => parseConfig({ nope: 1 }), "config.nope");
});

test("unknown nested key is rejected with the key path", () => {
  expectConfigError(() => parseConfig({ search: { nope: 1 } }), "config.search.nope");
});

test("wrong type is rejected with the key path", () => {
  expectConfigError(() => parseConfig({ search: { n: "5" } }), "config.search.n");
  expectConfigError(() => parseConfig({ debug: "yes" }), "config.debug");
});

test("partial config merges over defaults", () => {
  const config = parseConfig({ search: { n: 8 }, engines: { yandex: { enabled: false } } });
  assert.equal(config.search.n, 8);
  assert.equal(config.search.nMax, DEFAULT_CONFIG.search.nMax);
  assert.equal(config.engines.yandex.enabled, false);
  assert.equal(config.engines.google.enabled, true);
});

test("cross-field constraints are enforced", () => {
  expectConfigError(() => parseConfig({ search: { n: 9, nMax: 5 } }), "config.search.n");
  expectConfigError(() => parseConfig({ search: { nMax: 11 } }), "config.search.nMax");
  expectConfigError(
    () => parseConfig({ pacing: { google: [9000, 1000] } }),
    "config.pacing.google",
  );
  expectConfigError(
    () => parseConfig({ read: { defaultMaxChars: 30000 } }),
    "config.read.defaultMaxChars",
  );
  expectConfigError(
    () =>
      parseConfig({
        engines: {
          google: { enabled: false },
          duckduckgo: { enabled: false },
          yandex: { enabled: false },
        },
      }),
    "at least one engine",
  );
});

test("malformed JSON is E_CONFIG and names the file", () => {
  const file = join(tempDir(), "web-search.json");
  writeFileSync(file, "{ not json", "utf8");
  expectConfigError(() => loadConfig({ path: file, env: {} }), file);
});

test("env overrides apply without touching the file", () => {
  const config = loadConfig({
    path: join(tempDir(), "absent.json"),
    env: {
      PI_CHROME_CDP_WS: "ws://127.0.0.1:9333/devtools/browser/abc",
      PI_CHROME_CDP_PORTS: "9222, 9333",
      PI_CHROME_SEARCH_DEBUG: "1",
      PI_CHROME_SEARCH_PROFILE: "/tmp/pi-chrome-search-profile",
    },
  });
  assert.equal(config.cdp.ws, "ws://127.0.0.1:9333/devtools/browser/abc");
  assert.deepEqual(config.cdp.ports, [9222, 9333]);
  assert.equal(config.debug, true);
  assert.equal(config.cdp.profileDir, "/tmp/pi-chrome-search-profile");
});

test("invalid env values are E_CONFIG", () => {
  expectConfigError(() => applyEnv(DEFAULT_CONFIG, { PI_CHROME_CDP_PORTS: "9222,abc" }), "PI_CHROME_CDP_PORTS");
  expectConfigError(() => applyEnv(DEFAULT_CONFIG, { PI_CHROME_CDP_WS: "http://localhost" }), "PI_CHROME_CDP_WS");
});

test("config path honours PI_CODING_AGENT_DIR", () => {
  assert.equal(
    resolveConfigPath({ PI_CODING_AGENT_DIR: "/tmp/agentdir" }),
    "/tmp/agentdir/web-search.json",
  );
  assert.match(resolveConfigPath({}), /\.pi\/agent\/web-search\.json$/);
});

// ---------------------------------------------------------------------------
// P10 config (additive: panel, follow, idleMs, humanize "typing")
// ---------------------------------------------------------------------------

test("P10 defaults: the panel is on, focus follows the work, hand-back is 1.5 s", () => {
  assert.equal(DEFAULT_CONFIG.window.panel, true);
  assert.equal(DEFAULT_CONFIG.window.follow, "work");
  assert.equal(DEFAULT_CONFIG.window.idleMs, 1500);
  assert.equal(DEFAULT_CONFIG.humanize, "auto", "auto stays the compatibility default");
});

test('P10: humanize "typing" and every follow policy are valid', () => {
  assert.equal(parseConfig({ humanize: "typing" }).humanize, "typing");
  for (const follow of ["work", "anchor", "never"] as const) {
    assert.equal(parseConfig({ window: { follow } }).window.follow, follow);
  }
  assert.equal(parseConfig({ window: { panel: false } }).window.panel, false);
  assert.equal(parseConfig({ window: { idleMs: 0 } }).window.idleMs, 0);
});

test("P10: a bad follow policy or idleMs names the exact config key", () => {
  expectConfigError(() => parseConfig({ window: { follow: "sometimes" } }), "config.window.follow");
  expectConfigError(() => parseConfig({ window: { idleMs: -1 } }), "config.window.idleMs");
  expectConfigError(() => parseConfig({ window: { idleMs: 60_001 } }), "config.window.idleMs");
  expectConfigError(() => parseConfig({ humanize: "keyboard" }), "config.humanize");
});
