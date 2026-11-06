/**
 * Streaming-summary wait (PLAN-v2 P8-A, gates V8.1–V8.5).
 *
 * The bug this module exists for: the engine's SERP shell settles while the AI
 * block is still streaming (or not rendered yet), extraction runs, and a
 * labelled-but-empty block was shipped as `ai:yes`. The fix is to *wait for
 * prose*, bounded, and to report what was actually seen:
 *
 *  - the wait ends the moment the probe reports `state: "answer"` with at least
 *    `minChars` characters, so a page that already has the answer pays one probe;
 *  - a block that is present but not an answer keeps the wait alive until the
 *    deadline (it may still turn into prose);
 *  - a page with no AI block at all stops after `noneGraceMs` (default 1.4 s)
 *    instead of burning the whole deadline. Without that grace a slow Overview
 *    would never be waited for; without the grace *limit* every ordinary
 *    summary-less search would pay six seconds (V8.4 caps the added latency at
 *    1.5 s).
 *
 * Nothing here sleeps for a fixed amount, nothing retries a navigation, and the
 * clock/rng/deadline seams are the same ones `waitForMarker` uses
 * (`cdp/humanize.ts`), so tests advance virtual time.
 */

import type { CdpPage } from "./types.ts";
import type { AiProbe, AiState, EngineAi, EngineId } from "../engines/types.ts";
import { AI_ANSWER_MIN_CHARS } from "../engines/types.ts";
import type { Clock } from "../runtime/types.ts";
import { systemClock } from "../runtime/clock.ts";
import { asFailure, jitteredPollMs, normalizeDeadline, normalizePoll, throwIfAborted } from "./humanize.ts";

/** Long enough for a streaming Overview, short enough to stay under V8.4. */
export const DEFAULT_AI_WAIT_MS = 6_000;
/**
 * How long a page with *no* AI block is watched before giving up. Kept below the
 * V8.4 ceiling (1.5 s) on purpose: probe round-trips and the jittered poll land
 * on top of the grace, and a budget that can only be met by measuring the clock
 * is not a budget.
 */
export const DEFAULT_NONE_GRACE_MS = 1_400;
const DEFAULT_POLL_MS = 150;

/** Readiness answer of the wait. `timedOut` means "the deadline/grace ran out first". */
export interface AiWaitResult {
  /** Best state observed; never downgraded by a later empty poll. */
  state: AiState;
  /** Characters of answer prose in the best observation. */
  chars: number;
  /** Clock time spent in the wait (0 when the first probe was already an answer). */
  waitMs: number;
  /** True when the wait ended without an answer. */
  timedOut: boolean;
  /** Number of probes executed (evidence for the P8 latency table). */
  polls: number;
}

export interface WaitForAiOptions {
  /** Answer width required to stop early; default `AI_ANSWER_MIN_CHARS` (200). */
  minChars?: number;
  /** Overall budget; default 6000 ms, `0` means "probe once and do not wait". */
  deadlineMs?: number;
  /** How long `none` is tolerated before the wait gives up; default 1500 ms. */
  noneGraceMs?: number;
  pollMs?: number;
  rng?: () => number;
  clock?: Clock;
  signal?: AbortSignal;
  engine?: EngineId;
}

/**
 * A probe result crosses a boundary we do not own (it is produced by an
 * adapter). Anything malformed is treated as "nothing seen yet" rather than as
 * an answer: guessing an answer is the failure mode this phase forbids.
 */
function normalizeProbe(value: unknown): AiProbe {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { state: "none", chars: 0 };
  }
  const record = value as { state?: unknown; chars?: unknown };
  const chars =
    typeof record.chars === "number" && Number.isFinite(record.chars) && record.chars > 0
      ? Math.floor(record.chars)
      : 0;
  const state = record.state === "answer" || record.state === "lead" ? record.state : "none";
  // An "answer" with no measured prose is a contradiction; keep the state but
  // report zero chars, and the length gate below will refuse to stop on it.
  return { state, chars };
}

/**
 * Poll the adapter's AI probe until it reports a full answer or the budget runs
 * out. A probe failure is *not* swallowed: a torn socket during the wait is the
 * same failure it would be one millisecond later in `extract`, and pretending
 * the page is simply summary-less would hide a disconnect behind `ai:no`.
 */
export async function waitForAi(
  page: CdpPage,
  ai: EngineAi,
  options: WaitForAiOptions = {},
): Promise<AiWaitResult> {
  const clock = options.clock ?? systemClock;
  const rng = options.rng ?? Math.random;
  const deadlineMs = normalizeDeadline(options.deadlineMs ?? DEFAULT_AI_WAIT_MS);
  const noneGraceMs = Math.max(
    0,
    Math.min(deadlineMs, Math.floor(options.noneGraceMs ?? DEFAULT_NONE_GRACE_MS)),
  );
  const pollMs = normalizePoll(options.pollMs ?? DEFAULT_POLL_MS);
  const minChars = Math.max(
    1,
    Math.floor(options.minChars ?? AI_ANSWER_MIN_CHARS),
  );
  const start = clock.now();

  let best: AiProbe = { state: "none", chars: 0 };
  let polls = 0;
  const rank = (state: AiState): number => (state === "answer" ? 2 : state === "lead" ? 1 : 0);

  try {
    for (;;) {
      throwIfAborted(options.signal, "settle", options.engine);
      const observed = normalizeProbe(await ai.probe(page));
      polls += 1;
      // A later empty poll must not erase a block that was already seen: the AI
      // block can be re-rendered mid-stream. Keep the strongest observation.
      if (rank(observed.state) >= rank(best.state)) best = observed;

      const elapsed = Math.max(0, clock.now() - start);
      if (observed.state === "answer" && observed.chars >= minChars) {
        return { state: "answer", chars: observed.chars, waitMs: elapsed, timedOut: false, polls };
      }
      if (elapsed >= deadlineMs) {
        return { state: best.state, chars: best.chars, waitMs: elapsed, timedOut: true, polls };
      }
      if (best.state === "none" && elapsed >= noneGraceMs) {
        return { state: "none", chars: 0, waitMs: elapsed, timedOut: true, polls };
      }
      // While nothing has been seen, never sleep past the grace: that budget is a
      // hard ceiling on the latency a summary-less page may cost (V8.4), and an
      // unclamped jittered poll would overshoot it by up to 25%.
      const remainingGrace = best.state === "none" ? noneGraceMs - elapsed : Number.POSITIVE_INFINITY;
      const delay = Math.min(jitteredPollMs(pollMs, rng), remainingGrace);
      await clock.sleep(delay, options.signal);
    }
  } catch (error) {
    throw asFailure(error, "settle", options.engine);
  }
}
