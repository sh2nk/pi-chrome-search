/**
 * P4-A unit tests: the SSRF guard (SPEC §7.2, PLAN V4.1).
 *
 * Offline by construction: every hostname goes through an injected resolver.
 * The matrix covers each blocked IPv4/IPv6 family, the boundary just outside
 * it, DNS answers where only one address is private, URL credentials (which
 * must never be echoed), non-http(s) schemes, unicode hosts and the second
 * guard pass a redirect triggers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import type { FailureDetails } from "../../src/runtime/error-codes.ts";
import { assertPublicUrl, isPublicAddress, type ResolveHost } from "../../src/runtime/ssrf.ts";

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
