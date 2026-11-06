/**
 * Frozen System 1 (reflex) interface (SPEC §9.3). The interface is part of the
 * P0 contract so `ToolDeps` can reference it; implementations (rules/classifier/
 * policy) land in P5. Additive changes only.
 */

import type { EngineId, Freshness } from "../engines/types.ts";

export interface Candidate {
  title: string;
  url: string;
  snippet: string;
  /**
   * `"read"` describes a bare URL handed to the read gate by `web_read`: that
   * tool has no SERP and no engine, and pretending otherwise would log a lie.
   */
  engine: EngineId | "read";
}

export interface TriageResult {
  /** Indices into the input array, best first. */
  keep: number[];
  scores: number[];
  /** Advisory flags such as "spam" or "duplicate"; never a security gate. */
  flags: string[];
}

export interface Evidence {
  url: string;
  title?: string;
  excerpt?: string;
}

export type CoverageNext = "refine" | "read_more" | "stop";

export interface CoverageVerdict {
  enough: boolean;
  next: CoverageNext;
}

export interface Route {
  engines: EngineId[];
  lang?: string;
  region?: string;
  freshness?: Freshness;
  n?: number;
  summary?: boolean;
}

/**
 * P14 contract: what a page is, as far as a cheap judge can tell from the SERP
 * snapshot (and, after a read, from an excerpt).
 */
export type PageKind = "original" | "aggregator" | "forum" | "slop" | "unsafe" | "unknown";

/** One page the gate is asked about. Only `url` is mandatory; a read has nothing else. */
export interface PageSubject {
  url: string;
  title?: string;
  snippet?: string;
  /** Read text window, when the caller already has one. Never required. */
  excerpt?: string;
}

/**
 * `worth` is the only decision a caller acts on; `trust` is advisory (0..1, or
 * null when the judge abstained on quality) and `reasons` is a short, printable
 * list a tool may show instead of the page.
 */
export interface PageVerdict {
  worth: boolean;
  trust: number | null;
  kind: PageKind;
  reasons: string[];
}

/**
 * Most candidates one page-gate decision may cover. The budget is a *call*
 * budget, so a batch of ten must cost what a batch of one costs.
 */
export const PAGE_BATCH_MAX = 10;

/** P14: how a caller wants the page gate to judge. */
export interface PageGateOptions {
  /**
   * `"rules"` never calls the model. `web_read` uses it: an explicit URL has
   * already been chosen, so the safety floor is enough and the read does not pay
   * classifier latency/cost. `web_research` uses `"auto"`: one batch amortizes
   * the call across the sources it ranks.
   */
  backend?: "auto" | "rules";
}

export interface Reflex {
  triage(query: string, items: Candidate[]): Promise<TriageResult>;
  gateRead(query: string, item: Candidate): Promise<boolean>;
  coverage(query: string, evidence: Evidence[]): Promise<CoverageVerdict>;
  route(query: string): Promise<Route>;
  /**
   * P14 (additive): is this page worth spending a read on? Returns one verdict
   * per subject, in input order, for at most `PAGE_BATCH_MAX` subjects. `null`
   * means "no verdict" (disabled reflex, no backend, abstention); callers then
   * fall back to `gateRead` or to their fixed order. A `Reflex` without this
   * method behaves exactly as it did before P14.
   */
  judgePages?(
    query: string,
    subjects: readonly PageSubject[],
    options?: PageGateOptions,
  ): Promise<PageVerdict[] | null>;
  /**
   * Optional per-search reset of the model budget (P5 policy). Tools call it
   * once at the start of a user search; a `Reflex` without budgets (rules,
   * test doubles) simply omits it.
   */
  beginSearch?(): void;
}
