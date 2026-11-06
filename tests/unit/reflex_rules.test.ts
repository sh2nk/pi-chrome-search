/**
 * Deterministic rules fallback (PLAN P5-B, gates V5.1/V5.3).
 *
 * Every test here runs offline and without a clock: the rules are a pure
 * function of `(query, items)`, which is what makes them a bench baseline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Candidate } from "../../src/reflex/types.ts";
import {
  DEFAULT_TRIAGE_KEEP,
  bm25Scores,
  createRules,
  detectFreshness,
  detectScript,
  domainPrior,
  hasExactTerm,
  isAllowHost,
  isSpamHost,
  queryTerms,
  tokenize,
} from "../../src/reflex/rules.ts";

function candidate(url: string, title: string, snippet = ""): Candidate {
  return { url, title, snippet, engine: "google" };
}

const rules = createRules();

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

test("tokenize keeps Unicode words and numbers, drops punctuation", () => {
  assert.deepEqual(tokenize("Node.js — установка!"), ["node", "js", "установка"]);
  assert.deepEqual(tokenize("   "), []);
});

test("queryTerms removes function words and duplicates, keeps first-seen order", () => {
  assert.deepEqual(queryTerms("how to install node node"), ["install", "node"]);
  assert.deepEqual(queryTerms("как установить node"), ["установить", "node"]);
});

test("hasExactTerm matches tokens, not prefixes", () => {
  assert.equal(hasExactTerm("install node", "How to install Node.js"), true);
  assert.equal(hasExactTerm("install node", "Installing nodes"), false);
  assert.equal(hasExactTerm("install node", ""), false);
});

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

test("bm25Scores: a rare term outweighs a term present in every document", () => {
  const documents = [tokenize("rare common"), tokenize("common"), tokenize("common")];
  const rare = bm25Scores(queryTerms("rare"), documents);
  const common = bm25Scores(queryTerms("common"), documents);

  assert.ok(rare[0] > 0);
  assert.ok(common[0] > 0);
  assert.ok(rare[0] > common[0], "rare term must score higher than a term in every document");
  assert.deepEqual(bm25Scores(queryTerms("absent"), documents), [0, 0, 0]);
  assert.deepEqual(bm25Scores(["x"], []), []);
});

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

test("triage ranks the term-matching candidate first, deterministically", async () => {
  const items = [
    candidate(
      "https://en.wikipedia.org/wiki/Cat",
      "Cat - Wikipedia",
      "The cat is a domestic species of small carnivorous mammal.",
    ),
    candidate(
      "https://nodejs.org/en/download",
      "Download Node.js",
      "Install Node.js 26 with the official installer or a package manager.",
    ),
    candidate("https://example.org/coffee", "Coffee brewing guide", "How to brew coffee at home."),
  ];

  const first = await rules.triage("install node 26", items);
  const second = await rules.triage("install node 26", items);

  assert.equal(first.keep[0], 1);
  assert.ok(first.keep.length <= DEFAULT_TRIAGE_KEEP);
  assert.deepEqual(first, second, "same input must produce the same verdict");
  assert.equal(JSON.stringify(first), JSON.stringify(second), "verdict must be stable JSON");
  assert.equal(first.scores.length, items.length);
  for (const score of first.scores) {
    assert.ok(Number.isInteger(score) && score >= 0 && score <= 5, `score out of range: ${score}`);
  }
  assert.deepEqual(first.flags, []);
});

test("triage dedups exact URLs and flags the duplicate", async () => {
  const items = [
    candidate("https://example.com/guide?utm_source=serp", "Guide", "install node"),
    candidate("https://example.com/guide", "Guide", "install node"),
  ];

  const result = await rules.triage("install node", items);

  assert.ok(result.flags.includes("duplicate"));
  assert.equal(result.keep.length, 1, "only one copy of a URL may be kept");
  assert.equal(result.scores[1], 0, "the dropped duplicate scores 0");
});

test("triage flags a spam host and never keeps it ahead of a real result", async () => {
  const items = [
    candidate(
      "https://doubleclick.net/install-node",
      "Install node now",
      "install node 26 free download install node",
    ),
    candidate("https://nodejs.org/en/docs", "Node.js docs", "Install Node.js with nvm"),
  ];

  const result = await rules.triage("install node", items);

  assert.ok(result.flags.includes("spam"));
  assert.equal(result.keep[0], 1);
  assert.ok(!result.keep.includes(0), "a spam host is never kept");
  assert.equal(result.scores[0], 0);
});

test("triage still returns one result when every candidate looks like spam", async () => {
  const items = [candidate("https://bit.ly/x", "Shocking install node trick", "click here")];

  const result = await rules.triage("install node", items);

  assert.deepEqual(result.keep, [0], "recall safety: never an empty keep list for a non-empty SERP");
  assert.ok(result.flags.includes("spam"));
  assert.equal(result.scores[0], 0);
});

test("triage of an empty SERP is empty", async () => {
  assert.deepEqual(await rules.triage("anything", []), { keep: [], scores: [], flags: [] });
});

test("triage honours a custom keep limit", async () => {
  const items = Array.from({ length: 9 }, (_, index) =>
    candidate(`https://example.org/p${index}`, `Result ${index}`, "install node"),
  );

  const result = await createRules({ keep: 3 }).triage("install node", items);

  assert.equal(result.keep.length, 3);
});

// ---------------------------------------------------------------------------
// Read gate
// ---------------------------------------------------------------------------

test("gateRead allows an allowlisted docs page that carries a query term", async () => {
  const item = candidate(
    "https://docs.python.org/3/library/asyncio.html",
    "asyncio — Asynchronous I/O",
    "asyncio is a library to write concurrent code using async/await",
  );

  assert.equal(await rules.gateRead("asyncio library", item), true);
});

test("gateRead denies unrelated content, blocked paths, spam hosts and binary files", async () => {
  const unrelated = candidate("https://example.org/recipe", "Chocolate cake", "Flour, sugar, eggs.");
  assert.equal(await rules.gateRead("asyncio library", unrelated), false);

  const login = candidate("https://docs.python.org/login", "Log in", "asyncio library");
  assert.equal(await rules.gateRead("asyncio library", login), false);

  const spam = candidate("https://doubleclick.net/asyncio", "asyncio library", "asyncio library");
  assert.equal(await rules.gateRead("asyncio library", spam), false);

  const pdf = candidate("https://example.org/asyncio.pdf", "asyncio library", "asyncio library");
  assert.equal(await rules.gateRead("asyncio library", pdf), false);
});

test("gateRead requires one hit on an allowlisted host and two on an unknown host", async () => {
  const allowZeroHits = candidate("https://en.wikipedia.org/wiki/Cat", "Cat", "Felis catus");
  assert.equal(await rules.gateRead("asyncio library", allowZeroHits), false);

  const allowOneHit = candidate("https://en.wikipedia.org/wiki/Asyncio", "Asyncio", "Felis catus");
  assert.equal(await rules.gateRead("asyncio library", allowOneHit), true);

  const unknownOneHit = candidate("https://example.org/asyncio", "Asyncio guide", "Felis catus");
  assert.equal(await rules.gateRead("asyncio library", unknownOneHit), false);

  const unknownTwoHits = candidate("https://example.org/asyncio", "Asyncio library", "Felis catus");
  assert.equal(await rules.gateRead("asyncio library", unknownTwoHits), true);
});

test("gateRead handles a one-term query and non-http URLs", async () => {
  const oneTerm = candidate("https://example.org/asyncio", "Asyncio basics", "Getting started");
  assert.equal(await rules.gateRead("asyncio", oneTerm), true);

  const badScheme = candidate("ftp://example.org/asyncio", "Asyncio", "asyncio");
  assert.equal(await rules.gateRead("asyncio", badScheme), false);
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test("coverage is enough with two domains and one exact-term hit", async () => {
  const verdict = await rules.coverage("install node", [
    { url: "https://nodejs.org/en/download", title: "Download Node.js", excerpt: "Install Node.js here" },
    { url: "https://en.wikipedia.org/wiki/Node.js", title: "Node.js", excerpt: "JavaScript runtime" },
  ]);

  assert.deepEqual(verdict, { enough: true, next: "stop" });
});

test("coverage asks for more reads when only one domain is covered", async () => {
  const verdict = await rules.coverage("install node", [
    { url: "https://nodejs.org/en/download", title: "Download Node.js", excerpt: "Install Node.js here" },
    { url: "https://nodejs.org/en/docs", title: "Node.js docs", excerpt: "Install Node.js with nvm" },
  ]);

  assert.deepEqual(verdict, { enough: false, next: "read_more" });
});

test("coverage refines when domains are covered but no page carries a query term", async () => {
  const verdict = await rules.coverage("asyncio library", [
    { url: "https://example.org/recipe", title: "Chocolate cake", excerpt: "Flour, sugar, eggs." },
    { url: "https://example.net/coffee", title: "Coffee guide", excerpt: "Beans and water." },
  ]);

  assert.deepEqual(verdict, { enough: false, next: "refine" });
});

test("coverage asks for a read when nothing was read yet, and stops after the read budget", async () => {
  assert.deepEqual(await rules.coverage("install node", []), { enough: false, next: "read_more" });

  const sameDomain = Array.from({ length: 5 }, (_, index) => ({
    url: `https://example.org/page${index}`,
    title: "Chocolate cake",
    excerpt: "Flour, sugar, eggs.",
  }));
  assert.deepEqual(await rules.coverage("asyncio library", sameDomain), {
    enough: false,
    next: "refine",
  });
});

test("coverage ignores duplicate evidence URLs", async () => {
  const verdict = await rules.coverage("install node", [
    { url: "https://nodejs.org/en/download", title: "Download Node.js", excerpt: "Install Node.js here" },
    { url: "https://nodejs.org/en/download#top", title: "Download Node.js", excerpt: "Install Node.js here" },
  ]);

  assert.deepEqual(verdict, { enough: false, next: "read_more" });
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

test("route sends a Cyrillic query to yandex+google with lang ru", async () => {
  const route = await rules.route("установить node 26");

  assert.deepEqual(route.engines, ["yandex", "google"]);
  assert.equal(route.lang, "ru");
  assert.equal(route.n, 5);
  assert.equal(route.summary, true);
});

test("route sends a Latin query to google+duckduckgo with lang en", async () => {
  const route = await rules.route("install node 26");

  assert.deepEqual(route.engines, ["google", "duckduckgo"]);
  assert.equal(route.lang, "en");
});

test("route treats a Cyrillic-dominant mixed query as Russian", async () => {
  assert.equal(detectScript("купить iPhone 16"), "cyrillic");
  assert.equal(detectScript("install node on linux для дома"), "latin");
  assert.equal(detectScript("2026"), "none");
});

test("route maps freshness keywords and keeps the strongest match", async () => {
  assert.equal(detectFreshness("breaking news about node"), "d");
  assert.equal(detectFreshness("последние новости node"), "d");
  assert.equal(detectFreshness("latest node release"), "w");
  assert.equal(detectFreshness("node release this month"), "m");
  assert.equal(detectFreshness("node 26 release notes 2026"), "y");
  assert.equal(detectFreshness("install node"), undefined);

  const fresh = await rules.route("latest node release");
  assert.equal(fresh.freshness, "w");
  assert.equal(fresh.n, 5);
});

test("route trims n and summary for a one-word navigational query", async () => {
  const route = await rules.route("weather");

  assert.equal(route.n, 3);
  assert.equal(route.summary, false);

  // A freshness marker keeps the summary on even for a single term.
  const year = await rules.route("2026");
  assert.equal(year.n, 3);
  assert.equal(year.summary, true);
  assert.equal(year.freshness, "y");
});

test("route is deterministic", async () => {
  const first = await rules.route("купить ноутбук недорого");
  const second = await rules.route("купить ноутбук недорого");
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

// ---------------------------------------------------------------------------
// Domain priors
// ---------------------------------------------------------------------------

test("domain helpers recognise docs/gov/edu hosts and ad hosts", () => {
  assert.equal(isAllowHost("https://docs.python.org/3/"), true);
  assert.equal(isAllowHost("en.wikipedia.org"), true);
  assert.equal(isAllowHost("https://www.nasa.gov/mission"), true);
  assert.equal(isAllowHost("https://example.org/guide"), false);

  assert.equal(isSpamHost("https://bit.ly/x"), true);
  assert.equal(isSpamHost("https://taboola.com/x"), true);
  assert.equal(isSpamHost("https://nodejs.org/x"), false);

  assert.ok(domainPrior("https://nodejs.org/x") > domainPrior("https://example.org/x"));
  assert.ok(domainPrior("https://doubleclick.net/x") < 0);
  assert.equal(domainPrior("not a url"), 0);
});
