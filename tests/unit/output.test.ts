/**
 * Output shaping: the AI state machine (post-P8) and the compact caps/budgets.
 *
 * The AI block has three states — answer/lead/none — and a lead must never be
 * rendered as an answer. Every output path is capped in one place
 * (`extract/compact.ts`): results floor first, then the summary.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AI_WAIT_MS, DEFAULT_NONE_GRACE_MS, waitForAi } from "../../src/cdp/ai-wait.ts";
import { type CdpPage } from "../../src/cdp/types.ts";
import { AI_ANSWER_MIN_CHARS, type AiProbe, type EngineId, type RawSerp, type SerpItem } from "../../src/engines/types.ts";
import { COMPACT_CAPS, type CompactOptions, compactSerps } from "../../src/extract/compact.ts";
import { isHttpUrl, normalizeUrl } from "../../src/extract/urls.ts";
import { WebSearchError, isWebSearchError } from "../../src/runtime/error-codes.ts";
import { FakeClock, FakePage } from "../helpers/fake-cdp.ts";

// ---------------------------------------------------------------------------
// from tests/unit/ai_wait.test.ts
// ---------------------------------------------------------------------------
{
/**
 * P8-A: the streaming-summary wait (`src/cdp/ai-wait.ts`).
 *
 * Every case drives virtual time through `FakeClock`, so the suite proves the
 * deadline, the "no block" grace and the early-answer path without sleeping.
 * The probe is a scripted sequence: this file tests the wait's contract, not an
 * engine's DOM.
 */



function page(): CdpPage {
  return new FakePage({ url: "https://www.google.com/search?q=sample" });
}

/** Probe that replays `sequence`, repeating the last entry once it is exhausted. */
function sequenceProbe(sequence: readonly AiProbe[]): {
  probe: (page: CdpPage) => Promise<AiProbe>;
  polls: () => number;
} {
  let index = 0;
  let polls = 0;
  return {
    probe: async () => {
      polls += 1;
      const value = sequence[Math.min(index, sequence.length - 1)] ?? { state: "none", chars: 0 };
      index += 1;
      return value;
    },
    polls: () => polls,
  };
}

/** No jitter: the clock math is the subject here, not the poll shape. */
const STEADY = (): number => 0.5;

test("an answer already on the page resolves on the first probe with no sleep", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "answer", chars: AI_ANSWER_MIN_CHARS }]);
  const result = await waitForAi(page(), { probe: scripted.probe }, { clock, pollMs: 150, rng: STEADY });

  assert.deepEqual(result, { state: "answer", chars: AI_ANSWER_MIN_CHARS, waitMs: 0, timedOut: false, polls: 1 });
  assert.equal(clock.durations().length, 0);
});

test("a lead that turns into prose returns as soon as the prose appears", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([
    { state: "none", chars: 0 },
    { state: "lead", chars: 31 },
    { state: "lead", chars: 31 },
    { state: "answer", chars: 812 },
  ]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 6000, rng: STEADY },
  );

  assert.equal(result.state, "answer");
  assert.equal(result.chars, 812);
  assert.equal(result.timedOut, false);
  assert.equal(result.waitMs, 300);
  assert.equal(result.polls, 4);
});

test("a lead that never becomes prose waits out the deadline and reports a timeout", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "lead", chars: 31 }]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 600, rng: STEADY },
  );

  assert.equal(result.state, "lead");
  assert.equal(result.chars, 31);
  assert.equal(result.timedOut, true);
  assert.equal(result.waitMs, 600);
  assert.equal(result.polls, 7);
});

test("a page with no AI block stops after the grace instead of the whole deadline", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "none", chars: 0 }]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 6000, noneGraceMs: 300, rng: STEADY },
  );

  assert.equal(result.state, "none");
  assert.equal(result.timedOut, true);
  assert.equal(result.waitMs, 300, "the 6 s budget must not be spent on a page with no AI block");
  assert.equal(result.polls, 4);
});

test("the default budgets are the documented ones", () => {
  assert.equal(DEFAULT_AI_WAIT_MS, 6000);
  // V8.4: a no-AI search pays at most 1.5 s; the constant leaves room for the
  // probe round-trip and the jittered poll on top of the grace itself.
  assert.equal(DEFAULT_NONE_GRACE_MS, 1400);
  assert.ok(DEFAULT_NONE_GRACE_MS < 1500);
});

test("a zero budget probes once and returns (summary:false never waits)", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "answer", chars: 400 }]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 0, rng: STEADY },
  );

  assert.equal(result.state, "answer");
  assert.equal(result.waitMs, 0);
  assert.equal(result.polls, 1);
  assert.equal(clock.durations().length, 0);
});

test("a declared answer shorter than the minimum does not stop the wait", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([{ state: "answer", chars: 40 }]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 500, rng: STEADY },
  );

  assert.equal(result.state, "answer");
  assert.equal(result.chars, 40);
  assert.equal(result.timedOut, true, "40 chars is not an answer, whatever the probe called it");
  assert.equal(result.waitMs, 500);
});

test("the strongest observation wins: a lead is not erased by a later empty probe", async () => {
  const clock = new FakeClock();
  const scripted = sequenceProbe([
    { state: "lead", chars: 31 },
    { state: "none", chars: 0 },
    { state: "none", chars: 0 },
  ]);
  const result = await waitForAi(
    page(),
    { probe: scripted.probe },
    { clock, pollMs: 100, deadlineMs: 300, noneGraceMs: 0, rng: STEADY },
  );

  assert.equal(result.state, "lead");
  assert.equal(result.chars, 31);
  assert.equal(result.timedOut, true);
});

test("a malformed probe payload is treated as nothing seen, never as an answer", async () => {
  const clock = new FakeClock();
  const result = await waitForAi(
    page(),
    { probe: async () => ({ state: "answer", chars: Number.NaN }) as unknown as AiProbe },
    { clock, pollMs: 100, deadlineMs: 400, noneGraceMs: 200, rng: STEADY },
  );

  assert.equal(result.state, "answer", "the state string is kept, but...");
  assert.equal(result.chars, 0, "...a non-finite width is zero");
  assert.equal(result.timedOut, true);
});

test("an aborted wait fails with E_CANCELLED and names the engine", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  controller.abort(
    new WebSearchError({ code: "E_CANCELLED", stage: "settle", retryable: false, hint: "cancelled", message: "cancelled" }),
  );

  await assert.rejects(
    waitForAi(
      page(),
      { probe: async () => ({ state: "none", chars: 0 }) },
      { clock, signal: controller.signal, engine: "google" },
    ),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CANCELLED");
      assert.equal(error.details.engine, "google");
      return true;
    },
  );
});

test("a probe failure is not swallowed: a torn socket is still a failure", async () => {
  const clock = new FakeClock();
  await assert.rejects(
    waitForAi(
      page(),
      {
        probe: async () => {
          throw new Error("socket closed");
        },
      },
      { clock, engine: "yandex" },
    ),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CDP_DISCONNECTED");
      assert.equal(error.details.engine, "yandex");
      return true;
    },
  );
});
}

// ---------------------------------------------------------------------------
// from tests/unit/compact.test.ts
// ---------------------------------------------------------------------------
{
/**
 * P8: only prose of at least `AI_ANSWER_MIN_CHARS` is an answer. Fixtures that
 * want `ai:yes` must carry real answer width; short "Overview" strings are the
 * `ai:lead` case now, by design.
 */
const ANSWER = "A complete answer paragraph with enough prose to be an answer. ".repeat(4).trim();
const ANSWER_SHORT = "A short fragment that is not an answer.";

const OPTS: CompactOptions = {
  n: 5,
  summaryMaxChars: 1200,
  snippetMaxChars: 140,
  outputMaxChars: 2500,
};

function serp(engine: EngineId, results: SerpItem[], overrides: Partial<RawSerp> = {}): RawSerp {
  return {
    engine,
    query: "test query",
    results,
    pageCarried: false,
    timings: {},
    ...overrides,
  };
}

function result(index: number, overrides: Partial<SerpItem> = {}): SerpItem {
  return {
    title: `Result ${index}`,
    url: `https://example.com/r${index}`,
    snippet: `snippet ${index}`,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function headerOf(text: string): string {
  return text.split("\n")[0] ?? "";
}

test("header: exact shape with AI, elapsed, result count", () => {
  const input = [
    serp("google", [1, 2, 3, 4, 5].map((i) => result(i)), {
      ai: { text: ANSWER, sources: ["a.com", "b.com"] },
    }),
  ];
  const out = compactSerps(input, { ...OPTS, elapsedMs: 1400 });

  assert.equal(headerOf(out.text), "google · 5 results · ai:yes · 1.4s");
  assert.equal(out.text.split("\n")[1], `AI: ${ANSWER} [sources: a.com, b.com]`);
  assert.ok(out.text.includes("\n\n1. Result 1 — example.com\n   https://example.com/r1\n   snippet 1"));
  assert.equal(out.chars, out.text.length);
});

test("header: ai:no when no summary, timing omitted when unknown", () => {
  const out = compactSerps([serp("google", [result(1)])], OPTS);
  assert.equal(headerOf(out.text), "google · 1 results · ai:no");
  assert.equal(out.text.includes("AI:"), false);
  assert.equal(out.ai, undefined);
});

test("header: cached and degraded are appended in order", () => {
  const out = compactSerps([serp("yandex", [result(1), result(2)], { degraded: true })], {
    ...OPTS,
    cached: true,
    elapsedMs: 500,
  });
  assert.equal(headerOf(out.text), "yandex · 2 results · ai:no · 0.5s · cached · degraded");
  assert.equal(out.cached, true);
  assert.equal(out.degraded, true);
});

test("mixed engines: canonical label, per-item engine tag only when mixed", () => {
  const input = [
    serp("duckduckgo", [result(2, { url: "https://duck.example/b" })]),
    serp("google", [result(1, { url: "https://google.example/a" })]),
  ];
  const out = compactSerps(input, OPTS);

  assert.equal(out.engineLabel, "google+duckduckgo");
  assert.equal(headerOf(out.text), "google+duckduckgo · 2 results · ai:no");
  // Result order follows the caller's SERP order; only the label is canonical.
  assert.deepEqual(
    out.items.map((item) => item.engine),
    ["duckduckgo", "google"],
  );
  assert.ok(out.text.includes("1. [duckduckgo] Result 2 — duck.example"));
  assert.ok(out.text.includes("2. [google] Result 1 — google.example"));

  const jsonResults = out.data.results as Array<Record<string, unknown>>;
  assert.equal(jsonResults[0]?.engine, "duckduckgo");
  assert.equal(jsonResults[1]?.engine, "google");
});

test("single engine never tags, even when SerpItem.engine is set", () => {
  const out = compactSerps([serp("google", [result(1, { engine: "google" })])], OPTS);
  assert.equal(out.engineLabel, "google");
  assert.equal(out.items[0]?.engine, undefined);
  assert.equal(out.text.includes("[google]"), false);
});

test("ads are dropped before merging and counting", () => {
  const out = compactSerps(
    [
      serp("google", [
        result(1, { isAd: true }),
        result(2),
        result(3, { isAd: false }),
      ]),
    ],
    OPTS,
  );
  assert.equal(out.items.length, 2);
  assert.deepEqual(
    out.items.map((item) => item.url),
    ["https://example.com/r2", "https://example.com/r3"],
  );
  assert.equal(headerOf(out.text), "google · 2 results · ai:no");
});

test("dedup by normalized URL keeps the first title and the longest snippet", () => {
  const input = [
    serp("google", [
      result(1, {
        title: "First title",
        url: "https://example.com/a?utm_source=google&gclid=1",
        snippet: "short",
      }),
    ]),
    serp("duckduckgo", [
      result(2, {
        title: "Second title",
        url: "https://example.com/a?utm_source=ddg",
        snippet: "a considerably longer snippet from the other engine",
      }),
    ]),
  ];
  const out = compactSerps(input, OPTS);

  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.title, "First title");
  assert.equal(out.items[0]?.snippet, "a considerably longer snippet from the other engine");
  assert.equal(out.items[0]?.url, "https://example.com/a");
  assert.equal(out.items[0]?.domain, "example.com");
  assert.ok(out.text.includes("https://example.com/a\n"));
  assert.equal(out.text.includes("utm_source"), false);
});

test("same-domain results are capped at two unless n needs more", () => {
  const input = [
    serp(
      "google",
      [1, 2, 3, 4, 5].map((i) => result(i, { url: `https://example.com/p${i}` })),
    ),
  ];

  const capped = compactSerps(input, { ...OPTS, n: 2 });
  assert.equal(capped.items.length, 2);
  assert.deepEqual(
    capped.items.map((item) => item.url),
    ["https://example.com/p1", "https://example.com/p2"],
  );

  const widened = compactSerps(input, { ...OPTS, n: 3 });
  assert.equal(widened.items.length, 3);
  assert.equal(widened.items[2]?.url, "https://example.com/p3");
});

test("n is respected and clamped to the supported ceiling", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    result(i + 1, { url: `https://site${i}.example/p` }),
  );
  const out = compactSerps([serp("google", many)], { ...OPTS, n: 5 });
  assert.equal(out.items.length, 5);
  assert.equal(headerOf(out.text), "google · 5 results · ai:no");

  const clamped = compactSerps([serp("google", many)], { ...OPTS, n: 50 });
  assert.ok(clamped.items.length <= COMPACT_CAPS.maxN);
});

test("AI text and snippets are capped with an ellipsis inside the cap", () => {
  const out = compactSerps(
    [
      serp("google", [result(1, { snippet: "b".repeat(2000) })], {
        ai: { text: "a".repeat(5000), sources: ["a.com"] },
      }),
    ],
    OPTS,
  );

  assert.ok(out.ai);
  // The AI *block* (prefix + text + sources + newline) fits the 1200-char AI
  // budget, so the text itself is ≤1200 once the source suffix is counted.
  assert.ok(out.aiChars <= 1200, `aiChars ${out.aiChars} > 1200`);
  assert.ok(out.ai?.text.length <= 1200);
  assert.equal(out.ai?.text.endsWith("…"), true);
  assert.equal(out.items[0]?.snippet.length, 140);
  assert.equal(out.items[0]?.snippet.endsWith("…"), true);
  assert.ok(out.text.length <= 2500);
  assert.equal(out.truncated, true);
});

test("budget split: a 1200-char AI at the default cap never starves n results", () => {
  // Adversarial shape: titles + URLs alone nearly fill the 2500-char cap, so the
  // summary can only survive if the results floor was reserved first. With the
  // short `result()` fixture this test passes even on AI-first code (the summary
  // eats a result instead); these sizes make that regression observable.
  const results = [1, 2, 3, 4, 5].map((i) =>
    result(i, {
      title: "T".repeat(120),
      url: `https://example.com/${"p".repeat(159)}${i}`,
      snippet: "s".repeat(200),
    }),
  );
  const input = [
    serp("google", results, {
      ai: { text: "x".repeat(1200), sources: ["a.com", "b.com"] },
    }),
  ];
  const out = compactSerps(input, OPTS);

  assert.equal(out.items.length, 5, "the results floor is reserved before the AI is capped");
  assert.ok(out.ai, "the summary still gets whatever is left");
  assert.ok(out.ai.text.length > 0);
  assert.ok(
    out.ai.text.length < 1200,
    "the summary must absorb the loss, not the result list",
  );
  assert.ok(out.text.length <= 2500);
  for (const item of out.items) {
    assert.equal(item.url.length, 180, `fixture URL too short: ${item.url.length}`);
    assert.ok(out.text.includes(item.url), "URL was cut");
  }
  assert.equal(out.truncated, true, "AI text was cut to its own budget");
});


test("when the results floor does not fit, results win and the AI is dropped", () => {
  const input = [
    serp("google", [1, 2, 3, 4, 5].map((i) => result(i)), {
      ai: { text: "x".repeat(300), sources: [] },
    }),
  ];
  const out = compactSerps(input, { ...OPTS, outputMaxChars: 250 });

  // A 250-char cap cannot hold five items even at 100-char snippets, so the AI
  // budget collapses to 0. The documented rule is shape-based, not floor-based:
  // an AI block needs at least AI_MIN_BLOCK (6) chars — the newline, `AI: ` and
  // one prose char — so any budget ≤ 5 drops the summary and results keep the
  // space. Results are trimmed truthfully; URLs stay intact.
  assert.equal(out.ai, undefined, "no AI budget is stolen from the results floor");
  assert.equal(out.aiChars, 0);
  assert.ok(out.items.length > 0);
  assert.ok(out.items.length < 5);
  assert.ok(out.text.length <= 250);
  for (const item of out.items) assert.ok(out.text.includes(item.url), "URL was cut");
  assert.equal(out.truncated, true);
});

test("AI block: a 6-char budget renders `AI: …`, a 5-char budget drops it", () => {
  // The summary is dropped for space only when its block is narrower than the
  // documented minimum (`\nAI: x` = 6 chars); it is not tied to the results floor.
  // With no results the whole cap is the AI budget, so the boundary is exact.
  const input = [serp("google", [], { ai: { text: "x".repeat(300), sources: [] } })];
  const headerLen = "google · 0 results · ai:yes".length;
  // The budget reserves the widest possible AI header (`ai:lead`, one char wider
  // than `ai:yes`), which is what makes the boundary honest before the state is
  // final: a dropped answer must not leave a `yes` header with no line.
  const reserve = "google · 0 results · ai:lead".length;

  const tooNarrow = compactSerps(input, { ...OPTS, outputMaxChars: reserve + 5 });
  assert.equal(tooNarrow.ai, undefined, "5 chars cannot hold the newline + prefix + prose char");
  assert.equal(tooNarrow.aiChars, 0);
  assert.equal(tooNarrow.text, "google · 0 results · ai:no");

  const minimum = compactSerps(input, { ...OPTS, outputMaxChars: reserve + 6 });
  assert.ok(minimum.ai, "exactly 6 chars is the smallest renderable AI block");
  assert.equal(minimum.ai?.text, "…");
  assert.equal(minimum.aiChars, 6);
  assert.equal(minimum.text, "google · 0 results · ai:yes\nAI: …");
  assert.equal(minimum.chars, headerLen + 6);
});

test("when nothing fits but the header, the AI cannot outlive the results either", () => {
  const results = [1, 2, 3].map((i) =>
    result(i, {
      title: `Result ${i} `.padEnd(60, "r"),
      url: `https://site${i}.example/${"p".repeat(50)}`,
      snippet: "s".repeat(140),
    }),
  );
  const input = [
    serp("google", results, {
      ai: { text: "y".repeat(2000), sources: ["a.com", "b.com"] },
    }),
  ];
  const out = compactSerps(input, { ...OPTS, outputMaxChars: 300 });

  assert.equal(out.ai, undefined);
  assert.ok(out.items.length > 0, "results are the product; the summary is the bonus");
  assert.ok(out.items.length < 3);
  assert.ok(out.text.length <= 300);
  assert.equal(headerOf(out.text).startsWith("google · 1 results · ai:no"), true);
  assert.equal(out.truncated, true);
});

test("AI alone is still rendered when there are no results to compete with", () => {
  const out = compactSerps([serp("google", [], { ai: { text: ANSWER, sources: ["a.com"] } })], OPTS);
  assert.ok(out.ai);
  assert.equal(out.items.length, 0);
  assert.ok(out.aiChars > 0);
  assert.equal(out.resultsChars, 0);
  assert.ok(out.text.includes(`AI: ${ANSWER} [sources: a.com]`));
});

test("worst case: 140-char titles + 180-215-char URLs + 1200-char AI at n=5", () => {
  // Adversarial-but-realistic shape from live SERPs: the floor must still fit,
  // and the AI has to survive inside its own budget instead of eating a result.
  const title = "T".repeat(140);
  const urlLengths = [180, 186, 192, 198, 204];
  const results = urlLengths.map((length, i) => {
    const prefix = `https://news.example.com/2026/11/06/article-${i + 1}-`;
    return result(i + 1, {
      title,
      url: prefix + "slug".repeat(Math.ceil((length - prefix.length) / 4)).slice(0, length - prefix.length),
      snippet: "s".repeat(220),
    });
  });
  const out = compactSerps([serp("google", results, {
    ai: { text: "a".repeat(1200), sources: ["a.com", "b.com"] },
  })], OPTS);

  assert.equal(out.items.length, 5, "the floor must fit all five results");
  assert.ok(out.ai, "a small AI budget remains and must be used, not wasted");
  assert.ok((out.ai?.text.length ?? 0) > 0);
  assert.ok(out.text.length <= 2500, `text ${out.text.length} > 2500`);
  for (const item of out.items) {
    assert.ok(item.url.length >= 180, `fixture URL too short: ${item.url.length}`);
    assert.ok(out.text.includes(item.url), "URL was cut");
    assert.ok(item.title.length <= 200);
  }
  assert.equal(out.truncated, true, "snippets fell 140 → 100 and the AI was cut");
});

test("AI absent: results may use the whole output budget (no 1300-char cap)", () => {
  const results = Array.from({ length: 5 }, (_, i) =>
    result(i + 1, { title: "t".repeat(100), url: `https://site${i}.example/${"p".repeat(70)}`, snippet: "s".repeat(140) }),
  );
  const out = compactSerps([serp("google", results)], OPTS);

  assert.equal(out.items.length, 5);
  assert.equal(out.ai, undefined);
  assert.equal(out.aiChars, 0);
  assert.ok(out.chars > 1300, `chars ${out.chars}: results must not stop at an AI-era cap`);
  assert.ok(out.chars <= 2500);
  for (const item of out.items) assert.equal(item.snippet.length, 140);
  assert.equal(out.truncated, false);
});

test("n=10 with AI: the floor keeps ten results, the summary gets the remainder", () => {
  const results = Array.from({ length: 10 }, (_, i) =>
    result(i + 1, {
      title: `Result ${i + 1} `.padEnd(40, "t"),
      url: `https://site${i}.example/page/${"a".repeat(30)}`,
      snippet: "s".repeat(200),
    }),
  );
  const out = compactSerps([serp("google", results, { ai: { text: "x".repeat(1200), sources: [] } })], {
    ...OPTS,
    n: 10,
  });

  assert.equal(out.items.length, 10);
  assert.ok(out.ai);
  assert.ok((out.ai?.text.length ?? 0) > 0);
  assert.ok(out.aiChars <= 1200);
  assert.ok(out.text.length <= 2500);
  for (const item of out.items) {
    assert.ok(item.snippet.length <= COMPACT_CAPS.fallbackSnippetMaxChars);
  }
  assert.equal(out.truncated, true);
});

test("n=10 trim path: snippets fall to 100 chars before any result is dropped", () => {
  const results = Array.from({ length: 10 }, (_, i) =>
    result(i + 1, {
      title: `title ${i + 1} `.padEnd(60, "t"),
      url: `https://site${i}.example/page/1234567890`,
      snippet: "s".repeat(140),
    }),
  );
  const out = compactSerps([serp("google", results)], { ...OPTS, n: 10 });

  assert.equal(out.items.length, 10, "the 100-char fallback should be enough at n=10");
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 2500);
  for (const item of out.items) {
    assert.ok(item.snippet.length <= COMPACT_CAPS.fallbackSnippetMaxChars);
  }
});

test("pageCarried: propagated from input or inferred when more merged results exist than n", () => {
  const flagged = compactSerps([serp("google", [result(1)], { pageCarried: true })], OPTS);
  assert.equal(flagged.pageCarried, true);
  assert.equal(flagged.text.endsWith("\npage: more results available"), true);

  const many = Array.from({ length: 7 }, (_, i) =>
    result(i + 1, { url: `https://site${i}.example/p` }),
  );
  const inferred = compactSerps([serp("google", many)], { ...OPTS, n: 5 });
  assert.equal(inferred.pageCarried, true);
  assert.equal(inferred.text.endsWith("page: more results available"), true);

  const quiet = compactSerps([serp("google", [result(1), result(2)])], OPTS);
  assert.equal(quiet.pageCarried, false);
  assert.equal(quiet.text.includes("page: more results available"), false);
});

test("invalid or non-http results are dropped, empty snippets do not break the format", () => {
  const out = compactSerps(
    [
      serp("google", [
        result(1, { url: "javascript:alert(1)" }),
        result(2, { url: "" }),
        result(3, { url: "ftp://example.com/file" }),
        result(4, { snippet: "" }),
      ]),
    ],
    OPTS,
  );
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]?.url, "https://example.com/r4");
  assert.equal(out.text.includes("\n   \n"), false);
  assert.ok(out.text.includes("1. Result 4 — example.com\n   https://example.com/r4"));
});

test("AI sources are de-duplicated and only rendered when present", () => {
  const withSources = compactSerps(
    [serp("google", [result(1)], { ai: { text: ANSWER, sources: ["a.com", "a.com", "", "b.com"] } })],
    OPTS,
  );
  assert.deepEqual(withSources.ai?.sources, ["a.com", "b.com"]);
  assert.ok(withSources.text.includes(`AI: ${ANSWER} [sources: a.com, b.com]`));

  const withoutSources = compactSerps(
    [serp("google", [result(1)], { ai: { text: ANSWER, sources: [] } })],
    OPTS,
  );
  assert.equal(withoutSources.text.includes(`AI: ${ANSWER}\n`), true);
});

test("AI block: a long source list is trimmed before the prose is cut", () => {
  // Eight 120-char sources render a 986-char suffix. Paying it in full would leave
  // the 1200-char overview only ~209 prose chars; the source share cap drops the
  // tail of the list and the prose keeps most of the budget (prose > decoration).
  const longSources = Array.from({ length: 8 }, (_, i) => `s${i}`.padEnd(120, "x"));
  const fullSuffix = ` [sources: ${longSources.join(", ")}]`.length;
  const legacyProse = 1200 - 1 - 4 - fullSuffix;

  const out = compactSerps(
    [serp("google", [], { ai: { text: "x".repeat(1200), sources: longSources } })],
    OPTS,
  );

  assert.ok(out.ai);
  assert.ok(out.ai.sources.length < longSources.length, "the source list was not reduced");
  assert.ok(out.ai.sources.length > 0, "at least one source should survive the slim list");
  assert.deepEqual(out.ai.sources, longSources.slice(0, out.ai.sources.length));
  assert.ok(
    out.ai.text.length > legacyProse,
    `prose ${out.ai.text.length} did not gain on the legacy ${legacyProse}`,
  );
  assert.ok(out.ai.text.length > 800, `prose ${out.ai.text.length} is too short`);
  assert.ok(out.aiChars <= 1200, `aiChars ${out.aiChars} > 1200`);
  assert.ok(out.text.length <= 2500);
  assert.equal(out.ai.text.endsWith("…"), true);
  assert.equal(out.truncated, true);
});

test("json schema: exact key set, documented optional keys and identical caps", () => {
  const out = compactSerps(
    [
      serp("google", [result(1, { snippet: "b".repeat(500) })], {
        ai: { text: "a".repeat(5000), sources: ["a.com"] },
      }),
    ],
    { ...OPTS, cached: true },
  );

  assert.deepEqual(Object.keys(out.data).sort(), [
    "ai",
    "cached",
    "chars",
    "engine",
    "pageCarried",
    "query",
    "results",
    "truncated",
  ]);
  assert.equal(out.data.engine, "google");
  assert.equal(out.data.query, "test query");
  assert.equal(out.data.pageCarried, false);
  assert.equal(out.data.chars, out.text.length);
  assert.equal(out.data.truncated, out.truncated);

  const jsonAi = out.data.ai as { text: string; sources: string[] };
  assert.ok(jsonAi.text.length <= 1200);
  assert.equal(jsonAi.text.endsWith("…"), true);
  assert.deepEqual(jsonAi.sources, ["a.com"]);

  const jsonResults = out.data.results as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(jsonResults[0] ?? {}).sort(), ["domain", "snippet", "title", "url"]);
  assert.equal(String(jsonResults[0]?.snippet).length, 140);
});

test("json schema: degraded only appears when true and never as false", () => {
  const plain = compactSerps([serp("google", [result(1)])], OPTS);
  assert.deepEqual(Object.keys(plain.data).sort(), [
    "chars",
    "engine",
    "pageCarried",
    "query",
    "results",
    "truncated",
  ]);

  const degraded = compactSerps([serp("duckduckgo", [result(1)], { degraded: true })], OPTS);
  assert.equal(degraded.data.degraded, true);
  assert.equal(degraded.data.cached, undefined);
});

test("budget split: aiChars/resultsChars sum back to the rendered text", () => {
  const withAi = compactSerps(
    [serp("google", [1, 2, 3, 4, 5].map((i) => result(i)), {
      ai: { text: "a".repeat(900), sources: ["a.com"] },
    })],
    { ...OPTS, elapsedMs: 900 },
  );
  assert.ok(withAi.ai);
  assert.ok(withAi.aiChars > 0);
  assert.ok(withAi.resultsChars > 0);
  assert.equal(withAi.items.length, 5);

  const page = withAi.text.endsWith("page: more results available")
    ? "\npage: more results available".length
    : 0;
  assert.equal(
    headerOf(withAi.text).length + withAi.aiChars + withAi.resultsChars + page,
    withAi.text.length,
  );
  assert.ok(withAi.aiChars + withAi.resultsChars + headerOf(withAi.text).length <= withAi.text.length);

  const withoutAi = compactSerps([serp("google", [result(1), result(2)])], OPTS);
  assert.equal(withoutAi.ai, undefined);
  assert.equal(withoutAi.aiChars, 0);
  assert.ok(withoutAi.resultsChars > 0);
  assert.equal(headerOf(withoutAi.text).length + withoutAi.resultsChars, withoutAi.text.length);
});

test("empty input produces an honest, empty result", () => {
  const out = compactSerps([], OPTS);
  assert.equal(out.engineLabel, "none");
  assert.equal(out.items.length, 0);
  assert.equal(out.ai, undefined);
  assert.equal(out.text, "none · 0 results · ai:no");
  assert.equal(out.chars, out.text.length);
});

test("inputs are never mutated", () => {
  const input = deepFreeze([
    serp(
      "google",
      [result(1, { url: "https://example.com/a?utm_source=x", snippet: "s".repeat(500) })],
      { ai: { text: "summary", sources: ["a.com"] }, pageCarried: true },
    ),
  ]);
  const before = JSON.stringify(input);
  compactSerps(input, OPTS);
  assert.equal(JSON.stringify(input), before);
});

test("deterministic: identical input yields identical text and json", () => {
  const input = [
    serp("google", [result(1), result(2, { url: "https://example.com/r1?utm_source=z" })]),
    serp("duckduckgo", [result(3, { url: "https://other.example/x" })], {
      ai: { text: "summary", sources: ["a.com"] },
    }),
  ];
  const first = compactSerps(input, { ...OPTS, elapsedMs: 1234 });
  const second = compactSerps(input, { ...OPTS, elapsedMs: 1234 });
  assert.equal(first.text, second.text);
  assert.equal(JSON.stringify(first.data), JSON.stringify(second.data));
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANDOM_CHARS = ["a", "b", "c", "word", " ", "—", "\n", "\t", "😀", "ü"];

function randomText(rng: () => number, maxLength: number): string {
  let text = "";
  while (text.length < maxLength) {
    text += RANDOM_CHARS[Math.floor(rng() * RANDOM_CHARS.length)] ?? "a";
  }
  return text.slice(0, maxLength);
}

test("property: 500 seeded SERPs always fit outputMaxChars and the per-field caps", () => {
  const rng = mulberry32(0x5eed);
  const engines: EngineId[] = ["google", "duckduckgo", "yandex"];
  const hosts = ["example.com", "www.example.org", "news.example.net"];
  const paths = ["a", "b", "c", "d", "e"];

  for (let caseIndex = 0; caseIndex < 500; caseIndex++) {
    const engineCount = 1 + Math.floor(rng() * engines.length);
    const chosen = engines.slice(0, engineCount);
    const serps: RawSerp[] = chosen.map((engine) => {
      const count = 1 + Math.floor(rng() * 10);
      const results: SerpItem[] = Array.from({ length: count }, (_, i) => {
        const tracking = rng() < 0.3 ? "?utm_source=x&gclid=1&from=serp" : "";
        const path = rng() < 0.5 ? (paths[Math.floor(rng() * paths.length)] ?? "a") : `p${caseIndex}-${i}`;
        const host = hosts[Math.floor(rng() * hosts.length)] ?? "example.com";
        return {
          title: randomText(rng, Math.floor(rng() * 120)),
          url: `https://${host}/${path}${tracking}`,
          snippet: randomText(rng, Math.floor(rng() * 2000)),
          isAd: rng() < 0.1,
        };
      });
      const withAi = rng() < 0.5;
      return serp(engine, results, {
        query: `query ${caseIndex}`,
        ai: withAi
          ? { text: randomText(rng, Math.floor(rng() * 5000)), sources: ["a.com", "b.com", "a.com"] }
          : undefined,
        pageCarried: rng() < 0.3,
        degraded: rng() < 0.2,
      });
    });

    // n ≤ 5 keeps the worst-case floor comfortably inside 2500 even with
    // 120-char random titles, so the "AI must not starve results" invariant is
    // checkable for every case; the n=10 path has its own deterministic test.
    const n = 1 + Math.floor(rng() * 5);
    const opts: CompactOptions = { n, summaryMaxChars: 1200, snippetMaxChars: 140, outputMaxChars: 2500 };
    const out = compactSerps(serps, opts);

    const distinct = new Set<string>();
    for (const s of serps) {
      for (const r of s.results) {
        if (r.isAd === true || !isHttpUrl(r.url)) continue;
        const normalized = normalizeUrl(r.url);
        if (normalized) distinct.add(normalized);
      }
    }
    const target = Math.min(n, distinct.size);
    // `hasAi` means "an answer candidate" now: a short random fragment is a
    // legitimate `ai:lead`, and the invariant below is about answers only.
    const hasAi = serps.some((s) => {
      const text = (s.ai?.text ?? "").replace(/\s+/g, " ").trim();
      return text.length >= AI_ANSWER_MIN_CHARS && text.toLowerCase() !== s.query.toLowerCase();
    });

    assert.ok(out.text.length <= 2500, `case ${caseIndex}: text ${out.text.length} > 2500`);
    assert.equal(out.chars, out.text.length);
    assert.ok(out.items.length <= target, `case ${caseIndex}: ${out.items.length} items > target=${target}`);
    assert.ok(out.items.length <= COMPACT_CAPS.maxN);

    // The split invariant: header + AI block + results block (+ page marker)
    // accounts for the rendered text exactly, and never exceeds it.
    assert.equal(out.aiChars > 0, out.ai !== undefined, `case ${caseIndex}: aiChars/ai disagree`);
    assert.equal(out.resultsChars > 0, out.items.length > 0, `case ${caseIndex}: resultsChars/items disagree`);
    assert.ok(out.aiChars <= 1200, `case ${caseIndex}: AI block ${out.aiChars} > 1200`);
    const pageLen = out.text.endsWith("page: more results available")
      ? "\npage: more results available".length
      : 0;
    assert.equal(
      headerOf(out.text).length + out.aiChars + out.resultsChars + pageLen,
      out.text.length,
      `case ${caseIndex}: budget split does not add up`,
    );
    assert.ok(
      out.aiChars + out.resultsChars + headerOf(out.text).length <= out.text.length,
      `case ${caseIndex}: split exceeds total`,
    );

    if (out.ai) assert.ok(out.ai.text.length <= 1200, `case ${caseIndex}: ai too long`);
    for (const item of out.items) {
      assert.ok(item.snippet.length <= 140, `case ${caseIndex}: snippet too long`);
      assert.ok(out.text.includes(item.url), `case ${caseIndex}: URL was cut`);
      assert.ok(item.url.startsWith("https://"));
      assert.equal(item.url.includes("utm_source"), false);
    }

    const urls = out.items.map((item) => item.url);
    assert.equal(new Set(urls).size, urls.length, `case ${caseIndex}: duplicate URLs`);

    // New policy: with at least n distinct results and an AI summary, the floor
    // fits at n≤5, so exactly n items and a non-empty summary must survive.
    if (hasAi && distinct.size >= n) {
      assert.equal(out.items.length, n, `case ${caseIndex}: AI starved results to ${out.items.length}/${n}`);
      assert.ok(out.ai, `case ${caseIndex}: summary missing although the floor fits`);
      assert.ok((out.ai?.text.length ?? 0) > 0, `case ${caseIndex}: empty summary`);
    } else if (out.ai) {
      assert.equal(out.items.length, target, `case ${caseIndex}: AI present but items trimmed`);
    }

    if (out.pageCarried) {
      assert.equal(out.text.endsWith("page: more results available"), true);
    }

    const jsonResults = out.data.results as Array<Record<string, unknown>>;
    for (const jsonItem of jsonResults) {
      assert.equal(typeof jsonItem.url, "string");
      assert.ok(String(jsonItem.snippet).length <= 140);
    }
  }
});

test("property: n=6..10 short SERPs keep exactly n results next to a non-empty AI", () => {
  // The 500-case pass caps n at 5 because random 120-char titles can push the
  // floor past 2500 at n=10. This pass uses short, bounded titles/URLs so the
  // floor always fits, which makes the "ai:yes ⇒ exactly n items" claim
  // property-checked across the whole supported range, not just the default n=5.
  const rng = mulberry32(0xc0ffee);
  const engines: EngineId[] = ["google", "duckduckgo", "yandex"];
  const hosts = ["a.test", "bb.test", "ccc.test"];

  for (let caseIndex = 0; caseIndex < 300; caseIndex++) {
    const n = 6 + Math.floor(rng() * 5); // 6..10
    const engine = engines[Math.floor(rng() * engines.length)] ?? "google";
    const host = hosts[Math.floor(rng() * hosts.length)] ?? "a.test";
    const results: SerpItem[] = Array.from({ length: n }, (_, i) => ({
      // Short on purpose: worst case here is ~170 chars per item at the 100-char
      // snippet floor, so 10 items + header + a non-empty AI fit inside 2500.
      title: `Item ${caseIndex}-${i} ${"t".repeat(Math.floor(rng() * 12))}`,
      url: `https://${host}/p${caseIndex}/${i}`,
      snippet: randomText(rng, Math.floor(rng() * 400)),
    }));
    const serps = [
      serp(engine, results, {
        query: `query ${caseIndex}`,
        ai: {
          // Non-empty by construction: an all-whitespace random value would be
          // collapsed away and turn this into a no-AI case.
          // ≥200 chars by construction (V8.1): this pass is about answers.
          text: `summary ${caseIndex} ${randomText(rng, 200 + Math.floor(rng() * 1800))}`,
          sources: ["a.com", "b.com"],
        },
      }),
    ];

    const out = compactSerps(serps, {
      n,
      summaryMaxChars: 1200,
      snippetMaxChars: 140,
      outputMaxChars: 2500,
    });

    assert.ok(out.text.length <= 2500, `case ${caseIndex} (n=${n}): text ${out.text.length} > 2500`);
    assert.equal(out.chars, out.text.length);
    assert.equal(
      out.items.length,
      n,
      `case ${caseIndex} (n=${n}): got ${out.items.length} items, AI must not starve results`,
    );
    assert.equal(headerOf(out.text).includes("ai:yes"), true, `case ${caseIndex} (n=${n}): header lost ai:yes`);
    assert.ok(out.ai, `case ${caseIndex} (n=${n}): summary missing although the floor fits`);
    assert.ok((out.ai?.text.length ?? 0) > 0, `case ${caseIndex} (n=${n}): empty summary`);
    assert.ok(out.aiChars >= 6 && out.aiChars <= 1200, `case ${caseIndex} (n=${n}): aiChars ${out.aiChars}`);
    assert.equal(out.pageCarried, false, `case ${caseIndex} (n=${n}): unexpected page marker`);
    for (const item of out.items) {
      assert.ok(out.text.includes(item.url), `case ${caseIndex} (n=${n}): URL was cut`);
      assert.ok(item.snippet.length <= 140, `case ${caseIndex} (n=${n}): snippet too long`);
    }
  }
});

// ---------------------------------------------------------------------------
// P8: three AI states
// ---------------------------------------------------------------------------

test("a lead-only block renders `ai:lead`, no AI line and no answer claim", () => {
  const out = compactSerps(
    [serp("google", [result(1)], { ai: { text: ANSWER_SHORT, sources: [], state: "lead" } })],
    OPTS,
  );
  assert.equal(headerOf(out.text), "google · 1 results · ai:lead");
  assert.equal(out.text.includes("AI:"), false, "a lead has no answer line");
  assert.equal(out.ai, undefined);
  assert.equal(out.aiState, "lead");
  assert.equal(out.aiChars, 0);
  assert.deepEqual(out.data.ai, undefined);
  assert.equal(out.data.aiState, "lead");
});

test("V8.1: a short or query-echo text can never be rendered as ai:yes", () => {
  const cases: Array<{ text: string; state?: "answer" | "lead" }> = [
    { text: ANSWER_SHORT, state: "answer" },
    { text: "test query", state: "answer" },
    { text: "  Test   Query  ", state: "answer" },
    { text: "x".repeat(199), state: "answer" },
  ];
  for (const { text, state } of cases) {
    const out = compactSerps([serp("google", [result(1)], { ai: { text, sources: [], ...(state ? { state } : {}) } })], OPTS);
    assert.equal(headerOf(out.text).includes("ai:yes"), false, JSON.stringify(text.slice(0, 40)));
    assert.equal(out.ai, undefined);
    assert.equal(out.aiState, "lead");
  }

  const exact = compactSerps([serp("google", [result(1)], { ai: { text: "x".repeat(200), sources: [] } })], OPTS);
  assert.equal(headerOf(exact.text).includes("ai:yes"), true, "200 chars is the documented floor");
  assert.ok(exact.ai);

  // A declared `none` stays none even if a hostile payload carries long text.
  const declaredNone = compactSerps(
    [serp("google", [result(1)], { ai: { text: ANSWER, sources: [], state: "none" } })],
    OPTS,
  );
  assert.equal(declaredNone.aiState, "none");
  assert.equal(headerOf(declaredNone.text).includes("ai:no"), true);
});

test("an answer from any engine wins over a lead from an earlier one", () => {
  const out = compactSerps(
    [
      serp("duckduckgo", [result(1, { url: "https://ddg.example/a" })], {
        ai: { text: ANSWER_SHORT, sources: [], state: "lead" },
      }),
      serp("google", [result(2, { url: "https://google.example/b" })], {
        ai: { text: ANSWER, sources: [], state: "answer" },
      }),
    ],
    OPTS,
  );
  assert.equal(headerOf(out.text), "google+duckduckgo · 2 results · ai:yes");
  assert.equal(out.ai?.text, ANSWER);
  assert.equal(out.aiState, "answer");
});

test("an answer dropped for space leaves no `ai:yes` header behind", () => {
  const input = [
    serp("google", [1, 2, 3].map((i) => result(i, { url: `https://example.com/${"p".repeat(80)}${i}` })), {
      ai: { text: "z".repeat(1200), sources: [], state: "answer" },
    }),
  ];
  const out = compactSerps(input, { ...OPTS, outputMaxChars: 260 });
  assert.equal(out.ai, undefined);
  assert.equal(out.aiState, "none", "no AI is rendered, so the header must not claim one");
  assert.equal(headerOf(out.text).includes("ai:yes"), false);
  assert.equal(out.text.length <= 260, true);
});

// ---------------------------------------------------------------------------
// P9-D — per-engine accounting for a merged search
// ---------------------------------------------------------------------------

test("per-engine accounting prints contributions and failed engines", () => {
  const input = [
    serp("google", [result(1), result(2)]),
    serp("duckduckgo", [result(3)]),
  ];
  const out = compactSerps(input, {
    ...OPTS,
    n: 5,
    perEngine: true,
    failedEngines: { yandex: "E_WALL" },
  });

  assert.equal(headerOf(out.text), "google+duckduckgo · 3 results · ai:no · google:2 duckduckgo:1 yandex:0(E_WALL)");
  assert.deepEqual(out.data.perEngine, { google: 2, duckduckgo: 1, yandex: 0 });
  assert.deepEqual(out.data.failedEngines, { yandex: "E_WALL" });
  // Item-level engine tags are needed to attribute the counts.
  assert.ok(out.items.every((item) => item.engine !== undefined));
});

test("per-engine accounting follows the rendered items, not the input", () => {
  const input = [
    serp("google", [result(1), result(2), result(3)]),
    serp("duckduckgo", [result(4), result(5)]),
  ];
  const out = compactSerps(input, { ...OPTS, n: 2, perEngine: true });
  const counts = Object.values(out.data.perEngine as Record<string, number>);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 2, "counts must describe what was printed");
  // An engine that contributed nothing and did not fail is simply absent: the
  // header reports evidence, not a roll call.
  assert.match(headerOf(out.text), /google:2/);
});

test("a single-engine search stays byte-identical without the per-engine flag", () => {
  const input = [serp("google", [result(1), result(2)])];
  const plain = compactSerps(input, OPTS);
  const flagged = compactSerps(input, { ...OPTS, perEngine: true });

  assert.equal(headerOf(plain.text), "google · 2 results · ai:no");
  assert.match(headerOf(flagged.text), /google · 2 results · ai:no · google:2/);
  assert.equal(plain.data.perEngine, undefined);
  assert.equal(plain.items[0]?.engine, undefined);
});
}
