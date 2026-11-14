/**
 * Small, dependency-free helpers shared by the raw client and the document
 * layer. They are here so `client.ts` stays a socket and `page.ts` stays a
 * document, without either exporting the other's internals.
 */

import { setTimeout as sleepFor } from "node:timers/promises";

import type { ErrorCode, Stage } from "../runtime/error-codes.ts";
import { WebSearchError } from "../runtime/error-codes.ts";
import { toFailure } from "../runtime/errors.ts";
import type { Clock } from "../runtime/types.ts";

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    signal === undefined ? sleepFor(ms) : sleepFor(ms, undefined, { signal }),
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function positiveTimeout(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

/** Typing delays allow 0, unlike connect/request deadlines. */
export function nonNegativeDelay(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return fallback;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read `aborted` through a call so control-flow narrowing cannot hide a later abort. */
export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Main frame id + current document loaderId from a `Page.getFrameTree` response. */
export function mainFrameOf(tree: unknown): { frameId?: string; loaderId?: string } {
  const root = isRecord(tree) && isRecord(tree.frameTree) ? tree.frameTree : undefined;
  const frame = root !== undefined && isRecord(root.frame) ? root.frame : undefined;
  if (frame === undefined) return {};
  return { frameId: asString(frame.id), loaderId: asString(frame.loaderId) };
}

/**
 * `location.href` comes back normalised by the renderer (`https://host` is
 * reported as `https://host/`), so the fallback comparison tolerates the one
 * trailing slash Chrome adds.
 */
export function sameNavigatedUrl(current: string, requested: string): boolean {
  if (current === requested) return true;
  const trim = (value: string): string => (value.endsWith("/") ? value.slice(0, -1) : value);
  return trim(current) === trim(requested);
}

export function asWebSearchError(error: unknown, fallback: ErrorCode, stage: Stage): WebSearchError {
  if (error instanceof WebSearchError) return error;
  return new WebSearchError(toFailure(error, { code: fallback, stage }));
}
