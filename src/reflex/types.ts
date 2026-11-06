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

export interface Reflex {
  triage(query: string, items: Candidate[]): Promise<TriageResult>;
  gateRead(query: string, item: Candidate): Promise<boolean>;
  coverage(query: string, evidence: Evidence[]): Promise<CoverageVerdict>;
  route(query: string): Promise<Route>;
  /**
   * Optional per-search reset of the model budget (P5 policy). Tools call it
   * once at the start of a user search; a `Reflex` without budgets (rules,
   * test doubles) simply omits it.
   */
  beginSearch?(): void;
}
