/**
 * Google `/goto` wrapper resolution (SPEC §6.1, PLAN P3-Goto).
 *
 * A `/goto?url=<protobuf>` wrapper hides the destination behind a signed
 * protobuf we refuse to decode. The only honest way to learn the target is to
 * ask Google the way the browser would: a GET carrying the browser's own cookies
 * with `redirect: "manual"`, then read `Location`.
 *
 * Three outcomes are possible and all of them are normal:
 *
 * - `302`/`301`/`303`/`307`/`308` + a non-Google `Location` → the real URL.
 * - `200` with no redirect (observed live for roughly one in four links) → one
 *   navigation fallback through the caller's page, then give up and keep the
 *   wrapper URL. There is no second attempt: a wrapper that answers 200 twice
 *   will not start redirecting because we asked again.
 * - Everything else (403/429 wall, 5xx, network failure, Google-valued
 *   `Location`) → unresolved with a reason the caller can render. Failures are
 *   never cached; only a real target is.
 *
 * Redirect chains: a `Location` pointing at another wrapper is returned as a
 * Google host → `unexpected-redirect`; this resolver never follows it. A caller
 * that needs to chase one calls `resolve()` again, which keeps the loop visible
 * at the call site instead of hidden inside a `while`.
 *
 * Cookies are the user's session: they are attached to the outgoing request and
 * appear in no returned field and no log row.
 */

import { DEFAULT_CONFIG } from "../config.ts";
import { gotoKey } from "../runtime/cache.ts";
import { fail } from "../runtime/errors.ts";
import type { Cache, Clock } from "../runtime/types.ts";
import { isGoogleHost } from "./urls.ts";

/** The only part of a Chrome cookie this resolver needs; `domain` is not ours to re-filter. */
export interface GotoCookie {
  name: string;
  value: string;
}

export type GotoMethod = "cache" | "http" | "navigate" | "unresolved";

export interface GotoResolution {
  /** The resolved destination, or null when the wrapper stayed opaque. */
  url: string | null;
  /** The wrapper exactly as passed in (trimmed); never rewritten. */
  wrapperUrl: string;
  method: GotoMethod;
  /** HTTP status of the wrapper response, when one was read. */
  status?: number;
  /**
   * Why the result is what it is: `unexpected-redirect`, `bad-location`,
   * `no-redirect`, `opaque-redirect`, `wall`, `http-<status>`, `fetch-failed`
   * for failures; `no-cookies` when the cookie read failed or returned junk, and
   * `cookie-timeout` when it outlived its deadline. Both cookie reasons are
   * non-fatal — the resolution itself may still have succeeded.
   */
  reason?: string;
}

/**
 * One row per `resolve()` call. Deliberately narrow: the wrapper's query string
 * carries a signed protobuf, so only its host is logged, and cookies have no
 * field at all.
 */
export interface GotoLogRow {
  wrapperHost: string;
  method: GotoMethod;
  status?: number;
  reason?: string;
}

export interface GotoResolverOptions {
  cache: Cache;
  /**
   * Accepted (not read) so the resolver is built from the same runtime bundle as
   * the cache: TTL is enforced by `Cache`, and any future retry/backoff must use
   * the caller's clock rather than `Date.now()`.
   */
  clock: Clock;
  /** Browser cookies for the wrapper's origin; a throw or a deadline miss degrades to a cookie-less GET. */
  cookieSource?: (urls: string[]) => Promise<readonly GotoCookie[]>;
  fetchImpl?: typeof fetch;
  /**
   * Single navigation fallback for a `200`-without-`Location` wrapper. It must
   * return the URL the page ended up on (or null); the resolver validates it and
   * calls it at most once per resolution.
   */
  navigateFallback?: (wrapperUrl: string) => Promise<string | null>;
  /** Deadline for the cookie read and, separately, for the HTTP GET. The fallback owns its own deadline. */
  timeoutMs?: number;
  /**
   * Cache lifetime for successful resolutions. The only source of truth is this
   * option; its default is `DEFAULT_CONFIG.cache.gotoTtlMs` (24 h), so a config
   * change reaches the resolver instead of drifting from a local duplicate.
   */
  ttlMs?: number;
  log?: (row: GotoLogRow) => void;
}

export interface GotoResolver {
  resolve(wrapperUrl: string, signal?: AbortSignal): Promise<GotoResolution>;
}

/**
 * `/goto` is a cheap, same-origin redirect; anything slower means the request is
 * being challenged rather than answered. Local constant (not session's connect
 * timeout) because this module owns these deadlines: the cookie read and the GET
 * each get a full window, so a stalled CDP call cannot spend the request's time.
 */
export const DEFAULT_GOTO_TIMEOUT_MS = 5_000;

/** The scheme+host of the wrapper: a `google.de` wrapper must ask for `.google.de` cookies. */
function cookieOrigin(wrapperUrl: string): string {
  // The wrapper already passed `isGotoWrapper`, which parsed it; `origin` keeps
  // the wrapper's own scheme/port so the cookie read matches the request.
  return `${new URL(wrapperUrl).origin}/`;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * RFC 6265 cookie-octet, used as an allow-list for names and values so a
 * hostile/odd cookie cannot inject a second header (CR/LF) or a second cookie
 * (`;`). A dropped cookie only costs fidelity, never safety.
 */
const COOKIE_NAME_OK = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_OK = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

interface CachedGoto {
  url: string;
  status?: number;
}

/**
 * `Cache` stores `unknown`, and a key could in principle be written by another
 * caller; validate the shape instead of trusting the generic argument, which is
 * erased at runtime.
 */
function isCachedGoto(value: unknown): value is CachedGoto {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { url?: unknown; status?: unknown };
  if (typeof candidate.url !== "string") return false;
  return candidate.status === undefined || typeof candidate.status === "number";
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/**
 * True only for an absolute Google URL whose path ends in `/goto`. A relative
 * `/goto?url=…` is not a wrapper here: there is no host to send the request to,
 * and `parseLink` already returns an absolute `wrapperUrl`.
 */
export function isGotoWrapper(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (!isHttpProtocol(parsed.protocol)) return false;
  if (!isGoogleHost(parsed.hostname)) return false;
  return parsed.pathname.toLowerCase().endsWith("/goto");
}

/**
 * Validate a `Location`/fallback value without rewriting it. Only absolute
 * http(s) is accepted: a relative location points back into the engine (or is a
 * malformed header), and returning it would hand the caller a "result" whose
 * host is Google. The string is returned byte-for-byte; normalisation is the
 * caller's job (`normalizeUrl`).
 */
function absoluteHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return isHttpProtocol(parsed.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * A destination we are willing to surface or cache: absolute http(s), and not a
 * Google host (a Google-valued target means another wrapper, consent or /sorry).
 *
 * Cache reads use this too. `isCachedGoto` only checks the shape, and `Cache` is
 * a shared store, so a foreign writer under a `goto:v1:` key must not be able to
 * make the resolver return `javascript:` or a Google URL as a resolved result.
 */
function safeTarget(raw: unknown): string | null {
  const target = absoluteHttpUrl(typeof raw === "string" ? raw : null);
  if (target === null) return null;
  return isGoogleOwnedHost(hostOf(target)) ? null : target;
}

/**
 * Deliberately broader than `isGoogleHost` (urls.ts): `consent.google.com` and
 * `accounts.google.de` are Google, but they are not wrapper hosts.
 *
 * The two checks have different jobs. The wrapper check decides where the
 * browser's cookies are sent, so only the strict shapes may pass it; this one
 * only decides whether a `Location`/fallback is Google's own and must not be
 * followed or surfaced as a result. Refusing an extra Google subdomain costs
 * nothing, while following one would turn the resolver into a redirect walk.
 */
const GOOGLE_OWNED_SUBDOMAIN = /^[a-z0-9-]+\.google\.(?:com|[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/;

function isGoogleOwnedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isGoogleHost(host) || GOOGLE_OWNED_SUBDOMAIN.test(host);
}

/** `Cookie:` header value, or null when nothing usable survives validation. */
function cookieHeader(cookies: readonly GotoCookie[]): string | null {
  const parts: string[] = [];
  for (const cookie of cookies) {
    if (typeof cookie?.name !== "string" || typeof cookie?.value !== "string") continue;
    const name = cookie.name.trim();
    if (!COOKIE_NAME_OK.test(name)) continue;
    if (!COOKIE_VALUE_OK.test(cookie.value)) continue;
    parts.push(`${name}=${cookie.value}`);
  }
  return parts.length === 0 ? null : parts.join("; ");
}

function abortReasonOf(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function cancelled(): never {
  throw fail("E_CANCELLED", "resolve", { message: "the /goto resolution was aborted" });
}

/**
 * Race a promise against an abort signal so abort semantics do not depend on
 * `fetchImpl` honouring the signal (test doubles and older shims may not).
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // A rejection that loses the race must not surface as an unhandled rejection.
  void promise.catch(() => {});
  if (signal.aborted) return Promise.reject(abortReasonOf(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReasonOf(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface Deadline {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * Combine the caller's signal with our own timeout. `AbortSignal.timeout` would
 * do the same, but its timer cannot be cleared, and a resolver that leaves a 5 s
 * timer behind on every fast 302 shows up as a hung test process.
 */
function startDeadline(parent: AbortSignal | undefined, timeoutMs: number): Deadline {
  const timer = new AbortController();
  const handle = setTimeout(() => {
    timer.abort(new DOMException("The /goto request timed out.", "TimeoutError"));
  }, timeoutMs);
  handle.unref?.();
  const signal = parent === undefined ? timer.signal : AbortSignal.any([parent, timer.signal]);
  return { signal, cleanup: () => clearTimeout(handle) };
}

function configError(message: string, hint: string): never {
  throw fail("E_CONFIG", "config", { message, hint });
}

export function createGotoResolver(options: GotoResolverOptions): GotoResolver {
  const { cache } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? DEFAULT_CONFIG.cache.gotoTtlMs;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GOTO_TIMEOUT_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    configError(
      `goto timeoutMs must be a positive number, got ${String(options.timeoutMs)}`,
      "set the /goto resolver timeoutMs to a positive number of milliseconds",
    );
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    configError(
      `goto ttlMs must be a non-negative number, got ${String(options.ttlMs)}`,
      "set cache.gotoTtlMs to a non-negative number of milliseconds",
    );
  }

  function report(row: GotoLogRow): void {
    try {
      options.log?.(row);
    } catch {
      // A logging failure must not turn a resolution into an error.
    }
  }

  function unresolved(
    wrapperUrl: string,
    reason: string,
    status?: number,
  ): GotoResolution {
    const resolution: GotoResolution = {
      url: null,
      wrapperUrl,
      method: "unresolved",
      ...(status === undefined ? {} : { status }),
      reason,
    };
    report({
      wrapperHost: hostOf(wrapperUrl),
      method: "unresolved",
      ...(status === undefined ? {} : { status }),
      reason,
    });
    return resolution;
  }

  function resolved(
    wrapperUrl: string,
    url: string,
    method: "http" | "navigate",
    status: number | undefined,
    cookieNote: string | undefined,
  ): GotoResolution {
    // Only a real destination is cached: an unresolved wrapper may work later
    // (a solved captcha, a fresh session), so caching it would freeze a failure.
    cache.set<CachedGoto>(
      gotoKey(wrapperUrl),
      { url, ...(status === undefined ? {} : { status }) },
      ttlMs,
    );
    const resolution: GotoResolution = {
      url,
      wrapperUrl,
      method,
      ...(status === undefined ? {} : { status }),
      ...(cookieNote === undefined ? {} : { reason: cookieNote }),
    };
    report({
      wrapperHost: hostOf(wrapperUrl),
      method,
      ...(status === undefined ? {} : { status }),
      ...(cookieNote === undefined ? {} : { reason: cookieNote }),
    });
    return resolution;
  }

  return {
    async resolve(wrapperUrl: string, signal?: AbortSignal): Promise<GotoResolution> {
      if (signal?.aborted) cancelled();

      const wrapper = typeof wrapperUrl === "string" ? wrapperUrl.trim() : "";
      if (!isGotoWrapper(wrapper)) {
        // A caller bug, not a browser event: never spend a request to find out.
        throw fail("E_CONFIG", "resolve", {
          hint: "classify the href with parseLink() (src/extract/urls.ts) and pass its kind:\"goto\" wrapperUrl",
          message: `not an absolute Google /goto wrapper URL: ${wrapper.slice(0, 120) || "<empty>"}`,
        });
      }

      // Cache hits do zero network work; a hit is also where a 24 h-old wrapper
      // pays off at all. The stored target is re-validated: a cache entry is
      // plain data and may have been written by another caller.
      const cached = cache.get<unknown>(gotoKey(wrapper));
      if (isCachedGoto(cached)) {
        const cachedTarget = safeTarget(cached.url);
        if (cachedTarget !== null) {
          report({ wrapperHost: hostOf(wrapper), method: "cache" });
          return {
            url: cachedTarget,
            wrapperUrl: wrapper,
            method: "cache",
            ...(cached.status === undefined ? {} : { status: cached.status }),
          };
        }
        // A poisoned entry is a miss, not a result: resolve again and overwrite
        // it on success. Unresolved runs still leave it inert.
      }

      // Cookies raise fidelity (some wrappers answer differently signed-in) but
      // are never required: a CDP hiccup must not block a resolution. The read
      // gets its own deadline (the GET keeps the full budget) and is raced
      // against the caller's signal, so neither an abort nor a stalled CDP call
      // can park `resolve()` inside the cookie read.
      let cookies: readonly GotoCookie[] = [];
      let cookieNote: string | undefined;
      if (options.cookieSource !== undefined) {
        const cookieDeadline = startDeadline(signal, timeoutMs);
        try {
          const returned: unknown = await raceAbort(
            Promise.resolve(options.cookieSource([cookieOrigin(wrapper)])),
            cookieDeadline.signal,
          );
          // A runtime contract violation degrades like a CDP failure, not like a
          // crash inside the fetch path (which would be reported as fetch-failed).
          if (Array.isArray(returned)) {
            cookies = returned as readonly GotoCookie[];
          } else {
            cookies = [];
            cookieNote = "no-cookies";
          }
        } catch {
          // The caller's abort always wins: a cancelled resolve must not look
          // like a degraded-but-successful one.
          if (signal?.aborted) cancelled();
          cookies = [];
          // Our own timer aborted (the caller's already threw above), so the
          // reason is the deadline, not a failing CDP call.
          cookieNote = cookieDeadline.signal.aborted ? "cookie-timeout" : "no-cookies";
        } finally {
          cookieDeadline.cleanup();
        }
      }
      if (signal?.aborted) cancelled();

      const deadline = startDeadline(signal, timeoutMs);
      let status: number;
      let location: string | null;
      try {
        const header = cookieHeader(cookies);
        const init: RequestInit = {
          method: "GET",
          redirect: "manual",
          signal: deadline.signal,
        };
        if (header !== null) init.headers = { cookie: header };

        const response = await raceAbort(fetchImpl(wrapper, init), deadline.signal);
        status = response.status;
        location = response.headers.get("location");
        // The body is never needed; dropping it releases the socket.
        await response.body?.cancel().catch(() => {});
      } catch {
        if (signal?.aborted) cancelled();
        // Timeout, DNS, TLS, socket reset — one bucket, because the caller can
        // do exactly one thing about any of them: fall back to navigation.
        return unresolved(wrapper, "fetch-failed");
      } finally {
        deadline.cleanup();
      }
      if (signal?.aborted) cancelled();

      // A browser `redirect: "manual"` response is opaque (status 0, no headers
      // readable). Node's fetch does not do that, but we must not mistake it for
      // a real answer if the resolver is ever moved behind a browser fetch.
      if (status === 0) return unresolved(wrapper, "opaque-redirect", status);

      if (REDIRECT_STATUSES.has(status)) {
        const target = absoluteHttpUrl(location);
        if (target === null) return unresolved(wrapper, "bad-location", status);
        // A Google-valued Location means /sorry, consent or another wrapper.
        // Following it would turn this resolver into a redirect follower, and
        // looping on /sorry is exactly the burst that earns a captcha.
        if (isGoogleOwnedHost(hostOf(target))) {
          return unresolved(wrapper, "unexpected-redirect", status);
        }
        return resolved(wrapper, target, "http", status, cookieNote);
      }

      if (status >= 200 && status < 300) {
        // Live observation: one of four wrappers answered 200 with no Location.
        // One navigation is the only remaining honest probe, and only if the
        // caller supplied a page to drive.
        if (options.navigateFallback === undefined) {
          return unresolved(wrapper, "no-redirect", status);
        }
        let navigated: string | null = null;
        try {
          navigated = await options.navigateFallback(wrapper);
        } catch {
          if (signal?.aborted) cancelled();
          navigated = null;
        }
        if (signal?.aborted) cancelled();
        const target = absoluteHttpUrl(navigated);
        if (target === null || isGoogleOwnedHost(hostOf(target))) {
          return unresolved(wrapper, "no-redirect", status);
        }
        return resolved(wrapper, target, "navigate", status, cookieNote);
      }

      if (status === 403 || status === 429) {
        return unresolved(wrapper, "wall", status);
      }
      return unresolved(wrapper, `http-${status}`, status);
    },
  };
}
