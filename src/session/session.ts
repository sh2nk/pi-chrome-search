/**
 * One browser session, with an explicit lifecycle (SPEC S8.4, S12; PLAN P3).
 *
 * `idle -> connecting -> ready -> idle` is a reconnect cycle; `shutdown()` ends
 * at `closed`. Every public browser operation goes through this object: the
 * tools, the doctor, `/web-focus` and the CLI share one instance, so there is
 * one lock holder, one owned window and one writer per tab.
 *
 * The session owns three resources and releases them in this order:
 *
 *  1. owned tabs (anchor last, because the last tab closes its window),
 *  2. the CDP client,
 *  3. the cross-process lock.
 *
 * Attach only: this file never launches, restarts or kills a browser, never
 * writes the profile and never injects a document script. The Allow prompt is a
 * human step: it is waited out (`cdp.attachWaitMs`, one notification) and then
 * reported as `E_CDP_AWAITING_ALLOW`, never routed around.
 */

import { randomUUID } from "node:crypto";

import type { Config, FocusPolicy } from "../config/index.ts";
import type { EngineId } from "../engines/types.ts";
import { WebSearchError, isWebSearchError } from "../runtime/error-codes.ts";
import { fail, toFailure } from "../runtime/errors.ts";
import {
  PanelChannel,
  applyAnnouncement,
  initialPanelState,
  panelFileUrl,
  renderPanelExpression,
  type PanelState,
  type WorkAnnouncement,
} from "../runtime/panel.ts";
import { browserBrandFor, cdpAllowHint, inspectUrl } from "../runtime/host.ts";
import type { BrowserBrand } from "../runtime/host.ts";
import type { Clock, Logger } from "../runtime/types.ts";
import { captureBytes } from "../cdp/bytes.ts";
import { CdpClient as ProductionCdpClient } from "../cdp/client.ts";
import type {
  BrowserInfo,
  CdpClient,
  CdpConnectionInfo,
  CdpConnector,
  CdpEndpoint,
  CdpPage,
  FetchedBytes,
  FetchBytesOptions,
  PageKey,
} from "../cdp/types.ts";
import { SessionLock, defaultLockPath } from "./lock.ts";
import { ANCHOR_BLANK_PAGE, TabPool } from "./tabs.ts";

export type SessionState = "idle" | "connecting" | "ready" | "closed";

/** What the attention layer needs to know while the Allow prompt is unanswered. */
export interface AwaitingAllowInfo {
  /** 1 for the first failed attempt. */
  attempt: number;
  elapsedMs: number;
  budgetMs: number;
  /** Brand-detected action hint (`chrome://inspect/…` vs `brave://…`). */
  hint: string;
  brand: BrowserBrand | null;
  endpoint: CdpEndpoint;
  /** True for the last event, emitted just before `E_CDP_AWAITING_ALLOW`. */
  final?: boolean;
}

export interface SessionInfo {
  state: SessionState;
  endpoint: CdpEndpoint;
  browser: BrowserInfo;
  webdriver: boolean;
  windowId: number | null;
  ownedTargets: Array<{ targetId: string; key: PageKey | null; url: string }>;
  focusedOnce: PageKey[];
  windowDegraded: boolean;
  locked: boolean;
}

export interface ConnectClientOptions {
  wsUrl: string;
  connectTimeoutMs: number;
  clock: Clock;
  log: Logger;
}

export interface SessionOptions {
  config: Config;
  discover: () => Promise<CdpEndpoint>;
  /** Test seam; production connects the raw WebSocket client. */
  connectClient?: (opts: ConnectClientOptions) => Promise<CdpClient>;
  clock: Clock;
  log: Logger;
  /** Default `$PI_CODING_AGENT_DIR/web-search.lock` or `~/.pi/agent/web-search.lock`. */
  lockPath?: string;
  heartbeatMs?: number;
  staleMs?: number;
  /** Injectable for tests; defaults to a random UUID. */
  sessionId?: string;
  /** Test seam for stale-lock reclaim; defaults to the host layer's check. */
  alive?: (pid: number) => boolean;
  /** Called while a connect waits for the user's Allow prompt. */
  onAwaitingAllow?: (info: AwaitingAllowInfo) => void;
}

/** The session surface. `CdpConnector` is the slice adapters/tools see. */
export interface Session extends CdpConnector {
  /** Idempotent while the socket is alive; a dead socket starts one fresh attach. */
  connect(): Promise<CdpConnectionInfo>;
  acquirePage(key: PageKey): Promise<CdpPage>;
  releasePage(key: PageKey): Promise<void>;
  /** Close owned tabs and the lock but keep the object reusable. */
  releaseAll(): Promise<void>;
  /** Terminal teardown; a closed session must not be reused. */
  shutdown(): Promise<void>;
  state(): SessionState;
  info(): SessionInfo | null;
  ownedTargets(): string[];
  lockPath(): string;
  focus(): Promise<void>;
  anchorPage(): CdpPage | null;
  pageFor(key: PageKey): CdpPage | null;
  fetchBytes(url: string, o?: FetchBytesOptions): Promise<FetchedBytes>;
  announce(update: WorkAnnouncement): Promise<void>;
}

interface ConnectedState {
  endpoint: CdpEndpoint;
  browser: BrowserInfo;
  webdriver: boolean;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function asSessionError(error: unknown): WebSearchError {
  if (isWebSearchError(error)) return error;
  return new WebSearchError(toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" }));
}

export class BrowserSession implements Session {
  readonly #config: Config;
  readonly #discover: () => Promise<CdpEndpoint>;
  readonly #connectClient: NonNullable<SessionOptions["connectClient"]>;
  readonly #onAwaitingAllow: SessionOptions["onAwaitingAllow"];
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #sessionId: string;
  readonly #lock: SessionLock;

  #client: CdpClient | undefined;
  #tabs: TabPool | undefined;
  #state: SessionState = "idle";
  #cdp: ConnectedState | undefined;
  #connectPromise: Promise<CdpConnectionInfo> | undefined;
  readonly #focusedOnce = new Set<PageKey>();

  /** Panel writes, throttled; undefined when `window.panel` is false. */
  readonly #panel: PanelChannel | undefined;
  #panelState: PanelState | undefined;
  #panelWarned = false;
  #idleGeneration = 0;

  constructor(options: SessionOptions) {
    this.#config = options.config;
    this.#discover = options.discover;
    this.#connectClient =
      options.connectClient ?? ((opts) => ProductionCdpClient.connect(opts));
    this.#onAwaitingAllow = options.onAwaitingAllow;
    this.#clock = options.clock;
    this.#log = options.log;
    this.#sessionId = options.sessionId ?? randomUUID();
    this.#lock = new SessionLock({
      path: options.lockPath ?? defaultLockPath(process.env),
      sessionId: this.#sessionId,
      clock: this.#clock,
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
      ...(options.alive === undefined ? {} : { alive: options.alive }),
      warn: (event, detail) => this.#warn(event, detail),
    });
    this.#panel = this.#config.window.panel
      ? new PanelChannel({
          clock: this.#clock,
          sink: { write: (state) => this.#paintPanel(state) },
        })
      : undefined;
  }

  state(): SessionState {
    return this.#state;
  }

  // --- CdpConnector --------------------------------------------------------

  async connect(): Promise<CdpConnectionInfo> {
    if (this.#state === "closed") {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "this browser session was shut down",
        hint: "start a new pi session; a shut-down connector must not reopen the user's browser",
      });
    }
    const inFlight = this.#connectPromise;
    if (inFlight !== undefined) return await inFlight;

    const attempt = this.#connectOnce();
    this.#connectPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (this.#connectPromise === attempt) this.#connectPromise = undefined;
    }
  }

  async #connectOnce(): Promise<CdpConnectionInfo> {
    let orphans: string[] = [];
    if (this.#cdp !== undefined && this.#client !== undefined) {
      if (this.#client.isConnected()) return this.#connection();
      orphans = await this.#dropDeadSession();
    }

    await this.#lock.acquire();
    this.#state = "connecting";

    try {
      const endpoint = await this.#discover();
      const client = await this.#connectWithAllowWait(endpoint);
      this.#client = client;
      this.#tabs = new TabPool({
        client,
        clock: this.#clock,
        warn: (event, detail) => this.#warn(event, detail),
      });

      const browser = await client.version();
      // Tabs we created survived the socket: close them through the new session
      // so they do not leak. The anchor goes last because its window would close.
      await this.#tabs.closeTargets(orphans);
      const anchor = await this.#tabs.ensureAnchor(this.#anchorUrl());
      const webdriver = await anchor.page.evaluate<unknown>("navigator.webdriver");
      if (webdriver === true) {
        const brand = browserBrandFor(endpoint.profileDir);
        throw fail("E_CDP_UNAVAILABLE", "connect", {
          message: "navigator.webdriver is true on the CDP-attached anchor tab",
          hint:
            "this browser was started by an automation tool; close it and attach to your normal " +
            `profile via ${inspectUrl(brand)} → Allow — the extension never starts a browser itself`,
        });
      }

      if (this.#config.window.panel && anchor.page.url() !== ANCHOR_BLANK_PAGE) {
        // Seed the merge state only; the asset renders its own empty shell until
        // the first stage announcement, which then paints immediately.
        this.#panelState = initialPanelState({ sessionId: this.#sessionId, now: this.#clock.now() });
      }

      this.#cdp = { endpoint, browser, webdriver: false };
      this.#state = "ready";
      return this.#connection();
    } catch (error) {
      await this.#cleanupFailedConnect();
      throw asSessionError(error);
    }
  }

  /**
   * The Allow prompt cannot be seen by the agent, so a handshake that hangs is
   * waited out rather than turned into a false failure. Each attempt is bounded
   * by a short socket timeout; a refusal (`ECONNREFUSED`) means nothing is
   * listening and fails immediately. Budget exhaustion is its own actionable
   * code, `E_CDP_AWAITING_ALLOW` (S8.4), not a generic transport failure.
   */
  async #connectWithAllowWait(endpoint: CdpEndpoint): Promise<CdpClient> {
    const brand = browserBrandFor(endpoint.profileDir);
    const waitMs = Math.max(0, Math.floor(this.#config.cdp.attachWaitMs));
    const attemptTimeoutMs = Math.max(500, Math.min(this.#config.cdp.connectTimeoutMs, 3000));
    const started = this.#clock.now();
    let attempt = 0;
    let last: WebSearchError | undefined;

    for (;;) {
      attempt += 1;
      try {
        return await this.#connectClient({
          wsUrl: endpoint.wsUrl,
          connectTimeoutMs: attemptTimeoutMs,
          clock: this.#clock,
          log: this.#log,
        });
      } catch (error) {
        const details = isWebSearchError(error)
          ? error.details
          : toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
        last = fail(details.code, details.stage, {
          hint: cdpAllowHint(brand),
          ...(details.message === undefined ? {} : { message: details.message }),
        });
        if (details.code === "E_BUSY" || details.code === "E_CONFIG") throw last;

        const message = details.message ?? "";
        if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN/i.test(message)) throw last;

        const elapsedMs = this.#clock.now() - started;
        if (waitMs === 0) throw last;
        if (elapsedMs >= waitMs) {
          this.#onAwaitingAllow?.({
            attempt,
            elapsedMs,
            budgetMs: waitMs,
            hint: cdpAllowHint(brand),
            brand,
            endpoint,
            final: true,
          });
          throw fail("E_CDP_AWAITING_ALLOW", "connect", {
            message:
              `the CDP endpoint on 127.0.0.1:${endpoint.port} did not answer for ${elapsedMs}ms ` +
              `(${attempt} attempt(s)); the Allow prompt may be waiting in the browser window`,
            hint: cdpAllowHint(brand),
          });
        }

        this.#onAwaitingAllow?.({
          attempt,
          elapsedMs,
          budgetMs: waitMs,
          hint: cdpAllowHint(brand),
          brand,
          endpoint,
        });

        const remaining = waitMs - elapsedMs;
        const pause = Math.min(2_000, Math.max(250, remaining));
        try {
          await this.#clock.sleep(pause);
        } catch {
          // A clock without sleep must not turn the wait into a crash.
        }
      }
    }
  }

  async acquirePage(key: PageKey): Promise<CdpPage> {
    if (!this.isConnected()) await this.connect();
    const tabs = this.#tabs;
    if (tabs === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "acquirePage() has no CDP session",
        hint: "the session was released; call connect() again (or run /web-doctor)",
      });
    }

    const page = await tabs.acquire(key, this.#anchorUrl());
    if (this.#wantsFocus(key)) {
      await page.bringToFront();
      this.#focusedOnce.add(key);
    }
    return page;
  }

  async releasePage(key: PageKey): Promise<void> {
    this.#focusedOnce.delete(key);
    await this.#tabs?.release(key);
  }

  async releaseAll(): Promise<void> {
    const tabs = this.#tabs;
    const client = this.#client;
    this.#tabs = undefined;
    this.#client = undefined;
    this.#cdp = undefined;
    this.#focusedOnce.clear();
    this.#state = "idle";
    this.#cancelIdleHandback();
    this.#panel?.close();
    this.#panelState = undefined;

    try {
      await tabs?.releaseAll();
    } finally {
      if (client !== undefined) {
        try {
          await client.close();
        } catch (error) {
          this.#warn("session_close_failed", describeError(error));
        }
      }
      await this.#lock.release();
    }
  }

  async shutdown(): Promise<void> {
    await this.releaseAll();
    this.#state = "closed";
  }

  isConnected(): boolean {
    return this.#state === "ready" && this.#client?.isConnected() === true;
  }

  endpoint(): CdpEndpoint | null {
    return this.#cdp?.endpoint ?? null;
  }

  // --- doctor / command surface -------------------------------------------

  info(): SessionInfo | null {
    const state = this.#cdp;
    if (state === undefined) return null;
    const tabs = this.#tabs;
    return {
      state: this.#state,
      endpoint: state.endpoint,
      browser: state.browser,
      webdriver: state.webdriver,
      windowId: tabs?.windowId() ?? null,
      ownedTargets: tabs?.ownedInfo() ?? [],
      focusedOnce: [...this.#focusedOnce],
      windowDegraded: tabs?.windowDegraded() ?? false,
      locked: this.#lock.held,
    };
  }

  ownedTargets(): string[] {
    return this.#tabs?.ownedIds() ?? [];
  }

  lockPath(): string {
    return this.#lock.path;
  }

  anchorPage(): CdpPage | null {
    return this.#tabs?.anchor()?.page ?? null;
  }

  pageFor(key: PageKey): CdpPage | null {
    return this.#tabs?.pageFor(key) ?? null;
  }

  // --- response bytes through the browser ---------------------------------

  async fetchBytes(url: string, o: FetchBytesOptions = {}): Promise<FetchedBytes> {
    const client = this.#client;
    if (client === undefined || !this.isConnected()) {
      throw fail("E_CDP_UNAVAILABLE", "read", {
        message: "fetchBytes was called before the browser session was connected",
        hint: "call connect() (or run /web-doctor) before reading bytes",
      });
    }
    return await captureBytes(client, url, o);
  }

  // --- panel and follow-focus ---------------------------------------------

  async announce(update: WorkAnnouncement): Promise<void> {
    if (!this.isConnected()) return;

    if (this.#panel !== undefined) {
      const previous =
        this.#panelState ?? initialPanelState({ sessionId: this.#sessionId, now: this.#clock.now() });
      this.#panelState = applyAnnouncement(previous, update, {
        sessionId: this.#sessionId,
        now: this.#clock.now(),
      });
      await this.#panel.publish(this.#panelState);
    }

    await this.#applyFollow(update);
  }

  async #paintPanel(state: PanelState): Promise<boolean> {
    const anchor = this.#tabs?.anchor();
    if (anchor === undefined) return false;
    try {
      const painted = await anchor.page.evaluate<unknown>(renderPanelExpression(state));
      return painted !== false;
    } catch (error) {
      if (!this.#panelWarned) {
        this.#panelWarned = true;
        this.#warn("panel_paint_failed", `could not paint the anchor panel: ${describeError(error)}`);
      }
      return false;
    }
  }

  async #applyFollow(update: WorkAnnouncement): Promise<void> {
    const policy = this.#config.window.follow;
    if (this.#config.window.focus === "never" || policy === "never") return;

    if (policy === "anchor") {
      this.#cancelIdleHandback();
      await this.#raiseAnchor();
      return;
    }

    const working =
      update.stage === "navigate" ||
      update.stage === "settle" ||
      update.stage === "extract" ||
      update.stage === "read";
    if (working) {
      this.#cancelIdleHandback();
      await this.#raiseWork(update.engine ?? null);
      return;
    }

    // Only `done` hands the screen back. An `error` may be a captcha wall that
    // the user has to solve in the work tab; stealing focus back would fight them.
    if (update.stage === "done") this.#scheduleIdleHandback();
  }

  async #raiseWork(engine: EngineId | null): Promise<void> {
    const page = engine === null ? undefined : this.#tabs?.pageFor(engine);
    if (page === undefined) return;
    try {
      await page.bringToFront();
    } catch (error) {
      this.#warn("focus_failed", `could not raise the ${engine} tab: ${describeError(error)}`);
    }
  }

  async #raiseAnchor(): Promise<void> {
    const anchor = this.#tabs?.anchor();
    if (anchor === undefined || !this.isConnected()) return;
    try {
      await anchor.page.bringToFront();
    } catch (error) {
      this.#warn("focus_failed", `could not raise the anchor tab: ${describeError(error)}`);
    }
  }

  #cancelIdleHandback(): void {
    this.#idleGeneration += 1;
  }

  #scheduleIdleHandback(): void {
    const generation = ++this.#idleGeneration;
    const idleMs = Math.max(0, Math.floor(this.#config.window.idleMs));
    void this.#clock
      .sleep(idleMs)
      .then(async () => {
        if (generation !== this.#idleGeneration) return;
        await this.#raiseAnchor();
      })
      .catch(() => undefined);
  }

  async focus(): Promise<void> {
    const client = this.#client;
    if (this.#cdp === undefined || client === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "focus() was called before connect()",
        hint: "run /web-doctor first; focusing only applies to a window this extension already owns",
      });
    }

    let live: Set<string>;
    try {
      live = new Set((await client.targets()).map((target) => target.id));
    } catch (error) {
      throw asSessionError(error);
    }

    const tabs = this.#tabs;
    if (tabs === undefined) return;
    const pages: CdpPage[] = [];
    for (const target of tabs.ownedInfo()) {
      if (target.key !== null && live.has(target.targetId)) {
        const page = tabs.pageFor(target.key);
        if (page !== undefined) pages.push(page);
      }
    }
    const anchor = tabs.anchor();
    if (pages.length === 0 && anchor !== undefined && live.has(anchor.targetId)) pages.push(anchor.page);

    for (const page of pages) {
      try {
        await page.bringToFront();
      } catch (error) {
        this.#warn("focus_failed", `could not raise an owned target: ${describeError(error)}`);
      }
    }
  }

  // --- state ---------------------------------------------------------------

  #anchorUrl(): string {
    return this.#config.window.panel ? panelFileUrl() : ANCHOR_BLANK_PAGE;
  }

  #wantsFocus(key: PageKey): boolean {
    const policy: FocusPolicy = this.#config.window.focus;
    if (policy === "always") return true;
    if (policy === "session") return !this.#focusedOnce.has(key);
    return false;
  }

  #connection(): CdpConnectionInfo {
    const state = this.#cdp;
    if (state === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "the session is not connected",
        hint: "call connect() (or run /web-doctor) before using the browser",
      });
    }
    return { endpoint: state.endpoint, browser: state.browser, webdriver: state.webdriver };
  }

  async #dropDeadSession(): Promise<string[]> {
    const tabs = this.#tabs;
    const client = this.#client;
    const orphans = tabs?.detach() ?? [];

    this.#tabs = undefined;
    this.#client = undefined;
    this.#cdp = undefined;
    this.#state = "idle";
    this.#focusedOnce.clear();
    this.#cancelIdleHandback();
    this.#panelState = undefined;

    if (client !== undefined) {
      try {
        await client.close();
      } catch (error) {
        this.#warn("session_close_failed", describeError(error));
      }
    }

    this.#warn(
      "cdp_stale_session",
      `the CDP socket is dead; dropping ${orphans.length} owned target(s) and reconnecting`,
    );
    return orphans;
  }

  async #cleanupFailedConnect(): Promise<void> {
    const tabs = this.#tabs;
    const client = this.#client;
    this.#tabs = undefined;
    this.#client = undefined;
    this.#cdp = undefined;
    this.#focusedOnce.clear();
    this.#cancelIdleHandback();
    this.#panelState = undefined;

    try {
      await tabs?.releaseAll();
    } finally {
      if (client !== undefined) {
        try {
          await client.close();
        } catch (error) {
          this.#warn("session_close_failed", describeError(error));
        }
      }
      // A failed connect must not leave a lock that blocks every later attempt.
      await this.#lock.release();
      this.#state = "idle";
    }
  }

  #warn(event: string, detail: string): void {
    void this.#log
      .write({ ts: new Date(this.#clock.now()).toISOString(), level: "warn", event, message: detail })
      .catch(() => undefined);
  }
}

export function createSession(options: SessionOptions): Session {
  return new BrowserSession(options);
}
