/**
 * Raw CDP client over `ws` (SPEC S8.4, S12; PLAN P3).
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

import { WebSocket, type RawData } from "ws";

import type { Stage } from "../runtime/error-codes.ts";
import { WebSearchError } from "../runtime/error-codes.ts";
import { fail } from "../runtime/errors.ts";
import type { Clock, Logger } from "../runtime/types.ts";
import { asString, asWebSearchError, isRecord, positiveTimeout } from "./shared.ts";
import type { BrowserInfo, CdpClient as CdpClientContract, CdpTarget } from "./types.ts";

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface CdpClientOptions {
  wsUrl: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Used for human typing delays; tests inject `FakeClock`. */
  clock?: Clock;
  log?: Logger;
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

/** Which stage a CDP failure belongs to, for the error renderer. */
function stageForMethod(method: string): Stage {
  if (method.startsWith("Page.navigate") || method.startsWith("Page.frame")) return "navigate";
  if (method.startsWith("Runtime.")) return "extract";
  if (method.startsWith("Network.")) return "read";
  // P12: a paused request/body belongs to the read pipeline, not to "connect".
  if (method.startsWith("Fetch.")) return "read";
  if (method === "Page.captureScreenshot") return "render";
  if (method.startsWith("Input.")) return "resolve";
  return "connect";
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

export class CdpClient implements CdpClientContract {
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
  /** targetId → last known URL, so `CdpPage.url()` is not empty right after create/attach. */
  #targetUrls = new Map<string, string>();
  #reconnectUsed = false;
  /** TRUE from socket reopen until every live target is attached again. */
  #reattaching = false;

  private constructor(options: CdpClientOptions) {
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

  static async connect(options: CdpClientOptions): Promise<CdpClient> {
    const client = new CdpClient(options);
    try {
      await client.#openSocket();
    } catch (error) {
      client.#terminateSocket();
      client.#state = "closed";
      throw asWebSearchError(error, "E_CDP_UNAVAILABLE", "connect");
    }
    return client;
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

  /**
   * Last URL this client saw for a target. `createCdpPage` seeds `url()` from it,
   * because Chrome does not return the URL from `attachToTarget` and a page
   * created for a freshly opened tab would otherwise report `""` until its
   * first navigation commits.
   */
  targetUrlFor(targetId: string): string | undefined {
    return this.#targetUrls.get(targetId);
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
      const url = asString(info.url) ?? "";
      this.#targetUrls.set(id, url);
      targets.push({
        id,
        type: asString(info.type) ?? "",
        title: asString(info.title) ?? "",
        url,
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
    await this.#rememberTargetUrl(targetId);
    return { targetId, sessionId };
  }

  /**
   * Best effort: `attachToTarget` returns only a session id, so the URL has to
   * come from `Target.getTargetInfo`. A failure here must not fail the attach
   * (the page still works; `url()` is simply empty until the first navigate).
   */
  async #rememberTargetUrl(targetId: string): Promise<void> {
    try {
      const result = await this.send<Record<string, unknown>>("Target.getTargetInfo", { targetId });
      const info = isRecord(result) && isRecord(result.targetInfo) ? result.targetInfo : undefined;
      const url = info === undefined ? undefined : asString(info.url);
      if (url !== undefined) this.#targetUrls.set(targetId, url);
    } catch {
      // Swallowed on purpose; see the comment above.
    }
  }

  async detach(sessionId: string): Promise<void> {
    await this.send("Target.detachFromTarget", { sessionId });
    this.#forgetSession(sessionId);
  }

  async createTarget(url: string, opts: { newWindow?: boolean; background?: boolean } = {}): Promise<string> {
    const params: Record<string, unknown> = { url };
    // `newWindow: true` is the anchor/tab-pool lane; Chrome's default is a tab.
    if (opts.newWindow === true) params.newWindow = true;
    // P12-A: a capture target must not steal the user's foreground tab. Newer
    // Chrome honours `background`; older builds ignore the unknown param.
    if (opts.background === true) params.background = true;
    const result = await this.send<Record<string, unknown>>("Target.createTarget", params);
    const targetId = isRecord(result) ? asString(result.targetId) : undefined;
    if (targetId === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: `Target.createTarget returned no targetId for ${url}`,
      });
    }
    // The tab may still be on `about:blank` while the request loads, but the
    // requested URL is the only thing Chrome tells us synchronously; it makes
    // `page.url()` useful immediately after `createCdpPage`.
    this.#targetUrls.set(targetId, url);
    return targetId;
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId });
    this.#targetUrls.delete(targetId);
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

