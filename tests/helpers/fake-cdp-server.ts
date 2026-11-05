/**
 * Raw CDP WebSocket server for P1-B (`src/cdp/session.ts`), on a real loopback
 * port so the client exercises `ws`, JSON framing, flattened sessions and close
 * handling — not a mocked transport.
 *
 * Implemented subset: Browser.getVersion, Target.{getTargets,getTargetInfo,
 * attachToTarget,createTarget,closeTarget,detachFromTarget}, Page.{enable,getFrameTree,
 * navigate,bringToFront,captureScreenshot}, Runtime.{enable,evaluate}, Network.{getCookies,
 * getAllCookies}, Input.{dispatchKeyEvent,insertText}.
 *
 * Chrome behaviours that tests depend on, modelled here on purpose:
 *  - every `Target.attachToTarget` allocates a fresh sessionId (auto-attach does
 *    the same); the older session stays usable until it is detached, so tests
 *    can prove the client does not reuse a stale id;
 *  - a sessionId belongs to the socket that attached it: a command from another
 *    client returns -32001, exactly like Chrome after a reconnect;
 *  - session events go only to the socket that owns the sessionId, while
 *    `Target.*`/`Browser.*` events broadcast — otherwise a second client (or a
 *    second tab) would observe an event that Chrome would never deliver to it;
 *  - `Page.*` lifecycle events exist only after `Page.enable` on that session.
 *    A client that forgets it gets no load event (and therefore times out);
 *  - navigation is modelled the way Chrome actually behaves, which is *not*
 *    "navigate then load": every `Page.navigate` commits a new document with a
 *    fresh main-frame loaderId (`Page.getFrameTree` exposes the current one)
 *    and emits `Page.frameNavigated`; a redirect chain emits one commit per
 *    hop, each with its own loaderId; a fragment/history navigation emits only
 *    `Page.navigatedWithinDocument` and keeps the loaderId. `document.readyState`
 *    is answered from a configurable sequence (`loading → interactive →
 *    complete` by default) advanced once per probe, so a client must poll it —
 *    a load event alone is never proof that the page is usable;
 *  - `navigateUpdatesUrl: false` models a navigation Chrome reports (with a
 *    frameId) without committing anything: no event, no URL change, no loader
 *    change. That is what a stale event must never be mistaken for;
 *  - losing a target emits the browser-level `Target.detachedFromTarget`
 *    {sessionId, targetId} with **no** sessionId envelope, as real Chrome does:
 *    the client must read the id from params. `Inspector.detached` is kept
 *    alongside it as the legacy, session-scoped shape so older harness
 *    assertions keep their meaning; production code must not depend on it;
 *  - `Input.dispatchKeyEvent` models text insertion like Chrome: a `char`
 *    event inserts its text, and so does a `keyDown` that carries `text`
 *    (`rawKeyDown` never does). `typedText()` is therefore the visible effect
 *    of a typing sequence, and a client that types in both events doubles every
 *    character in it;
 *  - `Browser.close` is refused (-32601): a test must never be able to tear
 *    down the user's browser and still look green;
 *  - `Runtime.evaluate` honours `returnByValue` (objectId vs `value`),
 *    `awaitPromise` and reports thrown/rejected handlers as `exceptionDetails`
 *    instead of a protocol error, like Chrome;
 *  - `Network.getCookies` filters by the requested URLs, `getAllCookies` does not.
 *
 * Deterministic ids: responses echo the request id and sessionId exactly. Unknown
 * methods return Chrome's -32601 instead of hanging. `sent()` is the client→server
 * log (despite the name, it is what the fake received); `eventsSent()` is the
 * server→client event log.
 */

import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { BrowserInfo, CdpTarget } from "../../src/cdp/types.ts";
import { filterCookiesForUrls } from "./cookie-match.ts";

export interface CdpErrorPayload {
  code: number;
  message: string;
  data?: string;
}

export interface FakeCdpRequest {
  id?: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface FakeCdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface FakeCdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  [key: string]: unknown;
}

export type FakeCdpEvaluateHandler = (
  expression: string,
  params: Record<string, unknown>,
  target: CdpTarget | undefined,
) => unknown | Promise<unknown>;

export interface FakeCdpOptions {
  targets?: ReadonlyArray<CdpTarget>;
  version?: Partial<BrowserInfo>;
  cookies?: ReadonlyArray<FakeCdpCookie>;
  screenshot?: Uint8Array | string;
  /** Per-expression override; receives the attached target when there is one. */
  evaluate?: FakeCdpEvaluateHandler;
  /** Static `Runtime.evaluate` value when no handler is set. */
  evaluateResult?: unknown;
  /** Default `true`: `Page.navigate` emits `Page.loadEventFired` on its session. */
  emitLoadEvent?: boolean;
  /** Default `true`: the matching `Page.frameStoppedLoading` follows the load event. */
  emitFrameStoppedLoading?: boolean;
  /** Delay before the load event; default 0 (still a macrotask, after the response). */
  loadEventDelayMs?: number;
  /**
   * Default `true`: `Page.navigate` emits `Page.frameNavigated` for the new
   * document. Set `false` to model a commit Chrome does not announce (the
   * client then has to fall back to the target URL).
   */
  emitFrameNavigated?: boolean;
  /**
   * Default `true`: `Page.navigate` commits — the target URL and the main-frame
   * loaderId change. `false` models a navigation Chrome answers without
   * committing (blocked, downloaded, aborted): no event and old URL stays.
   */
  navigateUpdatesUrl?: boolean;
  /**
   * Extra redirect hops before the final document. Each hop emits its own
   * `Page.frameNavigated` with a fresh loaderId, like a consent/redirect chain.
   */
  redirectChain?: ReadonlyArray<string>;
  /**
   * Default `false`. When `true`, `Page.navigate` is a same-document (fragment
   * or history) navigation: URL changes, loaderId does not, and only
   * `Page.navigatedWithinDocument` is emitted.
   */
  sameDocumentNavigation?: boolean;
  /**
   * `document.readyState` answers, advanced once per probe and then held at the
   * last value. Default `loading → interactive → complete`. `["loading"]` stalls
   * forever; `["interactive"]` never reaches `complete`.
   */
  readyState?: ReadonlyArray<string>;
  /**
   * Delay before answering `Target.attachToTarget`. Lets a test observe the
   * window after a reconnect opens the socket but before the owned targets are
   * attached again (`isConnected()` must be false there).
   */
  attachDelayMs?: number;
  /** Persistent error injection keyed by method. */
  errors?: Record<string, CdpErrorPayload>;
}

export interface WaitForOptions {
  /** Number of matching requests to wait for. Default 1. */
  count?: number;
  /** Default 2 000 ms. */
  timeoutMs?: number;
}

type Outcome =
  | { kind: "result"; value: unknown }
  | { kind: "error"; error: CdpErrorPayload }
  | { kind: "none" }
  | { kind: "drop" };

interface Waiter {
  method: string;
  count: number;
  resolve: (request: FakeCdpRequest) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_VERSION: BrowserInfo = {
  product: "Chrome/157.0.8103.38",
  protocolVersion: "1.3",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  revision: "@fake-cdp",
  jsVersion: "13.7",
};

const DEFAULT_TARGET: CdpTarget = {
  id: "target-1",
  type: "page",
  title: "about:blank",
  url: "about:blank",
};

/** What a real document reports while it parses, then after `DOMContentLoaded`. */
const DEFAULT_READY_STATES: ReadonlyArray<string> = ["loading", "interactive", "complete"];

function result(value: unknown): Outcome {
  return { kind: "result", value };
}

function failure(code: number, message: string): Outcome {
  return { kind: "error", error: { code, message } };
}

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
    return JSON.parse(rawToString(raw));
  } catch {
    return undefined;
  }
}

function titleForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.length > 0 ? parsed.hostname : url;
  } catch {
    return url;
  }
}

function originForUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

interface RemoteValue {
  type: string;
  value?: unknown;
  subtype?: string;
  className?: string;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

function serializeValue(value: unknown): RemoteValue {
  if (value === null) return { type: "object", subtype: "null", value: null };
  switch (typeof value) {
    case "undefined":
      return { type: "undefined" };
    case "string":
      return { type: "string", value };
    case "boolean":
      return { type: "boolean", value };
    case "number":
      return Number.isFinite(value)
        ? { type: "number", value }
        : { type: "number", unserializableValue: String(value) };
    case "bigint":
      return { type: "bigint", unserializableValue: `${value}n` };
    case "object":
      return { type: "object", value };
    case "function":
    case "symbol":
      return { type: "undefined" };
    default:
      return { type: "undefined" };
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const constructor = (value as { constructor?: { name?: unknown } }).constructor;
  const name = constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "Object";
}

/**
 * RemoteObject as `Runtime.evaluate` returns it. Chrome serialises primitives
 * even without `returnByValue`; object values need `objectId` and lose `value`
 * unless the caller asked for a by-value copy. A fake that always inlined
 * `value` would let a client that forgets `returnByValue: true` look correct.
 */
function remoteObject(value: unknown, returnByValue: boolean, objectId: string): RemoteValue {
  const serialized = serializeValue(value);
  if (returnByValue) return serialized;
  if (serialized.type !== "object" || serialized.subtype === "null") return serialized;
  const { value: _omitted, ...rest } = serialized;
  return { ...rest, description: describeValue(value), objectId };
}

function promiseObject(objectId: string): RemoteValue {
  return { type: "object", subtype: "promise", className: "Promise", objectId };
}

function errorObject(objectId: string): RemoteValue {
  return { type: "object", subtype: "error", className: "Error", objectId };
}

function exceptionDetailsFor(
  error: unknown,
  awaitPromise: boolean,
  objectId: string,
): Record<string, unknown> {
  const name = error instanceof Error && error.name.length > 0 ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return {
    exceptionId: 1,
    text: awaitPromise ? "Uncaught (in promise)" : "Uncaught",
    lineNumber: 0,
    columnNumber: 0,
    exception: {
      type: "object",
      subtype: "error",
      className: name,
      description: `${name}: ${message}`,
      objectId,
    },
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value === "function") {
    return typeof (value as { then?: unknown }).then === "function";
  }
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Default evaluator for the checks P1 needs without a real page. Real adapters
 * always supply their own handler map (or use `FakePage`).
 */
function defaultEvaluate(expression: string, target: CdpTarget | undefined): unknown {
  if (/navigator\.webdriver/.test(expression)) return false;
  if (/document\.title/.test(expression)) return target?.title ?? "";
  if (/location\.href|document\.URL/.test(expression)) return target?.url ?? "about:blank";
  return null;
}

export class FakeCdpServer {
  #options: FakeCdpOptions;
  #wss: WebSocketServer | null = null;
  #port = 0;
  #sockets = new Set<WebSocket>();
  #requests: FakeCdpRequest[] = [];
  #events: FakeCdpEvent[] = [];
  #targets = new Map<string, CdpTarget>();
  /** sessionId → targetId. Chrome allows several sessions per target. */
  #sessions = new Map<string, string>();
  /** sessionId → simulated input value; only `char`/text-carrying keyDown insert. */
  #typed = new Map<string, string>();
  /** sessionId → the WebSocket that attached it; session events never cross sockets. */
  #sessionOwner = new Map<string, WebSocket>();
  /** Every sessionId this server ever minted, so a late timer cannot broadcast a dead session's event. */
  #knownSessions = new Set<string>();
  #lostSessions = new Set<string>();
  /** Page domain is disabled until `Page.enable`; no lifecycle event fires before that. */
  #enabledSessions = new Set<string>();
  #nextTargetId = 2;
  #nextSessionId = 1;
  #nextObjectId = 1;
  #nextLoaderId = 1;
  /** targetId → loaderId of the document currently committed in the main frame. */
  #frameLoaders = new Map<string, string>();
  /** targetId → how many `document.readyState` probes this document answered. */
  #readyStateProbes = new Map<string, number>();
  #injected = new Map<string, CdpErrorPayload[]>();
  #persistentErrors = new Map<string, CdpErrorPayload>();
  #dropNext = new Set<string>();
  /** Commands swallowed without a response, to exercise the client request timeout. */
  #holdNext = new Set<string>();
  #waiters = new Set<Waiter>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #evaluateHandler: FakeCdpEvaluateHandler | undefined;
  #evaluateResult: unknown;

  constructor(options: FakeCdpOptions = {}) {
    this.#options = { ...options };
    this.#resetState(options.targets);
    this.#evaluateHandler = options.evaluate;
    this.#evaluateResult = options.evaluateResult;
    for (const [method, error] of Object.entries(options.errors ?? {})) {
      this.#persistentErrors.set(method, { ...error });
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.#wss !== null) return;
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.#wss = wss;
    wss.on("connection", (socket) => this.#onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        wss.off("listening", onListening);
        this.#wss = null;
        reject(error);
      };
      const onListening = (): void => {
        wss.off("error", onError);
        resolve();
      };
      wss.once("listening", onListening);
      wss.once("error", onError);
    });
    const address = wss.address();
    if (typeof address === "object" && address !== null) {
      this.#port = (address as AddressInfo).port;
    }
  }

  async stop(): Promise<void> {
    const wss = this.#wss;
    this.#wss = null;
    this.#port = 0;
    this.#rejectWaiters(new DOMException("fake CDP server stopped", "AbortError"));
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (wss === null) return;
    for (const socket of this.#sockets) socket.terminate();
    this.#sockets.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  port(): number {
    return this.#port;
  }

  wsUrl(path = "/devtools/browser/fake-cdp"): string {
    return `ws://127.0.0.1:${this.#port}${path}`;
  }

  clientCount(): number {
    return this.#sockets.size;
  }

  // --- records -------------------------------------------------------------

  /** Client→server CDP messages, including commands without an id (rare). */
  sent(): FakeCdpRequest[] {
    return this.#requests.map((request) => ({ ...request, params: { ...request.params } }));
  }

  methods(): string[] {
    return this.#requests.map((request) => request.method);
  }

  calls(method: string): FakeCdpRequest[] {
    return this.#requests
      .filter((request) => request.method === method)
      .map((request) => ({ ...request, params: { ...request.params } }));
  }

  lastCall(method: string): FakeCdpRequest | undefined {
    return this.calls(method).at(-1);
  }

  /** Server→client events, including injected ones. */
  eventsSent(method?: string): FakeCdpEvent[] {
    const selected = method === undefined ? this.#events : this.#events.filter((event) => event.method === method);
    return selected.map((event) => ({ ...event, params: { ...event.params } }));
  }

  keyEvents(): Array<{ type?: string; key?: string; text?: string; unmodifiedText?: string }> {
    return this.calls("Input.dispatchKeyEvent").map((request) => ({
      type: asString(request.params.type),
      key: asString(request.params.key),
      text: asString(request.params.text),
      unmodifiedText: asString(request.params.unmodifiedText),
    }));
  }

  /**
   * Text a typing sequence actually inserted into the (simulated) focused
   * input. Keyed by session because two clients/tabs have separate inputs.
   */
  typedText(sessionId?: string): string {
    return this.#typed.get(sessionId ?? "") ?? "";
  }

  targets(): CdpTarget[] {
    return [...this.#targets.values()].map((target) => ({ ...target }));
  }

  resetCalls(): void {
    this.#requests = [];
    this.#events = [];
  }

  // --- fault injection -----------------------------------------------------

  /** Inject an error for the next matching command only. */
  failNext(method: string, error: Partial<CdpErrorPayload> = {}): void {
    const queue = this.#injected.get(method) ?? [];
    queue.push({
      code: error.code ?? -32000,
      message: error.message ?? "Injected CDP failure",
      ...(error.data !== undefined ? { data: error.data } : {}),
    });
    this.#injected.set(method, queue);
  }

  /** Persist an error for every matching command; `null` clears it. */
  setError(method: string, error: CdpErrorPayload | null): void {
    if (error === null) this.#persistentErrors.delete(method);
    else this.#persistentErrors.set(method, { ...error });
  }

  /** Drop the connection instead of answering the next matching command. */
  dropOnNext(method: string): void {
    this.#dropNext.add(method);
  }

  /** Swallow the next matching command (no response) to exercise a request timeout. */
  holdNext(method: string): void {
    this.#holdNext.add(method);
  }

  /** Flip load-event emission mid-test (e.g. to prove a stale event is ignored). */
  setEmitLoadEvent(enabled: boolean): void {
    this.#options.emitLoadEvent = enabled;
  }

  /** Flip commit-event emission mid-test (the stale-replay case needs it off). */
  setEmitFrameNavigated(enabled: boolean): void {
    this.#options.emitFrameNavigated = enabled;
  }

  /** Flip whether `Page.navigate` actually commits a new document mid-test. */
  setNavigateUpdatesUrl(enabled: boolean): void {
    this.#options.navigateUpdatesUrl = enabled;
  }

  /** Replace the `document.readyState` sequence mid-test. */
  setReadyState(sequence: ReadonlyArray<string>): void {
    this.#options.readyState = sequence;
  }

  /** How many `document.readyState` probes the current document has answered. */
  readyStateProbes(targetId?: string): number {
    return this.#readyStateProbes.get(targetId ?? this.#firstTargetId() ?? "") ?? 0;
  }

  /** The loaderId `Page.getFrameTree` reports for a target's main frame. */
  frameLoaderId(targetId?: string): string | undefined {
    const id = targetId ?? this.#firstTargetId();
    return id === undefined ? undefined : this.#frameLoaders.get(id);
  }

  /** Whether `Page.enable` was received for a session (mirrors Chrome's domain state). */
  isPageEnabled(sessionId: string): boolean {
    return this.#enabledSessions.has(sessionId);
  }

  /** Live sessionId → targetId bindings, for reconnect assertions. */
  sessionBindings(): Array<{ sessionId: string; targetId: string }> {
    return [...this.#sessions].map(([sessionId, targetId]) => ({ sessionId, targetId }));
  }

  /** Terminate every connected client. The server keeps listening for reconnects. */
  dropConnections(): void {
    for (const socket of this.#sockets) socket.terminate();
    this.#sockets.clear();
  }

  /**
   * Close a tab the way Chrome does: `Target.targetDestroyed` (browser level) and
   * `Inspector.detached` reason `target_closed` for attached sessions. Later
   * commands on those sessions fail with -32000 "Target closed.".
   */
  loseTarget(targetId?: string): string | undefined {
    const id = targetId ?? this.#firstTargetId();
    if (id === undefined || !this.#targets.has(id)) return undefined;
    this.#destroyTarget(id);
    return id;
  }

  addTarget(target: Partial<CdpTarget> & { id?: string } = {}): CdpTarget {
    const id = target.id ?? `target-${this.#nextTargetId++}`;
    const url = target.url ?? "about:blank";
    const created: CdpTarget = {
      id,
      type: target.type ?? "page",
      title: target.title ?? titleForUrl(url),
      url,
      ...(target.attached !== undefined ? { attached: target.attached } : {}),
    };
    this.#targets.set(id, created);
    return { ...created };
  }

  setEvaluateResult(value: unknown): void {
    this.#evaluateResult = value;
  }

  setEvaluateHandler(handler: FakeCdpEvaluateHandler | null): void {
    this.#evaluateHandler = handler ?? undefined;
  }

  /** Emit an arbitrary event to every connected client. */
  sendEvent(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.#emit(method, params, sessionId);
  }

  // --- waiting -------------------------------------------------------------

  waitFor(method: string, options: WaitForOptions = {}): Promise<FakeCdpRequest> {
    const count = options.count ?? 1;
    const matching = this.calls(method);
    if (matching.length >= count) return Promise.resolve(matching[count - 1]!);

    return new Promise<FakeCdpRequest>((resolve, reject) => {
      const waiter: Waiter = { method, count, resolve, reject };
      const timeoutMs = options.timeoutMs ?? 2_000;
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new DOMException(`timed out waiting for ${method}`, "TimeoutError"));
      }, timeoutMs);
      waiter.timer.unref();
      this.#waiters.add(waiter);
    });
  }

  // --- socket handling -----------------------------------------------------

  #onConnection(socket: WebSocket): void {
    this.#sockets.add(socket);
    socket.on("message", (raw) => {
      void this.#handle(socket, raw);
    });
    socket.on("close", () => {
      this.#forgetSocket(socket);
    });
    socket.on("error", () => {
      this.#forgetSocket(socket);
    });
  }

  /**
   * A disconnected client loses its sessions, like Chrome: the sessionId is no
   * longer known (-32001), and the target is `attached: false` once no other
   * client holds a session on it. No `Inspector.detached` event is emitted,
   * because there is no client left to receive it.
   */
  #forgetSocket(socket: WebSocket): void {
    this.#sockets.delete(socket);
    for (const [sessionId, owner] of [...this.#sessionOwner]) {
      if (owner !== socket) continue;
      const targetId = this.#sessions.get(sessionId);
      this.#sessions.delete(sessionId);
      this.#sessionOwner.delete(sessionId);
      this.#enabledSessions.delete(sessionId);
      if (targetId !== undefined && !this.#targetHasSession(targetId)) {
        const target = this.#targets.get(targetId);
        if (target !== undefined) target.attached = false;
      }
    }
  }

  async #handle(socket: WebSocket, raw: RawData): Promise<void> {
    const parsed = parseMessage(raw);
    if (!isRecord(parsed) || typeof parsed.method !== "string") return;

    const method = parsed.method;
    const params = isRecord(parsed.params) ? parsed.params : {};
    const sessionId = asString(parsed.sessionId);
    const id = typeof parsed.id === "number" ? parsed.id : undefined;
    const request: FakeCdpRequest = {
      method,
      params,
      ...(id !== undefined ? { id } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    this.#requests.push(request);
    this.#satisfyWaiters(request);

    // Client-sent events have no id and never get a response.
    if (id === undefined) return;

    if (this.#dropNext.delete(method)) {
      socket.terminate();
      return;
    }

    // A held request is recorded but never answered: exactly what a hung
    // browser looks like to the client's per-request timeout.
    if (this.#holdNext.delete(method)) return;

    const injected = this.#takeInjectedError(method);
    if (injected !== undefined) {
      this.#respond(socket, { id, error: injected, ...(sessionId !== undefined ? { sessionId } : {}) });
      return;
    }

    if (sessionId !== undefined) {
      if (this.#lostSessions.has(sessionId)) {
        this.#respond(socket, {
          id,
          error: { code: -32000, message: "Target closed." },
          sessionId,
        });
        return;
      }
      if (!this.#sessions.has(sessionId)) {
        this.#respond(socket, {
          id,
          error: { code: -32001, message: "Session with given id not found." },
          sessionId,
        });
        return;
      }
      // Flattened sessions are scoped to the socket that attached them. Chrome
      // does not let a second client reuse an id it never received, and a test
      // client that leaks ids across sockets must see the same refusal.
      if (this.#sessionOwner.get(sessionId) !== socket) {
        this.#respond(socket, {
          id,
          error: { code: -32001, message: "Session with given id not found." },
          sessionId,
        });
        return;
      }
    }

    let outcome: Outcome;
    try {
      outcome = await this.#dispatch(request, socket);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = failure(-32000, message);
    }

    if (outcome.kind === "drop") {
      socket.terminate();
      return;
    }
    if (outcome.kind === "error") {
      this.#respond(socket, {
        id,
        error: outcome.error,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      return;
    }
    if (outcome.kind === "result") {
      this.#respond(socket, {
        id,
        result: outcome.value,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    }
  }

  #respond(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  #insertInto(sessionId: string | undefined, text: string): void {
    const key = sessionId ?? "";
    this.#typed.set(key, (this.#typed.get(key) ?? "") + text);
  }

  /** Resolve after `ms`, tracked so `stop()` cannot leave stray timers. */
  #delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        resolve();
      }, Math.max(0, ms));
      this.#timers.add(timer);
    });
  }

  #takeInjectedError(method: string): CdpErrorPayload | undefined {
    const queue = this.#injected.get(method);
    if (queue !== undefined && queue.length > 0) {
      const error = queue.shift()!;
      if (queue.length === 0) this.#injected.delete(method);
      return error;
    }
    return this.#persistentErrors.get(method);
  }

  #satisfyWaiters(request: FakeCdpRequest): void {
    for (const waiter of [...this.#waiters]) {
      const matching = this.#requests.filter((item) => item.method === waiter.method);
      if (matching.length < waiter.count) continue;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve({ ...request, params: { ...request.params } });
    }
  }

  #rejectWaiters(reason: unknown): void {
    for (const waiter of this.#waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.#waiters.clear();
  }

  // --- CDP dispatch --------------------------------------------------------

  async #dispatch(request: FakeCdpRequest, socket: WebSocket): Promise<Outcome> {
    const { method, params, sessionId } = request;
    switch (method) {
      case "Browser.getVersion":
        return result({ ...DEFAULT_VERSION, ...this.#options.version });
      case "Browser.close":
        // Refused on purpose: a destructive call must fail loudly in tests
        // instead of looking like a successful teardown of the user's browser.
        return failure(-32601, "Browser.close is not supported by the test harness");

      case "Target.getTargets":
        return result({ targetInfos: [...this.#targets.values()].map((target) => this.#targetInfo(target)) });
      case "Target.getTargetInfo": {
        const target = this.#targets.get(asString(params.targetId) ?? "");
        if (target === undefined) return failure(-32602, "No target with given id found");
        return result({ targetInfo: this.#targetInfo(target) });
      }
      case "Target.attachToTarget": {
        const targetId = asString(params.targetId);
        const target = targetId !== undefined ? this.#targets.get(targetId) : undefined;
        if (targetId === undefined || target === undefined) {
          return failure(-32602, "No target with given id found");
        }
        // Tests that need to observe the reconnect window delay this response.
        if (this.#options.attachDelayMs !== undefined && this.#options.attachDelayMs > 0) {
          await this.#delay(this.#options.attachDelayMs);
        }
        // Chrome allocates a new sessionId on every attach. Reusing the previous
        // one would hide a client that keeps a stale id across a re-attach.
        const sessionId = `session-${this.#nextSessionId++}`;
        this.#sessions.set(sessionId, targetId);
        this.#sessionOwner.set(sessionId, socket);
        this.#knownSessions.add(sessionId);
        target.attached = true;
        return result({ sessionId });
      }
      case "Target.detachFromTarget": {
        const attachedSession = asString(params.sessionId);
        if (attachedSession !== undefined) this.#detachSession(attachedSession);
        return result({});
      }
      case "Target.createTarget": {
        const url = asString(params.url) ?? "about:blank";
        const created = this.addTarget({ url });
        return result({ targetId: created.id });
      }
      case "Target.closeTarget": {
        const targetId = asString(params.targetId);
        if (targetId === undefined || !this.#targets.has(targetId)) {
          return failure(-32602, "No target with given id found");
        }
        this.#destroyTarget(targetId);
        return result({ success: true });
      }
      case "Target.setDiscoverTargets":
        return result({});

      case "Page.enable":
        if (sessionId !== undefined) this.#enabledSessions.add(sessionId);
        return result({});
      case "Page.disable":
        if (sessionId !== undefined) this.#enabledSessions.delete(sessionId);
        return result({});
      case "Page.getFrameTree": {
        const target = sessionId !== undefined ? this.#targetForSession(sessionId) : this.#firstTarget();
        return result({ frameTree: { frame: this.#mainFrame(target) } });
      }
      case "Page.navigate": {
        const url = asString(params.url);
        if (url === undefined) return failure(-32602, "Invalid parameters");
        const target = sessionId !== undefined ? this.#targetForSession(sessionId) : this.#firstTarget();
        const commits = this.#options.navigateUpdatesUrl !== false;
        const sameDocument = this.#options.sameDocumentNavigation === true;
        const announce = commits && this.#options.emitFrameNavigated !== false && !sameDocument;
        // Per-hop loaderIds are minted in commit order, so the final document
        // always carries the newest one (a client that keys on it stays sane).
        const hopLoaders = announce
          ? (this.#options.redirectChain ?? []).map(() => this.#newLoaderId())
          : [];
        const loaderId = commits && !sameDocument ? this.#newLoaderId() : undefined;

        if (target !== undefined && commits) {
          target.url = url;
          if (target.title === "about:blank" || target.title === "") target.title = titleForUrl(url);
          this.#readyStateProbes.set(target.id, 0);
          // A same-document navigation keeps the document, so its loaderId
          // intentionally stays the same.
          if (loaderId !== undefined) this.#frameLoaders.set(target.id, loaderId);
        }

        // Page lifecycle events only flow after Page.enable on this session.
        // A client that never enables gets a silent navigate and must time out.
        const pageEnabled = sessionId !== undefined && this.#enabledSessions.has(sessionId);
        if (pageEnabled && commits) {
          if (sameDocument) {
            this.#scheduleEvent(
              "Page.navigatedWithinDocument",
              { frameId: "frame-1", url },
              sessionId,
              0,
            );
          } else if (announce) {
            // Every redirect hop commits with its own loaderId before the final
            // document; a client waiting for one specific loaderId would hang.
            // They are flushed in one tick, the way Chrome delivers a redirect
            // chain in a single socket read.
            const hops = this.#options.redirectChain ?? [];
            const frames = hops.map((hop, index) =>
              this.#framePayload(hop, hopLoaders[index] ?? this.#newLoaderId()),
            );
            if (loaderId !== undefined) {
              frames.push(this.#framePayload(url, loaderId));
            }
            if (target !== undefined && loaderId !== undefined) {
              this.#frameLoaders.set(target.id, loaderId);
            }
            this.#scheduleEvents(
              frames.map((frame) => ({ method: "Page.frameNavigated", params: { frame } })),
              sessionId,
            );
          }
          if (this.#options.emitLoadEvent !== false && !sameDocument) {
            const delayMs = this.#options.loadEventDelayMs ?? 0;
            this.#scheduleEvent("Page.loadEventFired", { timestamp: 1 }, sessionId, delayMs);
            if (this.#options.emitFrameStoppedLoading !== false) {
              this.#scheduleEvent("Page.frameStoppedLoading", { frameId: "frame-1" }, sessionId, delayMs);
            }
          }
        }
        // A navigation Chrome does not commit reports a frame but neither a
        // loaderId nor any lifecycle event, and leaves the URL untouched.
        return result(
          loaderId === undefined ? { frameId: "frame-1" } : { frameId: "frame-1", loaderId },
        );
      }
      case "Page.bringToFront":
        return result({});
      case "Page.captureScreenshot": {
        const source = this.#options.screenshot ?? Buffer.from("fake-screenshot");
        return result({ data: Buffer.from(source).toString("base64") });
      }

      case "Runtime.enable":
      case "Runtime.disable":
        return result({});
      case "Runtime.evaluate": {
        const expression = asString(params.expression) ?? "";
        const target = sessionId !== undefined ? this.#targetForSession(sessionId) : this.#firstTarget();
        return this.#evaluate(expression, params, target);
      }

      case "Network.getCookies": {
        const urls = Array.isArray(params.urls)
          ? params.urls.filter((url): url is string => typeof url === "string")
          : [];
        return result({
          cookies: filterCookiesForUrls(this.#options.cookies ?? [], urls).map((cookie) => ({ ...cookie })),
        });
      }
      case "Network.getAllCookies":
        return result({ cookies: (this.#options.cookies ?? []).map((cookie) => ({ ...cookie })) });

      case "Input.dispatchKeyEvent": {
        const type = asString(params.type);
        const text = asString(params.text) ?? "";
        // Chrome inserts on `char`, and on `keyDown` when the event carries
        // text; `rawKeyDown` does not insert. Modelling the keyDown path as
        // well is what makes a duplicated sequence visible in `typedText()`.
        if ((type === "char" || type === "keyDown") && text.length > 0) {
          this.#insertInto(sessionId, text);
        }
        return result({});
      }
      case "Input.insertText": {
        const text = asString(params.text) ?? "";
        if (text.length > 0) this.#insertInto(sessionId, text);
        return result({});
      }
      case "Input.dispatchMouseEvent":
        return result({});

      default:
        return failure(-32601, `'${method}' wasn't found`);
    }
  }

  /**
   * `Runtime.evaluate` semantics: `awaitPromise` decides whether a returned
   * thenable is resolved, `returnByValue` decides objectId vs inlined value, and
   * a throw/rejection becomes `exceptionDetails` on a normal response (Chrome
   * does not turn it into a protocol error, so client code must read the field).
   */
  async #evaluate(
    expression: string,
    params: Record<string, unknown>,
    target: CdpTarget | undefined,
  ): Promise<Outcome> {
    const awaitPromise = params.awaitPromise === true;
    const returnByValue = params.returnByValue === true;
    // `document.readyState` describes the simulated document, so it is answered
    // from the configured progression rather than from a scripted evaluate
    // fixture: navigation readiness must not be fakeable by `setEvaluateResult`.
    if (/document\.readyState/.test(expression)) {
      const state = this.#nextReadyState(target);
      return result({ result: remoteObject(state, returnByValue, this.#newObjectId()) });
    }
    let value: unknown;
    try {
      if (this.#evaluateHandler !== undefined) {
        value = this.#evaluateHandler(expression, params, target);
      } else if (this.#evaluateResult !== undefined) {
        value = this.#evaluateResult;
      } else {
        value = defaultEvaluate(expression, target);
      }
      if (isPromiseLike(value)) {
        if (!awaitPromise) {
          // Not awaited: Chrome hands back a Promise objectId. Attach a no-op
          // rejection handler so a rejected fixture promise cannot crash the run.
          void value.then(undefined, () => undefined);
          return result({ result: promiseObject(this.#newObjectId()) });
        }
        value = await value;
      }
    } catch (error) {
      return result({
        result: errorObject(this.#newObjectId()),
        exceptionDetails: exceptionDetailsFor(error, awaitPromise, this.#newObjectId()),
      });
    }
    return result({ result: remoteObject(value, returnByValue, this.#newObjectId()) });
  }

  #newObjectId(): string {
    return `object-${this.#nextObjectId++}`;
  }

  #newLoaderId(): string {
    return `loader-${this.#nextLoaderId++}`;
  }

  /** The loaderId of the committed document, allocating one for a fresh target. */
  #loaderForTarget(targetId: string): string {
    const existing = this.#frameLoaders.get(targetId);
    if (existing !== undefined) return existing;
    const loaderId = this.#newLoaderId();
    this.#frameLoaders.set(targetId, loaderId);
    return loaderId;
  }

  #framePayload(url: string, loaderId: string): Record<string, unknown> {
    return {
      id: "frame-1",
      loaderId,
      url,
      mimeType: "text/html",
      securityOrigin: originForUrl(url),
    };
  }

  #mainFrame(target: CdpTarget | undefined): Record<string, unknown> {
    const url = target?.url ?? "about:blank";
    const loaderId = target === undefined ? "loader-0" : this.#loaderForTarget(target.id);
    return this.#framePayload(url, loaderId);
  }

  /**
   * One answer per probe, then held at the last value: a client that polls
   * sees the document progress, and a client that never polls never reaches a
   * later state (which is what a stall test relies on).
   */
  #nextReadyState(target: CdpTarget | undefined): string {
    const sequence =
      this.#options.readyState !== undefined && this.#options.readyState.length > 0
        ? this.#options.readyState
        : DEFAULT_READY_STATES;
    const key = target?.id ?? "";
    const index = this.#readyStateProbes.get(key) ?? 0;
    this.#readyStateProbes.set(key, index + 1);
    const last = sequence.length - 1;
    return sequence[Math.min(index, last)] ?? "complete";
  }

  #targetInfo(target: CdpTarget): Record<string, unknown> {
    return {
      targetId: target.id,
      type: target.type,
      title: target.title,
      url: target.url,
      attached: target.attached === true,
      canAccessOpener: false,
    };
  }

  #firstTarget(): CdpTarget | undefined {
    for (const target of this.#targets.values()) return target;
    return undefined;
  }

  #firstTargetId(): string | undefined {
    for (const id of this.#targets.keys()) return id;
    return undefined;
  }

  #targetForSession(sessionId: string): CdpTarget | undefined {
    const targetId = this.#sessions.get(sessionId);
    return targetId === undefined ? undefined : this.#targets.get(targetId);
  }

  #destroyTarget(targetId: string): void {
    this.#targets.delete(targetId);
    this.#frameLoaders.delete(targetId);
    this.#readyStateProbes.delete(targetId);
    this.#emit("Target.targetDestroyed", { targetId });
    for (const [sessionId, ownerTargetId] of [...this.#sessions]) {
      if (ownerTargetId !== targetId) continue;
      this.#sessions.delete(sessionId);
      this.#lostSessions.add(sessionId);
      this.#enabledSessions.delete(sessionId);
      // Emit while the owner is still mapped: routing depends on it. Chrome
      // sends `Target.detachedFromTarget` at browser level (params carry the
      // session id), while `Inspector.detached` is the legacy session-scoped
      // shape kept for the P0 harness assertions only.
      this.#emit("Target.detachedFromTarget", { sessionId, targetId });
      this.#emit("Inspector.detached", { reason: "target_closed" }, sessionId);
      this.#sessionOwner.delete(sessionId);
    }
  }

  #detachSession(sessionId: string): void {
    const targetId = this.#sessions.get(sessionId);
    this.#sessionOwner.delete(sessionId);
    this.#enabledSessions.delete(sessionId);
    if (targetId === undefined) return;
    this.#sessions.delete(sessionId);
    if (this.#targetHasSession(targetId)) return;
    const target = this.#targets.get(targetId);
    if (target !== undefined) target.attached = false;
  }

  #targetHasSession(targetId: string): boolean {
    for (const sessionTargetId of this.#sessions.values()) {
      if (sessionTargetId === targetId) return true;
    }
    return false;
  }

  #scheduleEvent(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    delayMs: number,
  ): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#emit(method, params, sessionId);
    }, Math.max(0, delayMs));
    this.#timers.add(timer);
  }

  /**
   * Emit several events from one timer. Chrome delivers a redirect chain's
   * commits in a single socket read; separate timers would let a fast client
   * observe only the first one and make the ordering accidental.
   */
  #scheduleEvents(
    events: ReadonlyArray<{ method: string; params: Record<string, unknown> }>,
    sessionId: string | undefined,
  ): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      for (const event of events) this.#emit(event.method, event.params, sessionId);
    }, 0);
    this.#timers.add(timer);
  }

  #emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.#events.push({ method, params, ...(sessionId !== undefined ? { sessionId } : {}) });
    const payload = JSON.stringify({
      method,
      params,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    if (sessionId !== undefined) {
      // Session events belong to the client that attached the session. Sending
      // them to every socket would let a test "observe" an event Chrome would
      // route elsewhere — exactly the isolation P1-B needs to get right.
      const owner = this.#sessionOwner.get(sessionId);
      if (owner !== undefined) {
        if (owner.readyState === WebSocket.OPEN) owner.send(payload);
        return;
      }
      // Unknown owner but a session this fake minted: its client detached or
      // disconnected, so Chrome would drop the event — do not broadcast it.
      if (this.#knownSessions.has(sessionId)) return;
      // Never-attached id: only reachable through sendEvent(), keep it observable.
    }
    for (const socket of this.#sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  #resetState(targets?: ReadonlyArray<CdpTarget>): void {
    this.#targets.clear();
    this.#sessions.clear();
    this.#sessionOwner.clear();
    this.#knownSessions.clear();
    this.#lostSessions.clear();
    this.#enabledSessions.clear();
    this.#frameLoaders.clear();
    this.#readyStateProbes.clear();
    this.#nextLoaderId = 1;
    this.#nextObjectId = 1;
    const initial = targets ?? [DEFAULT_TARGET];
    for (const target of initial) this.#targets.set(target.id, { ...target });
  }
}
