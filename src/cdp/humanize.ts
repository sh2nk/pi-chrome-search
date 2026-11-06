/**
 * Human-like interaction primitives (SPEC §5.4, PLAN P2-C): type a query into a
 * real search box, wait for a text marker instead of a fixed sleep, and look
 * alive with one modest scroll before extraction.
 *
 * This module is deliberately engine-agnostic: adapters pass their search-box
 * candidates and result markers in. It attaches to the user's visible Chrome
 * through the frozen `CdpPage` surface only — no `Input.*`, no init scripts, no
 * fingerprint overrides.
 *
 * Every wait and pause goes through an injected `Clock`, so unit tests advance
 * virtual time and never spend real milliseconds. The page owns input dispatch:
 * this module clicks and calls `typeText`/`press`; it never hand-rolls key or
 * mouse events.
 */

import type { NavigateOptions, CdpPage } from "./types.ts";
import type { EngineId, EngineTypeProfile } from "../engines/types.ts";
import type { Clock } from "../runtime/types.ts";
import { fail, toFailure } from "../runtime/errors.ts";
import { systemClock } from "../runtime/clock.ts";
import { WebSearchError, isWebSearchError } from "../runtime/error-codes.ts";
import type { Stage } from "../runtime/error-codes.ts";

/** Anything a page/clock throws when the socket is gone: not "the tab was closed". */
const CDP_FAILURE_CODE = "E_CDP_DISCONNECTED";

const DEFAULT_DEADLINE_MS = 8_000;
const DEFAULT_POLL_MS = 150;
/**
 * A search box that has not appeared within this budget is not going to: the
 * home page is a wall/consent page or the layout changed. Falling back to the
 * direct SERP URL is faster than burning the whole settle deadline on the box.
 */
const BOX_DEADLINE_MS = 3_000;
/** SPEC §5.4: ±25% on the poll interval, so settle timing never looks metronomic. */
const JITTER_RATIO = 0.25;
/** A zero/negative poll would spin the event loop; 1 ms is the floor. */
const MIN_POLL_MS = 1;
const TYPE_MIN_MS = 30;
const TYPE_MAX_MS = 80;
const SCROLL_MIN_PX = 300;
const SCROLL_MAX_PX = 900;
const PAUSE_MIN_MS = 50;
const PAUSE_MAX_MS = 150;
/** Keeps `[0, 1)` semantics for an rng that returns exactly 1. */
const RNG_CEILING = 0.999_999;
const TIMEOUT_HINT = "the engine layout may have changed; run /web-doctor";
const MESSAGE_SNIPPET_CHARS = 60;

export interface WaitForMarkerOptions {
  /** Text that must appear in `page.innerText()`. Empty means "selector only". */
  marker: string;
  /** Optional structural marker; both checks must pass when both are set. */
  selector?: string;
  /** With `selector`, the minimum number of matches. Default 1. */
  minCount?: number;
  /** Default 8000 ms. */
  deadlineMs?: number;
  /** Base poll interval before jitter. Default 150 ms. */
  pollMs?: number;
  /** Jitter source for the poll interval; default `Math.random`. */
  rng?: () => number;
  signal?: AbortSignal;
  clock?: Clock;
}

export interface HumanSearchOptions {
  page: CdpPage;
  query: string;
  /** Engine home for the typed path. */
  homeUrl: string;
  /** Direct SERP for the fast path (and the fallback when no box appears). */
  serpUrl: string;
  /** Engine search-box candidates, tried in order. */
  boxSelectors: string[];
  marker: string;
  selector?: string;
  engine: EngineId;
  /**
   * `typing` (P10-C) types every search of every engine, `always` keeps the
   * pre-P10 "every search" meaning without a profile, and `auto` types only the
   * first search of the session.
   */
  mode: "auto" | "always" | "typing";
  firstInSession: boolean;
  focus: "session" | "always" | "never";
  /** Hosts a `homeUrl` navigation may land on; outside them means a redirect (P10-D). */
  homeHosts?: readonly string[];
  /** Per-engine box/delay/limit for `mode: "typing"` (P10-C). */
  typeProfile?: EngineTypeProfile;
  /** Start the typed path at the engine home (`home`, default) or on the SERP (`serp`). */
  typeOn?: "home" | "serp";
  deadlineMs?: number;
  pollMs?: number;
  clock?: Clock;
  rng?: () => number;
  signal?: AbortSignal;
}

export interface HumanSearchResult {
  /**
   * True only when this call actually sent keystrokes into the box. A call that
   * chose the typed path but fell back before typing reports `false` here and
   * `true` in `typedPath`, so the two flags never claim the same thing.
   */
  typed: boolean;
  /**
   * Whether this call selected the typed path (`mode:"typing"`, `"always"` or
   * the first search of the session), even when it degraded to the SERP fallback.
   */
  typedPath: boolean;
  /** True only when this call actually called `bringToFront`. */
  focused: boolean;
  /** Time spent waiting for the marker, in clock milliseconds (0 = instant). */
  settleMs: number;
  /** Pixels scrolled before extraction. */
  scrollPx: number;
  /** True when the box never appeared, the query was too long, or home redirected. */
  fellBackToSerp: boolean;
  /** Why the typed path was not used, when it wasn't. */
  fellBackReason?: "box-missing" | "query-too-long" | "home-redirect";
  /** Host the home navigation actually landed on when it was the wrong one. */
  homeRedirectHost?: string;
  /** Time the home navigation cost (0 on the fast path). */
  homeMs: number;
  /** Time spent clicking, typing and submitting (0 when nothing was typed). */
  typeMs: number;
}

export interface HumanScrollOptions {
  rng?: () => number;
  clock?: Clock;
  /** Optional cancellation for the trailing pause (the scroll itself is instant). */
  signal?: AbortSignal;
}

/** One rng value in `[0, 1)`; a hostile or broken rng cannot escape the range. */
function unitRandom(rng: () => number): number {
  const value = rng();
  if (!Number.isFinite(value)) return 0;
  return Math.min(RNG_CEILING, Math.max(0, value));
}

/** Inclusive integer in `[min, max]` from one rng draw. */
function randomBetween(min: number, max: number, rng: () => number): number {
  return Math.floor(min + unitRandom(rng) * (max - min + 1));
}

function normalizeDeadline(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DEADLINE_MS;
  return Math.max(0, Math.floor(value));
}

function normalizePoll(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.floor(value));
}

/** ±25% jitter around the base poll, clamped into `[floor(0.75p), ceil(1.25p)]` and at least 1 ms. */
function jitteredPollMs(pollMs: number, rng: () => number): number {
  const factor = 1 + (unitRandom(rng) * 2 - 1) * JITTER_RATIO;
  // Rounding a tiny base poll (1–3 ms) can land outside the ratio window, so the
  // result is clamped to the integer bounds of that window instead of trusted.
  const jittered = Math.round(pollMs * factor);
  const low = Math.max(MIN_POLL_MS, Math.floor(pollMs * (1 - JITTER_RATIO)));
  const high = Math.max(low, Math.ceil(pollMs * (1 + JITTER_RATIO)));
  return Math.min(high, Math.max(low, jittered));
}

function snippet(value: string): string {
  return value.length > MESSAGE_SNIPPET_CHARS ? `${value.slice(0, MESSAGE_SNIPPET_CHARS - 1)}…` : value;
}

/**
 * Shared poll primitives (P8-A). `cdp/ai-wait.ts` reuses exactly these three so
 * the streaming-summary wait has the same clock seam, deadline floor and ±25%
 * jitter as the settle wait — two waits that drift apart make latency numbers
 * incomparable.
 */
export { jitteredPollMs, normalizeDeadline, normalizePoll };

/** A JS string literal for `Runtime.evaluate`; selectors are data, not code. */
function literal(value: string): string {
  return JSON.stringify(value);
}

function countExpression(selector: string): string {
  // One-off extraction evaluate is allowed (SPEC §5.4); nothing is installed.
  return `document.querySelectorAll(${literal(selector)}).length`;
}

function existsExpression(selector: string): string {
  return `Boolean(document.querySelector(${literal(selector)}))`;
}

function navigateOptions(signal: AbortSignal | undefined): NavigateOptions {
  return signal === undefined ? {} : { signal };
}

function throwIfAborted(signal: AbortSignal | undefined, stage: Stage, engine?: EngineId): void {
  if (signal?.aborted !== true) return;
  throw fail("E_CANCELLED", stage, {
    ...(engine === undefined ? {} : { engine }),
    message: "aborted by the caller",
  });
}

/** Exported for `cdp/ai-wait.ts`: one failure taxonomy for every wait. */
export { asFailure, throwIfAborted };

/**
 * Normalize anything a page/clock can throw. A `WebSearchError` is already
 * precise and passes through unchanged (the browser layer is the only place
 * that may say E_TARGET_LOST); an abort becomes E_CANCELLED, a timeout becomes
 * E_TIMEOUT, and any other throw from the CDP layer becomes E_CDP_DISCONNECTED.
 * Nothing here guesses that the tab was closed: a socket error and a closed tab
 * have different remedies, and only the caller below the CDP surface knows which
 * one happened.
 */
function asFailure(error: unknown, stage: Stage, engine?: EngineId): WebSearchError {
  if (isWebSearchError(error)) {
    if (engine === undefined || error.details.engine !== undefined) return error;
    return new WebSearchError({ ...error.details, engine });
  }
  const details = toFailure(error, { code: CDP_FAILURE_CODE, stage });
  return new WebSearchError(engine === undefined ? details : { ...details, engine });
}

async function markerPresent(
  page: CdpPage,
  marker: string,
  selector: string | undefined,
  minCount: number,
): Promise<boolean> {
  if (marker !== "") {
    const text = await page.innerText();
    if (!text.includes(marker)) return false;
  }
  if (selector === undefined) return true;
  const count = await page.evaluate<unknown>(countExpression(selector));
  return typeof count === "number" && Number.isFinite(count) && count >= minCount;
}

/**
 * Poll until the marker (and, when given, `minCount` matches of `selector`) is
 * visible. A marker that is already on the page resolves with 0 and no sleep.
 *
 * Both checks are cheap and text-first: reading `innerText()` is one evaluate
 * and a text marker survives class-name churn, which is why the SPEC forbids a
 * fixed sleep here.
 *
 * Stale-marker risk (known, documented, not guessed around): text alone cannot
 * tell "the results are here" from "the engine home already contains this
 * word" — a search for "google" against a home page whose header says "Google"
 * settles instantly even though the SERP never loaded. That is why adapters
 * should pass `selector`+`minCount` (a result container, not a bare word). This
 * function never trades settlement for a navigation guess: it does not know
 * whether a navigation is in flight and must not pretend to.
 */
export async function waitForMarker(page: CdpPage, opts: WaitForMarkerOptions): Promise<number> {
  const clock = opts.clock ?? systemClock;
  const rng = opts.rng ?? Math.random;
  const deadlineMs = normalizeDeadline(opts.deadlineMs);
  const pollMs = normalizePoll(opts.pollMs);
  const selector = opts.selector === undefined || opts.selector === "" ? undefined : opts.selector;
  const minCount = selector === undefined ? 0 : Math.max(1, Math.floor(opts.minCount ?? 1));
  const start = clock.now();

  try {
    for (;;) {
      throwIfAborted(opts.signal, "settle");
      if (await markerPresent(page, opts.marker, selector, minCount)) {
        return Math.max(0, clock.now() - start);
      }
      const elapsed = clock.now() - start;
      if (elapsed >= deadlineMs) {
        const parts = [`marker "${snippet(opts.marker)}" not found after ${elapsed} ms`];
        if (selector !== undefined) {
          parts.push(`selector ${snippet(selector)} matched fewer than ${minCount} element(s)`);
        }
        throw fail("E_TIMEOUT", "settle", { hint: TIMEOUT_HINT, message: parts.join("; ") });
      }
      await clock.sleep(jitteredPollMs(pollMs, rng), opts.signal);
    }
  } catch (error) {
    throw asFailure(error, "settle");
  }
}

/**
 * First selector that currently resolves, in caller order. Nowhere near a
 * "truthy string" check: search boxes are `<input>`s, whose `innerText` is
 * empty even when visible, so existence must be asked of the DOM.
 */
async function findBox(page: CdpPage, boxSelectors: readonly string[]): Promise<string | null> {
  for (const selector of boxSelectors) {
    if (typeof selector !== "string" || selector === "") continue;
    const present = await page.evaluate<unknown>(existsExpression(selector));
    if (present === true) return selector;
  }
  return null;
}

/**
 * Wait (bounded) for one of the box candidates. Returns `null` on the box
 * deadline instead of throwing: the caller's fallback is a normal outcome, not
 * a failure, and must never hang.
 */
async function waitForBox(
  page: CdpPage,
  boxSelectors: readonly string[],
  deadlineMs: number,
  pollMs: number,
  clock: Clock,
  rng: () => number,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  throwIfAborted(signal, "navigate");
  if (boxSelectors.length === 0) return null;
  const start = clock.now();
  for (;;) {
    throwIfAborted(signal, "navigate");
    const box = await findBox(page, boxSelectors);
    if (box !== null) return box;
    const elapsed = clock.now() - start;
    if (elapsed >= deadlineMs) return null;
    await clock.sleep(jitteredPollMs(pollMs, rng), signal);
  }
}

function shouldFocus(policy: HumanSearchOptions["focus"], firstInSession: boolean): boolean {
  switch (policy) {
    case "always":
      return true;
    case "session":
      return firstInSession;
    case "never":
      return false;
  }
}

/** Code points, not UTF-16 units: an emoji must not count as two characters. */
function queryLength(query: string): number {
  return [...query].length;
}

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * Is this landing one of the engine's own host names? A `dzen.ru` landing after
 * `yandex.ru`/`ya.ru` is a redirect, not a home page (P10-D); a URL we cannot
 * parse is accepted, because guessing a redirect from garbage would be a lie.
 */
function homeAccepted(url: string, hosts: readonly string[] | undefined): boolean {
  if (hosts === undefined || hosts.length === 0) return true;
  const host = hostOf(url);
  if (host === null) return true;
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

/** Profile delays, clamped to a pace a real keyboard could produce. */
function typeDelays(profile: EngineTypeProfile | undefined): { minMs: number; maxMs: number } {
  const raw = profile?.keyDelayMs;
  if (raw === undefined) return { minMs: TYPE_MIN_MS, maxMs: TYPE_MAX_MS };
  const min = Math.min(250, Math.max(5, Math.round(raw[0])));
  const max = Math.max(min, Math.min(250, Math.round(raw[1])));
  return { minMs: min, maxMs: max };
}

/** How many characters the engine prefilled into the SERP box (read-only). */
async function boxValueLength(page: CdpPage, selector: string): Promise<number> {
  try {
    const raw = await page.evaluate<unknown>(
      `(() => { const el = document.querySelector(${literal(selector)}); ` +
        `return el && typeof el.value === "string" ? el.value.length : 0; })()`,
    );
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
    // A hostile/odd value must not turn into a thousand key presses.
    return Math.min(500, Math.max(0, Math.floor(raw)));
  } catch {
    return 0;
  }
}

/** Box candidates in profile-first order, without duplicates. */
function boxCandidates(selectors: readonly string[], profile: EngineTypeProfile | undefined): string[] {
  const ordered: string[] = [];
  for (const selector of [profile?.box, ...selectors]) {
    if (typeof selector !== "string" || selector === "" || ordered.includes(selector)) continue;
    ordered.push(selector);
  }
  return ordered;
}

/**
 * One search, human-shaped.
 *
 * Typed path (`mode:"typing"`, `mode:"always"` or the first search of the
 * session): open the engine home, click the box, type with jitter, press Enter.
 * Pressing Enter (rather than building a SERP URL) is why the browser sends the
 * same request a person would, from the same meaningful referrer chain.
 *
 * Three ways the typed path degrades — all honest, all reported in the result:
 * the box never appeared (`box-missing`), the query is longer than the engine's
 * box accepts (`query-too-long`; typing a truncated query would search for
 * something the user did not ask), or the home navigation landed on a host the
 * engine does not own (`home-redirect`, e.g. Yandex → Dzen, P10-D).
 *
 * Fast path: a direct SERP URL, which people share and reopen all the time.
 *
 * Then the marker wait and one 300–900 px scroll before extraction: the scroll
 * triggers lazy blocks (images, infoboxes, AI summaries) that a fresh SERP
 * defers until they enter the viewport, and it looks alive.
 */
export async function humanSearch(opts: HumanSearchOptions): Promise<HumanSearchResult> {
  const { page, engine } = opts;
  const clock = opts.clock ?? systemClock;
  const rng = opts.rng ?? Math.random;
  const signal = opts.signal;
  const deadlineMs = normalizeDeadline(opts.deadlineMs);
  const pollMs = normalizePoll(opts.pollMs);
  const typedPath = opts.mode === "typing" || opts.mode === "always" || opts.firstInSession;
  const profile = opts.typeProfile;
  const tooLong = profile !== undefined && queryLength(opts.query) > profile.maxChars;
  // Actual keystrokes, set only once `typeText` ran: the fallback below must not
  // report a typed search it never typed.
  let typed = false;
  let homeMs = 0;
  let typeMs = 0;
  const focused = shouldFocus(opts.focus, opts.firstInSession);
  let stage: Stage = "navigate";

  try {
    throwIfAborted(signal, stage, engine);
    // Focus before navigating: when the user is watching, they should see the
    // page load and the query being typed, not a window that pops forward later.
    if (focused) await page.bringToFront();

    let fellBackToSerp = false;
    let fellBackReason: HumanSearchResult["fellBackReason"];
    let homeRedirectHost: string | undefined;

    if (!typedPath) {
      await page.navigate(opts.serpUrl, navigateOptions(signal));
    } else if (tooLong) {
      // The box would silently truncate (or the engine would rewrite) the query.
      fellBackToSerp = true;
      fellBackReason = "query-too-long";
      await page.navigate(opts.serpUrl, navigateOptions(signal));
    } else if (opts.typeOn === "serp") {
      // The engine home page has no usable box (DuckDuckGo 2026-11): open the
      // SERP the way the fast path would and retype its prefilled query. This is
      // a person refining a search, and it keeps the typed path free of an extra
      // home-page load.
      await page.navigate(opts.serpUrl, navigateOptions(signal));
      const box = await waitForBox(
        page,
        boxCandidates(opts.boxSelectors, profile),
        Math.min(deadlineMs, BOX_DEADLINE_MS),
        pollMs,
        clock,
        rng,
        signal,
      );
      if (box === null) {
        // Already on the SERP: nothing to navigate, and the direct page is usable.
        fellBackToSerp = true;
        fellBackReason = "box-missing";
      } else {
        throwIfAborted(signal, stage, engine);
        const typingStart = clock.now();
        await page.click(box);
        const prefilled = await boxValueLength(page, box);
        for (let index = 0; index < prefilled; index += 1) {
          throwIfAborted(signal, stage, engine);
          await page.press("Backspace");
        }
        const { minMs, maxMs } = typeDelays(profile);
        await page.typeText(opts.query, { minMs, maxMs });
        typed = true;
        throwIfAborted(signal, stage, engine);
        await page.press("Enter");
        typeMs = Math.max(0, clock.now() - typingStart);
      }
    } else {
      const homeStart = clock.now();
      await page.navigate(opts.homeUrl, navigateOptions(signal));
      homeMs = Math.max(0, clock.now() - homeStart);

      let landed = page.url();
      try {
        landed = await page.currentUrl();
      } catch {
        // The cached URL is the best available answer; a failed probe is not a redirect.
      }
      if (!homeAccepted(landed, opts.homeHosts)) {
        // Yandex warm-up can land on Dzen; the SERP URL is still a human entry.
        fellBackToSerp = true;
        fellBackReason = "home-redirect";
        homeRedirectHost = hostOf(landed) ?? undefined;
        await page.navigate(opts.serpUrl, navigateOptions(signal));
      } else {
        const box = await waitForBox(
          page,
          boxCandidates(opts.boxSelectors, profile),
          Math.min(deadlineMs, BOX_DEADLINE_MS),
          pollMs,
          clock,
          rng,
          signal,
        );
        if (box === null) {
          // Consent walls and layout changes keep the box away; the SERP URL is
          // still a legitimate human entry point, and the tool layer logs the flag.
          fellBackToSerp = true;
          fellBackReason = "box-missing";
          await page.navigate(opts.serpUrl, navigateOptions(signal));
        } else {
          throwIfAborted(signal, stage, engine);
          const typingStart = clock.now();
          await page.click(box);
          const { minMs, maxMs } = typeDelays(profile);
          await page.typeText(opts.query, { minMs, maxMs });
          typed = true;
          // Typing is a page call without a signal; an abort that landed mid-query
          // must not submit a half-typed search.
          throwIfAborted(signal, stage, engine);
          await page.press("Enter");
          typeMs = Math.max(0, clock.now() - typingStart);
        }
      }
    }

    stage = "settle";
    const settleMs = await waitForMarker(page, {
      marker: opts.marker,
      ...(opts.selector === undefined ? {} : { selector: opts.selector }),
      deadlineMs,
      pollMs,
      rng,
      ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      ...(signal === undefined ? {} : { signal }),
    });

    stage = "extract";
    const scrollPx = await humanScroll(page, {
      rng,
      clock,
      ...(signal === undefined ? {} : { signal }),
    });

    return {
      typed,
      typedPath,
      focused,
      settleMs,
      scrollPx,
      fellBackToSerp,
      ...(fellBackReason === undefined ? {} : { fellBackReason }),
      ...(homeRedirectHost === undefined ? {} : { homeRedirectHost }),
      homeMs,
      typeMs,
    };
  } catch (error) {
    throw asFailure(error, stage, engine);
  }
}

/**
 * One scroll of 300–900 px plus a 50–150 ms pause. Returns the pixels so the
 * caller can log them. The rng is clamped: a broken generator must not produce
 * a 20 000 px jump (a scroll that large is a bot tell and can miss the lazy
 * block that only loads just below the fold).
 */
export async function humanScroll(page: CdpPage, opts: HumanScrollOptions = {}): Promise<number> {
  const clock = opts.clock ?? systemClock;
  const rng = opts.rng ?? Math.random;
  const px = randomBetween(SCROLL_MIN_PX, SCROLL_MAX_PX, rng);
  const pauseMs = randomBetween(PAUSE_MIN_MS, PAUSE_MAX_MS, rng);
  try {
    await page.scroll(px);
    await clock.sleep(pauseMs, opts.signal);
  } catch (error) {
    throw asFailure(error, "extract");
  }
  return px;
}
