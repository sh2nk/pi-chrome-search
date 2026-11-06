/**
 * Tool surface and prompt budget: which five tools exist, which one is direct,
 * and the 900-char total description budget that keeps the prompt cheap.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, DEFAULT_CONFIG } from "../../src/config.ts";
import { DEFAULT_ENGINES, createDefaultRegistry, createEngineRegistry, describeRegistry, registerAdapter } from "../../src/engines/index.ts";
import { ENGINE_IDS, type Engine, type EngineId } from "../../src/engines/types.ts";
import { type WebSearchError, isWebSearchError } from "../../src/runtime/error-codes.ts";
import { createTools } from "../../src/tools/index.ts";

// ---------------------------------------------------------------------------
// from tests/unit/tool_surface.test.ts
// ---------------------------------------------------------------------------
{
/**
 * P4-D: tool surface audit (SPEC §7.1, §7.5, §8; PLAN V4.5).
 *
 * The prompt is the most expensive real estate in the extension. Two rules:
 *
 * 1. exactly one tool is `direct` — `web_search`. Everything else is
 *    `deferred`: findable through tool search and callable from codemode, but
 *    never paid for in every prompt;
 * 2. the declared descriptions together stay under 900 characters
 *    (≈230 tokens), and each one stays under 350.
 *
 * This test reads the real `createTools()` output, so adding a tool without
 * budgeting it fails here rather than in the user's context window.
 */



const TOOLS = createTools({
  getDeps: () => {
    throw new Error("tool_surface: a shape probe must not resolve tool dependencies");
  },
  getDoctorDeps: () => {
    throw new Error("tool_surface: a shape probe must not resolve tool dependencies");
  },
});

const TOTAL_BUDGET = 900;
const DIRECT_BUDGET = 350;
const DEFERRED_BUDGET = 350;

test("exactly one tool is direct and it is web_search", () => {
  const direct = TOOLS.filter((tool) => tool.exposure === "direct");
  assert.equal(direct.length, 1, `expected one direct tool, got ${direct.map((tool) => tool.name).join(",")}`);
  assert.equal(direct[0]?.name, "web_search");
});

test("read, images and doctor are deferred (not paid for in every prompt)", () => {
  for (const name of ["web_read", "image_search", "web_doctor"]) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `${name} must be registered`);
    assert.equal(tool.exposure, "deferred", `${name} must be deferred, not ${String(tool.exposure)}`);
  }
});

test("every declared description fits its budget and the total stays under 900", () => {
  const lines: string[] = [];
  let total = 0;
  for (const tool of TOOLS) {
    assert.equal(typeof tool.description, "string", `${tool.name} has no description`);
    assert.equal(tool.description.includes("\n"), false, `${tool.name} description must be one line`);
    assert.ok(tool.description.length > 0, `${tool.name} description must not be empty`);
    const budget = tool.exposure === "direct" ? DIRECT_BUDGET : DEFERRED_BUDGET;
    assert.ok(
      tool.description.length <= budget,
      `${tool.name} description is ${tool.description.length} chars, cap is ${budget}`,
    );
    lines.push(`${tool.name} ${tool.description.length}`);
    total += tool.description.length;
  }
  assert.ok(total <= TOTAL_BUDGET, `declared descriptions: ${total}/${TOTAL_BUDGET} chars — ${lines.join(", ")}`);
});

test("a deferred tool still exposes a callable execute with a schema", () => {
  for (const tool of TOOLS) {
    assert.equal(typeof tool.execute, "function", `${tool.name} must be callable`);
    assert.equal(typeof tool.parameters, "object", `${tool.name} must declare parameters`);
  }
});

test("only genuinely inert tools are declared read-only", () => {
  // `web_doctor` is deliberately NOT read-only: `fix: true` closes the tabs this
  // connector owns and prunes artifact files, so it mutates the browser and the
  // disk. A caller that batches read-only tools must not get it for free.
  for (const name of ["web_search", "web_read", "image_search"]) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `${name} must be registered`);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} must be read-only`);
  }

  const doctor = TOOLS.find((tool) => tool.name === "web_doctor");
  assert.ok(doctor !== undefined, "web_doctor must be registered");
  assert.equal(doctor.annotations.readOnlyHint, false, "web_doctor's fix mutates: not read-only");
  assert.equal(doctor.annotations.openWorldHint, true, "web_doctor talks to the live browser");
  assert.equal(doctor.annotations.idempotentHint, true, "a repeated web_doctor converges");
});

test("no tool name collides with the core tool names", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_]*$/);
});
}

// ---------------------------------------------------------------------------
// from tests/unit/tool_budget.test.ts
// ---------------------------------------------------------------------------
{
/**
 * P2-E: prompt budget + registry contract (SPEC §7.5, PLAN V2.6, AGENTS.md §2.10).
 *
 * Two independent guarantees live here.
 *
 * 1. Prompt cost. `web_search` is the only `direct` tool bounded at 350 chars;
 *    every declared tool's description is summed and must stay under 900 chars
 *    (≈230 tokens). `TOOL_DESCRIPTIONS` is the extension's whole declared
 *    surface: P4-D appends `web_read` / `image_search` / `web_research` to it
 *    and the same sum applies — there is deliberately no second budget test.
 *
 * 2. Registry contract. `auto` order is canonical (D10), explicit lists keep
 *    caller order, and duplicates/disabled/unregistered ids are dropped. `get`
 *    and `enabled` never hand out an adapter this session may not use, and the
 *    append-only map cannot quietly grow two adapters for one id.
 *
 * Fully offline: no socket, no Chrome, no timers. The tool factory gets a deps
 * getter that throws, so a shape assertion can never silently become a live
 * call (P2-D ships a factory, not a module-level instance — dependency
 * construction belongs to the extension wiring).
 */



// ---------------------------------------------------------------------------
// Tool surface budget
// ---------------------------------------------------------------------------

/** SPEC §7.5: all tool descriptions together cost ≤900 chars of prompt. */
const TOOL_BUDGET_CHARS = 900;

/** PLAN V2.6: `web_search` alone is capped at 350 chars (P2-D contract). */
const WEB_SEARCH_DESCRIPTION_MAX = 350;

const tools = createTools({
  getDeps: () => {
    throw new Error("tool_budget: a shape probe must not resolve tool dependencies");
  },
  getDoctorDeps: () => {
    throw new Error("tool_budget: a shape probe must not resolve tool dependencies");
  },
});
const webSearchTool = tools.find((tool) => tool.name === "web_search");
if (webSearchTool === undefined) throw new Error("tool_budget: web_search is not exported by createTools");

interface DeclaredTool {
  name: string;
  description: string;
  exposure: "direct" | "deferred";
}

/**
 * Every tool the extension declares. P4-D appends the deferred tools here:
 *
 *   { name: "web_read", description: WEB_READ_DESCRIPTION, exposure: "deferred" },
 *   { name: "image_search", ... }, { name: "web_research", ... }
 *
 * The sum below is the gate; keep entries at most one line each.
 */
const TOOL_DESCRIPTIONS: DeclaredTool[] = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  exposure: tool.exposure,
}));

test("web_search is a cheap direct tool with honest annotations", (t) => {
  assert.equal(webSearchTool.name, "web_search");
  assert.equal(webSearchTool.exposure, "direct");
  assert.deepEqual(webSearchTool.annotations, {
    readOnlyHint: true,
    openWorldHint: true,
    idempotentHint: true,
  });

  const description = webSearchTool.description;
  assert.ok(description.length > 0, "the description must not be empty");
  assert.ok(
    description.length <= WEB_SEARCH_DESCRIPTION_MAX,
    `web_search description is ${description.length} chars, cap is ${WEB_SEARCH_DESCRIPTION_MAX}`,
  );
  // A newline turns one description into several prompt lines; the budget is
  // measured in chars, not in layout, so forbid it outright.
  assert.equal(description.includes("\n"), false, "the description must stay one line");

  t.diagnostic(`web_search description: ${description.length}/${WEB_SEARCH_DESCRIPTION_MAX} chars`);
});

test("the declared tool surface fits the 900-char description budget", (t) => {
  assert.ok(TOOL_DESCRIPTIONS.length >= 1, "at least web_search is declared");

  const names = TOOL_DESCRIPTIONS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, `duplicate tool name in ${names.join(", ")}`);

  const total = TOOL_DESCRIPTIONS.reduce((sum, tool) => sum + tool.description.length, 0);
  t.diagnostic(
    `declared tool descriptions: ${total}/${TOOL_BUDGET_CHARS} chars across ${TOOL_DESCRIPTIONS.length} tool(s)`,
  );

  assert.ok(total > 0);
  assert.ok(
    total <= TOOL_BUDGET_CHARS,
    `total description budget is ${total} chars, cap is ${TOOL_BUDGET_CHARS}: ${names.join(", ")}`,
  );
});

test("web_search is the only direct tool today", () => {
  assert.deepEqual(
    TOOL_DESCRIPTIONS.filter((tool) => tool.exposure === "direct").map((tool) => tool.name),
    ["web_search"],
  );
  for (const tool of TOOL_DESCRIPTIONS) {
    if (tool.name === webSearchTool.name) continue;
    assert.equal(tool.exposure, "deferred", `${tool.name} must stay deferred (SPEC §7.5)`);
  }
});

test("the budget list cannot drift from the real web_search shape", () => {
  const declared = TOOL_DESCRIPTIONS.find((tool) => tool.name === webSearchTool.name);
  assert.ok(declared !== undefined, "web_search is missing from TOOL_DESCRIPTIONS");
  assert.equal(declared.description, webSearchTool.description);
  assert.equal(declared.exposure, webSearchTool.exposure);
});

// ---------------------------------------------------------------------------
// Registry fixtures
// ---------------------------------------------------------------------------

function stubEngine(id: EngineId): Engine {
  return {
    id,
    buildUrl: (query) => `https://${id}.example.test/search?q=${encodeURIComponent(query.text)}`,
    async settle() {},
    async detectWall() {
      return null;
    },
    async extract(_page, query) {
      return { engine: id, query: query.text, results: [], pageCarried: false, timings: {} };
    },
    async canaries() {
      return {};
    },
  };
}

function configWith(disabled: readonly EngineId[] = []): Config {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  for (const id of disabled) config.engines[id].enabled = false;
  return config;
}

function allEngines(): Record<EngineId, Engine> {
  return {
    google: stubEngine("google"),
    duckduckgo: stubEngine("duckduckgo"),
    yandex: stubEngine("yandex"),
  };
}

function expectError(fn: () => unknown, code: "E_UNSUPPORTED" | "E_CONFIG"): WebSearchError {
  try {
    fn();
  } catch (error) {
    assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
    assert.equal(error.details.code, code);
    // Registry misses are a resolution failure; a duplicate wiring entry is config.
    assert.equal(error.details.stage, code === "E_UNSUPPORTED" ? "resolve" : "config");
    assert.equal(error.details.retryable, false);
    assert.ok(error.details.hint.length > 0, "every failure carries an actionable hint");
    return error;
  }
  assert.fail(`expected ${code}, nothing was thrown`);
}

// ---------------------------------------------------------------------------
// Selection (D9/D10)
// ---------------------------------------------------------------------------

test("auto keeps the canonical order regardless of map insertion order", () => {
  const registry = createEngineRegistry(
    { yandex: stubEngine("yandex"), google: stubEngine("google"), duckduckgo: stubEngine("duckduckgo") },
    configWith(),
  );
  assert.deepEqual(registry.select("auto"), ["google", "duckduckgo", "yandex"]);
  assert.deepEqual(registry.enabled(), ["google", "duckduckgo", "yandex"]);
});

test("an explicit selection keeps the caller's order", () => {
  const registry = createEngineRegistry(allEngines(), configWith());
  assert.deepEqual(registry.select(["yandex", "google"]), ["yandex", "google"]);
  assert.deepEqual(registry.select("duckduckgo"), ["duckduckgo"]);
});

test("duplicate ids are deduped, keeping the first position", () => {
  const registry = createEngineRegistry(allEngines(), configWith());
  assert.deepEqual(registry.select(["google", "yandex", "google"]), ["google", "yandex"]);
});

test("disabled engines are dropped from auto and from explicit lists", () => {
  const registry = createEngineRegistry(allEngines(), configWith(["duckduckgo", "yandex"]));

  assert.deepEqual(registry.select("auto"), ["google"]);
  assert.deepEqual(registry.select(["yandex", "google", "duckduckgo"]), ["google"]);
  // Registered but not usable: `has` is the wiring fact, not the tool answer.
  assert.equal(registry.has("yandex"), true);
  expectError(() => registry.get("yandex"), "E_UNSUPPORTED");
});

test("engines without an adapter are dropped, not fatal", () => {
  const registry = createEngineRegistry({ google: stubEngine("google") }, configWith());

  assert.deepEqual(registry.select("auto"), ["google"]);
  assert.deepEqual(registry.select(["yandex", "google"]), ["google"]);
  assert.deepEqual(registry.enabled(), ["google"]);
  assert.equal(registry.has("yandex"), false);
});

test("select returns a fresh array (callers cannot poison the registry)", () => {
  const registry = createEngineRegistry(allEngines(), configWith());
  const first = registry.select("auto");
  first.length = 0;
  assert.deepEqual(registry.select("auto"), ["google", "duckduckgo", "yandex"]);
});

test("get on a missing adapter is E_UNSUPPORTED with a doctor hint", () => {
  const registry = createEngineRegistry({ google: stubEngine("google") }, configWith());
  const error = expectError(() => registry.get("yandex"), "E_UNSUPPORTED");

  assert.equal(error.details.engine, "yandex");
  assert.match(error.details.message ?? "", /not registered/);
  assert.match(error.details.hint, /web-doctor/);
});

test("get on a disabled adapter is E_UNSUPPORTED naming the config key", () => {
  const registry = createEngineRegistry(allEngines(), configWith(["yandex"]));
  const error = expectError(() => registry.get("yandex"), "E_UNSUPPORTED");

  assert.equal(error.details.engine, "yandex");
  assert.match(error.details.hint, /config\.engines\.yandex\.enabled/);
});

// ---------------------------------------------------------------------------
// Append-only map and the production registry
// ---------------------------------------------------------------------------

test("registerAdapter appends to a copy and never mutates its input", () => {
  const base = { google: stubEngine("google") };
  const extended = registerAdapter(base, stubEngine("duckduckgo"));

  assert.notEqual(extended, base);
  assert.deepEqual(Object.keys(base), ["google"]);
  assert.equal(extended.duckduckgo?.id, "duckduckgo");
  assert.equal(extended.google, base.google);
});

test("registerAdapter tolerates the same adapter and rejects a second one", () => {
  const google = stubEngine("google");
  const base = { google };

  const again = registerAdapter(base, google);
  assert.notEqual(again, base);
  assert.equal(again.google, google);

  const error = expectError(() => registerAdapter(base, stubEngine("google")), "E_CONFIG");
  assert.equal(error.details.engine, "google");
  assert.match(error.details.hint, /append-only/);
});

test("DEFAULT_ENGINES is frozen and drives createDefaultRegistry", () => {
  assert.equal(Object.isFrozen(DEFAULT_ENGINES), true);

  const config = configWith();
  const registry = createDefaultRegistry(config);

  for (const id of ENGINE_IDS) {
    assert.equal(registry.has(id), DEFAULT_ENGINES[id] !== undefined, `has(${id}) must mirror the map`);
  }
  // Survives the P3 one-line append: the default registry must expose exactly
  // the registered, config-enabled adapters in canonical order.
  assert.deepEqual(
    registry.select("auto"),
    ENGINE_IDS.filter((id) => DEFAULT_ENGINES[id] !== undefined && config.engines[id].enabled),
  );
});

// ---------------------------------------------------------------------------
// Doctor snapshot
// ---------------------------------------------------------------------------

test("describeRegistry reports canonical status without conflating the two causes", () => {
  const config = configWith(["yandex"]);
  const registry = createEngineRegistry({ google: stubEngine("google") }, config);
  const status = describeRegistry(registry, config);

  assert.deepEqual(
    status.engines.map((engine) => engine.id),
    ["google", "duckduckgo", "yandex"],
  );
  assert.deepEqual(status.engines[0], {
    id: "google",
    registered: true,
    configEnabled: true,
    available: true,
  });
  // No adapter yet (P3) vs disabled in config: different fixes, different rows.
  assert.deepEqual(status.engines[1], {
    id: "duckduckgo",
    registered: false,
    configEnabled: true,
    available: false,
  });
  assert.deepEqual(status.engines[2], {
    id: "yandex",
    registered: false,
    configEnabled: false,
    available: false,
  });

  assert.deepEqual(status.auto, ["google"]);
  assert.equal(status.ready, 1);
  assert.equal(status.total, ENGINE_IDS.length);
});

test("describeRegistry without a config reports registered-only availability", () => {
  const registry = createEngineRegistry({ yandex: stubEngine("yandex") }, configWith());
  const status = describeRegistry(registry);

  for (const engine of status.engines) {
    assert.equal(engine.configEnabled, null);
    assert.equal(engine.available, engine.registered);
  }
  assert.deepEqual(status.auto, ["yandex"]);
  assert.equal(status.ready, 1);
});

test("the shipped registry wires all three adapters in canonical order", () => {
  // P3 adds one line per adapter to DEFAULT_ENGINES. The CLI doctor and the
  // extension both read this map, so a missing line silently turns a working
  // engine into "unavailable" — exactly what happened to the doctor CLI before
  // it stopped building an empty registry.
  const registry = createDefaultRegistry(DEFAULT_CONFIG);
  assert.deepEqual(registry.enabled(), ["google", "duckduckgo", "yandex"]);
  for (const id of ENGINE_IDS) {
    assert.equal(registry.has(id), true, `${id} must be registered`);
    assert.equal(registry.get(id).id, id);
  }
});
}
