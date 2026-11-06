/**
 * P14 — System 1 v2: the page-quality gate (PLAN-v2 P14-A/B/C).
 *
 * The gate answers one question before a browser read is spent: *is this page
 * worth reading, and can this source be trusted?* These tests pin the three
 * properties that make it safe to wire into `web_read`/`web_research`:
 *
 * - the rules layer is deterministic, offline and refuses only what it can name
 *   (farm host, off-topic path, translated/stuffed text, thin excerpt, unsafe
 *   URL) — it never guesses from a snippet;
 * - the classifier is one batched call per ≤10 pages, it abstains on garbage and
 *   the policy's merge can only *add* a skip, never rescue an unsafe page;
 * - the policy keeps its P5 guarantees: disabled = zero calls, budgets and the
 *   verdict cache stay authoritative, and every decision reaches the log with
 *   real usage/cost.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG, type Config } from "../../src/config.ts";
import {
  BUDGET_LOG_KIND,
  REFLEX_LOG_KIND,
  createPolicy,
  mergePageVerdicts,
  type BackendResult,
  type CallMeta,
  type ReflexBackend,
  type ReflexPolicy,
} from "../../src/reflex/policy.ts";
import {
  createClassifierReflex,
  type ClassifierAnswer,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierRegistry,
  type ClassifierResult,
} from "../../src/reflex/classifier.ts";
import { createRules, judgePage, judgePagesSync } from "../../src/reflex/rules.ts";
import { PAGE_BATCH_MAX, type PageSubject, type PageVerdict, type Reflex } from "../../src/reflex/types.ts";
import { createCache } from "../../src/runtime/cache.ts";
import type { Cache, Logger } from "../../src/runtime/types.ts";
import { FakeClock } from "../helpers/clock.ts";

// ---------------------------------------------------------------------------
// Config, subjects, fake logger
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config["reflex"]> = {}): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.reflex.enabled = true;
  Object.assign(config.reflex, overrides);
  return config;
}

function subject(url: string, title = "", snippet = "", excerpt?: string): PageSubject {
  return { url, title, snippet, ...(excerpt === undefined ? {} : { excerpt }) };
}

function pageVerdict(overrides: Partial<PageVerdict> = {}): PageVerdict {
  return { worth: true, trust: 0.9, kind: "original", reasons: ["model:test"], ...overrides };
}

function meta(overrides: Partial<CallMeta> = {}): CallMeta {
  return { confidence: 0.9, stopReason: "stop", model: "fake-jev", usage: { inputTokens: 40, outputTokens: 10 }, costUsd: 0.00001, ...overrides };
}

// ---------------------------------------------------------------------------
// Rules: P14-A
// ---------------------------------------------------------------------------

test("rules: unsafe shapes are refused and named", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["https://xn--80ak6aa92e.com/download", "punycode homograph", /punycode/],
    ["https://free-prize-giveaway.tk/claim", "abused TLD", /unsafe-tld/],
    ["http://user:pass@example.com/", "credentials in URL", /credentials/],
    ["https://best-casino-bonus.com/play", "gambling host", /unsafe-token/],
    ["https://cheap-viagra-now.shop/order", "pharma host", /unsafe-token/],
    ["https://adult-videos.example/watch", "adult host", /unsafe-token/],
  ];
  for (const [url, label, reason] of cases) {
    const verdict = judgePage(subject(url));
    assert.equal(verdict.worth, false, label);
    assert.equal(verdict.kind, "unsafe", label);
    assert.equal(verdict.trust, 0, label);
    assert.ok(verdict.reasons.some((entry) => reason.test(entry)), `${label}: ${verdict.reasons.join(",")}`);
  }

  const scam = judgePage(subject("https://example.com/article", "Ваш компьютер заражен — позвоните нам"));
  assert.equal(scam.kind, "unsafe");
  assert.equal(scam.worth, false);
});

test("rules: quality is not the rules' job — a farm host or a slop title stays readable", () => {
  // The classifier is the quality judge. The offline floor must not carry
  // hand-maintained farm/trusted lists and pretend they generalise.
  for (const entry of [
    subject("https://sonnik.ru/kot/", "Сонник кот"),
    subject("https://www.kp.ru/woman/sonnik/k-chemu-snyatsya-koshki/", "К чему снятся кошки"),
    subject("https://varfabric.com/blog/tayny-snov/", "Сны про кошек"),
    subject("https://example.com/post", "К чему снится кот", "Машинный перевод статьи с английского."),
    subject("https://en.wikipedia.org/wiki/Cat", "Cat"),
  ]) {
    const verdict = judgePage(entry);
    assert.equal(verdict.worth, true, `${entry.url} must stay readable`);
    assert.equal(verdict.kind, "unknown", entry.url);
    assert.deepEqual(verdict.reasons, ["safety:ok"], entry.url);
  }
});

test("rules: ad/affiliate hosts are refused, login/cart paths cost no read, a PDF still opens", () => {
  const ad = judgePage(subject("https://bit.ly/3xyz"));
  assert.equal(ad.worth, false);
  assert.equal(ad.kind, "slop");

  for (const url of [
    "https://example.com/login",
    "https://learn.microsoft.com/signin",
    "https://shop.example.com/checkout",
  ]) {
    const verdict = judgePage(subject(url));
    assert.equal(verdict.worth, false, url);
    assert.deepEqual(verdict.reasons, ["url:not-content"], url);
  }
  // P12: the PDF branch is supported, so a binary suffix must not be refused.
  assert.equal(judgePage(subject("https://arxiv.org/pdf/2211.17192")).worth, true);
});

test("rules: a snippet or excerpt never changes the verdict (no quality heuristics left)", () => {
  const thin = judgePage(subject("https://example.com/p", "Title", "", "Короткие. Без даты. Без автора. ".repeat(20)));
  assert.equal(thin.worth, true);
  assert.deepEqual(thin.reasons, ["safety:ok"]);
});

test("rules: deterministic, input-ordered, and the batch never abstains", async () => {
  const items = [
    subject("https://sonnik.ru/kot/", "Сонник кот"),
    subject("https://en.wikipedia.org/wiki/Cat", "Cat"),
    subject("https://best-casino-bonus.com/play", "Bonus"),
  ];
  const first = judgePagesSync(items);
  const second = judgePagesSync(items);
  assert.deepEqual(first, second);
  assert.equal(first.length, items.length);
  assert.deepEqual(first.map((entry) => entry.kind), ["unknown", "unknown", "unsafe"]);

  const rules = createRules();
  assert.ok(rules.judgePages !== undefined, "rules must implement the P14 method");
  assert.deepEqual(await rules.judgePages!("q", items), first);
});

// ---------------------------------------------------------------------------
// Policy: P14-B wiring, merge floor, budgets, cache, log
// ---------------------------------------------------------------------------

interface BackendSpy {
  backend: ReflexBackend;
  calls: string[];
  batches: PageSubject[][];
}

function pageBackend(
  impl: (query: string, subjects: readonly PageSubject[]) => BackendResult<PageVerdict[]>,
  overrides: Partial<CallMeta> = {},
): BackendSpy {
  const calls: string[] = [];
  const batches: PageSubject[][] = [];
  const backend: ReflexBackend = {
    async triage(_query, items) {
      calls.push("triage");
      return { value: { keep: items.map((_, index) => index), scores: items.map(() => 1), flags: [] }, meta: meta() };
    },
    async gateRead() {
      calls.push("gate_read");
      return { value: true, meta: meta() };
    },
    async judgePages(query, subjects) {
      calls.push("page_gate");
      batches.push([...subjects]);
      return impl(query, subjects);
    },
    async coverage() {
      calls.push("coverage");
      return { value: { enough: true, next: "stop" }, meta: meta() };
    },
    async route() {
      calls.push("route");
      return { value: { engines: ["google"] }, meta: meta() };
    },
  };
  return { backend, calls, batches };
}

interface Harness {
  policy: ReflexPolicy;
  rows: Record<string, unknown>[];
  cache: Cache;
  clock: FakeClock;
}

function harness(options: {
  config?: Config;
  backend?: ReflexBackend;
  rules?: Reflex;
  withBackend?: boolean;
} = {}): Harness {
  const clock = new FakeClock();
  const cache = createCache({ maxEntries: 50, clock });
  const rows: Record<string, unknown>[] = [];
  const log: Logger = {
    async write(row): Promise<void> {
      rows.push(structuredClone(row));
    },
    path: () => "memory",
  };
  const policy = createPolicy({
    config: options.config ?? makeConfig(),
    clock,
    cache,
    log,
    rules: options.rules ?? createRules(),
    ...(options.withBackend === false || options.backend === undefined ? {} : { backend: options.backend }),
  });
  return { policy, rows, cache, clock };
}

test("policy: the whole gate off (enabled:false, pageGate:false) is the rules-only path", async () => {
  const spy = pageBackend(() => ({ value: [pageVerdict({ worth: true })], meta: meta() }));
  const h = harness({ config: makeConfig({ enabled: false, pageGate: false }), backend: spy.backend });
  const items = [subject("https://sonnik.ru/kot/", "Сонник кот"), subject("https://en.wikipedia.org/wiki/Cat", "Cat")];

  const verdicts = await h.policy.judgePages("q", items);

  assert.deepEqual(verdicts, judgePagesSync(items));
  assert.equal(spy.calls.length, 0, "disabled reflex must never touch the backend");
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.kind, REFLEX_LOG_KIND);
  assert.equal(row.decision, "page_gate");
  assert.equal(row.model, "rules");
  assert.equal(row.fallback, true);
  assert.equal(row.reason, "disabled");
});

test("policy: reflex.pageGate uses the classifier with the rest of the reflex off", async () => {
  const spy = pageBackend((_query, subjects) => ({
    value: subjects.map(() => pageVerdict({ worth: false, kind: "slop" })),
    meta: meta(),
  }));
  const h = harness({ config: makeConfig({ enabled: false, pageGate: true }), backend: spy.backend });
  const item = subject("https://example.com/page", "Page");

  const verdicts = await h.policy.judgePages("q", [item]);

  assert.equal(spy.calls.length, 1, "pageGate is the quality judge even when the reflex is off");
  assert.equal(verdicts[0]?.worth, false);
  assert.equal(h.rows.at(-1)?.model, "fake-jev");
  assert.equal(h.policy.stats().backendCalls, 1);
});

test("policy: a rules-only caller (web_read) never spends a model call", async () => {
  const spy = pageBackend(() => ({ value: [pageVerdict({ worth: false })], meta: meta() }));
  const h = harness({ config: makeConfig({ enabled: true, pageGate: true }), backend: spy.backend });

  const verdicts = await h.policy.judgePages("q", [subject("https://example.com/page")], { backend: "rules" });

  assert.equal(spy.calls.length, 0);
  assert.equal(verdicts[0]?.worth, true, "the safety floor keeps an ordinary page");
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.reason, "rules_only");
  assert.equal(row.fallback, false);
});

test("policy: an explicit rules backend logs a non-fallback rules decision", async () => {
  const h = harness({ config: makeConfig({ backend: "rules" }) });
  await h.policy.judgePages("q", [subject("https://sonnik.ru/kot/", "Сонник кот")]);
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.reason, "backend_rules");
  assert.equal(row.fallback, false);
});

test("policy: a model skip is merged in, an unsafe rules verdict is never rescued", async () => {
  const spy = pageBackend((_query, subjects) => ({
    value: subjects.map((entry) =>
      entry.url.includes("example.com")
        ? pageVerdict({ worth: false, trust: 0.2, kind: "slop", reasons: ["model:slop"] })
        : pageVerdict({ worth: true, trust: 0.9, kind: "original", reasons: ["model:original"] }),
    ),
    meta: meta(),
  }));
  const h = harness({ backend: spy.backend });
  const items = [
    subject("https://example.com/landing", "Landing"),
    subject("https://best-casino-bonus.com/play", "Bonus"),
  ];

  const verdicts = await h.policy.judgePages("q", items);

  assert.equal(verdicts[0]?.worth, false, "the model may add a skip");
  assert.equal(verdicts[0]?.kind, "slop");
  assert.equal(verdicts[1]?.worth, false, "unsafe stays skipped");
  assert.equal(verdicts[1]?.kind, "unsafe", "the model cannot relabel an unsafe page");
  assert.ok(verdicts[1]?.reasons.includes("host:unsafe-token"), "the rules reason is preserved");

  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.model, "fake-jev");
  assert.equal(row.fallback, false);
  assert.equal(row.verdict, "keep=0/2");
  assert.deepEqual(row.usage, { inputTokens: 40, outputTokens: 10 });
  assert.equal(row.costUsd, 0.00001);
  assert.equal(spy.calls.length, 1, "one batch, one backend call");
});

test("policy: merge is idempotent, so the rules fallback can pass through settle", () => {
  const rules = judgePagesSync([
    subject("https://sonnik.ru/kot/", "Сонник кот"),
    subject("https://example.com/x", "X"),
    subject("https://best-casino-bonus.com/play", "Bonus"),
  ]);
  assert.deepEqual(mergePageVerdicts(rules, rules), rules);

  const notContent = judgePagesSync([subject("https://example.com/login")]);
  assert.equal(notContent[0]?.kind, "unknown");
  assert.deepEqual(mergePageVerdicts(notContent, notContent), notContent);
});

test("policy: a low-confidence model batch falls back to rules and says why", async () => {
  const spy = pageBackend(() => ({ value: [pageVerdict({ worth: false, kind: "slop" })], meta: meta({ confidence: 0.2 }) }));
  const h = harness({ backend: spy.backend });
  const item = subject("https://example.com/unknown-host", "Some page");

  const verdicts = await h.policy.judgePages("q", [item]);
  assert.deepEqual(verdicts, judgePagesSync([item]));
  const row = h.rows.at(-1);
  assert.ok(row);
  assert.equal(row.reason, "low_confidence");
  assert.equal(row.fallback, true);
  assert.equal(row.attemptedModel, "fake-jev");
});

test("policy: a malformed batch is rejected as invalid_verdict, not trusted", async () => {
  const spy = pageBackend(() => ({
    value: [{ worth: "yes", trust: 2, kind: "wat", reasons: [] }] as unknown as PageVerdict[],
    meta: meta(),
  }));
  const h = harness({ backend: spy.backend });
  const item = subject("https://example.com/x", "X");

  const verdicts = await h.policy.judgePages("q", [item]);
  assert.deepEqual(verdicts, judgePagesSync([item]));
  assert.equal(h.rows.at(-1)?.reason, "invalid_verdict");
});

test("policy: one batch is one budget call, and the cap stops the next batch", async () => {
  const spy = pageBackend((_query, subjects) => ({ value: subjects.map(() => pageVerdict()), meta: meta() }));
  const h = harness({ backend: spy.backend, config: makeConfig({ maxCallsPerSearch: 1 }) });

  await h.policy.judgePages("q", Array.from({ length: PAGE_BATCH_MAX }, (_, index) => subject(`https://example.com/${index}`)));
  await h.policy.judgePages("q", [subject("https://example.com/second")]);

  assert.equal(spy.calls.length, 1, "a ten-page batch must cost one call");
  assert.equal(h.policy.stats().backendCalls, 1);
  assert.equal(h.policy.stats().budgetStops, 1);
  const budget = h.rows.find((row) => row.kind === BUDGET_LOG_KIND);
  assert.ok(budget);
  assert.equal(budget.reason, "max_calls_per_search");
});

test("policy: the 24 h verdict cache answers a repeated batch without a call", async () => {
  const spy = pageBackend((_query, subjects) => ({ value: subjects.map(() => pageVerdict()), meta: meta() }));
  const h = harness({ backend: spy.backend });
  const items = [subject("https://example.com/a"), subject("https://example.com/b")];

  await h.policy.judgePages("q", items);
  await h.policy.judgePages("q", items);

  assert.equal(spy.calls.length, 1);
  assert.equal(h.policy.stats().cacheHits, 1);
  const cached = h.rows.at(-1);
  assert.ok(cached);
  assert.equal(cached.cached, true);
  assert.equal(cached.costUsd, 0);
});

test("policy: at most PAGE_BATCH_MAX pages per decision, and URLs are logged without query strings", async () => {
  const spy = pageBackend((_query, subjects) => ({ value: subjects.map(() => pageVerdict()), meta: meta() }));
  const h = harness({ backend: spy.backend });
  const items = Array.from({ length: PAGE_BATCH_MAX + 3 }, (_, index) =>
    subject(`https://example.com/${index}?token=secret-${index}`),
  );

  const verdicts = await h.policy.judgePages("q", items);

  assert.equal(verdicts.length, PAGE_BATCH_MAX);
  assert.equal(spy.batches[0]?.length, PAGE_BATCH_MAX);
  const row = h.rows.at(-1);
  assert.ok(row);
  // A batch decision has no single URL; the log carries none, and nothing in it
  // may leak the query strings the callers passed.
  assert.equal(row.url, undefined);
  assert.equal(JSON.stringify(row).includes("token="), false, "query strings must never be logged");
});

// ---------------------------------------------------------------------------
// Classifier: one batched call, strict mapping, abstention
// ---------------------------------------------------------------------------

interface CallRecord {
  model: ClassifierModel;
  context: ClassifierContext;
}

class FakeRegistry implements ClassifierRegistry {
  readonly calls: CallRecord[] = [];
  readonly models: ClassifierModel[] = [{ provider: "llama.cpp", id: "julia-1" }];
  responder: (call: CallRecord, index: number) => ClassifierResult;

  constructor(responder?: (call: CallRecord, index: number) => ClassifierResult) {
    this.responder = responder ?? ((call, index) => this.typed(call, index));
  }

  async getAvailableOfType(_type: "classifier", provider?: string): Promise<readonly ClassifierModel[]> {
    return provider === undefined ? this.models : this.models.filter((model) => model.provider === provider);
  }

  findOfType(_type: "classifier", provider: string, modelId: string): ClassifierModel | undefined {
    return this.models.find((model) => model.provider === provider && model.id === modelId);
  }

  async classify(model: ClassifierModel, context: ClassifierContext): Promise<ClassifierResult> {
    const call = { model, context };
    this.calls.push(call);
    return this.responder(call, this.calls.length - 1);
  }

  /** Default: every page `original` and worth reading, with real usage. */
  private typed(call: CallRecord, index: number): ClassifierResult {
    return this.result(call, "original", 0.9, 0.9, index);
  }

  result(
    call: CallRecord,
    kind: string,
    worth: number,
    confidence: number,
    index = 0,
    omit: ReadonlySet<string> = new Set(),
  ): ClassifierResult {
    const answers: Record<string, ClassifierAnswer> = {};
    for (const [id, question] of Object.entries(call.context.questions)) {
      if (omit.has(id)) continue;
      if (question.type === "bool") answers[id] = { type: "bool", probability: worth };
      else if (question.type === "choice") {
        answers[id] = { type: "choice", choice: kind, probabilities: {}, confidence };
      }
    }
    return {
      provider: call.model.provider,
      model: call.model.id,
      answers,
      stopReason: "stop",
      usage: { input: 120, output: 20, totalTokens: 140, cost: { total: 0.000004 * (index + 1) } },
    };
  }
}

function pageState(context: ClassifierContext): Array<{ index: number; url: string; title: string; snippet: string }> {
  return (context.state as unknown as { data: { candidates: Array<{ index: number; url: string; title: string; snippet: string }> } })
    .data.candidates;
}

function makeClassifier(registry: FakeRegistry, overrides: Partial<Config["reflex"]> = {}) {
  return createClassifierReflex({
    config: makeConfig({ backend: "local", provider: "llama.cpp", model: "julia-1", ...overrides }),
    registry,
    clock: new FakeClock({ autoAdvance: false }),
  });
}

test("classifier: one classify() call covers ten pages with one worth+kind question each", async () => {
  const registry = new FakeRegistry();
  registry.responder = (call, index) => registry.result(call, "slop", 0.2, 0.8, index);
  const reflex = makeClassifier(registry);
  const items = Array.from({ length: PAGE_BATCH_MAX }, (_, index) =>
    subject(`https://example.com/${index}`, `Page ${index}`, `Snippet ${index}`),
  );

  const verdicts = await reflex.judgePages("q", items);

  assert.equal(registry.calls.length, 1, "one batched call");
  const questions = Object.keys(registry.calls[0]!.context.questions);
  assert.equal(questions.length, PAGE_BATCH_MAX * 2);
  assert.ok(questions.includes("w0") && questions.includes("k0"));
  assert.ok(questions.includes(`w${PAGE_BATCH_MAX - 1}`) && questions.includes(`k${PAGE_BATCH_MAX - 1}`));
  assert.equal(pageState(registry.calls[0]!.context).length, PAGE_BATCH_MAX);
  assert.equal(verdicts.length, PAGE_BATCH_MAX);
  assert.ok(verdicts.every((verdict) => verdict.worth === false && verdict.kind === "slop"));
  assert.ok(verdicts.every((verdict) => verdict.trust === 0.15));

  const outcome = reflex.lastOutcome();
  assert.ok(outcome);
  assert.equal(outcome.decision, "page_gate");
  assert.equal(outcome.abstain, false);
  assert.equal(outcome.judged, PAGE_BATCH_MAX);
  assert.equal(outcome.partial, false);
  assert.ok((outcome.usage?.inputTokens ?? 0) > 0);
  assert.ok((outcome.costUsd ?? 0) > 0);
});

test("classifier: a missing answer fails open per page and marks the batch partial", async () => {
  const registry = new FakeRegistry();
  registry.responder = (call) =>
    registry.result(call, "original", 0.9, 0.9, 0, new Set(["w3", "k3"]));
  const reflex = makeClassifier(registry);
  const items = Array.from({ length: 5 }, (_, index) => subject(`https://example.com/${index}`));

  const verdicts = await reflex.judgePages("q", items);

  assert.equal(verdicts[3]?.worth, true, "an unjudged page must stay readable");
  assert.equal(verdicts[3]?.kind, "unknown");
  assert.deepEqual(verdicts[3]?.reasons, ["model:unjudged"]);
  const outcome = reflex.lastOutcome();
  assert.ok(outcome);
  assert.equal(outcome.abstain, false);
  assert.equal(outcome.judged, 4);
  assert.equal(outcome.partial, true);
});

test("classifier: garbage answers abstain instead of inventing a skip", async () => {
  const registry = new FakeRegistry((call) => ({
    provider: call.model.provider,
    model: call.model.id,
    answers: {},
    stopReason: "stop",
  }));
  const reflex = makeClassifier(registry);

  const verdicts = await reflex.judgePages("q", [subject("https://example.com/x", "X")]);

  assert.equal(verdicts[0]?.worth, true);
  assert.equal(reflex.lastOutcome()?.abstain, true);
  assert.equal(reflex.lastOutcome()?.reason, "bad_answer");
});

test("classifier: provider errors and low confidence abstain with a reason", async () => {
  const failing = new FakeRegistry((call) => ({
    provider: call.model.provider,
    model: call.model.id,
    answers: {},
    stopReason: "error",
    errorMessage: "provider exploded",
  }));
  const errorReflex = makeClassifier(failing);
  await errorReflex.judgePages("q", [subject("https://example.com/x")]);
  assert.equal(errorReflex.lastOutcome()?.abstain, true);
  assert.equal(errorReflex.lastOutcome()?.reason, "provider_error");

  const lowRegistry = new FakeRegistry();
  lowRegistry.responder = (call) => lowRegistry.result(call, "slop", 0.4, 0.1);
  const lowReflex = makeClassifier(lowRegistry);
  await lowReflex.judgePages("q", [subject("https://example.com/x")]);
  assert.equal(lowReflex.lastOutcome()?.abstain, true);
  assert.equal(lowReflex.lastOutcome()?.reason, "low_confidence");
});

test("classifier: an unconfigured remote backend and a disabled reflex send nothing to the registry", async () => {
  const registry = new FakeRegistry();
  const localOnly = makeClassifier(registry, { localOnly: false, backend: "openrouter" });
  await localOnly.judgePages("q", [subject("https://example.com/x")]);
  // openrouter is not configured in the fake registry, so the batch abstains.
  assert.equal(localOnly.lastOutcome()?.abstain, true);
  assert.equal(registry.calls.length, 0);

  const disabled = createClassifierReflex({
    config: makeConfig({ enabled: false, pageGate: false }),
    registry,
    clock: new FakeClock({ autoAdvance: false }),
  });
  await disabled.judgePages("q", [subject("https://example.com/x")]);
  assert.equal(disabled.lastOutcome()?.reason, "disabled");
  assert.equal(registry.calls.length, 0);
});
