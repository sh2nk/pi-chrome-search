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

/**
 * What an engine's AI block actually shows (PLAN-v2 P8, `contract: ai states`).
 *
 * - `answer`  — the block carries answer prose of at least
 *               {@link AI_ANSWER_MIN_CHARS} characters. Only this state may be
 *               rendered as `ai:yes`.
 * - `lead`    — the block exists but carries no full answer (an affordance, a
 *               prompt, a query echo, or a short fragment). Rendered `ai:lead`,
 *               never `ai:yes` and never as an answer body.
 * - `none`    — no AI block on the page. Absence is a normal A/B outcome.
 */
export type AiState = "answer" | "lead" | "none";

/**
 * Minimum answer prose for `ai:yes` (PLAN-v2 V8.1). A block below this width is
 * reported as `lead`: calling forty characters an answer is the small lie this
 * phase exists to remove.
 */
export const AI_ANSWER_MIN_CHARS = 200;

export interface AiSummary {
  text: string;
  /** Visible source names/domains. Never fabricated, may be empty. */
  sources: string[];
  /**
   * Optional only for additive compatibility: adapters always set it, and the
   * compaction layer re-derives the state from `text`/`query` whenever it is
   * missing, so an adapter cannot smuggle a short or echo-only "answer" past
   * the promise that `ai:yes` means prose.
   */
  state?: AiState;
}

/** Cheap in-page answer of "what does the AI block show right now?". */
export interface AiProbe {
  state: AiState;
  /** Characters of answer prose the extractor would report for this state. */
  chars: number;
}

/**
 * Streaming-summary hooks (PLAN-v2 P8-A/P8-B). Optional: an adapter without
 * them simply never waits for a summary, which is honest for a third-party
 * engine that has no AI block contract.
 */
export interface EngineAi {
  /** Bounded poll target; must be cheap (no result extraction). */
  probe(page: CdpPage): Promise<AiProbe>;
  /**
   * One visible expand click ("Показать полностью", "Show more"). Never called
   * implicitly: the tool layer only invokes it when `search.aiExpand` is true,
   * because it is a real interaction inside the user's window.
   */
  expand?(page: CdpPage, options?: AiExpandOptions): Promise<boolean>;
}

export interface AiExpandOptions {
  signal?: AbortSignal;
}

export interface SerpTimings {
  navigateMs?: number;
  settleMs?: number;
  extractMs?: number;
  /** Time spent in the streaming-summary wait (0 when `summary:false`). */
  aiWaitMs?: number;
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
  /** Optional AI-block probe/expand (PLAN-v2 P8). Absent means "never wait". */
  readonly ai?: EngineAi;
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
