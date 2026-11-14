/**
 * Runtime service interfaces shared by the tool layer (P0 frozen contract).
 * Implementations are owned by later lanes: cache/limiter (P2-B), artifacts
 * (P4-C), log/errors (P1-C), browser (P1-D).
 */

import type { CdpPage } from "../cdp/types.ts";
import type { EngineId, RawSerp } from "../engines/types.ts";

export interface Clock {
  /** Epoch milliseconds. Injectable so cache/TTL/pacing tests are deterministic. */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Append-only JSONL log (decisions, audits, read-domain log). */
export interface Logger {
  write(row: Record<string, unknown>): Promise<void>;
  path(): string;
}

export interface Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  size(): number;
  clear(): void;
}

export interface LimiterStats {
  engine: EngineId;
  lastAt: number | null;
  /** Searches this process has issued to the engine (observability, not a quota). */
  today: number;
}

export interface Limiter {
  /** Resolves when the engine may be queried; never enforces a daily quota (SPEC D8). */
  acquire(engine: EngineId, signal?: AbortSignal): Promise<void>;
  stats(engine: EngineId): LimiterStats;
}

export interface ArtifactInput {
  code: string;
  stage: string;
  engine?: EngineId;
  url: string;
  query: string;
  serp?: RawSerp;
  page?: CdpPage;
  extra?: Record<string, unknown>;
  /** Extra files written into the artifact directory (`doc.pdf` for P12-A). */
  files?: Record<string, Uint8Array>;
}

export interface PruneResult {
  removed: number;
  kept: number;
  bytes: number;
}

export interface Artifacts {
  /** Writes page.html/page.txt/screenshot.jpg/meta.json and returns the directory. */
  save(input: ArtifactInput): Promise<string>;
  prune(): Promise<PruneResult>;
  /** Total size of the artifact root in bytes. */
  size(): Promise<number>;
  root(): string;
}
