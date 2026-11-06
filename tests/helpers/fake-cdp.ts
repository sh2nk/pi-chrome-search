/**
 * The fake CDP doubles used by the offline suite: a virtual clock, cookie-domain
 * matching and an in-memory `CdpPage`.
 *
 * Nothing here touches a socket. `FakePage.navigate()` changes a string,
 * `innerText()` returns configured text, `evaluate()` runs a handler map, and
 * every call is recorded so a test can assert navigation counts, keystroke
 * delays, scroll distances and focus calls. `FakeClock` removes wall-clock
 * waits from pacing/abort tests.
 *
 * `cookiesFor(urls)` filters by cookie domain, because a fake that returned the
 * whole jar would let a wrong-host cookie bug pass: real Chrome never sends a
 * `.google.com` session cookie to a yandex tab.
 */

import type {
  CdpPage,
  CookieInfo,
  EvaluateOptions,
  NavigateOptions,
  TypeOptions,
} from "../../src/cdp/types.ts";
import type { Clock } from "../../src/runtime/types.ts";

/**
 * Deterministic `Clock` for cache/TTL/pacing tests (P2-B) and abort paths (P2-C).
 *
 * Two modes:
 *  - `autoAdvance: true` (default) — `sleep(ms)` resolves in a microtask and moves
 *    virtual time forward by `ms`. No wall-clock wait, so limiter tests can simply
 *    `await limiter.acquire(...)`.
 *  - `autoAdvance: false` — sleeps stay pending until `advance()`/`advanceTo()`.
 *    This is the mode to use when asserting abort behaviour: an auto-advancing
 *    sleep has no observable pending window.
 *
 * Abort choice: reject with `signal.reason` when set, otherwise with a DOMException
 * named `AbortError` (the same shape `node:timers/promises` produces). The tool
 * layer maps that to `E_CANCELLED`; tests that need the exact taxonomy can pass
 * `new WebSearchError({ code: "E_CANCELLED", ... })` as the abort reason.
 */


/** Default virtual epoch: 2026-01-01T00:00:00Z. Deterministic across timezones for date math. */
export const DEFAULT_FAKE_NOW = Date.UTC(2026, 0, 1);

export interface FakeClockOptions {
  /** Initial virtual epoch milliseconds. */
  now?: number;
  /** Resolve sleeps immediately and move time forward. Default `true`. */
  autoAdvance?: boolean;
}

export interface SleepRecord {
  /** Requested duration. */
  ms: number;
  /** Virtual time when `sleep` was called. */
  at: number;
  /** Virtual time when the sleep was due. */
  due: number;
  /** Virtual time when it settled, or `null` while pending / rejected. */
  resolvedAt: number | null;
}

interface Waiter {
  record: SleepRecord;
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function abortReason(signal?: AbortSignal): unknown {
  if (signal !== undefined && signal.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(value: unknown): boolean {
  if (value instanceof DOMException) return value.name === "AbortError";
  return value instanceof Error && value.name === "AbortError";
}

export class FakeClock implements Clock {
  #now: number;
  #autoAdvance: boolean;
  #log: SleepRecord[] = [];
  #waiters = new Set<Waiter>();

  constructor(options: FakeClockOptions = {}) {
    this.#now = options.now ?? DEFAULT_FAKE_NOW;
    this.#autoAdvance = options.autoAdvance ?? true;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.sleep: expected a finite non-negative duration, got ${String(ms)}`);
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    const record: SleepRecord = { ms, at: this.#now, due: this.#now + ms, resolvedAt: null };
    this.#log.push(record);

    if (this.#autoAdvance) {
      this.#now = record.due;
      record.resolvedAt = record.due;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        record,
        resolve: () => {
          record.resolvedAt = this.#now;
          this.#detach(waiter);
          this.#waiters.delete(waiter);
          resolve();
        },
        reject: (reason: unknown) => {
          this.#detach(waiter);
          this.#waiters.delete(waiter);
          reject(reason);
        },
      };
      if (signal !== undefined) {
        waiter.signal = signal;
        waiter.onAbort = () => waiter.reject(abortReason(signal));
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.add(waiter);
    });
  }

  /** Move virtual time forward and resolve every sleep whose due time was reached. */
  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`FakeClock.advance: expected a finite non-negative duration, got ${String(ms)}`);
    }
    this.#now += ms;
    this.#wake();
    return this.#now;
  }

  /** Jump to an absolute epoch. Refuses to move backwards (use `setNow` for that). */
  advanceTo(epochMs: number): number {
    if (!Number.isFinite(epochMs)) throw new RangeError("FakeClock.advanceTo: expected a finite epoch");
    if (epochMs > this.#now) {
      this.#now = epochMs;
      this.#wake();
    }
    return this.#now;
  }

  /** Test escape hatch for date-boundary scenarios (e.g. daily caps). */
  setNow(epochMs: number): void {
    if (!Number.isFinite(epochMs)) throw new RangeError("FakeClock.setNow: expected a finite epoch");
    this.#now = epochMs;
  }

  /** Only affects future sleeps; already-pending waiters keep waiting for `advance`. */
  setAutoAdvance(enabled: boolean): void {
    this.#autoAdvance = enabled;
  }

  pendingCount(): number {
    return this.#waiters.size;
  }

  /** Every recorded sleep, in call order. Durations are what tests usually assert. */
  sleepLog(): ReadonlyArray<SleepRecord> {
    return this.#log.map((record) => ({ ...record }));
  }

  durations(): number[] {
    return this.#log.map((record) => record.ms);
  }

  totalSleptMs(): number {
    return this.#log.reduce((sum, record) => sum + record.ms, 0);
  }

  #wake(): void {
    const due = [...this.#waiters].filter((waiter) => waiter.record.due <= this.#now);
    due.sort((a, b) => a.record.due - b.record.due);
    for (const waiter of due) waiter.resolve();
  }

  #detach(waiter: Waiter): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
  }
}

/**
 * Cookie↔URL matching shared by `FakePage.cookiesFor()` and the fake CDP
 * server's `Network.getCookies`.
 *
 * Real Chrome returns only the cookies whose domain applies to one of the
 * requested URLs. A fake that always returned every cookie would hide exactly
 * the bugs P1-B/P3 need to catch: sending a `.google.com` session cookie to a
 * yandex tab, or dropping the `.yandex.ru` cookies a `/goto` resolve needs.
 *
 * Rules (RFC 6265 §5.1.3, simplified):
 *  - `Domain=.example.com` matches `example.com` and every subdomain;
 *  - `Domain=example.com` (host-only in a capture) matches the host itself and,
 *    because CDP does not expose `hostOnly` in `CookieInfo`, its subdomains too;
 *  - a plain suffix must not match a different registrable name
 *    (`example.com` vs `notexample.com`), so the dot boundary is required;
 *  - an unparsable URL contributes no host; `about:blank` has no host at all.
 *
 * Path and `Secure` scoping are intentionally ignored: the harness models the
 * domain filter that callers depend on, not the whole cookie store.
 */

export interface DomainScopedCookie {
  domain: string;
}

/** Lowercases and strips the `Domain=` leading dot and a trailing root dot. */
export function normalizeCookieDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
}

/** Hostname of `url`, or `undefined` for a relative/unparsable/opaque URL. */
export function hostFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname.length === 0) return undefined;
  return parsed.hostname.toLowerCase().replace(/\.$/, "");
}

export function cookieMatchesHost(domain: string, host: string): boolean {
  const cookieDomain = normalizeCookieDomain(domain);
  const urlHost = host.trim().toLowerCase().replace(/\.$/, "");
  if (cookieDomain.length === 0 || urlHost.length === 0) return false;
  if (urlHost === cookieDomain) return true;
  return urlHost.endsWith(`.${cookieDomain}`);
}

/**
 * Domain filter used by `cookiesFor()`/`Network.getCookies`: an empty or
 * omitted `urls` list means "the whole jar", matching CDP's `getAllCookies`.
 * When URLs are given but none parse, nothing matches — never everything.
 */
export function filterCookiesForUrls<T extends DomainScopedCookie>(
  cookies: readonly T[],
  urls?: readonly string[],
): T[] {
  if (urls === undefined || urls.length === 0) return [...cookies];
  const hosts = new Set<string>();
  for (const url of urls) {
    const host = hostFromUrl(url);
    if (host !== undefined) hosts.add(host);
  }
  if (hosts.size === 0) return [];
  return cookies.filter((cookie) => [...hosts].some((host) => cookieMatchesHost(cookie.domain, host)));
}

/**
 * In-memory `CdpPage` (src/cdp/types.ts) for P1-D/P1-E, P2-C and every adapter
 * test in P3/P4.
 *
 * Nothing here touches a socket: `navigate()` changes a string, `innerText()`
 * returns configured text, `evaluate()` runs a handler map. Every method records
 * a call so tests can spy on navigation count, keystroke delays, scroll
 * distances and focus calls (V1.2 / V2.4).
 *
 * `url()` is the exception: it is a synchronous getter used on hot paths, so it
 * is not recorded. Everything that mutates or reads the document is.
 *
 * `innerText(selector)` mirrors the frozen contract: a selector that is not
 * configured returns `""`, never the document text. A selector-blind page is
 * still available through `innerText()` (no selector).
 *
 * `cookiesFor(urls)` filters by cookie domain, because a fake that returned the
 * whole jar would let a wrong-host cookie bug pass P1/P3 tests.
 */


export type FakePageCallKind =
  | "navigate"
  | "title"
  | "evaluate"
  | "innerText"
  | "html"
  | "click"
  | "typeText"
  | "press"
  | "scroll"
  | "screenshot"
  | "cookiesFor"
  | "bringToFront";

export interface FakePageCall {
  seq: number;
  kind: FakePageCallKind;
  /** Clock time when available, wall time otherwise. */
  at: number;
  url?: string;
  expression?: string;
  selector?: string;
  text?: string;
  key?: string;
  dy?: number;
  point?: { x: number; y: number };
  urls?: string[];
  awaitPromise?: boolean;
  minMs?: number;
  maxMs?: number;
}

/**
 * Page text. A string is the document text; a function is selector-aware and is
 * called for `innerText(selector)` too, so it must return `""` for a selector
 * the modelled page does not have. Plain strings never leak into a missing
 * selector (see `#textFor`).
 */
export type FakePageText = string | ((selector: string | undefined) => string);

export type EvaluateHandler = (
  expression: string,
  options?: EvaluateOptions,
) => unknown | Promise<unknown>;

/**
 * Handler lookup:
 *  - a function receives every expression;
 *  - a plain object matches keys by substring, first entry in insertion order;
 *  - a Map may use strings (substring) or RegExp keys.
 * Unmatched expressions return `null`, mirroring a document that found nothing.
 */
export type EvaluateHandlers =
  | EvaluateHandler
  | ReadonlyMap<string | RegExp, EvaluateHandler>
  | Record<string, EvaluateHandler>;

export interface FakePageOptions {
  url?: string;
  title?: string;
  /** Default visible text. A function can vary by selector. */
  text?: FakePageText;
  /** Selector-specific text; takes precedence over `text`. */
  texts?: Record<string, string>;
  html?: string;
  cookies?: CookieInfo[];
  screenshot?: Buffer | Uint8Array;
  /** Injected clock; its `sleep` drives `typeText` delays. */
  clock?: Clock;
  /** Per-character delay range. Default 30..80 ms, matching P2-C. */
  typeDelayMs?: { min?: number; max?: number };
  /** Deterministic RNG in [0, 1) for the delays. Default `Math.random`. */
  random?: () => number;
  evaluate?: EvaluateHandlers;
  /** Runs after `url` is updated; use it to swap text/html per navigation. */
  onNavigate?: (url: string, page: FakePage) => void | Promise<void>;
}

interface TypedSession {
  text: string;
  delays: number[];
}

const DEFAULT_TYPE_MIN = 30;
const DEFAULT_TYPE_MAX = 80;
const MAX_TYPE_DELAY = 2_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function matchesKey(key: string | RegExp, expression: string): boolean {
  if (typeof key === "string") return expression.includes(key);
  key.lastIndex = 0;
  return key.test(expression);
}

export class FakePage implements CdpPage {
  #url: string;
  #title: string;
  #text: FakePageText;
  #texts: Record<string, string>;
  #html: string;
  #cookies: CookieInfo[];
  #screenshot: Buffer;
  #clock: Clock | undefined;
  #typeMin: number;
  #typeMax: number;
  #random: () => number;
  #evaluate: EvaluateHandlers | undefined;
  #onNavigate: FakePageOptions["onNavigate"];
  #scrollY = 0;
  #bringToFronts = 0;
  #seq = 0;
  #calls: FakePageCall[] = [];
  #typed: TypedSession[] = [];
  #delays: number[] = [];

  constructor(options: FakePageOptions = {}) {
    this.#url = options.url ?? "about:blank";
    this.#title = options.title ?? "";
    this.#text = options.text ?? "";
    this.#texts = { ...(options.texts ?? {}) };
    this.#html = options.html ?? "";
    this.#cookies = (options.cookies ?? []).map((cookie) => ({ ...cookie }));
    this.#screenshot = Buffer.from(options.screenshot ?? Buffer.from("fake-screenshot"));
    this.#clock = options.clock;
    this.#typeMin = clamp(options.typeDelayMs?.min ?? DEFAULT_TYPE_MIN, 1, MAX_TYPE_DELAY);
    this.#typeMax = clamp(options.typeDelayMs?.max ?? DEFAULT_TYPE_MAX, this.#typeMin, MAX_TYPE_DELAY);
    this.#random = options.random ?? Math.random;
    this.#evaluate = options.evaluate;
    this.#onNavigate = options.onNavigate;
  }

  // --- CdpPage -------------------------------------------------------------

  url(): string {
    return this.#url;
  }

  /**
   * The authoritative URL. Offline tests exercise the post-navigate proof with
   * the same value as `url()`; a test that wants a racing document overrides
   * this method or swaps the URL from an evaluate handler.
   */
  async currentUrl(): Promise<string> {
    return this.#url;
  }

  async title(): Promise<string> {
    this.#record({ kind: "title" });
    return this.#title;
  }

  async navigate(url: string, options: NavigateOptions = {}): Promise<void> {
    this.#record({ kind: "navigate", url });
    if (options.signal?.aborted) throw abortReason(options.signal);
    this.#url = url;
    if (this.#onNavigate !== undefined) await this.#onNavigate(url, this);
    if (options.signal?.aborted) throw abortReason(options.signal);
  }

  async evaluate<T>(expression: string, options: EvaluateOptions = {}): Promise<T> {
    this.#record({ kind: "evaluate", expression, awaitPromise: options.awaitPromise });
    const value = await this.#resolveEvaluate(expression, options);
    return value as T;
  }

  async innerText(selector?: string): Promise<string> {
    this.#record({ kind: "innerText", selector });
    return this.#textFor(selector);
  }

  async html(): Promise<string> {
    this.#record({ kind: "html" });
    return this.#html;
  }

  async click(selectorOrPoint: string | { x: number; y: number }): Promise<void> {
    if (typeof selectorOrPoint === "string") {
      this.#record({ kind: "click", selector: selectorOrPoint });
      return;
    }
    this.#record({ kind: "click", point: { x: selectorOrPoint.x, y: selectorOrPoint.y } });
  }

  /**
   * Types one character at a time. With a real `FakeClock` this advances virtual
   * time; without one it still records the delays but returns immediately, so
   * unit tests never sit in a real 30 ms loop.
   */
  async typeText(text: string, options: TypeOptions = {}): Promise<void> {
    const min = clamp(options.minMs ?? this.#typeMin, 1, MAX_TYPE_DELAY);
    const max = clamp(options.maxMs ?? this.#typeMax, min, MAX_TYPE_DELAY);
    const characters = [...text];
    const delays = characters.map(() => this.#nextDelay(min, max));
    this.#record({ kind: "typeText", text, minMs: min, maxMs: max });
    this.#typed.push({ text, delays: [...delays] });
    for (const delay of delays) {
      this.#delays.push(delay);
      if (this.#clock !== undefined) await this.#clock.sleep(delay);
    }
  }

  async press(key: string): Promise<void> {
    this.#record({ kind: "press", key });
  }

  async scroll(dy: number): Promise<void> {
    this.#record({ kind: "scroll", dy });
    this.#scrollY += dy;
  }

  async screenshot(): Promise<Buffer> {
    this.#record({ kind: "screenshot" });
    return Buffer.from(this.#screenshot);
  }

  async cookiesFor(urls: string[] = []): Promise<CookieInfo[]> {
    this.#record({ kind: "cookiesFor", urls: [...urls] });
    return filterCookiesForUrls(this.#cookies, urls).map((cookie) => ({ ...cookie }));
  }

  async bringToFront(): Promise<void> {
    this.#bringToFronts += 1;
    this.#record({ kind: "bringToFront" });
  }

  // --- test state ----------------------------------------------------------

  setUrl(url: string): void {
    this.#url = url;
  }

  setTitle(title: string): void {
    this.#title = title;
  }

  setText(text: string, selector?: string): void {
    if (selector === undefined) {
      this.#text = text;
      return;
    }
    this.#texts[selector] = text;
  }

  setHtml(html: string): void {
    this.#html = html;
  }

  setCookies(cookies: CookieInfo[]): void {
    this.#cookies = cookies.map((cookie) => ({ ...cookie }));
  }

  setScreenshot(screenshot: Buffer | Uint8Array): void {
    this.#screenshot = Buffer.from(screenshot);
  }

  setEvaluateHandlers(handlers: EvaluateHandlers | undefined): void {
    this.#evaluate = handlers;
  }

  setNavigateHandler(handler: FakePageOptions["onNavigate"]): void {
    this.#onNavigate = handler;
  }

  // --- spies ---------------------------------------------------------------

  calls(kind?: FakePageCallKind): FakePageCall[] {
    const selected = kind === undefined ? this.#calls : this.#calls.filter((call) => call.kind === kind);
    return selected.map((call) => ({ ...call, point: call.point ? { ...call.point } : undefined }));
  }

  callCount(kind: FakePageCallKind): number {
    return this.#calls.reduce((count, call) => (call.kind === kind ? count + 1 : count), 0);
  }

  navigations(): string[] {
    return this.#calls.flatMap((call) => (call.kind === "navigate" && call.url !== undefined ? [call.url] : []));
  }

  lastNavigation(): string | undefined {
    return this.navigations().at(-1);
  }

  evaluateCalls(): Array<{ expression: string; awaitPromise: boolean }> {
    return this.#calls.flatMap((call) =>
      call.kind === "evaluate" && call.expression !== undefined
        ? [{ expression: call.expression, awaitPromise: call.awaitPromise === true }]
        : [],
    );
  }

  clicks(): Array<string | { x: number; y: number }> {
    return this.#calls.flatMap((call): Array<string | { x: number; y: number }> => {
      if (call.kind !== "click") return [];
      if (call.selector !== undefined) return [call.selector];
      if (call.point !== undefined) return [{ x: call.point.x, y: call.point.y }];
      return [];
    });
  }

  typedTexts(): string[] {
    return this.#typed.map((session) => session.text);
  }

  typedSessions(): Array<{ text: string; delays: number[] }> {
    return this.#typed.map((session) => ({ text: session.text, delays: [...session.delays] }));
  }

  /** Flattened per-character delays across every `typeText` call. */
  typeDelays(): number[] {
    return [...this.#delays];
  }

  presses(): string[] {
    return this.#calls.flatMap((call) => (call.kind === "press" && call.key !== undefined ? [call.key] : []));
  }

  scrolls(): number[] {
    return this.#calls.flatMap((call) => (call.kind === "scroll" && call.dy !== undefined ? [call.dy] : []));
  }

  scrollY(): number {
    return this.#scrollY;
  }

  bringToFrontCount(): number {
    return this.#bringToFronts;
  }

  clearCalls(): void {
    this.#calls = [];
    this.#typed = [];
    this.#delays = [];
  }

  // --- internals -----------------------------------------------------------

  #record(call: Omit<FakePageCall, "seq" | "at">): void {
    this.#seq += 1;
    this.#calls.push({
      ...call,
      seq: this.#seq,
      at: this.#clock !== undefined ? this.#clock.now() : Date.now(),
    });
  }

  #textFor(selector?: string): string {
    if (selector === undefined) {
      return typeof this.#text === "function" ? this.#text(undefined) : this.#text;
    }
    if (Object.hasOwn(this.#texts, selector)) return this.#texts[selector] ?? "";
    // A function is an explicit selector-aware document and owns the "missing"
    // decision; a string is document-wide text and must not answer for a
    // selector that was never configured (frozen CdpPage contract: "").
    if (typeof this.#text === "function") return this.#text(selector);
    return "";
  }

  #nextDelay(min: number, max: number): number {
    const random = clamp(this.#random(), 0, 0.999_999);
    return Math.min(max, min + Math.floor(random * (max - min + 1)));
  }

  async #resolveEvaluate(expression: string, options: EvaluateOptions): Promise<unknown> {
    const handlers = this.#evaluate;
    if (handlers === undefined) return null;
    if (typeof handlers === "function") return await handlers(expression, options);
    if (handlers instanceof Map) {
      for (const [key, handler] of handlers) {
        if (matchesKey(key, expression)) return await handler(expression, options);
      }
      return null;
    }
    for (const [key, handler] of Object.entries(handlers)) {
      if (expression.includes(key)) return await handler(expression, options);
    }
    return null;
  }
}
