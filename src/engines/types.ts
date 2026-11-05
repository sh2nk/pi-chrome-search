/**
 * Frozen contract for engine adapters. See PLAN.md Appendix A and the D9 decision
 * (SPEC §7.1): `engines` may be a single id or a list.
 *
 * Additive changes only, and only with a `contract:` commit. Adapters are pure
 * URL builders + DOM extractors: they never navigate, never take screenshots,
 * never write artifacts, and never apply output caps (that is extract/compact.ts).
 */

import type { CdpPage } from "../cdp/types.ts";

export type EngineId = "google" | "duckduckgo" | "yandex";

/** Canonical order. `auto` keeps this order; yandex stays last by policy (D10). */
export const ENGINE_IDS = ["google", "duckduckgo", "yandex"] as const satisfies readonly EngineId[];

export type Freshness = "d" | "w" | "m" | "y";

export interface Query {
  text: string;
  /** Engine UI language, e.g. "ru". "auto" is resolved by the caller, never by the adapter. */
  lang?: string;
  /** Engine region/country, e.g. "ru". */
  region?: string;
  n: number;
  /** 1-based. Google/Yandex only. */
  page?: number;
  freshness?: Freshness;
  /** Ask the engine for its native AI summary; `false` only suppresses extraction effort. */
  summary: boolean;
}

export interface SerpItem {
  title: string;
  url: string;
  snippet: string;
  isAd?: boolean;
  /** Set by the merge layer when the query was rewritten (M5+). */
  sourceQuery?: string;
  /** Set by the merge layer only when results from several engines are mixed. */
  engine?: EngineId;
}

export interface AiSummary {
  text: string;
  /** Visible source names/domains. Never fabricated, may be empty. */
  sources: string[];
}

export interface SerpTimings {
  navigateMs?: number;
  settleMs?: number;
  extractMs?: number;
}

export interface RawSerp {
  engine: EngineId;
  query: string;
  ai?: AiSummary;
  results: SerpItem[];
  /** True when the page carried more results than were returned. */
  pageCarried: boolean;
  /** True only for the keyless HTTP fallback (SPEC §6.5); never for a real SERP. */
  degraded?: boolean;
  timings: SerpTimings;
}

export type WallKind = "captcha" | "consent" | "sorry" | "blocked";

export interface Wall {
  kind: WallKind;
  url: string;
  /** Text/url markers that produced the verdict, for artifacts and doctor output. */
  markers: string[];
}

export interface EngineInteraction {
  /** Engine home page for the typed first search of a session. */
  homeUrl: string;
  /** Search-box candidates, tried in order. */
  boxSelectors: readonly string[];
  /** Text marker that means "SERP is ready" (prefer a stable text marker). */
  marker: string;
  /** Optional structural marker; pairs with minCount to avoid a stale home-page match. */
  selector?: string;
  minCount?: number;
}

export interface Engine {
  readonly id: EngineId;
  /** Yandex only: the tool layer may retry once after a wall. Adapters never retry themselves. */
  readonly retryOnWall?: boolean;
  /** Optional human-search metadata; absent means the tool navigates the SERP directly. */
  readonly interaction?: EngineInteraction;
  /** Pure: same Query → same URL. No network, no clock, no config lookups. */
  buildUrl(q: Query): string;
  /** Marker-based settle with a deadline; resolves when the page is ready to extract. */
  settle(page: CdpPage, signal?: AbortSignal): Promise<void>;
  detectWall(page: CdpPage): Promise<Wall | null>;
  extract(page: CdpPage, q: Query): Promise<RawSerp>;
  /** Selector canaries for the doctor. Zero counts are a `layout_changed` signal, not an error. */
  canaries(page: CdpPage): Promise<Record<string, number>>;
}

/** Engine selection requested by the tool layer (D9). */
export type EngineSelection = "auto" | EngineId | EngineId[];

export interface EngineRegistry {
  /** Throws E_UNSUPPORTED when the adapter is missing or disabled. */
  get(id: EngineId): Engine;
  has(id: EngineId): boolean;
  /** Enabled engines in canonical order; yandex last. */
  enabled(): EngineId[];
  /**
   * Resolve a user selection to a try-order (D9/D10): `auto` uses the canonical order
   * (google → duckduckgo → yandex) and the tool stops at the first success; an explicit
   * list keeps the caller's order and merges the results. Unknown/disabled ids are dropped.
   */
  select(requested: EngineSelection): EngineId[];
}
