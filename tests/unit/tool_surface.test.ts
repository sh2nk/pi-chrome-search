/**
 * Tool surface and reachability (S3).
 *
 * The v1 suite counted `exposure` values on the factory output and declared the
 * surface healthy while four of five tools were unreachable in a stock session.
 * This suite instead drives the real registration function with a fake pi and
 * asks what the model can actually see:
 *
 *  - discovery branch: `web_search` + `web_read` are declared and `tool_search`
 *    is activated by the extension itself;
 *  - fallback branch: without a usable discovery tool every tool is registered
 *    `direct`, so reachability cannot depend on the user editing settings.
 *
 * The prompt budget (S3.3), the generated README table (S13.3) and the registry
 * contract share this file because they all read the same `createTools()` output.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { type Config, DEFAULT_CONFIG } from "../../src/config.ts";
import { DEFAULT_ENGINES, createDefaultRegistry, createEngineRegistry, describeRegistry, registerAdapter } from "../../src/engines/index.ts";
import { ENGINE_IDS, type Engine, type EngineId } from "../../src/engines/types.ts";
import { ensureToolReachability, default as register } from "../../src/index.ts";
import { type WebSearchError, isWebSearchError } from "../../src/runtime/error-codes.ts";
import {
  DEFERRED_TOOL_NAMES,
  DIRECT_TOOL_NAMES,
  DISCOVERY_TOOL_NAME,
  createTools,
} from "../../src/tools/index.ts";
import { README_TOOLS_END, README_TOOLS_START, renderReadmeToolTable } from "../../src/tools/surface.ts";
import { createFakePi } from "../helpers/fake-pi.ts";

// ---------------------------------------------------------------------------
// Shape probe: the factory output, never a dependency resolution
// ---------------------------------------------------------------------------

const TOOLS = createTools({
  getDeps: () => {
    throw new Error("tool_surface: a shape probe must not resolve tool dependencies");
  },
  getDoctorDeps: () => {
    throw new Error("tool_surface: a shape probe must not resolve tool dependencies");
  },
});

const TOOL_NAMES = [...DIRECT_TOOL_NAMES, ...DEFERRED_TOOL_NAMES].sort();

// ---------------------------------------------------------------------------
// Reachability through the registration path (S3.2)
// ---------------------------------------------------------------------------

test("with tool_search the extension activates discovery and keeps only two direct tools", async () => {
  const pi = createFakePi({ withDiscovery: true });
  register(pi as unknown as ExtensionAPI);
  await pi.emit("session_start");

  assert.deepEqual(
    pi.visible(),
    ["web_search", "web_read", DISCOVERY_TOOL_NAME],
    "the model must see both direct tools and the discovery tool",
  );
  assert.equal(
    pi.getActiveTools().includes(DISCOVERY_TOOL_NAME),
    true,
    "the extension must activate tool_search itself (S3.1)",
  );

  const all = pi.getAllTools();
  for (const name of DEFERRED_TOOL_NAMES) {
    const tool = all.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `${name} must be registered in the discovery branch`);
    assert.equal(tool.exposure, "deferred", `${name} must stay deferred, not ${String(tool.exposure)}`);
    assert.equal(pi.getActiveTools().includes(name), false, `${name} must not be declared directly`);
  }
  for (const name of DIRECT_TOOL_NAMES) {
    assert.equal(all.find((tool) => tool.name === name)?.exposure, "direct", `${name} must be direct`);
  }
});

test("without tool_search every tool becomes direct and model-visible", async () => {
  const pi = createFakePi();
  register(pi as unknown as ExtensionAPI);
  await pi.emit("session_start");

  assert.deepEqual(pi.visible().sort(), TOOL_NAMES, "a stock session must expose all five tools");
  for (const tool of pi.getAllTools()) {
    assert.equal(tool.exposure, "direct", `${tool.name} must be promoted in the fallback branch`);
    assert.equal(pi.getActiveTools().includes(tool.name), true, `${tool.name} must be active`);
  }
});

test("a same-named tool without reachesTools is not a discovery tool", async () => {
  const pi = createFakePi();
  pi.registerTool({
    name: DISCOVERY_TOOL_NAME,
    label: DISCOVERY_TOOL_NAME,
    description: "a decoy that cannot reach deferred tools",
    parameters: {},
    exposure: "model-only",
    defaultActive: false,
    execute: async () => ({ content: [], details: {} }),
  } as unknown as ToolDefinition);

  register(pi as unknown as ExtensionAPI);
  await pi.emit("session_start");

  // The decoy stays inactive, and the fallback promotes every real tool instead
  // of pretending deferred tools are findable through it.
  assert.deepEqual(pi.visible().sort(), TOOL_NAMES);
});

test("the canonical surface carries exactly the documented exposures", () => {
  for (const name of DIRECT_TOOL_NAMES) {
    assert.equal(TOOLS.find((tool) => tool.name === name)?.exposure, "direct", `${name} must default to direct`);
  }
  for (const name of DEFERRED_TOOL_NAMES) {
    assert.equal(TOOLS.find((tool) => tool.name === name)?.exposure, "deferred", `${name} must default to deferred`);
  }
});

// The exported helper is the same path `register` uses; prove its two answers
// directly so the branch names cannot drift from the registration behaviour.
test("ensureToolReachability reports which branch it took", async () => {
  const discovery = createFakePi({ withDiscovery: true });
  register(discovery as unknown as ExtensionAPI);
  assert.equal(ensureToolReachability(discovery as unknown as ExtensionAPI, TOOLS), "discovery");

  const fallback = createFakePi();
  assert.equal(ensureToolReachability(fallback as unknown as ExtensionAPI, TOOLS), "direct-fallback");
  await fallback.emit("session_start");
});

// ---------------------------------------------------------------------------
// Prompt budget (S3.3) and discoverability (S3.4)
// ---------------------------------------------------------------------------

const TOTAL_BUDGET = 1200;
const PER_TOOL_BUDGET = 350;
const GUIDELINE_BUDGET = 400;

test("each description fits 350 chars and the total stays under 1200", (t) => {
  const lines: string[] = [];
  let total = 0;
  for (const tool of TOOLS) {
    assert.equal(typeof tool.description, "string", `${tool.name} has no description`);
    assert.equal(tool.description.includes("\n"), false, `${tool.name} description must be one line`);
    assert.ok(tool.description.length > 0, `${tool.name} description must not be empty`);
    assert.ok(
      tool.description.length <= PER_TOOL_BUDGET,
      `${tool.name} description is ${tool.description.length} chars, cap is ${PER_TOOL_BUDGET}`,
    );
    lines.push(`${tool.name} ${tool.description.length}`);
    total += tool.description.length;
  }
  assert.ok(total <= TOTAL_BUDGET, `declared descriptions: ${total}/${TOTAL_BUDGET} chars — ${lines.join(", ")}`);
  t.diagnostic(`tool descriptions: ${total}/${TOTAL_BUDGET} chars`);
});

test("web_search names both direct tools and what they return", () => {
  const search = TOOLS.find((tool) => tool.name === "web_search");
  assert.ok(search !== undefined);
  assert.match(search.description, /web_read/, "the search description must name the read tool");
  assert.match(search.description, /Markdown/, "the search description must say what web_read returns");

  const read = TOOLS.find((tool) => tool.name === "web_read");
  assert.ok(read !== undefined);
  assert.match(read.description, /page/, "web_read must say it reads one page");
  assert.match(read.description, /Markdown|text/, "web_read must say what it returns");
});

test("search operators are taught in prompt guidelines, not another argument", () => {
  const search = TOOLS.find((tool) => tool.name === "web_search");
  assert.ok(search !== undefined);
  const guidelines = "promptGuidelines" in search ? search.promptGuidelines ?? [] : [];
  assert.ok(guidelines.length > 0, "web_search must declare search-operator guidelines (S3.6)");

  const text = guidelines.join(" ");
  assert.ok(text.length <= GUIDELINE_BUDGET, `guidelines are ${text.length} chars, cap is ${GUIDELINE_BUDGET}`);
  for (const operator of ["quoted phrases", "-term", "OR", "site:", "filetype:", "after:", "before:", "date:"]) {
    assert.ok(text.includes(operator), `guidelines must teach ${operator}`);
  }
  const properties = search.parameters.properties ?? {};
  assert.equal(Object.hasOwn(properties, "date"), false, "date narrowing must not become a new argument");
});

// ---------------------------------------------------------------------------
// Generated README table (S13.3 pattern)
// ---------------------------------------------------------------------------

test("README's tool table is generated from the same definitions", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const pattern = new RegExp(`${README_TOOLS_START}[\\s\\S]*?${README_TOOLS_END}`);
  assert.match(readme, pattern, "README must keep the generated tools markers");

  const block = `${README_TOOLS_START}\n${renderReadmeToolTable(TOOLS)}\n${README_TOOLS_END}`;
  assert.equal(
    readme.match(pattern)?.[0],
    block,
    "README tool table drifted; run node scripts/gen-readme.mjs",
  );
});

// ---------------------------------------------------------------------------
// Annotations and callable shape
// ---------------------------------------------------------------------------

test("only genuinely inert tools are declared read-only", () => {
  for (const name of ["web_search", "web_read", "image_search"]) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool !== undefined, `${name} must be registered`);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} must be read-only`);
  }

  const doctor = TOOLS.find((tool) => tool.name === "web_doctor");
  assert.ok(doctor !== undefined, "web_doctor must be registered");
  assert.equal(doctor.annotations.readOnlyHint, false, "web_doctor's fix mutates: not read-only");
  assert.equal(doctor.annotations.openWorldHint, true, "web_doctor talks to the live browser");
});

test("every tool has a callable execute and a parameter schema", () => {
  for (const tool of TOOLS) {
    assert.equal(typeof tool.execute, "function", `${tool.name} must be callable`);
    assert.equal(typeof tool.parameters, "object", `${tool.name} must declare parameters`);
  }
});

test("tool names are unique and provider-safe", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_]*$/);
});

// ---------------------------------------------------------------------------
// Registry fixtures (unchanged contract)
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
    assert.equal(error.details.stage, code === "E_UNSUPPORTED" ? "resolve" : "config");
    assert.equal(error.details.retryable, false);
    assert.ok(error.details.hint.length > 0, "every failure carries an actionable hint");
    return error;
  }
  assert.fail(`expected ${code}, nothing was thrown`);
}

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
  assert.deepEqual(
    registry.select("auto"),
    ENGINE_IDS.filter((id) => DEFAULT_ENGINES[id] !== undefined && config.engines[id].enabled),
  );
});

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
  const registry = createDefaultRegistry(DEFAULT_CONFIG);
  assert.deepEqual(registry.enabled(), ["google", "duckduckgo", "yandex"]);
  for (const id of ENGINE_IDS) {
    assert.equal(registry.has(id), true, `${id} must be registered`);
    assert.equal(registry.get(id).id, id);
  }
});
