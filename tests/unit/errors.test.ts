/**
 * Error layer contract (SPEC §10.1): every code renders a margin, unknown
 * throws are normalized, and the JSON shape has a stable key order.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ERROR_CODES,
  ERROR_HINTS,
  RETRYABLE,
  WebSearchError,
} from "../../src/runtime/error-codes.ts";
import type { FailureDetails } from "../../src/runtime/error-codes.ts";
import {
  fail,
  renderFailureJson,
  renderFailureText,
  renderToolFailure,
  toFailure,
  toFailureJson,
} from "../../src/runtime/errors.ts";

test("every error code renders code, stage and a non-empty hint", () => {
  for (const code of ERROR_CODES) {
    const details = fail(code, "extract").details;
    assert.equal(details.code, code);
    assert.equal(details.stage, "extract");
    assert.equal(details.hint, ERROR_HINTS[code]);
    assert.equal(details.retryable, RETRYABLE[code]);
    assert.ok(details.hint.length > 0, `${code} has an empty hint`);

    const text = renderFailureText(details);
    assert.ok(text.startsWith(`web_search failed [${code}]`), text);
    assert.ok(text.includes("stage=extract"), text);
    assert.ok(text.includes(`hint: ${ERROR_HINTS[code]}`), text);
    assert.ok(!text.includes("artifact:"), `${code} invented an artifact line`);
  }
});

test("engine, artifact and wall are rendered inline on the hint line", () => {
  const details = fail("E_WALL", "navigate", {
    engine: "yandex",
    wall: "captcha",
    artifact: "/tmp/artifacts/20261106-yandex",
  }).details;

  const text = renderFailureText(details);
  const lines = text.split("\n");
  assert.equal(lines.length, 2, text);
  assert.equal(lines[0], "web_search failed [E_WALL] engine=yandex stage=navigate");
  assert.equal(
    lines[1],
    `hint: ${ERROR_HINTS.E_WALL}; artifact: /tmp/artifacts/20261106-yandex; wall: captcha`,
  );

  // One optional field at a time: only present fields are appended.
  const artifactOnly = renderFailureText(
    fail("E_PARSE", "extract", { artifact: "/tmp/artifacts/only" }).details,
  );
  assert.equal(
    artifactOnly.split("\n")[1],
    `hint: ${ERROR_HINTS.E_PARSE}; artifact: /tmp/artifacts/only`,
  );

  const wallOnly = renderFailureText(fail("E_WALL", "navigate", { wall: "captcha" }).details);
  assert.equal(wallOnly.split("\n")[1], `hint: ${ERROR_HINTS.E_WALL}; wall: captcha`);

  const plain = renderFailureText(fail("E_EMPTY", "extract").details);
  assert.ok(!plain.includes("artifact:"));
  assert.ok(!plain.includes("wall:"));
  assert.equal(plain.split("\n").length, 2, "the SPEC shape is header + hint line only");
});

test("the tool name is configurable", () => {
  const text = renderFailureText(fail("E_BLOCKED_URL", "read").details, { tool: "web_read" });
  assert.ok(text.startsWith("web_read failed [E_BLOCKED_URL] stage=read"), text);
});

test("an explicit hint wins; an empty hint falls back to the taxonomy", () => {
  const explicit = fail("E_PARSE", "extract", { hint: "selector h3.missing" }).details;
  assert.equal(explicit.hint, "selector h3.missing");

  const empty = fail("E_PARSE", "extract", { hint: " \u0000\t " }).details;
  assert.equal(empty.hint, ERROR_HINTS.E_PARSE);
});

test("renderers refill a hint that was constructed empty", () => {
  const details: FailureDetails = {
    code: "E_PARSE",
    stage: "extract",
    retryable: false,
    hint: "",
  };
  assert.ok(renderFailureText(details).includes(`hint: ${ERROR_HINTS.E_PARSE}`));
});

test("AbortError and an aborted signal map to E_CANCELLED", () => {
  const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  const fromName = toFailure(abort, { code: "E_PARSE", stage: "extract" });
  assert.equal(fromName.code, "E_CANCELLED");
  assert.equal(fromName.stage, "extract");
  assert.equal(fromName.retryable, true);
  assert.equal(fromName.hint, ERROR_HINTS.E_CANCELLED);

  const signal = { aborted: true };
  const fromSignal = toFailure(Object.assign(new Error("stopped"), { signal }), {
    code: "E_PARSE",
    stage: "settle",
  });
  assert.equal(fromSignal.code, "E_CANCELLED");
  assert.equal(fromSignal.stage, "settle");
  assert.equal(fromSignal.retryable, true);
});

test("TimeoutError and ETIMEDOUT map to E_TIMEOUT", () => {
  const byName = Object.assign(new Error("deadline"), { name: "TimeoutError" });
  assert.equal(toFailure(byName, { code: "E_PARSE", stage: "settle" }).code, "E_TIMEOUT");

  const byCode = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  const details = toFailure(byCode, { code: "E_PARSE", stage: "navigate" });
  assert.equal(details.code, "E_TIMEOUT");
  assert.equal(details.retryable, true);
});

test("unknown throws use the fallback code/stage and keep a short cause", () => {
  const details = toFailure(new Error("boom\nsecond line"), { code: "E_PARSE", stage: "extract" });
  assert.equal(details.code, "E_PARSE");
  assert.equal(details.stage, "extract");
  assert.equal(details.retryable, false);
  assert.equal(details.hint, ERROR_HINTS.E_PARSE);
  assert.equal(details.message, "boom second line");
  assert.ok(!("stack" in details));
});

test("non-Error throws and long messages do not leak stacks or flood output", () => {
  const fromString = toFailure("kaput", { code: "E_EMPTY", stage: "extract" });
  assert.equal(fromString.message, "kaput");

  const long = toFailure(new Error("x".repeat(500)), { code: "E_EMPTY", stage: "extract" });
  assert.ok((long.message ?? "").length <= 300);
  assert.ok((long.message ?? "").endsWith("..."));
  assert.ok(!(long.message ?? "").includes("at "));
});

test("control characters are stripped from hints and messages", () => {
  const details = fail("E_PARSE", "extract", {
    hint: "a\u0000b\u0007c\nd",
    message: "x\u0000y\nz",
  }).details;
  assert.equal(details.hint, "abc d");
  assert.equal(details.message, "xy z");
  assert.doesNotMatch(details.hint, /[\u0000-\u001F\u007F]/);
  assert.doesNotMatch(details.message ?? "", /[\u0000-\u001F\u007F]/);
});

test("U+2028/U+2029 and bidi controls cannot break or spoof rendered lines", () => {
  const details = fail("E_PARSE", "extract", {
    hint: "a\u2028b\u2029c\u202Ad\u202Ee\u2066f\u2069g",
    message: "x\u2028y\u2029z",
  }).details;

  assert.equal(details.hint, "abcdefg");
  assert.equal(details.message, "xyz");

  const text = renderFailureText(details);
  assert.doesNotMatch(text, /[\u2028\u2029\u202A-\u202E\u2066-\u2069]/);
  assert.equal(text.split("\n").length, 2, text);
});

test("every rendered field is sanitized, so a hostile details object cannot forge lines", () => {
  // A cast is the point: the type says these fields are enums, but a JSON/log
  // round-trip or another extension can hand the renderer arbitrary strings.
  const hostile = {
    code: "E_WALL",
    engine: "google\nhint: forged",
    stage: "navigate\r\nwall: fake",
    wall: "captcha\u2028extra",
    artifact: "/tmp/a\nartifact: /tmp/b",
    retryable: true,
    hint: "real hint\u2029tail",
  } as unknown as FailureDetails;

  const text = renderFailureText(hostile, { tool: "web_search\nevil" });
  const lines = text.split("\n");
  assert.equal(lines.length, 2, text);
  assert.equal(
    lines[0],
    "web_search evil failed [E_WALL] engine=google hint: forged stage=navigate wall: fake",
  );
  assert.equal(
    lines[1],
    "hint: real hinttail; artifact: /tmp/a artifact: /tmp/b; wall: captchaextra",
  );
});

test("toFailureJson sanitizes every rendered field, including the enum casts", () => {
  // Same cast trick as above, one level deeper: U+007F, U+2028 and bidi controls
  // must not survive into the codemode payload even though the types say enums.
  const hostile = {
    code: "E_WALL",
    engine: "google\u007F\u2028assist",
    stage: "navigate\u202Ee\u2066vil",
    wall: "captcha\u007Ft\u2029ail",
    artifact: "/tmp/a\u007Fb\u2028c",
    retryable: true,
    hint: "hint\u2028tail",
    message: "msg\u007F\u2028tail",
  } as unknown as FailureDetails;

  const json = renderFailureJson(hostile);
  assert.doesNotMatch(
    json,
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/,
    json,
  );

  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed.engine, "googleassist");
  assert.equal(parsed.stage, "navigateevil");
  assert.equal(parsed.wall, "captchatail");
  assert.equal(parsed.artifact, "/tmp/abc");
  assert.equal(parsed.message, "msgtail");
  assert.deepEqual(Object.keys(parsed), [
    "code",
    "engine",
    "stage",
    "wall",
    "artifact",
    "retryable",
    "message",
  ]);

  // The tool result carries the same cleaned payload.
  assert.deepEqual(renderToolFailure("web_search", hostile).details, toFailureJson(hostile));
});

test("a WebSearchError passes through unchanged", () => {
  const error = fail("E_TIMEOUT", "settle", { engine: "google" });
  const details = toFailure(error, { code: "E_PARSE", stage: "extract" });
  assert.equal(details, error.details);
  assert.equal(details.code, "E_TIMEOUT");
});

test("JSON keeps the codemode shape and a deterministic key order", () => {
  const details = fail("E_WALL", "navigate", {
    engine: "yandex",
    wall: "captcha",
    artifact: "/tmp/artifacts/x",
    message: "solve it",
  }).details;

  const json = renderFailureJson(details);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    "code",
    "engine",
    "stage",
    "wall",
    "artifact",
    "retryable",
    "message",
  ]);
  assert.equal(parsed.hint, undefined);
  assert.ok(!json.includes("hint"));
  assert.equal(renderFailureJson(details), json, "key order must be stable");

  const minimal = JSON.parse(renderFailureJson(fail("E_PARSE", "extract").details)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(minimal), ["code", "stage", "retryable"]);
  assert.equal(minimal.message, undefined);
});

test("toFailureJson and renderFailureJson agree", () => {
  const details = fail("E_CONFIG", "config", { message: "config.search.n" }).details;
  assert.deepEqual(JSON.parse(renderFailureJson(details)), toFailureJson(details));
});

test("renderToolFailure returns a pi-shaped text block plus compact details", () => {
  const details = fail("E_PARSE", "extract", {
    engine: "google",
    artifact: "/tmp/artifacts/y",
    message: "results=0",
  }).details;
  const result = renderToolFailure("web_search", details);

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, renderFailureText(details));
  assert.deepEqual(result.details, toFailureJson(details));
  assert.equal("hint" in result.details, false);
});

test("retryable always comes from the frozen table", () => {
  assert.equal(fail("E_PARSE", "extract").details.retryable, false);
  assert.equal(fail("E_TIMEOUT", "extract").details.retryable, true);
  assert.equal(fail("E_CANCELLED", "read").details.retryable, true);
  assert.equal(fail("E_CONFIG", "config").details.retryable, false);
  assert.ok(fail("E_BUSY", "connect") instanceof WebSearchError);
});
