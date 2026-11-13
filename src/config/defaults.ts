/**
 * The config contract: one type tree, one default tree (S13.1).
 *
 * Every leaf here is read by production code; `scripts/audit.mjs` fails when a
 * leaf has no reader (S13.2). Removed surfaces (ADR-0001) do not come back:
 * there is no attach/launch mode, no classifier block, no wall retry, no daily
 * caps and no profile-directory key. `PI_CHROME_SEARCH_PROFILE` is a host
 * discovery input, not configuration.
 */

export type FocusPolicy = "session" | "always" | "never";
export type FollowPolicy = "work" | "anchor" | "never";
export type HumanizeMode = "auto" | "always" | "typing";

export interface CdpConfig {
  ports: number[];
  ws: string | null;
  connectTimeoutMs: number;
  /** How long an attach may wait for the user's CDP Allow (S8.4); `0` disables the wait. */
  attachWaitMs: number;
}

export interface WindowConfig {
  focus: FocusPolicy;
  /** Best-effort raise while the Allow prompt is waiting; `never` keeps the session passive. */
  raiseOnPrompt: "auto" | "never";
  /** Host the local anchor panel instead of `about:blank`. */
  panel: boolean;
  /** Which tab is raised during and after a stage. */
  follow: FollowPolicy;
  /** ms after the last stage before the anchor is raised again. */
  idleMs: number;
}

export interface GoogleConfig {
  enabled: boolean;
  lang: string;
  gl: string;
}

export interface DuckDuckGoConfig {
  enabled: boolean;
  kl: string;
}

export interface YandexConfig {
  enabled: boolean;
  lr: string;
}

export interface EnginesConfig {
  google: GoogleConfig;
  duckduckgo: DuckDuckGoConfig;
  yandex: YandexConfig;
}

export type PacingWindow = [number, number];

export interface PacingConfig {
  google: PacingWindow;
  duckduckgo: PacingWindow;
  yandex: PacingWindow;
}

export interface SearchConfig {
  n: number;
  nMax: number;
  summaryMaxChars: number;
  snippetMaxChars: number;
  outputMaxChars: number;
  /** Bounded wait for a streaming native AI summary; 0 disables waiting. */
  aiWaitMs: number;
  /** Allow one visible expand click inside the AI block; default off. */
  aiExpand: boolean;
}

export interface ReadConfig {
  defaultMaxChars: number;
  maxCharsCeiling: number;
  /** Concurrent read slots, each with its own tab and exclusive lock (S5.7). */
  pool: number;
  /** Hard ceiling for a fetched PDF. */
  pdfMaxBytes: number;
  /** Keep the fetched PDF bytes next to the text artifact; default off. */
  keepPdf: boolean;
  /** Per-page text cap before the next `--- p.N ---` marker. */
  pdfPageMaxChars: number;
}

export interface ImageConfig {
  /** Per-thumbnail byte ceiling for `attach:"bytes"`. */
  attachMaxBytes: number;
}

export interface CacheConfig {
  serpTtlMs: number;
  gotoTtlMs: number;
  maxEntries: number;
}

export interface ArtifactsConfig {
  enabled: boolean;
  keep: number;
  maxBytes: number;
}

export interface Config {
  cdp: CdpConfig;
  window: WindowConfig;
  humanize: HumanizeMode;
  engines: EnginesConfig;
  pacing: PacingConfig;
  search: SearchConfig;
  read: ReadConfig;
  image: ImageConfig;
  cache: CacheConfig;
  artifacts: ArtifactsConfig;
  debug: boolean;
}

export const DEFAULT_CONFIG: Config = {
  cdp: { ports: [9222], ws: null, connectTimeoutMs: 5000, attachWaitMs: 60000 },
  window: { focus: "session", raiseOnPrompt: "auto", panel: true, follow: "work", idleMs: 1500 },
  humanize: "auto",
  engines: {
    google: { enabled: true, lang: "auto", gl: "auto" },
    duckduckgo: { enabled: true, kl: "auto" },
    yandex: { enabled: true, lr: "auto" },
  },
  pacing: { google: [2500, 5000], yandex: [5000, 9000], duckduckgo: [2000, 4000] },
  search: {
    n: 5,
    nMax: 10,
    summaryMaxChars: 1200,
    snippetMaxChars: 140,
    outputMaxChars: 2500,
    aiWaitMs: 6000,
    aiExpand: false,
  },
  read: {
    defaultMaxChars: 6000,
    maxCharsCeiling: 20000,
    pool: 1,
    pdfMaxBytes: 20 * 1024 * 1024,
    keepPdf: false,
    pdfPageMaxChars: 4000,
  },
  image: { attachMaxBytes: 8 * 1024 * 1024 },
  cache: { serpTtlMs: 600000, gotoTtlMs: 86400000, maxEntries: 200 },
  artifacts: { enabled: true, keep: 30, maxBytes: 52428800 },
  debug: false,
};
