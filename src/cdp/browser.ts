/**
 * Browser ownership: one dedicated window, one reusable work tab per engine,
 * and a single cross-session lock (SPEC §5.3/§5.5, PLAN P1-D).
 *
 * Three behaviours here are deliberate and non-obvious:
 *
 *  - **One window, created by us.** `Target.createTarget` without `newWindow`
 *    puts a tab in whichever window was last focused, which may be a window the
 *    user is working in. We create an `about:blank` bootstrap tab with
 *    `newWindow: true` and keep it as the window anchor, then verify every work
 *    tab's placement with `Browser.getWindowForTarget`. A tab that landed in a
 *    foreign window is closed (it is ours, we just created it) and recreated in
 *    a dedicated window; `windowDegraded` records that the compositor refused
 *    the first attempt.
 *
 *    A forced `newWindow: true` tab *defines* the owned window: its id is
 *    re-read with `Browser.getWindowForTarget` and kept, and the placement check
 *    is skipped for it. Keeping the bootstrap id instead would judge every later
 *    engine tab foreign, so each acquire would close and recreate a tab in yet
 *    another window (one misplacement would leave three windows on screen).
 *
 *  - **The bootstrap tab stays open.** Closing the last tab of a Chrome window
 *    closes the window, so the anchor keeps the dedicated window alive between
 *    searches. It appears as `engine: null` in the doctor output.
 *
 *  - **The lock is published with `link(2)`.** A fully written and fsynced
 *    temporary file is linked into place, which fails with EEXIST for the loser.
 *    `open(path, "wx")` plus a later write would let a second connector see an
 *    empty file, call it corrupt and reclaim a lock that is being written.
 *
 *  - **PID liveness without signalling.** The lock holder may be another pi
 *    process. We only stat `/proc/<pid>` on Linux and let the heartbeat decide
 *    everywhere else; sending a signal to check liveness would be a
 *    kill-adjacent operation against the user's session (AGENTS §2, rule 2).
 *
 * Everything is serialized through this connector: at most one live session,
 * at most one work tab per engine, and tabs are closed only when their target
 * id is in `#owned`. A target we did not create can never be closed from here.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { Config, FocusPolicy } from "../config.ts";
import type { EngineId } from "../engines/types.ts";
import { WebSearchError, isWebSearchError } from "../runtime/error-codes.ts";
import { fail, toFailure } from "../runtime/errors.ts";
import type { Clock, Logger } from "../runtime/types.ts";
import { CdpSession, createCdpPage } from "./session.ts";
import type { BrowserInfo, CdpConnectionInfo, CdpConnector, CdpEndpoint, CdpPage } from "./types.ts";

/** Shape version of the lock file; a future field bump must refuse older files explicitly. */
export const LOCK_VERSION = 1;
/** 20 s is one third of the 60 s stale window: two missed beats still look alive. */
export const DEFAULT_HEARTBEAT_MS = 20_000;
export const DEFAULT_STALE_MS = 60_000;

/** Every tab we create starts blank: the engine adapter owns the actual URL. */
const BLANK_PAGE = "about:blank";
/** Owner-only: the lock names a PID and a session id, not a secret, but nothing else needs it. */
const LOCK_MODE = 0o600;

export interface ConnectorOptions {
  config: Config;
  discover: () => Promise<CdpEndpoint>;
  connectSession?: (opts: {
    wsUrl: string;
    connectTimeoutMs: number;
    clock: Clock;
    log: Logger;
  }) => Promise<CdpSession>;
  clock: Clock;
  log: Logger;
  /** Default `$PI_CODING_AGENT_DIR/web-search.lock` or `~/.pi/agent/web-search.lock`. */
  lockPath?: string;
  /** Default {@link DEFAULT_HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** Default {@link DEFAULT_STALE_MS}. */
  staleMs?: number;
  /** Injectable for tests; defaults to a random UUID. */
  sessionId?: string;
}

export interface ConnectorInfo {
  endpoint: CdpEndpoint;
  browser: BrowserInfo;
  webdriver: boolean;
  windowId: number | null;
  ownedTargets: Array<{ targetId: string; engine: EngineId | null; url: string }>;
  focusedOnce: EngineId[];
  windowDegraded: boolean;
  locked: boolean;
}

/** The frozen connector plus the introspection the doctor and `/web-focus` need. */
export type Connector = CdpConnector & {
  info(): ConnectorInfo | null;
  ownedTargets(): string[];
  lockPath(): string;
  /** Bring the owned window forward on demand (`/web-focus`). Never navigates or opens a tab. */
  focus(): Promise<void>;
};

interface LockRecord {
  version: number;
  pid: number;
  sessionId: string;
  startedAt: number;
  heartbeatAt: number;
}

type LockRead = { kind: "ok"; record: LockRecord } | { kind: "corrupt" };

interface OwnedPage {
  targetId: string;
  /** `null` only for the bootstrap anchor tab. */
  engine: EngineId | null;
  page: CdpPage;
}

/** Endpoint/version/webdriver triple, captured once by `connect()`. */
interface ConnectedState {
  endpoint: CdpEndpoint;
  browser: BrowserInfo;
  webdriver: boolean;
}

// ---------------------------------------------------------------------------
// Small guards and helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

/**
 * Validate a lock file. Anything that is not exactly the shape this module
 * writes is "corrupt", and a corrupt lock must never brick the extension: the
 * caller logs a warning and reclaims it.
 */
export function parseLockRecord(text: string): LockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const { version, pid, sessionId, startedAt, heartbeatAt } = value;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return null;
  if (typeof sessionId !== "string" || sessionId.trim() === "") return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (typeof heartbeatAt !== "number" || !Number.isFinite(heartbeatAt)) return null;

  return { version, pid, sessionId, startedAt, heartbeatAt };
}

/**
 * A PID is alive when its `/proc` entry exists. On other platforms we assume it
 * is alive and let the heartbeat expire the lock, because probing a process
 * without signalling it is not portable.
 */
export function pidAlive(pid: number): boolean {
  if (platform() !== "linux") return true;
  return existsSync(`/proc/${pid}`);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(homedir(), path);
}

export function defaultLockPath(env: NodeJS.ProcessEnv = process.env): string {
  const rawDir = env.PI_CODING_AGENT_DIR?.trim();
  const dir = rawDir !== undefined && rawDir !== "" ? expandHome(rawDir) : join(homedir(), ".pi", "agent");
  return join(dir, "web-search.lock");
}

function asConnectorError(error: unknown): WebSearchError {
  if (isWebSearchError(error)) return error;
  return new WebSearchError(toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" }));
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

class BrowserConnector implements Connector {
  readonly #config: Config;
  readonly #discover: () => Promise<CdpEndpoint>;
  readonly #connectSession: NonNullable<ConnectorOptions["connectSession"]>;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #sessionId: string;
  readonly #lockPath: string;
  readonly #heartbeatMs: number;
  readonly #staleMs: number;

  #session: CdpSession | undefined;
  #state: ConnectedState | undefined;
  /**
   * One in-flight connect per connector. Two callers that raced would each
   * create a bootstrap window, so the second gets the first attempt's promise.
   */
  #connectPromise: Promise<CdpConnectionInfo> | undefined;
  #lock: LockRecord | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /**
   * A 1 ms heartbeat (tests) can start a second tick before the first finished
   * its atomic rewrite; the guard keeps the tmp path from being renamed twice.
   */
  #heartbeatBusy = false;

  #bootstrap: OwnedPage | undefined;
  readonly #enginePages = new Map<EngineId, OwnedPage>();
  /** Target ids this connector created. The only ids `releaseAll` may close. */
  readonly #owned = new Set<string>();
  readonly #focusedOnce = new Set<EngineId>();

  #windowId: number | null = null;
  #windowDegraded = false;

  constructor(options: ConnectorOptions) {
    this.#config = options.config;
    this.#discover = options.discover;
    this.#connectSession = options.connectSession ?? ((opts) => CdpSession.connect(opts));
    this.#clock = options.clock;
    this.#log = options.log;
    this.#sessionId = options.sessionId ?? randomUUID();
    this.#lockPath = options.lockPath ?? defaultLockPath(process.env);
    this.#heartbeatMs = positiveInt(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
    this.#staleMs = positiveInt(options.staleMs, DEFAULT_STALE_MS);
  }

  // --- CdpConnector --------------------------------------------------------

  async connect(): Promise<CdpConnectionInfo> {
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
    // Idempotent only while the socket is alive: cached state over a dead
    // session would hand out pages whose every command fails. The lock stays
    // ours across the reconnect — this process is still running.
    let orphans: string[] = [];
    if (this.#state !== undefined) {
      if (this.#session?.isConnected() === true) return this.#connection();
      orphans = await this.#dropDeadSession();
    }

    await this.#acquireLock();

    try {
      const endpoint = await this.#discover();
      const session = await this.#connectSession({
        wsUrl: endpoint.wsUrl,
        connectTimeoutMs: this.#config.cdp.connectTimeoutMs,
        clock: this.#clock,
        log: this.#log,
      });
      this.#session = session;
      const browser = await session.version();

      // Tabs we created survived the socket: close them through the new
      // session so they do not leak. Engine tabs go first, the bootstrap
      // anchor last, because closing the last tab closes its window. Ids found
      // in `orphans` are ours by construction; a foreign tab is never listed.
      for (const targetId of orphans) await this.#closeTargetQuietly(session, targetId);

      // Bootstrap: the one window this extension owns. `newWindow: true` is the
      // only way to guarantee the window is not the user's.
      const bootstrapId = await session.createTarget(BLANK_PAGE, { newWindow: true });
      this.#owned.add(bootstrapId);
      // Attach before the page exists: every page command needs the flattened
      // session id, and a page built on an unattached target fails on first use.
      await session.attach(bootstrapId);
      const bootstrapPage = createCdpPage(session, bootstrapId, {
        clock: this.#clock,
        initialUrl: BLANK_PAGE,
      });
      this.#bootstrap = { targetId: bootstrapId, engine: null, page: bootstrapPage };

      const webdriver = await bootstrapPage.evaluate<unknown>("navigator.webdriver");
      if (webdriver === true) {
        throw fail("E_CDP_UNAVAILABLE", "connect", {
          message: "navigator.webdriver is true on the CDP-attached bootstrap tab",
          hint:
            "this Chrome was started by an automation tool; close it and attach to your normal " +
            "profile via chrome://inspect → Allow — the extension never starts a browser itself",
        });
      }

      this.#windowId = await this.#windowForTarget(session, bootstrapId);
      this.#state = { endpoint, browser, webdriver: false };
      return this.#connection();
    } catch (error) {
      await this.#cleanupFailedConnect();
      throw asConnectorError(error);
    }
  }

  async acquirePage(engine: EngineId): Promise<CdpPage> {
    if (!this.isConnected()) await this.connect();
    const session = this.#session;
    if (session === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "acquirePage() has no CDP session",
        hint: "the session was released; call connect() again (or run /web-doctor)",
      });
    }

    const existing = this.#enginePages.get(engine);
    if (existing !== undefined) {
      if (await this.#targetExists(session, existing.targetId)) {
        // The tab survived, but our flattened session may not (a reconnect
        // allocates new session ids), so re-attach before handing it out.
        if (session.sessionIdFor(existing.targetId) === undefined) await session.attach(existing.targetId);
        await this.#applyFocus(engine, existing.page);
        return existing.page;
      }
      // The user (or Chrome) closed it; forget it and open one fresh tab.
      this.#enginePages.delete(engine);
      this.#owned.delete(existing.targetId);
      this.#warn("tab_lost", `owned ${engine} tab ${existing.targetId} is gone; opening a new one`);
    }

    await this.#ensureBootstrap(session);

    // Bringing the owned window forward before `createTarget` biases Chrome's
    // "last focused window" choice towards it. Under `focus: "never"` we do not
    // touch focus at all, even here; placement is then verified and corrected.
    if (this.#wantsFocus(engine)) await this.#bringWindowToFront();

    const created = await this.#createWorkTarget(session);
    const owned: OwnedPage = { targetId: created.targetId, engine, page: created.page };
    this.#enginePages.set(engine, owned);
    await this.#applyFocus(engine, owned.page);
    return owned.page;
  }

  async releaseAll(): Promise<void> {
    const session = this.#session;
    const targets = [...this.#owned];

    // Close only targets this connector created; a foreign tab is never touched.
    if (session !== undefined) {
      for (const targetId of targets) await this.#closeTargetQuietly(session, targetId);
    }

    this.#owned.clear();
    this.#enginePages.clear();
    this.#bootstrap = undefined;
    this.#focusedOnce.clear();
    this.#session = undefined;
    this.#state = undefined;
    this.#windowId = null;
    this.#windowDegraded = false;

    await this.#releaseLock();

    if (session !== undefined) {
      try {
        await session.close();
      } catch (error) {
        this.#warn("session_close_failed", describeError(error));
      }
    }
  }

  isConnected(): boolean {
    return this.#state !== undefined && this.#session?.isConnected() === true;
  }

  endpoint(): CdpEndpoint | null {
    return this.#state?.endpoint ?? null;
  }

  // --- doctor / command surface -------------------------------------------

  info(): ConnectorInfo | null {
    const state = this.#state;
    if (state === undefined) return null;
    return {
      endpoint: state.endpoint,
      browser: state.browser,
      webdriver: state.webdriver,
      windowId: this.#windowId,
      ownedTargets: this.#ownedList(),
      focusedOnce: [...this.#focusedOnce],
      windowDegraded: this.#windowDegraded,
      locked: this.#lock !== undefined,
    };
  }

  ownedTargets(): string[] {
    return [...this.#owned];
  }

  lockPath(): string {
    return this.#lockPath;
  }

  async focus(): Promise<void> {
    const session = this.#session;
    if (this.#state === undefined || session === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "focus() was called before connect()",
        hint: "run /web-doctor first; focusing only applies to a window this extension already owns",
      });
    }

    // A tab may have been closed since the last acquire: raising a dead target
    // throws, and one vanished tab must not turn /web-focus into an error.
    let live: Set<string>;
    try {
      live = new Set((await session.targets()).map((target) => target.id));
    } catch (error) {
      throw asConnectorError(error);
    }

    // Prefer the engine tabs: one of them is the visible work. Only when no
    // engine tab exists yet is the bootstrap anchor worth raising.
    const enginePages = [...this.#enginePages.values()].filter((owned) => live.has(owned.targetId));
    const bootstrap = this.#bootstrap;
    const pages: OwnedPage[] =
      enginePages.length > 0
        ? enginePages
        : bootstrap === undefined || !live.has(bootstrap.targetId)
          ? []
          : [bootstrap];
    for (const owned of pages) {
      try {
        await owned.page.bringToFront();
      } catch (error) {
        this.#warn("focus_failed", `could not raise owned target ${owned.targetId}: ${describeError(error)}`);
      }
    }
  }

  // --- lock ----------------------------------------------------------------

  async #acquireLock(): Promise<void> {
    if (this.#lock !== undefined) return;

    try {
      await mkdir(dirname(this.#lockPath), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw fail("E_CONFIG", "connect", {
        message: `cannot create the lock directory ${dirname(this.#lockPath)}: ${describeError(error)}`,
        hint: "check that the pi agent directory is writable; the lock stops two sessions from driving the same tab",
      });
    }

    // A stale or corrupt lock is reclaimed exactly once: two attempts, never a loop.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if ((await this.#attemptLock(this.#lockPath)) === "acquired") return;
    }

    throw fail("E_BUSY", "connect", {
      message: `could not acquire ${this.#lockPath} even after reclaiming it once`,
      hint: `another process keeps recreating ${this.#lockPath}; run /web-doctor or remove the file by hand`,
    });
  }

  async #attemptLock(path: string): Promise<"acquired" | "reclaim"> {
    const record: LockRecord = {
      version: LOCK_VERSION,
      pid: process.pid,
      sessionId: this.#sessionId,
      startedAt: this.#clock.now(),
      heartbeatAt: this.#clock.now(),
    };

    try {
      await this.#publishLock(path, record);
      this.#lock = record;
      this.#startHeartbeat();
      return "acquired";
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw fail("E_CONFIG", "connect", {
          message: `cannot create the lock file ${path}: ${describeError(error)}`,
          hint: `check that ${dirname(path)} is writable; the lock stops two pi sessions from driving the same tab`,
        });
      }
    }

    // The file exists. Read it before deciding: a lock we wrote ourselves must
    // be reusable, a live foreign holder is E_BUSY, anything else is stale.
    const holder = await this.#readLock(path);
    if (holder === undefined) return "reclaim"; // disappeared between the two calls

    if (holder.kind === "corrupt") {
      this.#warn("lock_corrupt", `unparsable lock file at ${path}; reclaiming it (a corrupt lock must not brick the extension)`);
      await this.#unlinkQuietly(path);
      return "reclaim";
    }

    const current = holder.record;
    if (current.sessionId === this.#sessionId) {
      // Same logical session (a second connector for the same run): keep the
      // file, take ownership of the pid/heartbeat, and refresh it immediately.
      this.#lock = { ...current, pid: process.pid, heartbeatAt: this.#clock.now() };
      await this.#writeLock();
      this.#startHeartbeat();
      return "acquired";
    }

    const alive = pidAlive(current.pid);
    const age = this.#clock.now() - current.heartbeatAt;
    const fresh = age <= this.#staleMs;
    if (alive && fresh) {
      throw fail("E_BUSY", "connect", {
        message: `another pi session holds ${path} (pid ${current.pid}, heartbeat ${Math.max(0, age)}ms old)`,
        hint:
          `pid ${current.pid} is still alive and its heartbeat is fresh; close that session or wait ` +
          `until ${path} is older than ${this.#staleMs}ms, then retry`,
      });
    }

    this.#warn(
      "lock_reclaim",
      `reclaiming stale lock at ${path} (pid ${current.pid}, heartbeat ${Math.max(0, age)}ms old)`,
    );
    await this.#unlinkQuietly(path);
    return "reclaim";
  }

  /**
   * Publish a lock that is already complete. `link(2)` is the commit point: it
   * fails with EEXIST when another connector won, and — unlike `open("wx")`
   * followed by a write — it can never expose an empty file to the loser, which
   * would parse as corrupt and get reclaimed while the winner still holds it.
   * The temporary file is always removed, on every path.
   */
  async #publishLock(path: string, record: LockRecord): Promise<void> {
    const tmp = `${path}.tmp-${this.#sessionId}-${randomUUID()}`;
    let handle: FileHandle;
    try {
      handle = await open(tmp, "wx", LOCK_MODE);
    } catch (error) {
      throw fail("E_CONFIG", "connect", {
        message: `cannot create the lock temporary file ${tmp}: ${describeError(error)}`,
        hint: `check that ${dirname(path)} is writable and not full; the lock stops two pi sessions from driving the same tab`,
      });
    }

    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      // fsync before link: the linked file must be readable as-is by the loser,
      // even if the machine loses power right after the link succeeds.
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await chmod(tmp, LOCK_MODE);
      await link(tmp, path);
    } finally {
      await this.#unlinkQuietly(tmp);
    }
  }

  async #releaseLock(): Promise<void> {
    this.#stopHeartbeat();
    const record = this.#lock;
    this.#lock = undefined;
    if (record === undefined) return;

    const current = await this.#readLock(this.#lockPath);
    if (current === undefined) return; // already gone (e.g. `doctor --fix` cleared it)
    if (current.kind === "corrupt") {
      this.#warn("lock_release_skipped", `lock file at ${this.#lockPath} is unreadable; leaving it in place`);
      return;
    }
    // A doctor or a human may have taken the lock over; deleting it would break
    // their session. Only the session that wrote it may remove it.
    if (current.record.sessionId !== this.#sessionId) {
      this.#warn(
        "lock_release_skipped",
        `lock file at ${this.#lockPath} belongs to session ${current.record.sessionId}; not removing it`,
      );
      return;
    }

    try {
      await unlink(this.#lockPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) this.#warn("lock_release_failed", describeError(error));
    }
  }

  async #readLock(path: string): Promise<LockRead | undefined> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      // An unreadable lock (EACCES on a shared box) is treated as corrupt so the
      // reclaim path can report it instead of failing with a bare errno.
      return { kind: "corrupt" };
    }
    const record = parseLockRecord(text);
    return record === null ? { kind: "corrupt" } : { kind: "ok", record };
  }

  async #writeLock(): Promise<void> {
    const record = this.#lock;
    if (record === undefined) return;
    // Atomic replace: a reader never sees a half-written JSON document, and the
    // rename keeps the owner-only mode of the temporary file.
    const tmp = `${this.#lockPath}.${process.pid}.${this.#sessionId}.tmp`;
    await writeFile(tmp, JSON.stringify(record), "utf8");
    await chmod(tmp, LOCK_MODE);
    await rename(tmp, this.#lockPath);
  }

  async #unlinkQuietly(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) this.#warn("lock_unlink_failed", describeError(error));
    }
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    const timer = setInterval(() => {
      void this.#heartbeatTick();
    }, this.#heartbeatMs);
    // Unref: a forgotten connector must not keep the pi process alive.
    timer.unref();
    this.#heartbeat = timer;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat === undefined) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  async #heartbeatTick(): Promise<void> {
    if (this.#heartbeatBusy) return;
    const record = this.#lock;
    if (record === undefined) {
      this.#stopHeartbeat();
      return;
    }
    this.#heartbeatBusy = true;
    record.heartbeatAt = this.#clock.now();

    try {
      const current = await this.#readLock(this.#lockPath);
      // Somebody removed or replaced the lock: stop beating instead of
      // recreating a lock we no longer own.
      if (current === undefined) {
        this.#stopHeartbeat();
        return;
      }
      if (current.kind === "corrupt" || current.record.sessionId !== record.sessionId) {
        this.#stopHeartbeat();
        return;
      }
      await this.#writeLock();
    } catch (error) {
      this.#warn("lock_heartbeat_failed", describeError(error));
    } finally {
      this.#heartbeatBusy = false;
    }
  }

  // --- owned window and tabs ----------------------------------------------

  async #ensureBootstrap(session: CdpSession): Promise<void> {
    const bootstrap = this.#bootstrap;
    if (bootstrap !== undefined && (await this.#targetExists(session, bootstrap.targetId))) return;

    if (bootstrap !== undefined) {
      this.#owned.delete(bootstrap.targetId);
      this.#warn("bootstrap_lost", `the anchor tab ${bootstrap.targetId} is gone; creating a new window`);
    }

    const targetId = await session.createTarget(BLANK_PAGE, { newWindow: true });
    this.#owned.add(targetId);
    await session.attach(targetId);
    const page = createCdpPage(session, targetId, { clock: this.#clock, initialUrl: BLANK_PAGE });
    this.#bootstrap = { targetId, engine: null, page };

    const windowId = await this.#windowForTarget(session, targetId);
    if (windowId !== null) this.#windowId = windowId;
  }

  /**
   * Create the engine tab, attach it before the page object exists, and repair
   * the placement if Chrome put it in a foreign window.
   */
  async #createWorkTarget(session: CdpSession): Promise<{ targetId: string; page: CdpPage }> {
    let targetId: string;
    // A `newWindow: true` tab already defines its own window: checking it
    // against the previous anchor would be wrong, and the anchor must follow it.
    let dedicated = false;
    try {
      targetId = await session.createTarget(BLANK_PAGE, { newWindow: false });
    } catch (error) {
      // No focused window to inherit (all windows minimised/closed): a dedicated
      // window is the only way forward, and it is honest to flag the degradation.
      this.#warn("tab_placement_failed", `could not create a tab in the owned window: ${describeError(error)}`);
      targetId = await session.createTarget(BLANK_PAGE, { newWindow: true });
      dedicated = true;
      this.#windowDegraded = true;
    }

    if (!dedicated) {
      const placedIn = await this.#windowForTarget(session, targetId);
      if (this.#windowId !== null && placedIn !== null && placedIn !== this.#windowId) {
        this.#warn(
          "tab_foreign_window",
          `new tab landed in window ${placedIn}, not the owned window ${this.#windowId}; forcing a dedicated window`,
        );
        // We created this target, so closing it is allowed; the user's window and
        // its tabs are untouched.
        await this.#closeTargetQuietly(session, targetId);
        this.#owned.delete(targetId);
        targetId = await session.createTarget(BLANK_PAGE, { newWindow: true });
        dedicated = true;
        this.#windowDegraded = true;
      }
    }

    if (dedicated) {
      // Chrome may hand back a window id we have not seen (the user's window was
      // last focused). Re-anchoring to it is what keeps the *next* engine tab in
      // the dedicated window instead of judging it foreign again.
      const windowId = await this.#windowForTarget(session, targetId);
      if (windowId !== null) this.#windowId = windowId;
    }

    this.#owned.add(targetId);
    // Attach BEFORE building the page: `createCdpPage` binds every later command
    // to the flattened session id and must never observe a bare target.
    await session.attach(targetId);
    const page = createCdpPage(session, targetId, { clock: this.#clock, initialUrl: BLANK_PAGE });
    return { targetId, page };
  }

  async #targetExists(session: CdpSession, targetId: string): Promise<boolean> {
    const targets = await session.targets();
    return targets.some((target) => target.id === targetId);
  }

  async #windowForTarget(session: CdpSession, targetId: string): Promise<number | null> {
    try {
      const result = await session.send<Record<string, unknown>>("Browser.getWindowForTarget", { targetId });
      const windowId = isRecord(result) ? result.windowId : undefined;
      return typeof windowId === "number" && Number.isFinite(windowId) ? windowId : null;
    } catch (error) {
      // The doctor must still work when the compositor cannot answer: an unknown
      // window id disables placement checks, it does not fail the search.
      this.#warn("window_lookup_failed", describeError(error));
      return null;
    }
  }

  async #bringWindowToFront(): Promise<void> {
    const bootstrap = this.#bootstrap;
    if (bootstrap === undefined) return;
    await bootstrap.page.bringToFront();
  }

  #wantsFocus(engine: EngineId): boolean {
    const policy: FocusPolicy = this.#config.window.focus;
    if (policy === "always") return true;
    if (policy === "session") return !this.#focusedOnce.has(engine);
    return false;
  }

  async #applyFocus(engine: EngineId, page: CdpPage): Promise<void> {
    if (!this.#wantsFocus(engine)) return;
    await page.bringToFront();
    this.#focusedOnce.add(engine);
  }

  async #closeTargetQuietly(session: CdpSession, targetId: string): Promise<void> {
    try {
      await session.closeTarget(targetId);
    } catch (error) {
      // Closing an id we created but Chrome already dropped is normal during
      // teardown; the log is the record, the release must still finish.
      this.#warn("target_close_failed", `could not close owned target ${targetId}: ${describeError(error)}`);
    }
  }

  // --- state ---------------------------------------------------------------

  #connection(): CdpConnectionInfo {
    const state = this.#state;
    if (state === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "the connector is not connected",
        hint: "call connect() (or run /web-doctor) before using the browser",
      });
    }
    return { endpoint: state.endpoint, browser: state.browser, webdriver: state.webdriver };
  }

  #ownedList(): Array<{ targetId: string; engine: EngineId | null; url: string }> {
    const list: Array<{ targetId: string; engine: EngineId | null; url: string }> = [];
    const bootstrap = this.#bootstrap;
    if (bootstrap !== undefined && this.#owned.has(bootstrap.targetId)) {
      list.push({ targetId: bootstrap.targetId, engine: null, url: bootstrap.page.url() });
    }
    for (const owned of this.#enginePages.values()) {
      if (!this.#owned.has(owned.targetId)) continue;
      list.push({ targetId: owned.targetId, engine: owned.engine, url: owned.page.url() });
    }
    return list;
  }

  /**
   * The socket died past its single reconnect, so every flattened session and
   * the owned-window anchor are worthless. Drop that state, return the ids of
   * the tabs we created (they are still in the browser and must be closed
   * through the next session), and keep the lock: this process still holds it.
   */
  async #dropDeadSession(): Promise<string[]> {
    const session = this.#session;
    const orphans: string[] = [];
    for (const owned of this.#enginePages.values()) orphans.push(owned.targetId);
    const bootstrap = this.#bootstrap;
    if (bootstrap !== undefined) orphans.push(bootstrap.targetId);

    this.#owned.clear();
    this.#enginePages.clear();
    this.#bootstrap = undefined;
    this.#focusedOnce.clear();
    this.#session = undefined;
    this.#state = undefined;
    this.#windowId = null;
    this.#windowDegraded = false;

    if (session !== undefined) {
      try {
        await session.close();
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
    const session = this.#session;
    const targets = [...this.#owned];
    if (session !== undefined) {
      for (const targetId of targets) await this.#closeTargetQuietly(session, targetId);
      try {
        await session.close();
      } catch (error) {
        this.#warn("session_close_failed", describeError(error));
      }
    }

    this.#owned.clear();
    this.#enginePages.clear();
    this.#bootstrap = undefined;
    this.#focusedOnce.clear();
    this.#session = undefined;
    this.#state = undefined;
    this.#windowId = null;
    this.#windowDegraded = false;

    // A failed connect must not leave a lock that blocks every later attempt.
    await this.#releaseLock();
  }

  #warn(event: string, detail: string): void {
    void this.#log
      .write({ ts: new Date(this.#clock.now()).toISOString(), level: "warn", event, message: detail })
      .catch(() => undefined);
  }
}

export function createConnector(options: ConnectorOptions): Connector {
  return new BrowserConnector(options);
}
