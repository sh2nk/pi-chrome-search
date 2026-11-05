import assert from "node:assert/strict";
import { test } from "node:test";

import {
  domainOf,
  isHttpUrl,
  isTrackingParam,
  normalizeUrl,
  parseLink,
  stableQueryKey,
  stripTrackingParams,
} from "../../src/extract/urls.ts";

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
