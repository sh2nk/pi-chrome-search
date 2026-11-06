/**
 * Frozen CDP surface. Adapters see `CdpPage` and nothing else, so a fake page
 * (P0-C) is enough to test every extractor offline.
 */

import type { EngineId } from "../engines/types.ts";
import type { WorkAnnouncement } from "../runtime/panel.ts";

export interface NavigateOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EvaluateOptions {
  awaitPromise?: boolean;
}

export interface TypeOptions {
  minMs?: number;
  maxMs?: number;
}

export interface CookieInfo {
  name: string;
  value: string;
  domain: string;
}

/**
 * Work-tab key. Search tabs are keyed by engine; a read gets its own tab so a
 * long article never navigates the SERP tab out from under a cached result.
 *
 * `read#<n>` is a pool slot (P9-A, `config.read.pool`): the tool takes an
 * exclusive lock per key, so two reads on different slots never share a tab.
 * Slot ids only exist for reads; an engine keeps its single tab.
 */
export type PageKey = EngineId | "read" | `read#${number}`;

export interface CdpPage {
  /**
   * Current URL as last known to the target (synchronously). This is a cache,
   * not a fact: a navigation the extension did not drive (a typed search, a
   * JS redirect) can leave it stale. `currentUrl()` is the authoritative read.
   */
  url(): string;
  /**
   * Ask the document for `location.href` and refresh the cached `url()`.
   * Used as the post-navigate proof (P9-B): a read compares this value before
   * and after extraction instead of trusting a target-event cache. Falls back
   * to the cached value when the document cannot be asked.
   */
  currentUrl(): Promise<string>;
  title(): Promise<string>;
  navigate(url: string, o?: NavigateOptions): Promise<void>;
  evaluate<T>(expression: string, o?: EvaluateOptions): Promise<T>;
  /** Visible text of the document, or of one selector. Empty string when missing. */
  innerText(selector?: string): Promise<string>;
  html(): Promise<string>;
  click(selectorOrPoint: string | { x: number; y: number }): Promise<void>;
  typeText(text: string, o?: TypeOptions): Promise<void>;
  press(key: string): Promise<void>;
  scroll(dy: number): Promise<void>;
  screenshot(): Promise<Buffer>;
  cookiesFor(urls: string[]): Promise<CookieInfo[]>;
  bringToFront(): Promise<void>;
}

export type CdpSource = "env-ws" | "env-ports" | "devtools-active-port" | "port-scan";

export interface CdpEndpoint {
  /** TCP port that answered the probe (for DevToolsActivePort: the port in the file). */
  port: number;
  /** The URL the session client must connect to. Never rebuild it from `port` — a probed
   * /json/version response may advertise a different port than the one that answered. */
  wsUrl: string;
  source: CdpSource;
  /** Profile directory the endpoint was found for, when known. */
  profileDir?: string;
}

export interface BrowserInfo {
  product: string;
  protocolVersion: string;
  userAgent: string;
  revision: string;
  jsVersion: string;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

export interface CdpConnectionInfo {
  endpoint: CdpEndpoint;
  browser: BrowserInfo;
  /** Result of `navigator.webdriver` on an owned page; must be false in attach mode. */
  webdriver: boolean;
}

/** Implemented by cdp/browser.ts (P1-D). Tools never touch raw sockets. */
export interface CdpConnector {
  connect(): Promise<CdpConnectionInfo>;
  /** One owned work tab per engine, reused across calls. */
  acquirePage(target: PageKey): Promise<CdpPage>;
  /** Closes only tabs/windows this extension opened. */
  releaseAll(): Promise<void>;
  isConnected(): boolean;
  endpoint(): CdpEndpoint | null;
  /**
   * P10-A/B: report a stage to the owned anchor and apply `window.follow`.
   * Optional so offline fakes need nothing; a connector without it simply has no
   * panel and no follow behaviour. Best effort by contract: it never throws a
   * search failure for a cosmetic paint or a focus call.
   */
  announce?(update: WorkAnnouncement): Promise<void>;
}
