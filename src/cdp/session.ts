/**
 * Raw CDP client over `ws` (SPEC §5.2–§5.5, PLAN P1-B).
 *
 * This is the only place that speaks the DevTools protocol. It attaches to the
 * user's already-running Chrome; it never launches, restarts or kills a browser
 * and never injects scripts. Adapters (P3) see `CdpPage` from `types.ts` and
 * nothing else, so the transport can be swapped or faked.
 *
 * Two behaviours are deliberate and load-bearing:
 *
 *  - **Flattened sessions.** Every command after `Target.attachToTarget` carries
 *    a `sessionId`; target-scoped events come back with the same id. A single
 *    browser socket can therefore drive several tabs without a second CDP
 *    connection (Chrome's `--remote-debugging-pipe`-style multiplexing).
 *
 *  - **One reconnect, never a loop.** A dropped socket is a normal event when
 *    the user suspends a laptop or Chrome restarts its browser process. Trying
 *    forever would turn a dead endpoint into a busy loop; trying zero times
 *    would kill every in-flight search. We retry exactly once, re-attach the
 *    live targets (Chrome allocates *new* session ids), and after a second drop
 *    fail honestly with `E_CDP_DISCONNECTED`. `close()` is intentional and
 *    never reconnects.
 */

import { setTimeout as sleepFor } from "node:timers/promises";
import { WebSocket, type RawData } from "ws";

import { WebSearchError } from "../runtime/error-codes.ts";
import type { ErrorCode, Stage } from "../runtime/error-codes.ts";
import { fail, toFailure } from "../runtime/errors.ts";
import type { Clock, Logger } from "../runtime/types.ts";
import type {
  BrowserInfo,
  CdpPage,
  CdpTarget,
  CookieInfo,
  EvaluateOptions,
  NavigateOptions,
  TypeOptions,
} from "./types.ts";

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** SERP documents settle well inside this; callers may pass their own deadline. */
export const DEFAULT_NAVIGATE_TIMEOUT_MS = 20_000;
export const DEFAULT_TYPE_MIN_MS = 30;
export const DEFAULT_TYPE_MAX_MS = 80;

export interface CdpSessionOptions {
  wsUrl: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Used for human typing delays; tests inject `FakeClock`. */
  clock?: Clock;
  log?: Logger;
}

/** `typeText` accepts an abort signal in addition to the frozen `TypeOptions`. */
export interface TypeTextOptions extends TypeOptions {
  signal?: AbortSignal;
}

interface CdpErrorPayload {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

interface PendingRequest {
  method: string;
  sessionId?: string;
  /** Stage at send time, so a socket drop blames the command, not the connect. */
  stage: Stage;
  resolve: (value: unknown) => void;
  reject: (error: WebSearchError) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;
type SessionState = "connecting" | "open" | "reconnecting" | "closed";

/** Real wall clock, used when no injectable clock is supplied. */
const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    signal === undefined ? sleepFor(ms) : sleepFor(ms, undefined, { signal }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

function parseMessage(raw: RawData): unknown {
  try {
    return JSON.parse(rawToString(raw)) as unknown;
  } catch {
    return undefined;
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

/** Typing delays allow 0, unlike connect/request deadlines. */
function nonNegativeDelay(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return fallback;
}

/** Which stage a CDP failure belongs to, for the error renderer. */
function stageForMethod(method: string): Stage {
  if (method.startsWith("Page.navigate") || method.startsWith("Page.frame")) return "navigate";
  if (method.startsWith("Runtime.")) return "extract";
  if (method.startsWith("Network.")) return "read";
  if (method === "Page.captureScreenshot") return "render";
  if (method.startsWith("Input.")) return "resolve";
  return "connect";
}

function asWebSearchError(error: unknown, fallback: ErrorCode, stage: Stage): WebSearchError {
  if (error instanceof WebSearchError) return error;
  return new WebSearchError(toFailure(error, { code: fallback, stage }));
}

/**
 * Map a CDP protocol error onto the frozen taxonomy. Chrome uses -32000 for a
 * vanished target/session (target closed, no target with given id) and -32001
 * for a session id it does not know — e.g. after a reconnect, until we
 * re-attach. -32601 is an older/newer Chrome without the command.
 */
function cdpError(method: string, sessionId: string | undefined, payload: CdpErrorPayload): WebSearchError {
  const stage = stageForMethod(method);
  const code = typeof payload.code === "number" ? payload.code : undefined;
  const message = asString(payload.message) ?? "CDP error";
  const detail = `${method}${sessionId === undefined ? "" : ` (session ${sessionId})`}: ${message}`;

  if (code === -32001 || /session with given id/i.test(message)) {
    return fail("E_CDP_DISCONNECTED", stage, {
      message: detail,
      hint:
        "the tab session is gone (the browser reconnected or the tab was detached); " +
        "retry once — if it repeats, run /web-doctor",
    });
  }
  if (code === -32000 && /(no target|target closed|target (?:is )?gone)/i.test(message)) {
    return fail("E_TARGET_LOST", stage, {
      message: detail,
      hint: "the owned tab was closed or navigated away; retry to reopen it",
    });
  }
  if (code === -32601) {
    return fail("E_UNSUPPORTED", stage, {
      message: detail,
      hint: "this Chrome build does not implement the CDP command; update Chrome or run /web-doctor",
    });
  }
  return fail("E_PARSE", stage, {
    message: detail,
    hint: "the browser rejected the CDP call; inspect the artifact and the command parameters",
  });
}

export class CdpSession {
  readonly wsUrl: string;
  readonly clock: Clock | undefined;

  #connectTimeoutMs: number;
  #requestTimeoutMs: number;
  #log: Logger | undefined;
  #socket: WebSocket | undefined;
  #state: SessionState = "closed";
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #handlers = new Map<string, Set<EventHandler>>();
  /** targetId → sessionId for every target this client attached. */
  #attached = new Map<string, string>();
  #reconnectUsed = false;
  /** TRUE from socket reopen until every live target is attached again. */
  #reattaching = false;

  private constructor(options: CdpSessionOptions) {
    this.wsUrl = options.wsUrl;
    this.clock = options.clock;
    this.#connectTimeoutMs = positiveTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.#log = options.log;

    // Chrome tears a flattened target down with `Target.detachedFromTarget`;
    // `Inspector.detached` is the legacy shape some builds still emit. Both
    // prune the mapping so the next page command fails fast instead of hanging.
    this.on("Target.detachedFromTarget", (params, sessionId) => {
      const payload = isRecord(params) ? params : {};
      const lostSession = asString(payload.sessionId) ?? sessionId;
      const lostTarget = asString(payload.targetId);
      this.#targetGone(lostSession, lostTarget);
    });
    this.on("Inspector.detached", (_params, sessionId) => {
      this.#targetGone(sessionId, undefined);
    });
  }

  static async connect(options: CdpSessionOptions): Promise<CdpSession> {
    const session = new CdpSession(options);
    try {
      await session.#openSocket();
    } catch (error) {
      session.#terminateSocket();
      session.#state = "closed";
      throw asWebSearchError(error, "E_CDP_UNAVAILABLE", "connect");
    }
    return session;
  }

  isConnected(): boolean {
    return (
      this.#state === "open" &&
      !this.#reattaching &&
      this.#socket !== undefined &&
      this.#socket.readyState === WebSocket.OPEN
    );
  }

  /** Current flattened session for a target, if this client still holds one. */
  sessionIdFor(targetId: string): string | undefined {
    return this.#attached.get(targetId);
  }

  async version(): Promise<BrowserInfo> {
    const result = await this.send<Record<string, unknown>>("Browser.getVersion");
    const info = isRecord(result) ? result : {};
    return {
      product: asString(info.product) ?? "",
      protocolVersion: asString(info.protocolVersion) ?? "",
      userAgent: asString(info.userAgent) ?? "",
      revision: asString(info.revision) ?? "",
      jsVersion: asString(info.jsVersion) ?? "",
    };
  }

  async targets(): Promise<CdpTarget[]> {
    const result = await this.send<Record<string, unknown>>("Target.getTargets");
    const infos = isRecord(result) && Array.isArray(result.targetInfos) ? result.targetInfos : [];
    const targets: CdpTarget[] = [];
    for (const info of infos) {
      if (!isRecord(info)) continue;
      const id = asString(info.targetId);
      if (id === undefined) continue;
      targets.push({
        id,
        type: asString(info.type) ?? "",
        title: asString(info.title) ?? "",
        url: asString(info.url) ?? "",
        ...(info.attached === true ? { attached: true } : {}),
      });
    }
    return targets;
  }

  async attach(targetId: string): Promise<{ targetId: string; sessionId: string }> {
    const result = await this.send<Record<string, unknown>>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = isRecord(result) ? asString(result.sessionId) : undefined;
    if (sessionId === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: `Target.attachToTarget returned no sessionId for ${targetId}`,
        hint: "the browser did not allocate a flattened session; retry or run /web-doctor",
      });
    }
    this.#attached.set(targetId, sessionId);
    return { targetId, sessionId };
  }

  async detach(sessionId: string): Promise<void> {
    await this.send("Target.detachFromTarget", { sessionId });
    this.#forgetSession(sessionId);
  }

  async createTarget(url: string, opts: { newWindow?: boolean } = {}): Promise<string> {
    const params: Record<string, unknown> = { url };
    // The browser.ts lane needs a dedicated window; Chrome's default is a tab.
    if (opts.newWindow === true) params.newWindow = true;
    const result = await this.send<Record<string, unknown>>("Target.createTarget", params);
    const targetId = isRecord(result) ? asString(result.targetId) : undefined;
    if (targetId === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: `Target.createTarget returned no targetId for ${url}`,
      });
    }
    return targetId;
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId });
    for (const [attachedTarget, sessionId] of [...this.#attached]) {
      if (attachedTarget !== targetId) continue;
      this.#attached.delete(attachedTarget);
      this.#rejectPendingForSession(
        sessionId,
        fail("E_TARGET_LOST", "navigate", { message: `target ${targetId} was closed` }),
      );
    }
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const socket = this.#socket;
    if (this.#state !== "open" || socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw this.#notConnected(method);
    }

    const id = this.#nextId++;
    const stage = stageForMethod(method);
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          fail("E_TIMEOUT", stage, {
            message: `${method} timed out after ${this.#requestTimeoutMs}ms`,
            hint: "the browser did not answer; retry, or raise requestTimeoutMs in config",
          }),
        );
      }, this.#requestTimeoutMs);
      timer.unref();

      this.#pending.set(id, {
        method,
        ...(sessionId === undefined ? {} : { sessionId }),
        stage,
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      });

      const message: Record<string, unknown> = { id, method, params };
      if (sessionId !== undefined) message.sessionId = sessionId;
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          fail("E_CDP_DISCONNECTED", stage, {
            message: `failed to send ${method}: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
      }
    });
  }

  /** Subscribe to a CDP event. The returned function removes the subscription. */
  on(method: string, handler: EventHandler): () => void {
    let handlers = this.#handlers.get(method);
    if (handlers === undefined) {
      handlers = new Set();
      this.#handlers.set(method, handlers);
    }
    handlers.add(handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.#handlers.get(method);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) this.#handlers.delete(method);
    };
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closed";

    this.#failPending((stage) =>
      fail("E_CDP_DISCONNECTED", stage, {
        message: "CDP session closed by the caller",
        hint: "the session was closed on purpose; open a new one if the search should continue",
      }),
    );
    this.#handlers.clear();

    const socket = this.#socket;
    this.#socket = undefined;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }

  // --- transport -----------------------------------------------------------

  async #openSocket(): Promise<void> {
    this.#state = "connecting";
    const socket = new WebSocket(this.wsUrl);
    this.#socket = socket;

    // Permanent listeners: message traffic and a no-op error listener (a
    // WebSocket `error` without a listener would crash the process). The close
    // handler decides between a reconnect and a final failure.
    socket.on("message", (raw) => this.#onMessage(socket, raw));
    socket.on("error", () => undefined);
    socket.on("close", () => this.#onClose(socket));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.terminate();
        reject(
          fail("E_CDP_UNAVAILABLE", "connect", {
            message: `CDP connect to ${this.wsUrl} timed out after ${this.#connectTimeoutMs}ms`,
          }),
        );
      }, this.#connectTimeoutMs);
      timer.unref();

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onCloseEarly);
      };
      const onOpen = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.terminate();
        reject(
          fail("E_CDP_UNAVAILABLE", "connect", {
            message: `CDP connect to ${this.wsUrl} failed: ${error.message}`,
          }),
        );
      };
      const onCloseEarly = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          fail("E_CDP_DISCONNECTED", "connect", {
            message: `CDP socket to ${this.wsUrl} closed before it was ready`,
          }),
        );
      };

      socket.on("open", onOpen);
      socket.on("error", onError);
      socket.on("close", onCloseEarly);
    });

    // `close()` may have won the race while the handshake was in flight; an
    // intentional close must never be undone by a late socket open.
    if (this.#closedDuringHandshake()) {
      socket.terminate();
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "CDP session was closed while connecting",
      });
    }
    this.#state = "open";
  }

  /** Read through a method so the compiler's entry-edge narrowing cannot hide it. */
  #closedDuringHandshake(): boolean {
    return this.#state === "closed";
  }

  #terminateSocket(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  #notConnected(method: string): WebSearchError {
    const stage = stageForMethod(method);
    if (this.#reconnectUsed) {
      return fail("E_CDP_DISCONNECTED", stage, {
        message: `CDP socket is down (method ${method}); the single reconnect attempt was already used`,
        hint:
          "the connection dropped twice; run /web-doctor, make sure Chrome is still running, " +
          "then retry the search",
      });
    }
    return fail("E_CDP_DISCONNECTED", stage, {
      message: `CDP socket is not open (method ${method})`,
      hint: "retry once; if it repeats, run /web-doctor and check that Chrome is still running",
    });
  }

  #onMessage(socket: WebSocket, raw: RawData): void {
    if (this.#socket !== socket) return;
    const message = parseMessage(raw);
    if (!isRecord(message)) return;

    const id = message.id;
    if (typeof id === "number") {
      this.#settle(id, message);
      return;
    }

    const method = asString(message.method);
    if (method === undefined) return;
    const params = isRecord(message.params) ? message.params : {};
    const sessionId = asString(message.sessionId);
    this.#dispatchEvent(method, params, sessionId);
  }

  #settle(id: number, message: Record<string, unknown>): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);

    const error = message.error;
    if (isRecord(error)) {
      pending.reject(cdpError(pending.method, pending.sessionId, error as CdpErrorPayload));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  #dispatchEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    const handlers = this.#handlers.get(method);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) {
      try {
        handler(params, sessionId);
      } catch {
        // A listener bug must not take down the whole CDP socket. The error is
        // swallowed deliberately: handlers are internal and their failures are
        // logged by the caller that owns them.
      }
    }
  }

  #onClose(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    if (this.#state === "closed" || this.#state === "connecting" || this.#state === "reconnecting") {
      return;
    }

    this.#state = "reconnecting";
    this.#failPending((stage) =>
      fail("E_CDP_DISCONNECTED", stage, {
        message: "CDP socket closed unexpectedly; reconnecting once",
        hint: "the connection dropped; the client re-attaches the owned tabs once",
      }),
    );
    void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    if (this.#reconnectUsed) {
      this.#shutdown();
      return;
    }
    this.#reconnectUsed = true;
    this.#reattaching = true;

    try {
      await this.#openSocket();
    } catch {
      this.#reattaching = false;
      this.#shutdown();
      return;
    }

    // Chrome forgets flattened sessions when the owning socket dies, so every
    // live target needs a fresh attach. A target that vanished meanwhile is
    // dropped; its page fails with E_TARGET_LOST on the next command.
    const targetIds = [...this.#attached.keys()];
    for (const targetId of targetIds) {
      try {
        await this.attach(targetId);
      } catch {
        this.#attached.delete(targetId);
      }
    }
    this.#reattaching = false;

    if (this.#state === "closed") return;

    const log = this.#log;
    if (log !== undefined) {
      const now = this.clock?.now() ?? Date.now();
      void log
        .write({
          ts: new Date(now).toISOString(),
          event: "cdp_reconnect",
          targets: targetIds.length,
        })
        .catch(() => undefined);
    }
  }

  /** Final state after a second drop or a failed reconnect: no more retries. */
  #shutdown(): void {
    this.#state = "closed";
    this.#reattaching = false;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    this.#failPending((stage) =>
      fail("E_CDP_DISCONNECTED", stage, {
        message: "CDP connection dropped again after one reconnect attempt",
        hint:
          "the single reconnect was already used; run /web-doctor and check that Chrome is " +
          "still running, then retry the search",
      }),
    );
    this.#handlers.clear();
  }

  /**
   * Reject everything in flight. The stage comes from each request, not from
   * the connection: a navigate killed by a dropped socket must not be logged as
   * a connect failure (the doctor groups failures by stage).
   */
  #failPending(makeError: (stage: Stage) => WebSearchError): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(makeError(request.stage));
    }
  }

  #rejectPendingForSession(sessionId: string, error: WebSearchError): void {
    for (const [id, request] of [...this.#pending]) {
      if (request.sessionId !== sessionId) continue;
      clearTimeout(request.timer);
      this.#pending.delete(id);
      request.reject(error);
    }
  }

  #forgetSession(sessionId: string): void {
    for (const [targetId, attachedSession] of [...this.#attached]) {
      if (attachedSession === sessionId) this.#attached.delete(targetId);
    }
  }

  /**
   * A target/session detached (target closed, tab crashed, or Chrome dropped
   * the session). Drop the mapping and reject in-flight commands so a caller
   * never waits for a response that cannot arrive.
   */
  #targetGone(sessionId: string | undefined, targetId: string | undefined): void {
    if (sessionId === undefined && targetId === undefined) return;

    let lostTarget = targetId;
    for (const [attachedTarget, attachedSession] of [...this.#attached]) {
      const matches = targetId !== undefined ? attachedTarget === targetId : attachedSession === sessionId;
      if (!matches) continue;
      this.#attached.delete(attachedTarget);
      lostTarget ??= attachedTarget;
      if (sessionId === undefined) continue;
      this.#rejectPendingForSession(
        sessionId,
        fail("E_TARGET_LOST", "navigate", {
          message: `target ${attachedTarget} was detached (session ${sessionId})`,
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CdpPage
// ---------------------------------------------------------------------------

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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read `aborted` through a call so control-flow narrowing cannot hide a later abort. */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

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
  session: CdpSession,
  targetId: string,
  opts: CdpPageOptions = {},
): CdpPageHandle {
  const clock = opts.clock ?? session.clock ?? realClock;
  let lastUrl = opts.initialUrl ?? "";
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
  // waiting for `loadEventFired` would sit until its deadline instead of
  // failing as E_TARGET_LOST.
  session.on("Target.detachedFromTarget", (params, sessionId) => {
    const payload = isRecord(params) ? params : {};
    const detachedTarget = asString(payload.targetId);
    const detachedSession = asString(payload.sessionId) ?? sessionId;
    if (detachedTarget === targetId || (detachedSession !== undefined && detachedSession === knownSessionId)) {
      markLost(`target ${targetId} was detached`);
    }
  });
  session.on("Inspector.detached", (_params, sessionId) => {
    if (sessionId !== undefined && sessionId === knownSessionId) {
      markLost(`target ${targetId} was detached`);
    }
  });

  const sessionIdOrThrow = (stage: Stage): string => {
    if (lost !== undefined) throw lost;
    const sessionId = session.sessionIdFor(targetId);
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
   * reconnect Chrome has forgotten the enable, and without it the load event
   * never arrives (the exact reason the session times out instead of reporting
   * a false success).
   */
  const ensureEnabled = async (stage: Stage): Promise<string> => {
    const sessionId = sessionIdOrThrow(stage);
    if (enabledSessionId !== sessionId) {
      await session.send("Page.enable", {}, sessionId);
      enabledSessionId = sessionId;
    }
    return sessionId;
  };

  const evaluateRaw = async <T>(expression: string, o: EvaluateOptions = {}): Promise<T> => {
    const sessionId = sessionIdOrThrow("extract");
    const response = await session.send<EvaluateResponse>(
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

    async title(): Promise<string> {
      const value = await evaluateRaw<unknown>("document.title");
      return typeof value === "string" ? value : "";
    },

    async navigate(url: string, o: NavigateOptions = {}): Promise<void> {
      if (lost !== undefined) throw lost;
      if (isAborted(o.signal)) {
        throw fail("E_CANCELLED", "navigate", { message: `navigation to ${url} was aborted` });
      }
      const sessionId = await ensureEnabled("navigate");
      // `ensureEnabled` awaits; the signal may have been aborted while the Page
      // domain was being enabled, and an already-aborted signal never fires
      // the listener below.
      if (isAborted(o.signal)) {
        throw fail("E_CANCELLED", "navigate", { message: `navigation to ${url} was aborted` });
      }
      const timeoutMs = positiveTimeout(o.timeoutMs, DEFAULT_NAVIGATE_TIMEOUT_MS);

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let responseReceived = false;
        let expectedFrameId: string | undefined;
        let expectedLoaderId: string | undefined;
        let committedLoaderId: string | undefined;
        const cleanups: Array<() => void> = [];
        const signals: Array<{ kind: "commit" | "load" | "stop"; frameId?: string; loaderId?: string }> = [];
        let flushScheduled = false;

        const cleanup = (): void => {
          for (const off of cleanups.splice(0)) off();
          clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
          if (activeNavigation?.reject === abort) activeNavigation = undefined;
        };
        const finish = (): void => {
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

        const timer = setTimeout(() => {
          abort(
            fail("E_TIMEOUT", "navigate", {
              message: `navigate to ${url} did not finish loading within ${timeoutMs}ms`,
              hint: "the page never fired its load event; retry, or raise navigateTimeoutMs in config",
            }),
          );
        }, timeoutMs);
        timer.unref();

        const onAbort = (): void => {
          abort(fail("E_CANCELLED", "navigate", { message: `navigation to ${url} was aborted` }));
        };
        o.signal?.addEventListener("abort", onAbort, { once: true });

        /**
         * Evaluate buffered lifecycle signals in protocol order. ws can deliver
         * the navigate response, `frameNavigated` and `loadEventFired` in one
         * socket read; promise `.then` callbacks then run only after all three
         * message handlers, so a direct "did the response arrive?" check would
         * drop a legitimate load event. Buffering and re-evaluating after the
         * response keeps the commit correlation without that race.
         */
        const processSignals = (): void => {
          if (settled) return;
          flushScheduled = false;
          if (!responseReceived) {
            // The response is the ordering barrier: keep the signals buffered
            // and re-run after `.then` sets the expected frame/loader. A stale
            // load from the previous document is then rejected by the commit
            // gate below instead of settling this navigation.
            return;
          }
          while (signals.length > 0) {
            const signal = signals.shift()!;
            if (signal.kind === "commit") {
              if (
                expectedFrameId !== undefined &&
                signal.frameId !== undefined &&
                signal.frameId !== expectedFrameId
              ) {
                continue;
              }
              if (signal.loaderId !== undefined) committedLoaderId = signal.loaderId;
              continue;
            }
            if (
              signal.kind === "stop" &&
              expectedFrameId !== undefined &&
              signal.frameId !== expectedFrameId
            ) {
              continue;
            }
            // The commit gate is what rejects a stale load event from the
            // previous navigation: until the new loader commits, this page is
            // still the old document.
            if (expectedLoaderId !== undefined && committedLoaderId !== expectedLoaderId) continue;
            finish();
            return;
          }
        };

        const enqueue = (signal: (typeof signals)[number]): void => {
          signals.push(signal);
          if (flushScheduled) return;
          flushScheduled = true;
          queueMicrotask(processSignals);
        };

        const forThisSession = (eventSessionId: string | undefined): boolean =>
          eventSessionId !== undefined && eventSessionId === knownSessionId && lost === undefined;

        // All three listeners are installed *before* the navigate command, so
        // an event cannot be missed.
        cleanups.push(
          session.on("Page.frameNavigated", (params, eventSessionId) => {
            if (!forThisSession(eventSessionId)) return;
            const frame = isRecord(params.frame) ? params.frame : undefined;
            if (frame === undefined) return;
            enqueue({
              kind: "commit",
              frameId: asString(frame.id),
              loaderId: asString(frame.loaderId),
            });
          }),
        );

        cleanups.push(
          session.on("Page.loadEventFired", (_params, eventSessionId) => {
            if (!forThisSession(eventSessionId)) return;
            enqueue({ kind: "load" });
          }),
        );

        cleanups.push(
          session.on("Page.frameStoppedLoading", (params, eventSessionId) => {
            if (!forThisSession(eventSessionId)) return;
            enqueue({ kind: "stop", frameId: asString(params.frameId) });
          }),
        );

        activeNavigation = { reject: abort };

        session.send<NavigateResponse>("Page.navigate", { url }, sessionId).then(
          (response) => {
            if (settled) return;
            responseReceived = true;
            expectedFrameId = asString(response.frameId);
            expectedLoaderId = asString(response.loaderId);
            lastUrl = url;
            processSignals();
          },
          (error: unknown) => {
            abort(asWebSearchError(error, "E_CDP_DISCONNECTED", "navigate"));
          },
        );
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
      await session.send("Input.dispatchMouseEvent", { ...mouse, type: "mousePressed" }, sessionId);
      await session.send("Input.dispatchMouseEvent", { ...mouse, type: "mouseReleased" }, sessionId);
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
        await session.send(
          "Input.dispatchKeyEvent",
          {
            type: "rawKeyDown",
            key: char,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
          },
          sessionId,
        );
        await session.send(
          "Input.dispatchKeyEvent",
          { type: "char", key: char, text: char, unmodifiedText: char },
          sessionId,
        );
        await session.send(
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
      await session.send("Input.dispatchKeyEvent", { ...params, type: "keyDown" }, sessionId);
      await session.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" }, sessionId);
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
      const response = await session.send<Record<string, unknown>>(
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
      const response = await session.send<Record<string, unknown>>(
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
      await session.send("Page.bringToFront", {}, sessionId);
    },
  };

  return page;
}
