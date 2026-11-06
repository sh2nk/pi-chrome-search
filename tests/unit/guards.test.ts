/**
 * Runtime guards: the error taxonomy and its rendering, the SSRF guard and the
 * URL/`/goto` rules.
 *
 * These are the checks that keep a failure diagnosable and keep `web_read` from
 * being talked into localhost, a private range, `file:` or `data:`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { domainOf, isGoogleHost, isHttpUrl, isTrackingParam, normalizeUrl, parseLink, stableQueryKey, stripTrackingParams } from "../../src/extract/urls.ts";
import { ERROR_CODES, ERROR_HINTS, type FailureDetails, RETRYABLE, WebSearchError, isWebSearchError } from "../../src/runtime/error-codes.ts";
import { fail, renderFailureJson, renderFailureText, renderToolFailure, toFailure, toFailureJson } from "../../src/runtime/errors.ts";
import { type ResolveHost, assertPublicUrl, isPublicAddress } from "../../src/runtime/ssrf.ts";

// ---------------------------------------------------------------------------
// from tests/unit/errors.test.ts
// ---------------------------------------------------------------------------
{
/**
 * Error layer contract (SPEC §10.1): every code renders a margin, unknown
 * throws are normalized, and the JSON shape has a stable key order.
 */



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
}

// ---------------------------------------------------------------------------
// from tests/unit/ssrf.test.ts
// ---------------------------------------------------------------------------
{
/**
 * P4-A unit tests: the SSRF guard (SPEC §7.2, PLAN V4.1).
 *
 * Offline by construction: every hostname goes through an injected resolver.
 * The matrix covers each blocked IPv4/IPv6 family, the boundary just outside
 * it, DNS answers where only one address is private, URL credentials (which
 * must never be echoed), non-http(s) schemes, unicode hosts and the second
 * guard pass a redirect triggers.
 */



const PUBLIC = "93.184.216.34";

function resolverFor(map: Readonly<Record<string, readonly string[]>> = {}): {
  resolve: ResolveHost;
  calls: string[];
} {
  const calls: string[] = [];
  const resolve: ResolveHost = async (host) => {
    calls.push(host);
    return map[host] ?? [PUBLIC];
  };
  return { resolve, calls };
}

/** Await one expected E_BLOCKED_URL and return its details, or fail the test. */
async function expectBlocked(
  url: string,
  opts: { resolve?: ResolveHost } = {},
): Promise<FailureDetails> {
  try {
    await assertPublicUrl(url, opts);
  } catch (error) {
    if (!isWebSearchError(error)) {
      assert.fail(`expected a WebSearchError, got ${String(error)}`);
    }
    assert.equal(error.details.code, "E_BLOCKED_URL");
    assert.equal(error.details.stage, "read");
    assert.ok(error.details.hint.length > 0, "a blocked URL must carry an actionable hint");
    return error.details;
  }
  assert.fail(`expected ${JSON.stringify(url)} to be blocked`);
}

// ---------------------------------------------------------------------------
// IPv4 matrix
// ---------------------------------------------------------------------------

test("isPublicAddress rejects every private/special-use IPv4 block", () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.169.254",
    "169.254.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "239.255.255.255",
  ];
  for (const address of blocked) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("isPublicAddress accepts addresses just outside those blocks", () => {
  const publicAddresses = [
    "8.8.8.8",
    "1.1.1.1",
    PUBLIC,
    "192.0.2.10",
    "203.0.113.7",
    "172.15.255.255",
    "172.32.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "223.255.255.255",
  ];
  for (const address of publicAddresses) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

// ---------------------------------------------------------------------------
// IPv6 matrix
// ---------------------------------------------------------------------------

test("isPublicAddress rejects loopback, unspecified, ULA, link-local and mapped private forms", () => {
  const blocked = [
    "::1",
    "::",
    "fc00::1",
    "fdff:ffff::1",
    "fe80::1",
    "fe80::abcd",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "[::1]",
  ];
  for (const address of blocked) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("isPublicAddress accepts public IPv6 and public IPv4-mapped addresses", () => {
  for (const address of ["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("isPublicAddress fails closed on unparsable input", () => {
  for (const value of ["", "not-an-ip", "300.1.1.1", "1.2.3", "fe80::1::2"]) {
    assert.equal(isPublicAddress(value), false, JSON.stringify(value));
  }
});

// ---------------------------------------------------------------------------
// assertPublicUrl: schemes, credentials, hosts
// ---------------------------------------------------------------------------

test("http(s) URLs with a public literal address pass without DNS", async () => {
  const resolve: ResolveHost = async () => {
    throw new Error("DNS must not run for a literal address");
  };
  const url = await assertPublicUrl("https://8.8.8.8/path?q=1", { resolve });
  assert.equal(url.href, "https://8.8.8.8/path?q=1");
  assert.equal(url.protocol, "https:");
});

test("private IPv4 literals are blocked before any DNS work", async () => {
  const { resolve, calls } = resolverFor();
  for (const raw of ["http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.1.1/admin", "http://169.254.169.254/"]) {
    const details = await expectBlocked(raw, { resolve });
    assert.match(details.message ?? "", /private|special-use/i);
  }
  assert.deepEqual(calls, []);
});

test("IPv6 literals are normalised and checked", async () => {
  const { resolve, calls } = resolverFor();
  await expectBlocked("http://[::1]/", { resolve });
  await expectBlocked("http://[::ffff:127.0.0.1]/", { resolve });
  await expectBlocked("http://[fe80::1]/", { resolve });
  assert.deepEqual(calls, []);

  const publicUrl = await assertPublicUrl("http://[2001:4860:4860::8888]/path", { resolve });
  assert.equal(publicUrl.hostname, "[2001:4860:4860::8888]");
});

test("non-http(s) schemes are blocked and named in the message", async () => {
  for (const [raw, scheme] of [
    ["file:///etc/passwd", "file"],
    ["data:text/html,<h1>hi</h1>", "data"],
    ["javascript:alert(1)", "javascript"],
  ] as const) {
    const details = await expectBlocked(raw);
    assert.match(details.message ?? "", new RegExp(scheme));
    assert.match(details.hint, /http\(s\)/i);
  }
});

test("URL credentials are refused and never echoed", async () => {
  const details = await expectBlocked("https://user:s3cret-token@example.test/page");
  const rendered = JSON.stringify(details);
  assert.ok(!rendered.includes("s3cret-token"), "the password must not leak into the error");
  assert.ok(!rendered.includes("user:"), "the userinfo must not leak into the error");
  assert.match(details.message ?? "", /credentials/i);
});

test("an empty URL and an unparsable URL are blocked", async () => {
  await expectBlocked("");
  await expectBlocked("   ");
  await expectBlocked("http://");
  await expectBlocked("://nope");
});

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

test("a public hostname resolves and is returned normalised", async () => {
  const { resolve, calls } = resolverFor({ "example.test": ["93.184.216.34", "2606:4700:4700::1111"] });
  const url = await assertPublicUrl("https://Example.TEST/a/../b", { resolve });
  assert.equal(calls.length, 1);
  assert.equal(url.hostname, "example.test");
  assert.equal(url.pathname, "/b");
});

test("a hostname resolving to any private address is blocked", async () => {
  const { resolve } = resolverFor({ "mixed.example.test": [PUBLIC, "10.0.0.5"] });
  const details = await expectBlocked("https://mixed.example.test/", { resolve });
  assert.match(details.message ?? "", /resolves to a non-public address/);
  assert.match(details.hint, /non-public/i);

  const mapped = resolverFor({ "mapped.example.test": ["::ffff:127.0.0.1"] });
  await expectBlocked("https://mapped.example.test/", { resolve: mapped.resolve });
});

test("a DNS failure or an empty answer is blocked with a resolution hint", async () => {
  const failing: ResolveHost = async () => {
    throw new Error("ENOTFOUND");
  };
  const failed = await expectBlocked("https://missing.example.test/", { resolve: failing });
  assert.match(failed.message ?? "", /DNS resolution failed/);
  assert.match(failed.hint, /could not be resolved/i);

  const empty: ResolveHost = async () => [];
  const emptyDetails = await expectBlocked("https://empty.example.test/", { resolve: empty });
  assert.match(emptyDetails.message ?? "", /no addresses/i);
});

test("unicode hosts reach the resolver as punycode and keep their path", async () => {
  const { resolve, calls } = resolverFor();
  const url = await assertPublicUrl("https://пример.рф/путь", { resolve });
  assert.deepEqual(calls, ["xn--e1afmkfd.xn--p1ai"]);
  assert.equal(url.hostname, "xn--e1afmkfd.xn--p1ai");
  assert.equal(url.pathname, "/%D0%BF%D1%83%D1%82%D1%8C");
});

test("a trailing root dot is stripped before resolution", async () => {
  const { resolve, calls } = resolverFor();
  await assertPublicUrl("https://example.test./page", { resolve });
  assert.deepEqual(calls, ["example.test"]);
});

// ---------------------------------------------------------------------------
// Redirect re-check
// ---------------------------------------------------------------------------

test("the redirect re-check blocks a landing page the first URL never revealed", async () => {
  const { resolve } = resolverFor();
  const first = await assertPublicUrl("https://example.test/start", { resolve });
  assert.equal(first.hostname, "example.test");

  // What web_read does after navigation: run the same guard on page.url().
  const details = await expectBlocked("http://127.0.0.1:8080/admin", { resolve });
  assert.match(details.message ?? "", /private|special-use/i);

  const viaName = resolverFor({ "internal.example.test": ["192.168.0.10"] });
  await expectBlocked("https://internal.example.test/", { resolve: viaName.resolve });
  await expectBlocked("file:///etc/shadow");
});

test("isPublicAddress rejects IPv6 forms that embed a private IPv4 address", () => {
  // SIIT, NAT64 and 6to4 each carry an IPv4 address the browser will reach; a
  // private one must not pass as "just a public IPv6".
  for (const address of ["::ffff:0:127.0.0.1", "::ffff:0:10.0.0.1", "64:ff9b::127.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["64:ff9b::8.8.8.8", "2002:808:808::"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});
}

// ---------------------------------------------------------------------------
// from tests/unit/urls.test.ts
// ---------------------------------------------------------------------------
{
test("normalizeUrl: lowercases scheme/host, drops fragment and default port, sorts params", () => {
  assert.equal(normalizeUrl("HTTPS://Example.COM:443/Path?b=2&a=1#frag"), "https://example.com/Path?a=1&b=2");
  assert.equal(normalizeUrl("http://Example.com:80/x"), "http://example.com/x");
  assert.equal(normalizeUrl("https://example.com/p?a=2&a=1"), "https://example.com/p?a=1&a=2");
});

test("normalizeUrl: empty path becomes /", () => {
  assert.equal(normalizeUrl("https://example.com?x=1"), "https://example.com/?x=1");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
});

test("normalizeUrl: strips utm_* and the known click-tracking params", () => {
  const raw =
    "https://example.com/a?utm_source=g&utm_medium=cpc&utm_campaign=z&gclid=1&yclid=2&fbclid=3&msclkid=4" +
    "&mc_eid=5&igshid=6&ref_src=7&spm=8&_openstat=9&from=serp&redircnt=10&si=11&sca_esv=12&sxsrf=13&keep=ok";
  assert.equal(normalizeUrl(raw), "https://example.com/a?keep=ok");
  assert.equal(normalizeUrl("https://example.com/a?UTM_Source=x&GCLID=y"), "https://example.com/a");
});

test("normalizeUrl: rejects invalid and non-http(s) input", () => {
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("   "), null);
  assert.equal(normalizeUrl("not a url"), null);
  assert.equal(normalizeUrl("/relative/path"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("mailto:someone@example.com"), null);
  assert.equal(normalizeUrl("ftp://example.com/file"), null);
  assert.equal(normalizeUrl("data:text/html,<b>x</b>"), null);
});

test("normalizeUrl: is idempotent and equal for tracking-only variants", () => {
  const raw = "https://example.com/a?utm_source=x&b=2&a=1#frag";
  const once = normalizeUrl(raw);
  assert.ok(once);
  assert.equal(normalizeUrl(once), once);
  assert.equal(normalizeUrl("https://example.com/a?a=1&b=2"), once);
});

test("normalizeUrl: keeps meaningful query params and path case", () => {
  assert.equal(normalizeUrl("https://example.com/Path/To?q=Hello+World&lang=ru"), "https://example.com/Path/To?lang=ru&q=Hello+World");
});

test("stripTrackingParams: removes tracking, keeps everything else", () => {
  assert.equal(
    stripTrackingParams("https://example.com/a?utm_source=x&gclid=1&keep=1&q=two"),
    "https://example.com/a?keep=1&q=two",
  );
  assert.equal(stripTrackingParams("https://example.com/a?keep=1"), "https://example.com/a?keep=1");
  // Invalid input passes through untouched: the caller intends to open it.
  assert.equal(stripTrackingParams("not a url"), "not a url");
  assert.equal(stripTrackingParams("mailto:a@b.c"), "mailto:a@b.c");
});

test("isTrackingParam: exact names and utm_ prefix, case-insensitive", () => {
  for (const name of ["utm_source", "UTM_Medium", "gclid", "yclid", "fbclid", "from", "redircnt", "si", "sxsrf"]) {
    assert.equal(isTrackingParam(name), true, name);
  }
  for (const name of ["q", "page", "lang", "start", "utm", "fromage"]) {
    assert.equal(isTrackingParam(name), false, name);
  }
});

test("domainOf: strips www, lowercases, empty for unparsable", () => {
  assert.equal(domainOf("https://WWW.Example.COM/path"), "example.com");
  assert.equal(domainOf("http://sub.example.org:8080/x"), "sub.example.org");
  assert.equal(domainOf("https://www.example.co.uk/"), "example.co.uk");
  assert.equal(domainOf("not a url"), "");
  assert.equal(domainOf("mailto:a@b.c"), "");
  assert.equal(domainOf(""), "");
});

test("isHttpUrl: only http(s) with a parseable URL", () => {
  assert.equal(isHttpUrl("https://example.com"), true);
  assert.equal(isHttpUrl("  http://example.com/x  "), true);
  assert.equal(isHttpUrl("ftp://example.com"), false);
  assert.equal(isHttpUrl("example.com"), false);
  assert.equal(isHttpUrl(""), false);
});

test("stableQueryKey: scheme-less key shared by http and https variants", () => {
  assert.equal(stableQueryKey("https://example.com/a?b=1"), "example.com/a?b=1");
  assert.equal(stableQueryKey("http://example.com/a?b=1"), "example.com/a?b=1");
  assert.equal(stableQueryKey("javascript:alert(1)"), null);
});

test("parseLink: direct absolute and relative links", () => {
  const absolute = parseLink("https://example.com/a?x=1#frag", "https://www.google.com/search?q=x");
  assert.deepEqual(absolute, { kind: "direct", url: "https://example.com/a?x=1#frag", wrapperUrl: null });

  const relative = parseLink("/docs/page?x=1", "https://example.com/dir/");
  assert.deepEqual(relative, { kind: "direct", url: "https://example.com/docs/page?x=1", wrapperUrl: null });

  const noBase = parseLink("docs/page", "");
  assert.equal(noBase, null);
});

test("parseLink: Google /goto stays opaque — url is null, never decoded", () => {
  const relative = parseLink("/goto?url=CAESaBcDeF", "https://www.google.com/search?q=x");
  assert.deepEqual(relative, {
    kind: "goto",
    url: null,
    wrapperUrl: "https://www.google.com/goto?url=CAESaBcDeF",
  });

  const absolute = parseLink("https://www.google.com/goto?url=CAESaBcDeF&hl=ru", "https://www.google.com/");
  assert.equal(absolute?.kind, "goto");
  assert.equal(absolute?.url, null);
  assert.ok(absolute?.wrapperUrl?.includes("CAESaBcDeF"));
});

test("parseLink: a non-Google absolute /goto is not treated as a Google wrapper", () => {
  const parsed = parseLink("https://example.com/goto?url=abc", "https://example.com/");
  assert.equal(parsed?.kind, "direct");
  assert.equal(parsed?.url, "https://example.com/goto?url=abc");
});

test("isGoogleHost: explicit google shapes only, never a wildcard subdomain", () => {
  for (const host of [
    "google.com",
    "www.google.com",
    "GOOGLE.DE",
    "www.google.co.uk",
    "google.co.uk",
    "google.com.br",
    "google.ru",
    "google.co.in",
  ]) {
    assert.equal(isGoogleHost(host), true, host);
  }

  // A host we would send cookies to must not be nameable by a SERP href.
  for (const host of [
    "google.duckdns.org",
    "google.com.evil.co",
    "google.co.uk.evil",
    "notgoogle.com",
    "evilgoogle.com",
    "google",
    "",
  ]) {
    assert.equal(isGoogleHost(host), false, host);
  }
});

test("parseLink: a hostile google-lookalike href is direct, so /goto cannot leak cookies", () => {
  for (const href of [
    "https://google.duckdns.org/goto?url=abc",
    "https://google.com.evil.co/goto?url=abc",
    "https://google.co.uk.evil/goto?url=abc",
    "https://notgoogle.com/goto?url=abc",
  ]) {
    const parsed = parseLink(href, "https://www.google.com/search?q=x");
    assert.equal(parsed?.kind, "direct", href);
    assert.equal(parsed?.url, href, "the href is kept as a plain link, never as a wrapper");
    assert.equal(parsed?.wrapperUrl, null);
  }

  // The real country hosts are still wrappers.
  for (const href of [
    "https://google.de/goto?url=abc",
    "https://www.google.co.uk/goto?url=abc",
    "https://google.com.br/goto?url=abc",
  ]) {
    const parsed = parseLink(href, "https://www.google.com/search?q=x");
    assert.equal(parsed?.kind, "goto", href);
    assert.equal(parsed?.url, null);
  }
});

test("parseLink: Google /url?q= yields the decoded target", () => {
  const parsed = parseLink(
    "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&sa=U&ved=x",
    "https://www.google.com/search?q=x",
  );
  assert.deepEqual(parsed, {
    kind: "url",
    url: "https://example.com/a?b=1",
    wrapperUrl: "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&sa=U&ved=x",
  });

  const relative = parseLink("/url?q=https%3A%2F%2Fexample.org%2Fp", "https://www.google.com/search?q=x");
  assert.equal(relative?.kind, "url");
  assert.equal(relative?.url, "https://example.org/p");
});

test("parseLink: /url without a usable target is unresolvable, not guessed", () => {
  assert.equal(parseLink("/url?q=", "https://www.google.com/search?q=x"), null);
  assert.equal(parseLink("/url?q=javascript%3Aalert(1)", "https://www.google.com/search?q=x"), null);
  assert.equal(parseLink("/url?sa=U", "https://www.google.com/search?q=x"), null);
});

test("parseLink: DuckDuckGo /l/?uddg= yields the decoded target", () => {
  const parsed = parseLink(
    "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fp&rut=abc",
    "https://duckduckgo.com/?q=x",
  );
  assert.equal(parsed?.kind, "url");
  assert.equal(parsed?.url, "https://example.org/p");
  assert.equal(parsed?.wrapperUrl?.startsWith("https://duckduckgo.com/l/"), true);
});

test("parseLink: unusable hrefs return null", () => {
  assert.equal(parseLink("", "https://example.com/"), null);
  assert.equal(parseLink("   ", "https://example.com/"), null);
  assert.equal(parseLink("mailto:a@b.c", "https://example.com/"), null);
  assert.equal(parseLink("javascript:void(0)", "https://example.com/"), null);
  assert.equal(parseLink("#anchor", "https://example.com/"), null);
});

test("parseLink: relative wrapper detection does not fire on unrelated paths", () => {
  const parsed = parseLink("/search/goto-elsewhere?url=x", "https://example.com/");
  assert.equal(parsed?.kind, "direct");
  assert.equal(parsed?.url, "https://example.com/search/goto-elsewhere?url=x");
});
}
