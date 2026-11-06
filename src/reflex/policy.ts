/**
 * Guard rails around ANY System 1 backend (SPEC §9.3, PLAN P5-B).
 *
 * The policy is the only place where a model can influence a search, and it is
 * built so that the model can never make the search worse:
 *
 *  - `reflex.enabled: false` (the default) is a hard fast path: the injected
 *    backend is not called even once, and the deterministic rules verdict is
 *    logged so the bench has a baseline.
 *  - Every backend verdict is checked before use: `confidence < abstainBelow`,
 *    `stopReason !== "stop"`, an `errorMessage`, an over-deadline latency, or a
 *    malformed shape falls back to rules. The classifier is never allowed to
 *    throw into a tool call.
 *  - Budgets (`maxCallsPerSearch`, `maxCallsPerSession`, `maxUsdPerSession`)
 *    stop model traffic and emit a budget event instead of failing.
 *  - Accepted verdicts are cached for 24 h by `(query_hash, url)` (triage and
 *    other multi-item decisions hash their URL list), so a repeated query costs
 *    nothing and replays in the bench are stable.
 *
 * The policy does not own the timeout mechanism: the frozen `Reflex` interface
 * has no signal, so an over-deadline call is discarded after the fact. The
 * classifier backend enforces its own hard duration (P5-C).
 *
 * Logging is append-only JSONL: rules verdicts, backend verdicts, abstains and
 * budget events all go to `decisions.jsonl`. Queries are logged only as a hash,
 * URLs only as `origin + pathname` (never the query string), and page text is
 * never logged.
 */

import { createHash } from "node:crypto";

import type { Config } from "../config.ts";
import { ENGINE_IDS, type EngineId, type Freshness } from "../engines/types.ts";
import { MIN_CLAIM_COVERAGE, claimsCoverage } from "../extract/claims.ts";
import type { Cache, Clock, Logger } from "../runtime/types.ts";
import { RULES_MODEL, judgePagesSync } from "./rules.ts";
import type {
  Candidate,
  CoverageVerdict,
  Evidence,
  PageKind,
  PageSubject,
  PageVerdict,
  Reflex,
  Route,
  TriageResult,
} from "./types.ts";
import { PAGE_BATCH_MAX } from "./types.ts";

/** 24 h verdict cache (SPEC §9.3). */
export const VERDICT_TTL_MS = 86_400_000;
/** `kind` of a normal reflex row in decisions.jsonl. */
export const REFLEX_LOG_KIND = "reflex";
/** `kind` row emitted when a budget blocks a model call. */
export const BUDGET_LOG_KIND = "budget";
/** Placeholder model for a backend that does not report one. */
export const UNKNOWN_MODEL = "unknown";

export type Decision = "triage" | "gate_read" | "page_gate" | "coverage" | "route";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Metadata every real backend must return alongside its verdict. The frozen
 * `Reflex` shape carries none of this, which is why P5-C wraps `classify()` in
 * `ReflexBackend` instead of implementing the bare interface.
 */
export interface CallMeta {
  confidence: number;
  stopReason: string;
  errorMessage?: string;
  model?: string;
  usage?: Usage;
  costUsd?: number;
  /** Backend-measured duration. When absent the policy measures with `Clock`. */
  latencyMs?: number;
}

export interface BackendResult<T> {
  value: T;
  meta: CallMeta;
}

/** A backend that reports confidence/latency/cost so the policy can abstain. */
export interface ReflexBackend {
  triage(query: string, items: Candidate[]): Promise<BackendResult<TriageResult>>;
  gateRead(query: string, item: Candidate): Promise<BackendResult<boolean>>;
  /**
   * P14 (additive, optional): one batch page-quality verdict. A backend written
   * before P14 simply omits it; the policy then answers the page gate from rules
   * and logs it, exactly as it does for a disabled reflex.
   */
  judgePages?(query: string, subjects: readonly PageSubject[]): Promise<BackendResult<PageVerdict[]>>;
  coverage(query: string, evidence: Evidence[]): Promise<BackendResult<CoverageVerdict>>;
  route(query: string): Promise<BackendResult<Route>>;
}

export interface PolicyStats {
  /** Calls that actually reached the backend. */
  backendCalls: number;
  /** Decisions answered by rules (always logged). */
  rulesVerdicts: number;
  /** Rules verdicts that replaced a backend result (abstain/error/invalid). */
  fallbacks: number;
  /** 24 h verdict-cache hits (no backend call, no budget spend). */
  cacheHits: number;
  /** Budget-blocked calls. */
  budgetStops: number;
  callsThisSearch: number;
  callsThisSession: number;
  usdThisSession: number;
  logErrors: number;
}

export interface PolicyDeps {
  config: Config;
  clock: Clock;
  cache: Cache;
  log: Logger;
  rules: Reflex;
  /**
   * Optional model backend. A plain `Reflex` is accepted for callers that have
   * no metadata; its verdict is then trusted unconditionally, which is only
   * safe for a backend that never talks to a model.
   */
  backend?: Reflex | ReflexBackend;
}

export interface ReflexPolicy extends Reflex {
  /** P14: required on the policy; the frozen `Reflex` keeps it optional. */
  judgePages(query: string, subjects: readonly PageSubject[]): Promise<PageVerdict[]>;
  /** Reset the per-search budget. A query change resets it automatically. */
  beginSearch(): void;
  stats(): PolicyStats;
}
// ---------------------------------------------------------------------------
// Small guards (no `any`)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

function isFreshness(value: unknown): value is Freshness {
  return value === "d" || value === "w" || value === "m" || value === "y";
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function readUsage(raw: unknown): Usage {
  if (!isRecord(raw)) return { inputTokens: 0, outputTokens: 0 };
  return { inputTokens: tokenCount(raw.inputTokens), outputTokens: tokenCount(raw.outputTokens) };
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

function safeConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function isValidTriage(value: unknown, count: number): value is TriageResult {
  if (!isRecord(value)) return false;
  const keep = asArray(value.keep);
  const scores = asArray(value.scores);
  const flags = asArray(value.flags);
  if (scores.length !== count) return false;
  if (!scores.every((score) => typeof score === "number" && Number.isFinite(score))) return false;
  if (!flags.every((flag) => typeof flag === "string")) return false;
  return keep.every(
    (index) => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < count,
  );
}

function isValidCoverage(value: unknown): value is CoverageVerdict {
  if (!isRecord(value) || typeof value.enough !== "boolean") return false;
  return value.next === "refine" || value.next === "read_more" || value.next === "stop";
}

function isValidRoute(value: unknown): value is Route {
  if (!isRecord(value)) return false;
  const engines = asArray(value.engines);
  if (engines.length === 0 || !engines.every(isEngineId)) return false;
  if (value.lang !== undefined && typeof value.lang !== "string") return false;
  if (value.region !== undefined && typeof value.region !== "string") return false;
  if (value.freshness !== undefined && !isFreshness(value.freshness)) return false;
  if (value.summary !== undefined && typeof value.summary !== "boolean") return false;
  return (
    value.n === undefined ||
    (typeof value.n === "number" && Number.isInteger(value.n) && value.n >= 1)
  );
}

const PAGE_KINDS: readonly PageKind[] = [
  "original",
  "aggregator",
  "forum",
  "slop",
  "unsafe",
  "unknown",
];

function isPageVerdict(value: unknown): value is PageVerdict {
  if (!isRecord(value) || typeof value.worth !== "boolean") return false;
  if (value.trust !== null && !(typeof value.trust === "number" && Number.isFinite(value.trust))) {
    return false;
  }
  if (typeof value.trust === "number" && (value.trust < 0 || value.trust > 1)) return false;
  if (!PAGE_KINDS.includes(value.kind as PageKind)) return false;
  return Array.isArray(value.reasons) && value.reasons.every((reason) => typeof reason === "string");
}

function isValidPageVerdicts(value: unknown, count: number): value is PageVerdict[] {
  return Array.isArray(value) && value.length === count && value.every(isPageVerdict);
}

// ---------------------------------------------------------------------------
// Backend normalization: accept `Reflex` or `ReflexBackend`
// ---------------------------------------------------------------------------

interface NormalizedBackend {
  triage(query: string, items: Candidate[]): Promise<BackendResult<unknown>>;
  gateRead(query: string, item: Candidate): Promise<BackendResult<unknown>>;
  judgePages(query: string, subjects: readonly PageSubject[]): Promise<BackendResult<unknown>>;
  coverage(query: string, evidence: Evidence[]): Promise<BackendResult<unknown>>;
  route(query: string): Promise<BackendResult<unknown>>;
}

function readMeta(raw: Record<string, unknown>): CallMeta {
  const meta: CallMeta = {
    confidence:
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : Number.NaN,
    stopReason: typeof raw.stopReason === "string" ? raw.stopReason : "unknown",
    usage: readUsage(raw.usage),
    costUsd:
      typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) && raw.costUsd > 0
        ? raw.costUsd
        : 0,
  };
  if (typeof raw.errorMessage === "string") meta.errorMessage = raw.errorMessage;
  if (typeof raw.model === "string" && raw.model !== "") meta.model = raw.model;
  if (typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs) && raw.latencyMs >= 0) {
    meta.latencyMs = raw.latencyMs;
  }
  return meta;
}

/** Unwrap a `BackendResult`, or trust a plain `Reflex` verdict as fully confident. */
function unwrap(raw: unknown): BackendResult<unknown> {
  if (isRecord(raw) && "value" in raw && isRecord(raw.meta)) {
    return { value: raw.value, meta: readMeta(raw.meta) };
  }
  return {
    value: raw,
    // A bare Reflex passed as `backend` IS the rules layer; labelling those rows
    // "unknown" made the bench baseline indistinguishable from a broken model.
    meta: { confidence: 1, stopReason: "stop", model: RULES_MODEL, usage: zeroUsage(), costUsd: 0 },
  };
}

function normalizeBackend(backend: Reflex | ReflexBackend): NormalizedBackend {
  // `ReflexBackend` returns `BackendResult<T>` where `Reflex` returns `T`; both
  // are `unknown` at the boundary and `unwrap` tells them apart by shape.
  const plain = backend as Reflex;
  return {
    triage: async (query, items) => unwrap(await plain.triage(query, items)),
    gateRead: async (query, item) => unwrap(await plain.gateRead(query, item)),
    judgePages: async (query, subjects) => {
      // A plain `Reflex` (or a pre-P14 backend) may lack the method; that is the
      // old contract, and the policy must treat it as "no verdict", not an error.
      if (typeof plain.judgePages !== "function") {
        return { value: null, meta: { confidence: 0, stopReason: "error" } };
      }
      return unwrap(await plain.judgePages(query, subjects));
    },
    coverage: async (query, evidence) => unwrap(await plain.coverage(query, evidence)),
    route: async (query) => unwrap(await plain.route(query)),
  };
}

// ---------------------------------------------------------------------------
// Logging, hashing, URL privacy
// ---------------------------------------------------------------------------

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Log-safe URL: origin + path only. The query string can carry a session token
 * (`sxsrf`, `reqid`) or a private search term, and the JSONL logger redacts by
 * key, not by value, so dropping the whole search string is the only reliable
 * guarantee.
 */
function safeUrlForLog(raw: string): string {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.origin}${parsed.pathname}`.slice(0, 300);
  } catch {
    return "";
  }
}

function urlCacheKey(raw: string): string {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return raw.trim();
    // The host is already lowercased by `URL`; the path is left alone because
    // `/Docs` and `/docs` can be different pages on a case-sensitive server.
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw.trim();
  }
}

function verdictKey(decision: Decision, queryHash: string, material: string): string {
  return `reflex:v1:${decision}:${queryHash}:${hashText(material)}`;
}

interface CachedVerdict {
  value: unknown;
  model: string;
  confidence: number;
  usage: Usage;
  fallback: boolean;
}

/**
 * Merge one rules batch with one model batch (V14 floor).
 *
 * The rules layer owns safety: an `unsafe` verdict is returned untouched, and a
 * model may *add* a skip but never rescue a page the rules judged worthless.
 * That is deliberate — a rescue spends a browser read on a page two independent
 * judges disagree about, and the gate's measured contract is "fewer wasted
 * reads", not "fewer rules". The model's value is the pages the rules cannot
 * judge (unknown host, no excerpt), where it can still add skips, and its
 * `kind`/`trust` refine the reasons a tool shows.
 *
 * The merge is idempotent (`merge(v, v)` returns `v`), which is what lets the
 * policy pass a rules fallback through the same `settle` step as a model batch.
 */
export function mergePageVerdicts(
  baseline: readonly PageVerdict[],
  model: readonly PageVerdict[],
): PageVerdict[] {
  return baseline.map((base, index) => {
    const judged = model[index];
    if (judged === undefined) return base;
    if (base.kind === "unsafe") return base;

    const modelUnsafe = judged.kind === "unsafe";
    const modelSlop = judged.kind === "slop";
    const worth = !modelUnsafe && !modelSlop && base.worth && judged.worth;
    // When the merge turns a readable page into a skip, the honest kind is
    // "slop"; a page the baseline already refused keeps its own kind (a login
    // URL is not slop), which is also what makes the merge idempotent.
    const kind: PageKind = modelUnsafe ? "unsafe" : worth ? judged.kind : base.worth ? "slop" : base.kind;
    const trust = Math.min(base.trust ?? 1, judged.trust ?? 1);
    const reasons = [...base.reasons];
    if (!judged.worth && base.worth) reasons.push("model:skip");
    if (judged.kind !== base.kind) reasons.push(`model:${judged.kind}`);
    return { worth, trust, kind, reasons: reasons.slice(0, 8) };
  });
}

function isCachedVerdict(value: unknown): value is CachedVerdict {
  if (!isRecord(value) || !("value" in value)) return false;
  return (
    typeof value.model === "string" &&
    typeof value.confidence === "number" &&
    typeof value.fallback === "boolean" &&
    isRecord(value.usage)
  );
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

type Validator<T> = (value: unknown) => value is T;

interface DecisionRequest<T> {
  decision: Decision;
  query: string;
  url?: string;
  /** Material that identifies the decision's cache slot; never empty. */
  cacheMaterial: string;
  rules: () => Promise<T>;
  backend: (() => Promise<BackendResult<unknown>>) | null;
  validate: Validator<T>;
  verdict: (value: T) => string;
  /**
   * Last deterministic word on a verdict, applied to rules and model answers
   * alike before it is cached or logged. Used by `coverage` for the V13.3
   * floor: no backend may call a bundle `enough` while its text ignores most
   * of the query. Optional, so every other decision is untouched.
   */
  settle?: (value: T) => T;
}

interface BudgetStop {
  reason: "max_calls_per_search" | "max_calls_per_session" | "max_usd_per_session";
  used: number;
  limit: number;
}

export function createPolicy(deps: PolicyDeps): ReflexPolicy {
  const { config, clock, cache, log, rules } = deps;
  const reflex = config.reflex;
  const backend = deps.backend === undefined ? null : normalizeBackend(deps.backend);

  let callsSearch = 0;
  let callsSession = 0;
  let usdSession = 0;
  let searchHash: string | null = null;

  let backendCalls = 0;
  let rulesVerdicts = 0;
  let fallbacks = 0;
  let cacheHits = 0;
  let budgetStops = 0;
  let logErrors = 0;

  function timestamp(): string {
    return new Date(clock.now()).toISOString();
  }

  async function writeRow(row: Record<string, unknown>): Promise<void> {
    try {
      await log.write(row);
    } catch {
      // A decisions log is observability, not a search dependency. A full disk
      // must not turn a working search into a failure; the counter is surfaced
      // in `stats()` for the doctor.
      logErrors += 1;
    }
  }

  function baseRow(
    req: { decision: Decision; url?: string },
    queryHash: string,
  ): Record<string, unknown> {
    const row: Record<string, unknown> = {
      ts: timestamp(),
      kind: REFLEX_LOG_KIND,
      decision: req.decision,
      queryHash,
    };
    if (req.url !== undefined) {
      const url = safeUrlForLog(req.url);
      if (url !== "") row.url = url;
    }
    return row;
  }

  function round6(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
  }

  function budgetStop(): BudgetStop | null {
    if (callsSearch >= reflex.maxCallsPerSearch) {
      return { reason: "max_calls_per_search", used: callsSearch, limit: reflex.maxCallsPerSearch };
    }
    if (callsSession >= reflex.maxCallsPerSession) {
      return { reason: "max_calls_per_session", used: callsSession, limit: reflex.maxCallsPerSession };
    }
    if (usdSession >= reflex.maxUsdPerSession) {
      return { reason: "max_usd_per_session", used: round6(usdSession), limit: reflex.maxUsdPerSession };
    }
    return null;
  }

  function abstainReason(meta: CallMeta, latencyMs: number): string | null {
    if (meta.errorMessage !== undefined && meta.errorMessage !== "") return "backend_error_message";
    if (meta.stopReason !== "stop") return "stop_reason";
    // Written as `!(confidence >= threshold)` so NaN abstains too.
    if (!(meta.confidence >= reflex.abstainBelow)) return "low_confidence";
    if (latencyMs > reflex.maxLatencyMs) return "deadline";
    return null;
  }

  function telemetry(meta: CallMeta, latencyMs: number, costUsd: number): Record<string, unknown> {
    return {
      confidence: safeConfidence(meta.confidence),
      latencyMs,
      // The verdict below is produced by the rules layer, so `model` must say
      // rules; the model that was asked and rejected stays visible separately.
      attemptedModel: meta.model ?? UNKNOWN_MODEL,
      usage: meta.usage ?? zeroUsage(),
      costUsd,
    };
  }

  async function useRules<T>(
    req: DecisionRequest<T>,
    queryHash: string,
    overrides: Record<string, unknown>,
  ): Promise<T> {
    const raw = await req.rules();
    const value = req.settle === undefined ? raw : req.settle(raw);
    rulesVerdicts += 1;
    await writeRow({
      ...baseRow(req, queryHash),
      verdict: req.verdict(value),
      confidence: 1,
      latencyMs: 0,
      model: RULES_MODEL,
      usage: zeroUsage(),
      costUsd: 0,
      fallback: true,
      ...overrides,
    });
    return value;
  }

  async function decide<T>(req: DecisionRequest<T>): Promise<T> {
    const queryHash = hashText(normalizeQuery(req.query));
    if (searchHash !== queryHash) {
      searchHash = queryHash;
      callsSearch = 0;
    }

    // Fast path first, before the cache: a disabled reflex must never serve a
    // model verdict that an earlier enabled call left in the shared cache.
    const callBackend = req.backend;
    // Compound check so `callBackend` is narrowed to non-null after the block.
    if (!reflex.enabled || reflex.backend === "rules" || callBackend === null) {
      const reason = !reflex.enabled
        ? "disabled"
        : reflex.backend === "rules"
          ? "backend_rules"
          : "no_backend";
      const overrides: Record<string, unknown> = { reason };
      // An explicitly configured rules backend is not a fallback; a disabled
      // reflex is, and the bench keys on that to find its baseline rows.
      if (reason === "backend_rules") overrides.fallback = false;
      return useRules(req, queryHash, overrides);
    }

    const cacheKey = verdictKey(req.decision, queryHash, req.cacheMaterial);
    const hit = cache.get<CachedVerdict>(cacheKey);
    if (isCachedVerdict(hit) && req.validate(hit.value)) {
      cacheHits += 1;
      await writeRow({
        ...baseRow(req, queryHash),
        verdict: req.verdict(hit.value),
        confidence: safeConfidence(hit.confidence),
        latencyMs: 0,
        model: hit.model,
        usage: hit.usage,
        costUsd: 0,
        fallback: hit.fallback,
        cached: true,
      });
      return hit.value;
    }

    const stop = budgetStop();
    if (stop !== null) {
      budgetStops += 1;
      await writeRow({
        ts: timestamp(),
        kind: BUDGET_LOG_KIND,
        decision: req.decision,
        reason: stop.reason,
        used: stop.used,
        limit: stop.limit,
        queryHash,
      });
      return useRules(req, queryHash, { reason: stop.reason });
    }

    // Reserve the slot before awaiting: two concurrent tool calls must not both
    // observe an under-limit counter and slip past the cap.
    callsSearch += 1;
    callsSession += 1;
    backendCalls += 1;

    const startedAt = clock.now();
    let result: BackendResult<unknown>;
    try {
      result = await callBackend();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fallbacks += 1;
      return useRules(req, queryHash, { reason: "backend_error", error: message.slice(0, 200) });
    }
    const elapsed = Math.max(0, clock.now() - startedAt);

    const meta = result.meta;
    const latencyMs = meta.latencyMs ?? elapsed;
    const costUsd = meta.costUsd ?? 0;
    if (costUsd > 0) usdSession = round6(usdSession + costUsd);

    const abstain = abstainReason(meta, latencyMs);
    if (abstain !== null) {
      fallbacks += 1;
      return useRules(req, queryHash, {
        reason: abstain,
        ...telemetry(meta, latencyMs, costUsd),
      });
    }

    const accepted = result.value;
    if (!req.validate(accepted)) {
      fallbacks += 1;
      return useRules(req, queryHash, {
        reason: "invalid_verdict",
        ...telemetry(meta, latencyMs, costUsd),
      });
    }

    // The floor is deterministic and model-independent: it runs after validation
    // so a malformed verdict still falls back, and before caching so an
    // over-eager verdict cannot be replayed from the cache.
    const settled = req.settle === undefined ? accepted : req.settle(accepted);

    cache.set<CachedVerdict>(
      cacheKey,
      {
        value: settled,
        model: meta.model ?? UNKNOWN_MODEL,
        confidence: safeConfidence(meta.confidence),
        usage: meta.usage ?? zeroUsage(),
        fallback: false,
      },
      VERDICT_TTL_MS,
    );

    await writeRow({
      ...baseRow(req, queryHash),
      verdict: req.verdict(settled),
      confidence: safeConfidence(meta.confidence),
      latencyMs,
      model: meta.model ?? UNKNOWN_MODEL,
      usage: meta.usage ?? zeroUsage(),
      costUsd,
      fallback: false,
    });
    return settled;
  }

  return {
    triage(query, items) {
      return decide<TriageResult>({
        decision: "triage",
        query,
        cacheMaterial: items.map((item) => urlCacheKey(item.url)).join("\n"),
        rules: () => rules.triage(query, items),
        backend: backend === null ? null : () => backend.triage(query, items),
        validate: (value) => isValidTriage(value, items.length),
        verdict: (value) => `keep=${value.keep.join(",")}`,
      });
    },

    gateRead(query, item) {
      return decide<boolean>({
        decision: "gate_read",
        query,
        url: item.url,
        cacheMaterial: urlCacheKey(item.url),
        rules: () => rules.gateRead(query, item),
        backend: backend === null ? null : () => backend.gateRead(query, item),
        validate: (value): value is boolean => typeof value === "boolean",
        verdict: (value) => (value ? "read" : "skip"),
      });
    },

    judgePages(query, subjects) {
      // The contract caps a batch at `PAGE_BATCH_MAX`; the caller may pass more
      // (a SERP is 10+ results) and gets verdicts for the prefix only.
      const items = subjects.slice(0, PAGE_BATCH_MAX);
      if (items.length === 0) return Promise.resolve<PageVerdict[]>([]);
      const baseline = judgePagesSync(query, items);
      return decide<PageVerdict[]>({
        decision: "page_gate",
        query,
        cacheMaterial: items.map((item) => urlCacheKey(item.url)).join("\n"),
        rules: () => Promise.resolve(baseline),
        backend: backend === null ? null : () => backend.judgePages(query, items),
        validate: (value) => isValidPageVerdicts(value, items.length),
        verdict: (value) => `keep=${value.filter((item) => item.worth).length}/${value.length}`,
        settle: (value) => mergePageVerdicts(baseline, value),
      });
    },

    coverage(query, evidence) {
      const settle = (value: CoverageVerdict): CoverageVerdict => {
        if (!value.enough) return value;
        // `Evidence.excerpt` is the page window the bundle will quote from; the
        // share of the query it covers is the same deterministic floor V13.3
        // applies in `web_research`, enforced here for every backend.
        if (claimsCoverage(query, evidence.map((item) => item.excerpt ?? "")) >= MIN_CLAIM_COVERAGE) {
          return value;
        }
        return { enough: false, next: value.next === "read_more" ? "read_more" : "refine" };
      };
      return decide<CoverageVerdict>({
        decision: "coverage",
        query,
        cacheMaterial: evidence.map((item) => urlCacheKey(item.url)).join("\n"),
        rules: () => rules.coverage(query, evidence),
        backend: backend === null ? null : () => backend.coverage(query, evidence),
        validate: isValidCoverage,
        verdict: (value) => `${value.enough ? "enough" : "not_enough"}:${value.next}`,
        settle,
      });
    },

    route(query) {
      return decide<Route>({
        decision: "route",
        query,
        cacheMaterial: "route",
        rules: () => rules.route(query),
        backend: backend === null ? null : () => backend.route(query),
        validate: isValidRoute,
        verdict: (value) => {
          const engines = value.engines.join("+");
          const lang = value.lang === undefined ? "" : `:${value.lang}`;
          const freshness = value.freshness === undefined ? "" : `:${value.freshness}`;
          return `${engines}${lang}${freshness}`;
        },
      });
    },

    beginSearch() {
      callsSearch = 0;
      searchHash = null;
    },

    stats() {
      return {
        backendCalls,
        rulesVerdicts,
        fallbacks,
        cacheHits,
        budgetStops,
        callsThisSearch: callsSearch,
        callsThisSession: callsSession,
        usdThisSession: round6(usdSession),
        logErrors,
      };
    },
  };
}
