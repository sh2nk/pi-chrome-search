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

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTools } from "../../src/tools/index.ts";

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
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be read-only`);
  }
});

test("no tool name collides with the core tool names", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_]*$/);
});
