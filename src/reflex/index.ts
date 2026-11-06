/**
 * System 1 composition root (SPEC §9.3, PLAN P5-D).
 *
 * The tools only ever see a `Reflex`; this module decides what sits behind it:
 *
 *   disabled / `backend: "rules"` / no pi classifier API
 *     → `createPolicy` with no model backend. The policy's fast path answers
 *       every decision from `rules.ts` and still logs it (`model: "rules"`), so
 *       the bench has a baseline and `reflex.enabled: false` stays observable.
 *
 *   enabled with a registry
 *     → `createClassifierReflex` (P5-C) wrapped in an adapter that turns each
 *       verdict + `lastOutcome()` into the policy's `BackendResult<T>`. The
 *       policy is the only place thresholds, abstention, caching and budgets
 *       live; the classifier never talks to a tool directly.
 *
 * Why the adapter exists: the frozen `Reflex` interface returns a bare verdict,
 * while the policy needs confidence/stopReason/usage/cost to decide whether to
 * trust it. `lastOutcome()` is the classifier's own record of the decision that
 * just completed, so it is read *after* the call resolves, never before.
 *
 * Nothing here reads credentials: the registry is pi's and `classify()` resolves
 * auth itself. Construction is side-effect free (no model listing, no network),
 * which is what lets the extension build it lazily, per execution context.
 */

import type { Config } from "../config.ts";
import type { Cache, Clock, Logger } from "../runtime/types.ts";
import {
  createClassifierReflex,
  type ClassifierReflex,
  type ClassifierRegistry,
  type ClassifyLogRow,
  type ClassifyOutcome,
} from "./classifier.ts";
import {
  createPolicy,
  type BackendResult,
  type CallMeta,
  type PolicyStats,
  type ReflexBackend,
  type ReflexPolicy,
} from "./policy.ts";
import { createRules } from "./rules.ts";

/** `kind` of the classifier's own JSONL row, so it is never mistaken for a policy row. */
export const REFLEX_BACKEND_LOG_KIND = "reflex_backend";

export interface ReflexBundle {
  /** The object tools receive as `ToolDeps.reflex`. */
  reflex: ReflexPolicy;
  /** Reset the per-search model budget; a tool calls this once per user search. */
  beginSearch(): void;
  /** Counters for the doctor/bench; no query text, no page text. */
  stats(): PolicyStats;
}

export interface CreateReflexOptions {
  config: Config;
  clock: Clock;
  cache: Cache;
  log: Logger;
  /**
   * pi's `ctx.modelRegistry` (the narrow classifier slice). Absent on older pi
   * builds and in tests; the reflex then degrades to rules-only instead of
   * failing a search.
   */
  registry?: ClassifierRegistry;
}

// ---------------------------------------------------------------------------
// Outcome → policy metadata
// ---------------------------------------------------------------------------

/**
 * Translate one classifier outcome into the policy's `CallMeta`.
 *
 * An abstained verdict is deliberately flattened to confidence 0: the policy
 * must never cache or apply it, and the classifier's own row already carries the
 * precise reason (`timeout`, `no_model`, `provider_error`, …). A missing outcome
 * (a backend that returned without recording anything) is treated as an error,
 * not as a confidently correct answer.
 */
function metaOf(outcome: ClassifyOutcome | null): CallMeta {
  if (outcome === null) {
    return {
      confidence: Number.NaN,
      stopReason: "error",
      errorMessage: "classifier returned no outcome",
    };
  }

  const meta: CallMeta = {
    confidence: outcome.abstain ? 0 : (outcome.confidence ?? 0),
    stopReason: outcome.stopReason ?? "stop",
    latencyMs: outcome.latencyMs,
  };
  if (outcome.model !== null) meta.model = outcome.model;
  if (outcome.usage !== undefined) {
    meta.usage = { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens };
  }
  if (outcome.costUsd !== undefined) meta.costUsd = outcome.costUsd;
  if (outcome.errorMessage !== undefined) meta.errorMessage = outcome.errorMessage;
  return meta;
}

/** Run one decision, then attach the metadata of that exact decision. */
async function judged<T>(call: () => Promise<T>, outcome: () => ClassifyOutcome | null): Promise<BackendResult<T>> {
  const value = await call();
  return { value, meta: metaOf(outcome()) };
}

function adapt(classifier: ClassifierReflex): ReflexBackend {
  const last = (): ClassifyOutcome | null => classifier.lastOutcome();
  return {
    triage: (query, items) => judged(() => classifier.triage(query, items), last),
    gateRead: (query, item) => judged(() => classifier.gateRead(query, item), last),
    judgePages: (query, subjects) => judged(() => classifier.judgePages(query, subjects), last),
    coverage: (query, evidence) => judged(() => classifier.coverage(query, evidence), last),
    route: (query) => judged(() => classifier.route(query), last),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The classifier's rows go to the same append-only log as the policy's, under a
 * distinct `kind`. A failure to write is the classifier's problem (it swallows
 * it); a broken log must never break a search.
 */
function backendLog(log: Logger): (row: ClassifyLogRow) => Promise<void> {
  return async (row) => {
    await log.write({ ...row, kind: REFLEX_BACKEND_LOG_KIND });
  };
}

/**
 * Build the reflex for one call site. Never returns null: rules always work, and
 * a tool that has to distinguish "no reflex" from "rules reflex" would start
 * duplicating policy logic.
 */
export function createReflex(options: CreateReflexOptions): ReflexBundle {
  const { config, clock, cache, log, registry } = options;
  const rules = createRules({ keep: config.reflex.triage.keep });

  // Constructing the classifier makes no model calls, but skipping it when it
  // cannot possibly answer guarantees "disabled = zero registry traffic".
  const useClassifier =
    (config.reflex.enabled || config.reflex.pageGate) &&
    config.reflex.backend !== "rules" &&
    registry !== undefined;
  const backend = useClassifier
    ? adapt(createClassifierReflex({ config, registry, clock, log: backendLog(log) }))
    : undefined;

  const policy = createPolicy({
    config,
    clock,
    cache,
    log,
    rules,
    ...(backend === undefined ? {} : { backend }),
  });

  return {
    reflex: policy,
    beginSearch: () => policy.beginSearch(),
    stats: () => policy.stats(),
  };
}
