/**
 * Frozen CDP surface. Adapters see `CdpPage` and nothing else, so a fake page
 * (P0-C) is enough to test every extractor offline.
 */

import type { EngineId } from "../engines/types.ts";

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
 */
export type PageKey = EngineId | "read";

export interface CdpPage {
  /** Current URL, synchronously, as last known to the target. */
  url(): string;
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
}
