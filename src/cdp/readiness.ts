/**
 * Document readiness for `web_read` (SPEC S5.1, S5.2).
 *
 * `navigate()` resolves at a *commit* and waits for `readyState interactive`,
 * which is the right bar for a SERP but not for an article: a client-rendered
 * page can be interactive with an empty body and paint its text a moment later.
 * v1 extracted immediately in that state, so a JS-heavy page came back as a
 * misleading `E_PARSE` with no text (SPEC appendix). This module adds the read
 * bar on top of the navigation bar:
 *
 *   readyState >= interactive AND (visible text >= 200 chars OR complete)
 *
 * The 200-char floor is the point: an interactive SPA with a shell is not ready,
 * while a complete short page (`complete` wins) is. The wait is bounded by a
 * soft deadline (2.5 s) that is itself clamped by the call budget. There is no
 * `loadEventFired` dependency and no fixed settle sleep: each probe is a
 * one-off `Runtime.evaluate`, and the poll interval backs off between a short
 * first look and a 250 ms cap.
 *
 * `waitForDocumentReadiness` never throws on "not ready": it returns the last
 * observation and lets the caller extract what is there. A complete but empty
 * document is the caller's `E_EMPTY_PAGE`, not a readiness timeout. Only the
 * clock abort (budget/caller) or a transport failure propagates.
 */

import type { CdpPage } from "./types.ts";
import type { Clock } from "../runtime/types.ts";

/** SPEC S5.1: a document with this much visible text is readable while interactive. */
export const READINESS_TEXT_FLOOR = 200;
/** SPEC S5.1: soft deadline inside the call budget; not a navigation timeout. */
export const READINESS_SOFT_DEADLINE_MS = 2500;
/** First look: a page that paints synchronously must not pay a settle sleep. */
export const READINESS_FIRST_POLL_MS = 50;
/** Upper bound for one poll interval; keeps the deadline arithmetic predictable. */
export const READINESS_MAX_POLL_MS = 250;

/**
 * One self-contained probe. It runs in the page, so it uses only `document` and
 * returns by value; `page.evaluate` is a one-off `Runtime.evaluate` (hard rule
 * 3 forbids `addScriptToEvaluateOnNewDocument`, not this).
 */
export const READINESS_PROBE = `(() => {
  const body = document.body;
  const raw = body === null ? "" : (body.innerText || body.textContent || "");
  return { readyState: document.readyState, textChars: raw.replace(/\\s+/g, " ").trim().length };
})()`;

export interface DocumentReadiness {
  /** `document.readyState`: loading, interactive or complete. */
  readyState: string;
  /** Visible text length after whitespace normalisation. */
  textChars: number;
}

export interface ReadinessOutcome {
  ready: boolean;
  /** Last observation, useful in the failure artifact/message. */
  state: DocumentReadiness;
  /** True when the soft deadline arrived while the document was still thin. */
  softDeadlineHit: boolean;
}

export interface ReadinessOptions {
  clock: Clock;
  /** Soft deadline in ms; the caller clamps it to the remaining call budget. */
  softDeadlineMs?: number;
  /** Call budget/caller abort; wins over the soft deadline. */
  signal?: AbortSignal;
}

function safeState(value: unknown): DocumentReadiness {
  if (typeof value !== "object" || value === null) return { readyState: "loading", textChars: 0 };
  const record = value as Record<string, unknown>;
  const readyState = typeof record.readyState === "string" ? record.readyState : "loading";
  const textChars =
    typeof record.textChars === "number" && Number.isFinite(record.textChars)
      ? Math.max(0, Math.floor(record.textChars))
      : 0;
  return { readyState, textChars };
}

/** SPEC S5.1, in one place so the probe and the tests cannot drift. */
export function isDocumentReady(state: DocumentReadiness): boolean {
  if (state.readyState === "complete") return true;
  if (state.readyState !== "interactive") return false;
  return state.textChars >= READINESS_TEXT_FLOOR;
}

/**
 * Poll until the document is ready or the soft deadline expires. The page is
 * never navigated or modified; only `document.readyState` and the visible text
 * length are read.
 */
export async function waitForDocumentReadiness(
  page: CdpPage,
  options: ReadinessOptions,
): Promise<ReadinessOutcome> {
  const requested = Number.isFinite(options.softDeadlineMs)
    ? Math.max(0, Math.floor(options.softDeadlineMs as number))
    : READINESS_SOFT_DEADLINE_MS;
  const deadline = options.clock.now() + Math.min(requested, READINESS_SOFT_DEADLINE_MS);
  let interval = READINESS_FIRST_POLL_MS;

  for (;;) {
    const state = safeState(await page.evaluate<unknown>(READINESS_PROBE));
    if (isDocumentReady(state)) {
      return { ready: true, state, softDeadlineHit: false };
    }

    const remaining = deadline - options.clock.now();
    if (remaining <= 0) {
      return { ready: false, state, softDeadlineHit: true };
    }

    await options.clock.sleep(Math.min(interval, remaining), options.signal);
    interval = Math.min(READINESS_MAX_POLL_MS, interval * 2);
  }
}
