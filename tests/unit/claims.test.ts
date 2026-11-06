/**
 * P13 unit gates: claim selection (V13.1), source hygiene (V13.2) and the
 * `enough` honesty floor (V13.3).
 *
 * Everything is offline and deterministic. `claims-qa.json` is the ten-query
 * fixture with a known answer fact; `research-live-p13.json` is the trimmed
 * transcript of the live V13.4 run (one query per engine, recorded once).
 *
 * The baseline is kept here on purpose: V13.1 asks for a measured baseline
 * before a target, so the shipped P6 rule ("first sentence of the first page")
 * is reproduced below and asserted to be as weak as the probe reported.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CLAIM_MAX_CHARS,
  MIN_CLAIM_COVERAGE,
  claimsCoverage,
  hasNamedEntity,
  isBoilerplateSentence,
  isLoneDate,
  isTocPage,
  looksLikeCode,
  scoreSentence,
  selectClaims,
  splitSentences,
  type ClaimSource,
} from "../../src/extract/claims.ts";
import { isTrackingParam, stripTrackingFromText } from "../../src/extract/urls.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface QaCase {
  id: string;
  query: string;
  answer: string;
  source: string;
  pages: ClaimSource[];
}

interface QaFixture {
  name: string;
  notes: string;
  cases: QaCase[];
}

const QA = JSON.parse(
  readFileSync(new URL("../fixtures/claims-qa.json", import.meta.url), "utf8"),
) as QaFixture;

/** The shipped P6 rule, copied verbatim from `web_research.ts` before P13. */
const SKIPPED_LINE = /^[#>*|!]|^\d+[.)]\s|^[-+*]\s/;

function baselineTop(entry: QaCase): string | null {
  for (const page of entry.pages) {
    for (const line of page.text.split(/\n+/)) {
      const clean = line.trim();
      if (clean === "" || SKIPPED_LINE.test(clean)) continue;
      for (const part of clean.split(/(?<=[.!?…])\s+/u)) {
        const sentence = part.replace(/\s+/g, " ").trim();
        if (sentence.length < 30) continue;
        return sentence;
      }
    }
  }
  return null;
}

function topClaim(entry: QaCase): string {
  return selectClaims(entry.pages, { query: entry.query, maxClaims: 2 })[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// V13.1 — the top claim is an answer, not the first sentence
// ---------------------------------------------------------------------------

test("V13.1 baseline: the shipped lead-sentence rule answers 3/10 at best", () => {
  let hits = 0;
  for (const entry of QA.cases) {
    const text = baselineTop(entry) ?? "";
    if (text.toLowerCase().includes(entry.answer.toLowerCase())) hits += 1;
  }
  // The probe (`research/probes/13-claims.mjs --baseline`) measured 2/10 on this
  // fixture. Pinning the ceiling keeps the target honest if the fixture grows.
  assert.ok(hits <= 3, `the baseline unexpectedly answers ${hits}/10: the fixture lost its difficulty`);
});

test("V13.1 target: at least 8/10 top claims contain the known answer fact", () => {
  const misses: string[] = [];
  let hits = 0;
  for (const entry of QA.cases) {
    const text = topClaim(entry);
    if (text.toLowerCase().includes(entry.answer.toLowerCase())) hits += 1;
    else misses.push(`${entry.id}: expected "${entry.answer}" in "${text}"`);
  }
  assert.ok(
    hits >= 8,
    `top-claim answers ${hits}/${QA.cases.length} (target >= 8)\n${misses.join("\n")}`,
  );
});

test("V13.1: every selected claim is still a real sentence with a real citation", () => {
  for (const entry of QA.cases) {
    const picks = selectClaims(entry.pages, { query: entry.query, maxClaims: 2 });
    assert.ok(picks.length > 0, `${entry.id}: no claim produced`);
    const known = new Set(entry.pages.map((page) => page.url));
    for (const pick of picks) {
      assert.ok(pick.text.length >= 30, `${entry.id}: fragment "${pick.text}"`);
      assert.ok(pick.text.length <= CLAIM_MAX_CHARS, `${entry.id}: claim over the cap`);
      assert.ok(known.has(pick.sourceUrl), `${entry.id}: fabricated citation ${pick.sourceUrl}`);
      assert.equal(pick.citations[0], pick.sourceUrl);
    }
  }
});

// ---------------------------------------------------------------------------
// V13.3 — enough means "the question was answered"
// ---------------------------------------------------------------------------

test("V13.3: claim coverage is the share of query terms the claims use", () => {
  assert.equal(claimsCoverage("postgres max_connections default", []), 0);
  assert.equal(claimsCoverage("postgres", []), 0, "an empty bundle never covers a query");
  assert.equal(
    claimsCoverage("retry after", ["A 429 response carries a Retry-After header."]),
    1,
  );
  const partial = claimsCoverage("postgres max_connections default", [
    "The default for max_connections is 100 connections.",
  ]);
  assert.ok(partial > 0 && partial < 1, `expected partial coverage, got ${partial}`);
  assert.equal(claimsCoverage("the a of", ["anything"]), 1, "a query with only stopwords has no terms");
});

test("V13.3: the gate threshold is 60%", () => {
  assert.equal(MIN_CLAIM_COVERAGE, 0.6);
  const coverTwoOfFour = claimsCoverage("alpha beta gamma delta", ["alpha beta"]);
  assert.ok(coverTwoOfFour < MIN_CLAIM_COVERAGE, `${coverTwoOfFour} must not count as enough`);
  const coverThreeOfFour = claimsCoverage("alpha beta gamma delta", ["alpha beta gamma"]);
  assert.ok(coverThreeOfFour >= MIN_CLAIM_COVERAGE, `${coverThreeOfFour} must count as enough`);
});

test("V13.3: off-target claims cannot claim enough", () => {
  // Two independent domains and one shared query term used to be enough:yes.
  const offTarget = selectClaims(
    [
      {
        url: "https://docs.example.test/logistics",
        text: "Freight volumes rose through the quarter as warehouse teams cleared the backlog. The report tracks tonnage and dwell time.",
      },
      {
        url: "https://news.example.test/rail",
        text: "Rail operators expect steady demand for bulk cargo next season. Network upgrades should shorten the run to the inland terminal.",
      },
    ],
    { query: "postgres max_connections default", maxClaims: 2 },
  );
  const texts = offTarget.map((pick) => pick.text);
  assert.ok(texts.length >= 2, "the bundle is not empty, it is just off-topic");
  assert.ok(claimsCoverage("postgres max_connections default", texts) < MIN_CLAIM_COVERAGE);
});

// ---------------------------------------------------------------------------
// V13.2 — source hygiene
// ---------------------------------------------------------------------------

test("V13.2: tracking parameters are stripped from a claim's links and link text", () => {
  const [pick] = selectClaims(
    [
      {
        url: "https://docs.example.test/attach?utm_source=newsletter",
        text:
          "Attaching a browser session is documented in [the attach guide](https://docs.example.test/guide?utm_medium=email&keep=1&gclid=abc) " +
          "and mirrored at https://mirror.example.test/guide?utm_source=x&fbclid=y for offline reading.",
      },
    ],
    { query: "attach browser session", maxClaims: 1 },
  );
  assert.ok(pick, "expected a claim");
  const urls = pick.text.match(/https?:\/\/[^\s)]+/g) ?? [];
  assert.ok(urls.length >= 2, `expected inline URLs in the claim, got ${pick.text}`);
  for (const url of urls) {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      assert.equal(isTrackingParam(key), false, `tracking parameter ${key} survived in ${url}`);
    }
  }
  assert.match(pick.text, /keep=1/, "meaningful parameters are preserved");
});

test("V13.2: stripTrackingFromText keeps sentence punctuation and clean URLs", () => {
  assert.equal(
    stripTrackingFromText("See https://example.com/a?utm_source=x&b=2."),
    "See https://example.com/a?b=2.",
  );
  assert.equal(
    stripTrackingFromText("[https://example.com/a?gclid=1](https://example.com/a?utm_medium=x)"),
    "[https://example.com/a](https://example.com/a)",
  );
  assert.equal(
    stripTrackingFromText("no links here, just prose"),
    "no links here, just prose",
  );
});

test("V13.2: a recorded live transcript never carries a tracking parameter", () => {
  const transcript = JSON.parse(
    readFileSync(new URL("../fixtures/research-live-p13.json", import.meta.url), "utf8"),
  ) as {
    claims: Array<{ text: string; sourceUrl: string; citations: string[] }>;
    citations: Array<{ url: string }>;
    excerpts: Array<{ url: string; excerpt: string }>;
  };

  const urls = new Set<string>();
  for (const claim of transcript.claims) {
    urls.add(claim.sourceUrl);
    for (const url of claim.citations) urls.add(url);
    for (const inline of claim.text.match(/https?:\/\/[^\s)\]]+/g) ?? []) urls.add(inline);
  }
  for (const citation of transcript.citations) urls.add(citation.url);
  for (const excerpt of transcript.excerpts) urls.add(excerpt.url);

  const violations: string[] = [];
  for (const raw of urls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue; // prose punctuation, not a URL
    }
    for (const [key] of parsed.searchParams) {
      if (isTrackingParam(key)) violations.push(`${raw} -> ${key}`);
    }
  }
  assert.deepEqual(violations, [], "a tracking parameter reached the rendered bundle");
  assert.ok(transcript.claims.length >= 3, "the transcript must contain the live claims");
});

// ---------------------------------------------------------------------------
// Selection mechanics
// ---------------------------------------------------------------------------

test("splitting keeps abbreviations and decimals inside one sentence", () => {
  assert.deepEqual(splitSentences("Use e.g. nvm to install Node. It works on macOS."), [
    "Use e.g. nvm to install Node.",
    "It works on macOS.",
  ]);
  assert.deepEqual(splitSentences("Version 1.5 shipped in 2024. It is stable."), [
    "Version 1.5 shipped in 2024.",
    "It is stable.",
  ]);
  assert.deepEqual(splitSentences("# Heading\n\n- a list item\n\nReal prose sentence here."), [
    "Real prose sentence here.",
  ]);
});

test("boilerplate, lone dates and navigational text are never quoted", () => {
  assert.equal(isBoilerplateSentence("This documentation page is part of the reference and is licensed under the Apache License."), true);
  assert.equal(isBoilerplateSentence("We use cookies to improve your experience and measure traffic."), true);
  assert.equal(isBoilerplateSentence("Read more about the DevTools protocol targets."), true);
  assert.equal(isBoilerplateSentence("A flat session is opened with Target.attachToTarget on a browser target."), false);

  assert.equal(isLoneDate("Актуально на 14 июля 2026 года."), true);
  assert.equal(isLoneDate("Updated July 14, 2026."), true);
  assert.equal(isLoneDate("The release 14 июля 2026 года changed the default."), false);

  // A statement that merely contains a date is still a statement.
  assert.ok(scoreSentence("release", "The release shipped on 14 July 2026 with a new default.") > 0);
  assert.equal(scoreSentence("release", "Актуально на 14 июля 2026 года."), -100);
});

test("a table of contents is recognised, prose with a list is not", () => {
  const toc = "# Содержание\n1. Быстрый ответ и нейросети\n2. Настройка поиска и быстрые ответы в браузере\n3. История поиска\n4. Настройки приватности\n5. Справочный центр";
  assert.equal(isTocPage(toc), true);
  const prose =
    "# Installing Node\n\nNode 26 is the current LTS line. Install it with nvm so upgrades stay simple.\n\nThe installer writes to your shell profile, so open a new terminal.";
  assert.equal(isTocPage(prose), false);
});

test("fenced code and inline code fragments are never claims", () => {
  const picks = selectClaims(
    [
      {
        url: "https://docs.example.test/env",
        text:
          "The server reads the port from the environment before it starts.\n\n```ruby\nport = ENV[\"PORT\"].to_i || 4000\n```\n\nSet PORT to a free port before starting the process, then restart the server.",
      },
    ],
    { query: "port environment variable server", maxClaims: 2 },
  );
  for (const pick of picks) {
    assert.equal(looksLikeCode(pick.text), false, `code reached the claims: ${pick.text}`);
    assert.equal(/:=\s*/.test(pick.text), false);
  }
  assert.equal(looksLikeCode('port = ENV["PORT"].to_i || 4000'), true);
  assert.equal(looksLikeCode("The port is read from the environment."), false);
});

test("when any claim is on-topic, off-topic sentences stay out", () => {
  const picks = selectClaims(
    [
      {
        url: "https://docs.example.test/ru",
        text:
          "Запись 0.0.0.0 позволяет задействовать все адреса IPv4. " +
          "Значение параметра max_connections по умолчанию равно 100 соединениям.",
      },
      {
        url: "https://docs.example.test/unrelated",
        text: "Freight volumes rose through the quarter as warehouse teams cleared the backlog and hired drivers.",
      },
    ],
    { query: "postgres max_connections default", maxClaims: 3 },
  );
  assert.ok(picks.length >= 1);
  for (const pick of picks) {
    assert.ok(
      /max|connections|default|postgres/i.test(pick.text),
      `off-topic claim survived next to an on-topic one: ${pick.text}`,
    );
  }
});

test("a claim from a later page outranks a weak first sentence", () => {
  const picks = selectClaims(
    [
      {
        url: "https://docs.example.test/intro",
        text: "This chapter covers asynchronous control flow in Rust and the ways a future can be polled to completion. The runtime is single threaded by default.",
      },
      {
        url: "https://docs.example.test/select",
        text: "The tokio::select! macro waits on several futures at once and runs the branch that completes first.",
      },
    ],
    { query: "rust tokio select macro", maxClaims: 2 },
  );
  assert.match(picks[0]?.text ?? "", /tokio::select!/);
  assert.equal(picks[0]?.sourceUrl, "https://docs.example.test/select");
});

test("identical text from two pages is one claim with two citations", () => {
  const shared =
    "Attaching over CDP reuses the running browser profile instead of launching a second instance.";
  const picks = selectClaims(
    [
      { url: "https://docs.example.test/a", text: shared },
      { url: "https://blog.example.test/b", text: shared },
    ],
    { query: "attach cdp browser profile", maxClaims: 2 },
  );
  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0]?.citations, ["https://docs.example.test/a", "https://blog.example.test/b"]);
});

test("a source supplies a second claim only when it is clearly distinct", () => {
  const picks = selectClaims(
    [
      {
        url: "https://docs.example.test/vm",
        text:
          "A virtual environment keeps project packages apart from the system interpreter. " +
          "On Windows the entry points live in Scripts\\activate and run from cmd.exe. " +
          "On POSIX the same file is bin/activate and you source it from the shell.",
      },
    ],
    { query: "venv activate windows scripts", maxClaims: 3 },
  );
  assert.ok(picks.length >= 1);
  for (const pick of picks) assert.equal(pick.sourceUrl, "https://docs.example.test/vm");
  if (picks.length > 1) {
    assert.notEqual(picks[1]?.text, picks[0]?.text);
  }
});

test("sources are de-duplicated by canonical host+path, not by tracking tail", () => {
  const picks = selectClaims(
    [
      { url: "https://docs.example.test/attach?utm_source=a", text: "Attach over CDP keeps the browser session alive." },
      { url: "https://docs.example.test/attach?utm_source=b", text: "Attach over CDP keeps the browser session alive." },
      { url: "https://www.docs.example.test/attach", text: "Attach over CDP keeps the browser session alive." },
    ],
    { query: "attach cdp browser session", maxClaims: 3 },
  );
  assert.equal(picks.length, 1);
  assert.equal(picks[0]?.citations.length, 1, "the dropped duplicate is not a second citation");
});

test("named entities are a tie-breaker, not a rule", () => {
  assert.equal(hasNamedEntity("Use Node 26 and the Retry-After header."), true);
  assert.equal(hasNamedEntity("the session id is returned by the command"), false);
});
