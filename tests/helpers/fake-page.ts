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

import type {
  CdpPage,
  CookieInfo,
  EvaluateOptions,
  NavigateOptions,
  TypeOptions,
} from "../../src/cdp/types.ts";
import type { Clock } from "../../src/runtime/types.ts";
import { abortReason } from "./clock.ts";
import { filterCookiesForUrls } from "./cookie-match.ts";

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
