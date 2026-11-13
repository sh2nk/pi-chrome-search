/**
 * Document access over a `CdpClient` (SPEC S5.1, S5.4; PLAN P3).
 *
 * This is the only module that turns a target id into a page: navigation commit
 * semantics (`frameNavigated` with a fresh loaderId), readiness, `Runtime.evaluate`
 * and the human input events adapters see. The raw socket, reconnect and target
 * attach live in `client.ts`; the owned-tab lifecycle lives in `src/session/`.
 *
 * Two behaviours are load-bearing and were hard-won on v1:
 *
 *  - **A commit, not a load event.** A real SERP never fires a correlated load
 *    event. `Page.navigate` resolving means "committed"; the page waits for a
 *    new loaderId on `Page.frameNavigated`, then for `readyState interactive`.
 *  - **The document is the URL authority.** `url()` is a target-event cache and
 *    can be stale after a typed search or a JS redirect; `currentUrl()` asks
 *    `location.href` and is what the read proof compares before and after.
 */


import { setTimeout as sleepFor } from "node:timers/promises";

import type { Stage } from "../runtime/error-codes.ts";
import type { WebSearchError } from "../runtime/error-codes.ts";
import { fail } from "../runtime/errors.ts";
import type { Clock } from "../runtime/types.ts";
import { asString, asWebSearchError, finiteNumber, isAborted, isRecord, mainFrameOf, nonNegativeDelay, positiveTimeout, realClock, sameNavigatedUrl } from "./shared.ts";
import type { CdpClient, CdpPage, CookieInfo, EvaluateOptions, NavigateOptions, TypeOptions } from "./types.ts";

export const DEFAULT_NAVIGATE_TIMEOUT_MS = 20_000;
export const DEFAULT_TYPE_MIN_MS = 30;
export const DEFAULT_TYPE_MAX_MS = 80;

/**
 * `readyState` polling cadence and the budget for accepting `interactive`.
 * A SERP keeps loading ads/trackers long after it is usable; waiting for
 * `complete` would time out on Google, so `interactive` plus a short grace is
 * the readiness bar. The adapter's marker settle waits for real content.
 */
const READY_STATE_POLL_MS = 120;
const READY_STATE_INTERACTIVE_GRACE_MS = 200;
/**
 * Some navigations return from `Page.navigate` without any commit event and
 * with the target URL already updated (Chrome sometimes skips the event for a
 * fast same-URL reload). One look after this grace avoids a false timeout.
 */
const NAVIGATE_URL_FALLBACK_MS = 250;
const READY_STATE_EXPRESSION = "document.readyState";

/** `typeText` accepts an abort signal in addition to the frozen `TypeOptions`. */
export interface TypeTextOptions extends TypeOptions {
  signal?: AbortSignal;
}

type RemoteObject = {
  value?: unknown;
  subtype?: string;
  unserializableValue?: string;
};

type EvaluateResponse = {
  result?: RemoteObject;
  exceptionDetails?: Record<string, unknown>;
};

type NavigateResponse = {
  frameId?: unknown;
  loaderId?: unknown;
};

function exceptionMessage(details: Record<string, unknown>): string {
  const exception = isRecord(details.exception) ? details.exception : undefined;
  const description = exception === undefined ? undefined : asString(exception.description);
  const text = asString(details.text);
  const raw = description ?? text ?? "evaluation threw";
  // Chrome's `description` includes a stack trace after the first line; the
  // agent needs the error, not local file paths.
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.trim() || "evaluation threw";
}

function clickExpression(selector: string): string {
  return (
    "(() => {" +
    ` const el = document.querySelector(${JSON.stringify(selector)});` +
    " if (!el) return null;" +
    ' el.scrollIntoView({ block: "center", inline: "center" });' +
    " const rect = el.getBoundingClientRect();" +
    " return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };" +
    " })()"
  );
}

function charKeyCode(text: string): number {
  const upper = text.toUpperCase();
  if (upper.length === 1) {
    const code = upper.charCodeAt(0);
    if (code >= 32 && code <= 126) return code;
  }
  return 0;
}

const KEY_INFO: Record<string, { code: string; vk: number }> = {
  Enter: { code: "Enter", vk: 13 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Space: { code: "Space", vk: 32 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageDown: { code: "PageDown", vk: 34 },
  PageUp: { code: "PageUp", vk: 33 },
};

export interface CdpPageOptions {
  clock?: Clock;
  /** Last known URL when the page is created for an existing target. */
  initialUrl?: string;
}

/**
 * `CdpPage` plus the abort-aware typing signature. The frozen `CdpPage`
 * contract stays the surface adapters see; callers that drive typing directly
 * get the optional signal without a cast.
 */
export type CdpPageHandle = CdpPage & {
  typeText(text: string, o?: TypeTextOptions): Promise<void>;
};

/**
 * A `CdpPage` bound to one target. The closure resolves its flattened session id
 * on every call, so a reconnect (which allocates a new session id) is invisible
 * to adapters.
 */
export function createCdpPage(
  client: CdpClient,
  targetId: string,
  opts: CdpPageOptions = {},
): CdpPageHandle {
  const clock = opts.clock ?? client.clock ?? realClock;
  // Seed from the target so a page created right after `createTarget`/`attach`
  // reports the URL Chrome knows instead of an empty string.
  let lastUrl = opts.initialUrl ?? client.targetUrlFor(targetId) ?? "";
  let enabledSessionId: string | undefined;
  let knownSessionId: string | undefined;
  let lost: WebSearchError | undefined;
  let activeNavigation: { reject: (error: WebSearchError) => void } | undefined;

  const markLost = (message: string): void => {
    const error = fail("E_TARGET_LOST", "navigate", { message });
    lost = error;
    activeNavigation?.reject(error);
  };

  // Chrome reports a dead target either as a rejected command (-32000/-32001)
  // or as one of these events. Without the event listeners a navigation that is
  // waiting for a commit would sit until its deadline instead of failing as
  // E_TARGET_LOST.
  client.on("Target.detachedFromTarget", (params, sessionId) => {
    const payload = isRecord(params) ? params : {};
    const detachedTarget = asString(payload.targetId);
    const detachedSession = asString(payload.sessionId) ?? sessionId;
    if (detachedTarget === targetId || (detachedSession !== undefined && detachedSession === knownSessionId)) {
      markLost(`target ${targetId} was detached`);
    }
  });
  client.on("Inspector.detached", (_params, sessionId) => {
    if (sessionId !== undefined && sessionId === knownSessionId) {
      markLost(`target ${targetId} was detached`);
    }
  });

  const sessionIdOrThrow = (stage: Stage): string => {
    if (lost !== undefined) throw lost;
    const sessionId = client.sessionIdFor(targetId);
    if (sessionId === undefined) {
      throw fail("E_TARGET_LOST", stage, {
        message: `target ${targetId} is not attached`,
        hint: "the owned tab was closed; retry so a fresh tab is opened",
      });
    }
    knownSessionId = sessionId;
    return sessionId;
  };

  /**
   * `Page.enable` makes Chrome emit `Page.*` lifecycle events. It must happen
   * before navigation and exactly once per (re)attached session: after a
   * reconnect Chrome has forgotten the enable, and without it no
   * `frameNavigated`/`navigatedWithinDocument` commit ever arrives (the exact
   * reason the session times out instead of reporting a false success).
   */
  const ensureEnabled = async (stage: Stage): Promise<string> => {
    const sessionId = sessionIdOrThrow(stage);
    if (enabledSessionId !== sessionId) {
      await client.send("Page.enable", {}, sessionId);
      enabledSessionId = sessionId;
    }
    return sessionId;
  };

  const evaluateRaw = async <T>(expression: string, o: EvaluateOptions = {}): Promise<T> => {
    const sessionId = sessionIdOrThrow("extract");
    const response = await client.send<EvaluateResponse>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: o.awaitPromise === true,
      },
      sessionId,
    );
    if (response.exceptionDetails !== undefined) {
      throw fail("E_PARSE", "extract", {
        message: exceptionMessage(response.exceptionDetails),
        hint: "the page expression threw; inspect the artifact and the selector/canary",
      });
    }
    const result = response.result;
    if (result === undefined) return undefined as T;
    if (result.unserializableValue !== undefined) return result.unserializableValue as T;
    return result.value as T;
  };

  const page: CdpPageHandle = {
    url: () => lastUrl,

    /**
     * Post-navigate proof (P9-B): `url()` is a cache fed by commit events, which
     * a typed search (press Enter inside the page) never produces. Asking the
     * document is the only way to know where the tab really is.
     */
    async currentUrl(): Promise<string> {
      try {
        const href = await evaluateRaw<unknown>("location.href");
        if (typeof href === "string" && href.trim() !== "") {
          lastUrl = href;
          return href;
        }
      } catch {
        // A detached or navigated-away document has no answer; the last known
        // target URL is still the honest best guess for the caller's proof.
      }
      return lastUrl;
    },

    async title(): Promise<string> {
      const value = await evaluateRaw<unknown>("document.title");
      return typeof value === "string" ? value : "";
    },

    async navigate(url: string, o: NavigateOptions = {}): Promise<void> {
      if (lost !== undefined) throw lost;
      const cancelled = (): WebSearchError =>
        fail("E_CANCELLED", "navigate", { message: `navigation to ${url} was aborted` });
      if (isAborted(o.signal)) throw cancelled();
      const sessionId = await ensureEnabled("navigate");
      // `ensureEnabled` awaits; the signal may have been aborted meanwhile and
      // an already-aborted signal never fires the listener below.
      if (lost !== undefined) throw lost;
      if (isAborted(o.signal)) throw cancelled();

      const timeoutMs = positiveTimeout(o.timeoutMs, DEFAULT_NAVIGATE_TIMEOUT_MS);
      // One deadline for the whole operation: a redirect chain that never
      // commits must not buy extra time by restarting a timer per event.
      const deadline = Date.now() + timeoutMs;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let committed = false;
        let responseReceived = false;
        /** Main-frame loaderId before the navigation: the stale-event discriminator. */
        let preLoaderId: string | undefined;
        /** Main-frame id, refined by `Page.navigate`'s response frameId. */
        let frameFilter: string | undefined;
        let interactiveSince: number | undefined;
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanups: Array<() => void> = [];
        /** Signals that arrived before the navigate response (ordering barrier). */
        const deferred: Array<() => void> = [];

        const cleanup = (): void => {
          for (const off of cleanups.splice(0)) off();
          clearTimeout(deadlineTimer);
          if (fallbackTimer !== undefined) {
            clearTimeout(fallbackTimer);
            fallbackTimer = undefined;
          }
          o.signal?.removeEventListener("abort", onAbort);
          if (activeNavigation?.reject === abort) activeNavigation = undefined;
        };
        const succeed = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const abort = (error: WebSearchError): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const timeoutError = (): WebSearchError =>
          fail("E_TIMEOUT", "navigate", {
            message: `navigate to ${url} did not finish loading within ${timeoutMs}ms`,
            hint:
              "the page never committed a new document or never reached readyState interactive; " +
              "retry, or raise navigateTimeoutMs in config",
          });

        const deadlineTimer = setTimeout(() => abort(timeoutError()), timeoutMs);
        deadlineTimer.unref();

        const onAbort = (): void => abort(cancelled());
        o.signal?.addEventListener("abort", onAbort, { once: true });

        const forThisSession = (eventSessionId: string | undefined): boolean =>
          eventSessionId !== undefined && eventSessionId === knownSessionId && lost === undefined;

        const readReadyState = async (): Promise<unknown> => {
          const response = await client.send<EvaluateResponse>(
            "Runtime.evaluate",
            { expression: READY_STATE_EXPRESSION, returnByValue: true },
            sessionId,
          );
          const result = response.result;
          if (result === undefined || !isRecord(result)) return undefined;
          return result.value;
        };

        /**
         * Readiness phase: `Page.navigate` resolving means *committed*, not
         * *loaded*. A SERP that waits for `load` (consent hops, long-tail ads)
         * would burn the deadline on a page that is already readable, so the
         * bar is `interactive` (with a short grace for `complete`).
         */
        const pollReadyState = async (): Promise<void> => {
          while (!settled) {
            const now = Date.now();
            if (now >= deadline) {
              abort(timeoutError());
              return;
            }
            if (
              interactiveSince !== undefined &&
              now - interactiveSince >= READY_STATE_INTERACTIVE_GRACE_MS
            ) {
              succeed();
              return;
            }

            let state: unknown;
            let probeFailed = false;
            try {
              state = await readReadyState();
            } catch (error) {
              if (settled) return;
              const failure = asWebSearchError(error, "E_CDP_DISCONNECTED", "navigate");
              // A destroyed execution context right after the commit is normal
              // ("Cannot find context with specified id"); only a dead target or
              // a dead socket is fatal. Anything else is retried until the
              // deadline, so a transient renderer error cannot fail a live page.
              if (
                failure.details.code === "E_TARGET_LOST" ||
                failure.details.code === "E_CDP_DISCONNECTED"
              ) {
                abort(failure);
                return;
              }
              probeFailed = true;
            }
            if (settled) return;

            if (!probeFailed) {
              if (state === "complete") {
                succeed();
                return;
              }
              if (state === "interactive") interactiveSince ??= Date.now();
              else interactiveSince = undefined;
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) continue; // the loop head turns this into E_TIMEOUT
            await sleepFor(Math.min(READY_STATE_POLL_MS, remaining), undefined, { ref: false });
          }
        };

        const commit = (committedUrl: string): void => {
          if (settled || committed) return;
          committed = true;
          lastUrl = committedUrl;
          if (fallbackTimer !== undefined) {
            clearTimeout(fallbackTimer);
            fallbackTimer = undefined;
          }
          void pollReadyState();
        };

        const frameMatches = (frameId: string | undefined): boolean =>
          frameFilter === undefined || frameId === undefined || frameId === frameFilter;

        /**
         * A commit is only the *new* document when it carries a loaderId
         * different from the pre-navigate one. A redirect chain emits several
         * (each hop commits); the first new one is enough. This is also what
         * makes an event replayed from the previous page inert.
         */
        const applyFrameNavigated = (params: Record<string, unknown>): void => {
          if (settled) return;
          const frame = isRecord(params.frame) ? params.frame : undefined;
          if (frame === undefined) return;
          if (!frameMatches(asString(frame.id))) return;
          const loaderId = asString(frame.loaderId);
          if (preLoaderId !== undefined && (loaderId === undefined || loaderId === preLoaderId)) return;
          const frameUrl = asString(frame.url);
          if (frameUrl !== undefined) lastUrl = frameUrl;
          commit(lastUrl === "" ? url : lastUrl);
        };

        const applyNavigatedWithinDocument = (params: Record<string, unknown>): void => {
          if (settled) return;
          if (!frameMatches(asString(params.frameId))) return;
          // Same-document navigation: the loaderId intentionally does not
          // change, so the loader gate above must not be applied here.
          const frameUrl = asString(params.url);
          lastUrl = frameUrl ?? url;
          commit(lastUrl);
        };

        const runOrDefer = (action: () => void): void => {
          if (!responseReceived) {
            deferred.push(action);
            return;
          }
          action();
        };

        // Both listeners are installed *before* `Page.navigate`, so a commit
        // event cannot be missed even when it arrives in the same socket read
        // as the response.
        cleanups.push(
          client.on("Page.frameNavigated", (params, eventSessionId) => {
            if (!forThisSession(eventSessionId)) return;
            runOrDefer(() => applyFrameNavigated(params));
          }),
        );
        cleanups.push(
          client.on("Page.navigatedWithinDocument", (params, eventSessionId) => {
            if (!forThisSession(eventSessionId)) return;
            runOrDefer(() => applyNavigatedWithinDocument(params));
          }),
        );

        /**
         * Some navigations return without any commit event and the target URL
         * is already the requested one. One probe after a short grace keeps
         * that case from timing out, without trusting the URL earlier (the tab
         * still shows the previous document until the commit happens).
         */
        const checkUrlFallback = async (): Promise<void> => {
          fallbackTimer = undefined;
          if (settled || committed) return;
          let current: unknown;
          try {
            current = await evaluateRaw<unknown>("location.href");
          } catch {
            return; // best effort; commit events can still arrive before the deadline
          }
          if (settled || committed) return;
          if (typeof current === "string" && sameNavigatedUrl(current, url)) commit(current);
        };

        const begin = async (): Promise<void> => {
          const tree = await client.send<Record<string, unknown>>("Page.getFrameTree", {}, sessionId);
          if (settled) return;
          const main = mainFrameOf(tree);
          preLoaderId = main.loaderId;
          frameFilter = main.frameId;

          const response = await client.send<NavigateResponse>("Page.navigate", { url }, sessionId);
          if (settled) return;

          responseReceived = true;
          // The response frameId is authoritative when the frame tree did not
          // carry one; `??=` keeps the pre-navigate id otherwise.
          frameFilter ??= asString(response.frameId);

          while (!settled) {
            const next = deferred.shift();
            if (next === undefined) break;
            next();
          }
          if (settled || committed) return;

          fallbackTimer = setTimeout(() => {
            void checkUrlFallback();
          }, NAVIGATE_URL_FALLBACK_MS);
          fallbackTimer.unref();
        };

        activeNavigation = { reject: abort };
        void begin().catch((error: unknown) => abort(asWebSearchError(error, "E_CDP_DISCONNECTED", "navigate")));
      });
    },

    async evaluate<T>(expression: string, o: EvaluateOptions = {}): Promise<T> {
      return await evaluateRaw<T>(expression, o);
    },

    async innerText(selector?: string): Promise<string> {
      const expression =
        selector === undefined
          ? '(() => (document.body ? document.body.innerText : ""))()'
          : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : ""; })()`;
      const value = await evaluateRaw<unknown>(expression);
      return typeof value === "string" ? value : "";
    },

    async html(): Promise<string> {
      const value = await evaluateRaw<unknown>(
        '(() => (document.documentElement ? document.documentElement.outerHTML : ""))()',
      );
      return typeof value === "string" ? value : "";
    },

    async click(selectorOrPoint: string | { x: number; y: number }): Promise<void> {
      const sessionId = await ensureEnabled("resolve");
      let x: number;
      let y: number;

      if (typeof selectorOrPoint === "string") {
        const rect = await evaluateRaw<unknown>(clickExpression(selectorOrPoint));
        if (!isRecord(rect)) {
          throw fail("E_PARSE", "resolve", {
            message: `selector not found: ${selectorOrPoint}`,
            hint: "the click target is missing; check the selector canary and the artifact",
          });
        }
        const rectX = finiteNumber(rect.x);
        const rectY = finiteNumber(rect.y);
        if (rectX === undefined || rectY === undefined) {
          throw fail("E_PARSE", "resolve", {
            message: `selector has no clickable box: ${selectorOrPoint}`,
          });
        }
        x = rectX;
        y = rectY;
      } else {
        const pointX = finiteNumber(selectorOrPoint.x);
        const pointY = finiteNumber(selectorOrPoint.y);
        if (pointX === undefined || pointY === undefined) {
          throw fail("E_PARSE", "resolve", { message: "click point must have finite x and y" });
        }
        x = pointX;
        y = pointY;
      }

      // Chrome expects integer CSS pixels; a fractional coordinate is rounded
      // rather than truncated so the click lands on the visual center.
      const px = Math.round(x);
      const py = Math.round(y);
      const mouse: Record<string, unknown> = {
        x: px,
        y: py,
        button: "left",
        clickCount: 1,
      };
      await client.send("Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" }, sessionId);
      await client.send("Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" }, sessionId);
    },

    async typeText(text: string, o: TypeTextOptions = {}): Promise<void> {
      const sessionId = await ensureEnabled("resolve");
      const minMs = nonNegativeDelay(o.minMs, DEFAULT_TYPE_MIN_MS);
      const maxMs = Math.max(minMs, nonNegativeDelay(o.maxMs, DEFAULT_TYPE_MAX_MS));
      const signal = o.signal;

      // No `Input.insertText`: it is one atomic event and skips the key events
      // a real keyboard produces, which is exactly the pattern a bot detector
      // looks for. Each character is rawKeyDown/char/keyUp with a human delay.
      //
      // The key-down half must be `rawKeyDown`: Chrome inserts `text` on a
      // `keyDown` event, so pairing a text-carrying keyDown with `char` typed
      // every character twice on a real page. `rawKeyDown` carries no text and
      // is what a physical keyboard emits before the character event.
      for (const char of text) {
        if (isAborted(signal)) {
          throw fail("E_CANCELLED", "resolve", { message: "typing was aborted" });
        }
        const waitMs = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
        try {
          await clock.sleep(waitMs, signal);
        } catch (error) {
          throw asWebSearchError(error, "E_CANCELLED", "resolve");
        }
        if (isAborted(signal)) {
          throw fail("E_CANCELLED", "resolve", { message: "typing was aborted" });
        }

        const vk = charKeyCode(char);
        await client.send(
          "Input.dispatchKeyEvent",
          {
            type: "rawKeyDown",
            key: char,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
          },
          sessionId,
        );
        await client.send(
          "Input.dispatchKeyEvent",
          { type: "char", key: char, text: char, unmodifiedText: char },
          sessionId,
        );
        await client.send(
          "Input.dispatchKeyEvent",
          {
            type: "keyUp",
            key: char,
            code: "",
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
          },
          sessionId,
        );
      }
    },

    async press(key: string): Promise<void> {
      const sessionId = await ensureEnabled("resolve");
      const info = KEY_INFO[key];
      if (info === undefined && key.length !== 1) {
        throw fail("E_UNSUPPORTED", "resolve", {
          message: `unknown key: ${key}`,
          hint: "use Enter, Tab, Escape, Arrow*, Backspace, Delete, Space, Home, End, Page* or one character",
        });
      }
      const vk = info?.vk ?? charKeyCode(key);
      const params: Record<string, unknown> = {
        key,
        code: info?.code ?? "",
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      };
      // Enter needs `text: "\r"` to activate a focused control in Chrome; the
      // other mapped keys are navigation/edit keys and must not insert text.
      if (key === "Enter") {
        params.text = "\r";
        params.unmodifiedText = "\r";
      }
      await client.send("Input.dispatchKeyEvent", { ...params, type: "keyDown" }, sessionId);
      await client.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" }, sessionId);
    },

    async scroll(dy: number): Promise<void> {
      const delta = finiteNumber(dy);
      if (delta === undefined) {
        throw fail("E_PARSE", "navigate", { message: "scroll delta must be a finite number" });
      }
      await evaluateRaw<unknown>(`window.scrollBy(0, ${delta})`);
    },

    async screenshot(): Promise<Buffer> {
      const sessionId = sessionIdOrThrow("render");
      const response = await client.send<Record<string, unknown>>(
        "Page.captureScreenshot",
        { format: "jpeg", quality: 70 },
        sessionId,
      );
      const data = asString(response.data);
      if (data === undefined || data === "") {
        throw fail("E_PARSE", "render", {
          message: "Page.captureScreenshot returned no data",
          hint: "the compositor did not produce a frame; retry or run /web-doctor",
        });
      }
      return Buffer.from(data, "base64");
    },

    async cookiesFor(urls: string[]): Promise<CookieInfo[]> {
      const sessionId = sessionIdOrThrow("read");
      const requested = Array.isArray(urls) ? urls.filter((url) => typeof url === "string") : [];
      const response = await client.send<Record<string, unknown>>(
        "Network.getCookies",
        { urls: requested },
        sessionId,
      );
      const cookies = Array.isArray(response.cookies) ? response.cookies : [];
      const result: CookieInfo[] = [];
      for (const cookie of cookies) {
        if (!isRecord(cookie)) continue;
        const name = asString(cookie.name);
        const value = asString(cookie.value);
        const domain = asString(cookie.domain);
        if (name === undefined || value === undefined || domain === undefined) continue;
        result.push({ name, value, domain });
      }
      return result;
    },

    async bringToFront(): Promise<void> {
      const sessionId = sessionIdOrThrow("render");
      await client.send("Page.bringToFront", {}, sessionId);
    },
  };

  return page;
}
