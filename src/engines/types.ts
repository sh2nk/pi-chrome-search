/**
 * Frozen contract for engine adapters. See SPEC.md §15 D9
 * (SPEC §7.1): `engines` may be a single id or a list.
 *
 * Additive changes only, and only with a `contract:` commit. Adapters are pure
 * URL builders + DOM extractors: they never navigate, never take screenshots,
 * never write artifacts, and never apply output caps (that is extract/compact.ts).
 */

import type { CdpPage } from "../cdp/types.ts";

/**
 * Primary engines answer a general web query. Canonical order; `auto` keeps this
 * order and yandex stays last by policy (SPEC §15 D10).
 */
export const PRIMARY_ENGINES = ["google", "duckduckgo", "yandex"] as const;

/**
 * Special engines answer one site, not the web (SPEC §15 D11). They are never
 * part of `auto`: a marketplace listing is not an answer to "search the web",
 * so a caller must name the engine (`engines: "avito"`) to get it.
 */
export const SPECIAL_ENGINES = ["avito"] as const;

export type PrimaryEngineId = (typeof PRIMARY_ENGINES)[number];
export type SpecialEngineId = (typeof SPECIAL_ENGINES)[number];
export type EngineId = PrimaryEngineId | SpecialEngineId;

/** Every id the contract knows, primary first. `auto` walks the primary part only. */
export const ENGINE_IDS = [...PRIMARY_ENGINES, ...SPECIAL_ENGINES] as const satisfies readonly EngineId[];

export type EngineClass = "primary" | "special";

/** Primary/special is data, so `auto` and the tool's docs cannot drift apart. */
export const ENGINE_CLASS: Readonly<Record<EngineId, EngineClass>> = Object.freeze({
  google: "primary",
  duckduckgo: "primary",
  yandex: "primary",
  avito: "special",
});

/** True when `auto` may pick this engine (SPEC S4.7). */
export function isPrimaryEngine(id: EngineId): boolean {
  return ENGINE_CLASS[id] === "primary";
}

export interface Query {
  text: string;
  /** Engine UI language, e.g. "ru". "auto" is resolved by the caller, never by the adapter. */
  lang?: string;
  /** Engine region/country, e.g. "ru". */
  region?: string;
  n: number;
  /** 1-based. Google/Yandex only. */
  page?: number;
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
  /**
   * True when this URL is still an opaque `/goto` wrapper: the destination could
   * not be verified, so the output must mark it instead of pretending it is a
   * resolved link (S3.5, S7.4).
   */
  unresolved?: boolean;
  /**
   * Short facts the card shows around the snippet, in display order: price,
   * availability, rating, location, listing date (SPEC §15 D13).
   *
   * Additive and optional on purpose: a SERP that does not surface them leaves
   * this absent, and an adapter never invents one. Google already prints
   * `103 500,00 ₽ · В наличии · 5,0 ★` under some results; Avito prints price,
   * location and date on every card. The renderer joins them after the snippet
   * and caps the line (`COMPACT_CAPS.factsMaxChars`).
   */
  facts?: readonly string[];
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
  /**
   * One adapter-authored line about the page the caller must not have to guess
   * (S7.6/S7.7): Avito answers a no-match query with "similar listings", and
   * saying so is the difference between a labelled fallback and a silent lie.
   *
   * A fixed adapter constant, never page text — a SERP cannot inject prose into
   * the output through it.
   */
  notice?: string;
  timings: SerpTimings;
}

export type WallKind = "captcha" | "consent" | "sorry" | "blocked";

export interface Wall {
  kind: WallKind;
  url: string;
  /** Text/url markers that produced the verdict, for artifacts and doctor output. */
  markers: string[];
}

/**
 * Per-engine typing profile (PLAN-v2 P10-C).
 *
 * `humanize: "typing"` types every search of every engine, so each adapter must
 * say which box it accepts input in, how long a query that box handles without
 * truncating, and at what pace the keystrokes should land. A query longer than
 * `maxChars` is *not* typed: a truncated query would search for something the
 * user did not ask, so the caller falls back to the pinned SERP URL instead.
 */
export interface EngineTypeProfile {
  /** The box this engine accepts typed input in; tried before `boxSelectors`. */
  box: string;
  /** Longest query this box accepts without truncating or reformatting. */
  maxChars: number;
  /** Per-keystroke delay window in ms, inclusive. */
  keyDelayMs: readonly [number, number];
}

export interface EngineInteraction {
  /** Engine home page for the typed first search of a session. */
  homeUrl: string;
  /**
   * Hosts the *home* navigation may legitimately land on (P10-D). Yandex
   * redirects `yandex.ru` to `dzen.ru` often enough that treating the landing as
   * the search box is a lie; a host outside this list means "the warm-up was
   * redirected" and the caller navigates the pinned SERP instead of failing.
   * Absent means "do not check" (the pre-P10 behaviour).
   */
  homeHosts?: readonly string[];
  /** Search-box candidates, tried in order. */
  boxSelectors: readonly string[];
  /** Text marker that means "SERP is ready" (prefer a stable text marker). */
  marker: string;
  /** Optional structural marker; pairs with minCount to avoid a stale home-page match. */
  selector?: string;
  minCount?: number;
  /** Optional typing profile; without it `humanize: "typing"` uses the generic delays. */
  typeProfile?: EngineTypeProfile;
  /**
   * Per-query home page, when the engine's home is parameterized (SPEC D12:
   * Avito's typed search starts on `https://www.avito.ru/<location>/`, so the
   * configured region must reach the warm-up page too). Absent means `homeUrl`.
   */
  homeUrlFor?(q: Query): string;
  /**
   * Where the typed path starts (P10-C). `home` (default) opens the engine home
   * page and types into its box. `serp` navigates the SERP URL first and types
   * into the SERP box after clearing its prefilled value — for engines whose
   * home page no longer renders a usable `<input>` (measured on DuckDuckGo
   * 2026-11-06), so "type everywhere" stays honest instead of silently falling
   * back on every search.
   */
  typeOn?: "home" | "serp";
}

export interface Engine {
  readonly id: EngineId;
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

/**
 * The tool-level arguments whose support differs per engine (SPEC S4.2).
 *
 * The matrix is deliberately data, not four `if` statements: the tool layer uses
 * `page: "flag"` to omit an unsupported parameter and report `ignored`, and the
 * unit test walks the same table, so the documentation and the behaviour cannot
 * drift apart. `q` operators are the fourth row of the S4.2 table and pass
 * through everywhere; they are asserted in the same test, not modelled here.
 */
export type SupportArgument = "n" | "page" | "summary";
export type ArgumentSupport = "yes" | "flag";

export const SUPPORT_MATRIX: Readonly<
  Record<SupportArgument, Readonly<Record<EngineId, ArgumentSupport>>>
> = Object.freeze({
  n: Object.freeze({ google: "yes", duckduckgo: "yes", yandex: "yes", avito: "yes" }),
  // DuckDuckGo has no pagination in this adapter: page > 1 is served as page 1
  // and must be reported as `ignored.page`, never silently dropped (S4.2, S7.1).
  // Avito paginates with `&p=` (verified live: the page-2 link carries `p=2`).
  page: Object.freeze({ google: "yes", duckduckgo: "flag", yandex: "yes", avito: "yes" }),
  // Avito has no native AI block at all (SPEC D12): asking is reported as
  // `ignored.summary`, never answered with an invented summary.
  summary: Object.freeze({ google: "yes", duckduckgo: "yes", yandex: "yes", avito: "flag" }),
});

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
