/**
 * P1-D: connector behaviour against an in-memory fake session.
 *
 * No sockets, no browser, no wall-clock waits. The fake records the exact CDP
 * calls the connector makes — `createTarget` flags, attaches, closes, focus —
 * which is precisely what the lock/window/tab rules are about.
 *
 *   node --test tests/unit/browser.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test, type TestContext } from "node:test";

import { createConnector, defaultLockPath } from "../../src/cdp/browser.ts";
import type { ConnectorInfo, ConnectorOptions } from "../../src/cdp/browser.ts";
import type { CdpSession } from "../../src/cdp/session.ts";
import type { BrowserInfo, CdpEndpoint, CdpTarget } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import type { Config, FocusPolicy } from "../../src/config.ts";
import type { EngineId } from "../../src/engines/types.ts";
import { isWebSearchError, WebSearchError } from "../../src/runtime/error-codes.ts";
import { fail } from "../../src/runtime/errors.ts";
import type { Clock, Logger } from "../../src/runtime/types.ts";
import { FakeClock } from "../helpers/clock.ts";

// ---------------------------------------------------------------------------
// Fake session (implements the CdpSession surface the connector uses)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  targetId?: string;
  sessionId?: string;
  newWindow?: boolean;
}

interface FakeTarget {
  url: string;
  windowId: number;
}

class FakeSession {
  readonly clock: Clock;
  readonly label: string;
  readonly wsUrl = "ws://127.0.0.1:9222/devtools/browser/fake";
  readonly calls: RecordedCall[] = [];
  readonly closed: string[] = [];
  /** Target ids whose page issued `Page.bringToFront`, in order. */
  readonly focused: string[] = [];
  readonly targetsById = new Map<string, FakeTarget>();
  readonly sessionByTarget = new Map<string, string>();
  readonly expressions: string[] = [];
  /** Targets whose `Page.bringToFront` rejects, as a dead tab would. */
  readonly focusFailures = new Set<string>();

  webdriver = false;
  closeCount = 0;
  /** `newWindow: false` throws, as Chrome does when no window can inherit a tab. */
  refuseTabCreation = false;
  /** Window a `newWindow: false` tab lands in; `null` = the window our last one opened. */
  placementWindow: number | null = null;

  #connected = true;
  #nextTarget = 1;
  #nextWindow = 10;
  #nextSession = 1;
  #ownedWindow = 10;

  constructor(clock: Clock, label = "") {
    this.clock = clock;
    this.label = label;
  }

  addUserTarget(id: string, url: string, windowId = 1): void {
    this.targetsById.set(id, { url, windowId });
  }

  async version(): Promise<BrowserInfo> {
    return {
      product: "Chrome/157.0.8103.38",
      protocolVersion: "1.3",
      userAgent: "Mozilla/5.0 Chrome/157.0.8103.38",
      revision: "@fake",
      jsVersion: "13.0",
    };
  }

  async targets(): Promise<CdpTarget[]> {
    return [...this.targetsById.entries()].map(([id, target]) => ({
      id,
      type: "page",
      title: "",
      url: target.url,
      ...(this.sessionByTarget.has(id) ? { attached: true } : {}),
    }));
  }

  async attach(targetId: string): Promise<{ targetId: string; sessionId: string }> {
    if (!this.targetsById.has(targetId)) {
      throw fail("E_TARGET_LOST", "connect", { message: `no target ${targetId}` });
    }
    const sessionId = `session-${this.#nextSession++}`;
    this.sessionByTarget.set(targetId, sessionId);
    this.calls.push({ method: "attach", targetId, sessionId });
    return { targetId, sessionId };
  }

  async createTarget(url: string, opts: { newWindow?: boolean } = {}): Promise<string> {
    if (this.refuseTabCreation && opts.newWindow !== true) {
      throw fail("E_CDP_UNAVAILABLE", "connect", { message: "no window can inherit a tab" });
    }
    const targetId = `owned-${this.label}${this.#nextTarget++}`;
    let windowId: number;
    if (opts.newWindow === true) {
      windowId = this.#nextWindow++;
      this.#ownedWindow = windowId;
    } else {
      windowId = this.placementWindow ?? this.#ownedWindow;
    }
    this.targetsById.set(targetId, { url, windowId });
    this.calls.push({ method: "createTarget", targetId, newWindow: opts.newWindow === true });
    return targetId;
  }

  async closeTarget(targetId: string): Promise<void> {
    if (!this.targetsById.has(targetId)) {
      throw fail("E_TARGET_LOST", "navigate", { message: `no target ${targetId}` });
    }
    this.closed.push(targetId);
    this.targetsById.delete(targetId);
    this.sessionByTarget.delete(targetId);
    this.calls.push({ method: "closeTarget", targetId });
  }

  sessionIdFor(targetId: string): string | undefined {
    return this.sessionByTarget.get(targetId);
  }

  isConnected(): boolean {
    return this.#connected;
  }

  /** The socket died without a closed tab: state is lost, the targets are not. */
  crash(): void {
    this.#connected = false;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.#connected = false;
    this.calls.push({ method: "close" });
  }

  on(_method: string, _handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
    return () => undefined;
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const targetId = sessionId === undefined ? undefined : this.#targetForSession(sessionId);
    this.calls.push({
      method,
      ...(targetId === undefined ? {} : { targetId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    switch (method) {
      case "Browser.getWindowForTarget": {
        const id = typeof params.targetId === "string" ? params.targetId : "";
        return { windowId: this.#windowOf(id) } as T;
      }
      case "Runtime.evaluate": {
        const expression = typeof params.expression === "string" ? params.expression : "";
        this.expressions.push(expression);
        if (expression === "navigator.webdriver") {
          return { result: { type: "boolean", value: this.webdriver } } as T;
        }
        return { result: { type: "number", value: 1 } } as T;
      }
      case "Page.bringToFront": {
        if (targetId === undefined && sessionId !== undefined) {
          throw fail("E_TARGET_LOST", "render", { message: "the target is gone" });
        }
        if (targetId !== undefined && this.focusFailures.has(targetId)) {
          throw fail("E_TARGET_LOST", "render", { message: `target ${targetId} refused to focus` });
        }
        if (targetId !== undefined) this.focused.push(targetId);
        return {} as T;
      }
      default:
        return {} as T;
    }
  }

  #windowOf(targetId: string): number {
    const target = this.targetsById.get(targetId);
    if (target === undefined) throw fail("E_TARGET_LOST", "connect", { message: `no target ${targetId}` });
    return target.windowId;
  }

  #targetForSession(sessionId: string): string | undefined {
    for (const [targetId, attached] of this.sessionByTarget) {
      if (attached === sessionId) return targetId;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const ENDPOINT: CdpEndpoint = {
  port: 9222,
  wsUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
  source: "devtools-active-port",
};

const tempDirs: string[] = [];

function tempLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-chrome-lock-"));
  tempDirs.push(dir);
  return join(dir, "web-search.lock");
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function testConfig(focus: FocusPolicy = "session"): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.window.focus = focus;
  return config;
}

interface Rig {
  connector: ReturnType<typeof createConnector>;
  session: FakeSession;
  rows: Array<Record<string, unknown>>;
  lockPath: string;
  clock: FakeClock;
}

interface RigOptions {
  focus?: FocusPolicy;
  session?: FakeSession;
  /** Sessions handed out in order, one per `connectSession` call (the last repeats). */
  sessions?: FakeSession[];
  clock?: FakeClock;
  lockPath?: string;
  heartbeatMs?: number;
  sessionId?: string;
  discover?: () => Promise<CdpEndpoint>;
  /** Override the session factory entirely (P11 wait tests throw from here). */
  connectSession?: () => Promise<CdpSession>;
  /** P11: `cdp.attachWaitMs` for this connector. */
  attachWaitMs?: number;
  onAwaitingAllow?: ConnectorOptions["onAwaitingAllow"];
}

function rig(t: TestContext, options: RigOptions = {}): Rig {
  const clock = options.clock ?? new FakeClock();
  const session = options.session ?? new FakeSession(clock);
  const rows: Array<Record<string, unknown>> = [];
  const log: Logger = {
    async write(row: Record<string, unknown>): Promise<void> {
      rows.push(row);
    },
    path: () => "/dev/null",
  };
  const lockPath = options.lockPath ?? tempLockPath();

  let sessionIndex = 0;
  const nextSession = (): FakeSession => {
    const list = options.sessions;
    if (list === undefined || list.length === 0) return session;
    const picked = list[Math.min(sessionIndex, list.length - 1)];
    sessionIndex += 1;
    return picked;
  };

  const config = testConfig(options.focus);
  if (options.attachWaitMs !== undefined) config.cdp.attachWaitMs = options.attachWaitMs;
  const connectorOptions: ConnectorOptions = {
    config,
    discover: options.discover ?? (async () => ENDPOINT),
    // The fake implements the used surface; the double assertion keeps `any`
    // out of the test while the connector still receives the real type.
    connectSession:
      options.connectSession ?? (async () => nextSession() as unknown as CdpSession),
    clock,
    log,
    lockPath,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.onAwaitingAllow === undefined ? {} : { onAwaitingAllow: options.onAwaitingAllow }),
  };

  const connector = createConnector(connectorOptions);
  t.after(async () => {
    await connector.releaseAll();
  });
  return { connector, session, rows, lockPath, clock };
}

async function rejectsWithCode(task: Promise<unknown>, code: string): Promise<WebSearchError> {
  let caught: unknown;
  try {
    await task;
  } catch (error) {
    caught = error;
  }
  assert.ok(isWebSearchError(caught), `expected WebSearchError, got ${String(caught)}`);
  assert.equal(caught.details.code, code);
  assert.ok(caught.details.hint.length > 0, "every failure must carry a hint");
  return caught;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeLock(path: string, record: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
}

function createTargets(session: FakeSession): RecordedCall[] {
  return session.calls.filter((call) => call.method === "createTarget");
}

function requireInfo(connector: ReturnType<typeof createConnector>): ConnectorInfo {
  const info = connector.info();
  if (info === null) assert.fail("connector must expose info after connect");
  return info;
}

function engineTarget(connector: ReturnType<typeof createConnector>, engine: EngineId): string {
  const owned = requireInfo(connector).ownedTargets.find((target) => target.engine === engine);
  if (owned === undefined) assert.fail(`no owned target for ${engine}`);
  return owned.targetId;
}

function bootstrapTarget(connector: ReturnType<typeof createConnector>): string {
  const owned = requireInfo(connector).ownedTargets.find((target) => target.engine === null);
  if (owned === undefined) assert.fail("bootstrap anchor must be owned");
  return owned.targetId;
}

function focusCount(session: FakeSession, targetId: string): number {
  return session.focused.filter((id) => id === targetId).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

test("connect creates the lock, exactly one dedicated window and honest info", async (t) => {
  const { connector, session, lockPath } = rig(t);

  const connection = await connector.connect();
  assert.equal(connection.webdriver, false);
  assert.equal(connection.endpoint.wsUrl, ENDPOINT.wsUrl);
  assert.equal(connection.browser.product, "Chrome/157.0.8103.38");

  const created = createTargets(session);
  assert.equal(created.length, 1, "connect must create exactly one window");
  assert.equal(created[0].newWindow, true);
  const bootstrapId = created[0].targetId;
  assert.ok(bootstrapId);
  assert.equal(session.targetsById.get(bootstrapId)?.url, "about:blank");

  assert.equal(statSync(lockPath).mode & 0o777, 0o600);
  const lock = readJson(lockPath);
  assert.equal(lock.version, 1);
  assert.equal(lock.pid, process.pid);
  assert.equal(typeof lock.sessionId, "string");
  assert.equal(typeof lock.startedAt, "number");
  assert.equal(typeof lock.heartbeatAt, "number");

  assert.ok(session.expressions.includes("navigator.webdriver"));

  const info = requireInfo(connector);
  assert.equal(info.locked, true);
  assert.equal(info.windowId, 10);
  assert.equal(info.windowDegraded, false);
  assert.deepEqual(info.focusedOnce, []);
  assert.equal(info.ownedTargets.length, 1);
  assert.deepEqual(info.ownedTargets[0], {
    targetId: bootstrapId,
    engine: null,
    url: "about:blank",
  });
  assert.deepEqual(connector.ownedTargets(), [bootstrapId]);
  assert.equal(connector.lockPath(), lockPath);
  assert.equal(connector.endpoint(), ENDPOINT);
  assert.equal(connector.isConnected(), true);
});

test("connect is idempotent: a second call returns the stored info", async (t) => {
  const { connector, session } = rig(t);

  const first = await connector.connect();
  const second = await connector.connect();

  assert.deepEqual(first, second);
  assert.equal(createTargets(session).length, 1);
  assert.equal(session.calls.filter((call) => call.method === "attach").length, 1);
});

test("two concurrent connect() calls share one attempt and one window", async (t) => {
  const { connector, session, lockPath } = rig(t);

  const [first, second] = await Promise.all([connector.connect(), connector.connect()]);

  assert.deepEqual(first, second);
  assert.equal(createTargets(session).length, 1, "a racing pair must not open two bootstrap windows");
  assert.equal(createTargets(session)[0].newWindow, true);
  assert.equal(session.calls.filter((call) => call.method === "attach").length, 1);
  assert.equal(typeof readJson(lockPath).sessionId, "string");
});

test("connect after the socket died rediscovers and drops the stale state", async (t) => {
  const clock = new FakeClock();
  const first = new FakeSession(clock);
  const second = new FakeSession(clock, "b");
  let discoveries = 0;
  const { connector, rows } = rig(t, {
    clock,
    sessions: [first, second],
    discover: async () => {
      discoveries += 1;
      return ENDPOINT;
    },
  });

  await connector.connect();
  await connector.acquirePage("google");
  const oldBootstrap = bootstrapTarget(connector);
  const oldGoogle = engineTarget(connector, "google");

  // Same browser process: the tabs survived, the socket and every flattened
  // session did not. Closing targets through the new session is the only way
  // to clean up waits that a dead socket cannot perform.
  second.addUserTarget("user-1", "https://example.com/", 1);
  for (const [targetId, target] of first.targetsById) {
    second.addUserTarget(targetId, target.url, target.windowId);
  }
  first.crash();
  assert.equal(connector.isConnected(), false, "a dead socket must be visible to the caller");

  const connection = await connector.connect();
  assert.equal(connection.endpoint.wsUrl, ENDPOINT.wsUrl);
  assert.equal(discoveries, 2, "a dead session must be discovered again, not reused");
  assert.equal(first.closeCount, 1, "the dead session must be closed");
  assert.deepEqual(
    [...second.closed].sort(),
    [oldBootstrap, oldGoogle].sort(),
    "our old tabs are closed through the new session",
  );
  assert.ok(!second.closed.includes("user-1"), "a foreign tab must never be closed");
  assert.ok(rows.some((row) => row.event === "cdp_stale_session"));

  const info = requireInfo(connector);
  assert.equal(info.ownedTargets.length, 1, "only the new bootstrap anchor is owned");
  assert.notEqual(info.ownedTargets[0]?.targetId, oldBootstrap);
  assert.deepEqual(connector.ownedTargets(), [info.ownedTargets[0]?.targetId]);

  // The replacement work tab behaves like any other acquire after a restart.
  await connector.acquirePage("google");
  assert.notEqual(engineTarget(connector, "google"), oldGoogle);
});

test("webdriver true fails with an actionable hint and leaves no lock or tab behind", async (t) => {
  const { connector, session, lockPath, rows } = rig(t);
  session.webdriver = true;

  const error = await rejectsWithCode(connector.connect(), "E_CDP_UNAVAILABLE");
  assert.match(error.details.hint, /normal profile/);
  assert.match(error.details.hint, /never starts a browser/);
  assert.equal(connector.info(), null);
  assert.equal(existsSync(lockPath), false);
  assert.equal(session.closed.length, 1, "the bootstrap tab must be closed on failure");
  assert.equal(session.closeCount, 1);
  assert.ok(rows.length === 0, "a webdriver rejection is reported, not logged as a warning");
});

test("a failed discovery releases the lock instead of bricking the next attempt", async (t) => {
  const lockPath = tempLockPath();
  const { connector } = rig(t, {
    lockPath,
    discover: async () => {
      throw new WebSearchError({
        code: "E_CDP_UNAVAILABLE",
        stage: "discover",
        retryable: false,
        hint: "open chrome://inspect and Allow",
        message: "no endpoint",
      });
    },
  });

  await rejectsWithCode(connector.connect(), "E_CDP_UNAVAILABLE");
  assert.equal(existsSync(lockPath), false);
  assert.equal(connector.info(), null);
});

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

test("a second connector sees E_BUSY naming the path and pid", async (t) => {
  const lockPath = tempLockPath();
  const first = rig(t, { lockPath });
  await first.connector.connect();

  const second = rig(t, { lockPath });
  const error = await rejectsWithCode(second.connector.connect(), "E_BUSY");
  assert.ok(error.details.hint.includes(lockPath), `hint must name ${lockPath}`);
  assert.ok(error.details.hint.includes(String(process.pid)), "hint must name the holder pid");
  assert.equal(second.session.calls.length, 0, "E_BUSY must be decided before touching CDP");

  // The first holder's file is untouched.
  assert.equal(readJson(lockPath).pid, process.pid);
  assert.equal(first.connector.info()?.locked, true);
});

test("two connectors racing for the lock: one wins, the file is never empty", async (t) => {
  const lockPath = tempLockPath();
  const a = rig(t, { lockPath, sessionId: "racer-a" });
  const b = rig(t, { lockPath, sessionId: "racer-b" });

  // Both reach the commit point together: `link(2)` decides, atomically.
  const [resultA, resultB] = await Promise.allSettled([
    a.connector.connect(),
    b.connector.connect(),
  ]);

  const winner = resultA.status === "fulfilled" ? a : b;
  const loser = resultA.status === "fulfilled" ? b : a;
  assert.equal(
    [resultA, resultB].filter((result) => result.status === "fulfilled").length,
    1,
    "exactly one connector may acquire the lock",
  );

  if (loser === b) {
    assert.equal(resultB.status, "rejected");
    const reason = (resultB as PromiseRejectedResult).reason;
    assert.ok(isWebSearchError(reason), `expected WebSearchError, got ${String(reason)}`);
    assert.equal(reason.details.code, "E_BUSY");
    assert.ok(reason.details.hint.includes(lockPath));
  } else {
    assert.equal(resultA.status, "rejected");
    const reason = (resultA as PromiseRejectedResult).reason;
    assert.ok(isWebSearchError(reason), `expected WebSearchError, got ${String(reason)}`);
    assert.equal(reason.details.code, "E_BUSY");
  }

  assert.equal(loser.session.calls.length, 0, "the loser must not touch CDP");
  assert.equal(createTargets(winner.session).length, 1, "the winner opens exactly one window");
  assert.equal(loser.connector.info(), null);

  const lock = readJson(lockPath);
  assert.equal(lock.sessionId, winner === a ? "racer-a" : "racer-b");
  assert.equal(lock.pid, process.pid);
  assert.equal(statSync(lockPath).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(dirname(lockPath)).filter((name) => name.includes(".tmp-")),
    [],
    "a failed link must not leave its temporary file behind",
  );
});

test("a zero-byte lock left by a crash is stale, not a permanent blocker", async (t) => {
  const lockPath = tempLockPath();
  // The exact shape of a crash between create and write in the old code.
  writeFileSync(lockPath, "", { mode: 0o600 });

  const { connector, rows } = rig(t, { lockPath });
  await connector.connect();

  assert.equal(readJson(lockPath).pid, process.pid);
  assert.ok(
    rows.some((row) => row.event === "lock_corrupt"),
    "an empty lock must be reported and reclaimed, not treated as held",
  );
  assert.equal(connector.info()?.locked, true);
});

test("a dead pid is reclaimed even with a fresh heartbeat", async (t) => {
  const lockPath = tempLockPath();
  const now = Date.UTC(2026, 0, 1);
  writeLock(lockPath, {
    version: 1,
    pid: 999_999,
    sessionId: "ghost-session",
    startedAt: now,
    heartbeatAt: now,
  });

  const { connector, rows } = rig(t, { lockPath, clock: new FakeClock({ now }) });
  await connector.connect();

  assert.equal(readJson(lockPath).pid, process.pid);
  assert.notEqual(readJson(lockPath).sessionId, "ghost-session");
  assert.ok(
    rows.some((row) => row.event === "lock_reclaim"),
    "reclaiming a stale lock must be logged",
  );
});

test("a live pid with an expired heartbeat is reclaimed", async (t) => {
  const lockPath = tempLockPath();
  const now = Date.UTC(2026, 0, 1);
  writeLock(lockPath, {
    version: 1,
    pid: process.pid,
    sessionId: "old-session",
    startedAt: now - 120_000,
    heartbeatAt: now - 120_000,
  });

  const { connector } = rig(t, { lockPath, clock: new FakeClock({ now }) });
  await connector.connect();

  assert.notEqual(readJson(lockPath).sessionId, "old-session");
});

test("a live pid with a fresh heartbeat is E_BUSY", async (t) => {
  const lockPath = tempLockPath();
  const now = Date.UTC(2026, 0, 1);
  writeLock(lockPath, {
    version: 1,
    pid: process.pid,
    sessionId: "live-session",
    startedAt: now,
    heartbeatAt: now,
  });

  const { connector } = rig(t, { lockPath, clock: new FakeClock({ now }) });
  const error = await rejectsWithCode(connector.connect(), "E_BUSY");
  assert.ok(error.details.hint.includes(String(process.pid)));
  assert.equal(readJson(lockPath).sessionId, "live-session");
});

test("a corrupt lock is reclaimed with a warning", async (t) => {
  const lockPath = tempLockPath();
  writeFileSync(lockPath, '{ "version": 1, not json', { mode: 0o600 });

  const { connector, rows } = rig(t, { lockPath });
  await connector.connect();

  assert.ok(
    rows.some((row) => row.level === "warn" && row.event === "lock_corrupt"),
    "a corrupt lock must be logged before reclaiming",
  );
  assert.equal(readJson(lockPath).pid, process.pid);
});

test("release removes the lock only when the session id matches", async (t) => {
  const lockPath = tempLockPath();
  const own = rig(t, { lockPath });
  await own.connector.connect();
  await own.connector.releaseAll();
  assert.equal(existsSync(lockPath), false);

  // A doctor/--fix or a human may replace the lock; deleting it would break them.
  const foreign = rig(t, { lockPath });
  await foreign.connector.connect();
  writeLock(lockPath, {
    version: 1,
    pid: 4242,
    sessionId: "someone-else",
    startedAt: 0,
    heartbeatAt: 0,
  });
  await foreign.connector.releaseAll();
  assert.equal(existsSync(lockPath), true);
  rmSync(lockPath, { force: true });
});

test("the heartbeat refreshes heartbeatAt without changing startedAt", async (t) => {
  const clock = new FakeClock({ now: Date.UTC(2026, 0, 1) });
  const { connector, lockPath } = rig(t, { clock, heartbeatMs: 1 });
  await connector.connect();

  const before = readJson(lockPath);
  assert.equal(before.startedAt, clock.now());

  await waitFor(() => {
    clock.advance(1);
    return Number(readJson(lockPath).heartbeatAt) > Number(before.heartbeatAt);
  });

  const after = readJson(lockPath);
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(statSync(lockPath).mode & 0o777, 0o600, "atomic rewrite keeps the lock 0600");
});

test("locking happens before discovery, and the default path honours the agent dir", async (t) => {
  assert.equal(defaultLockPath({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" }), "/tmp/agent-dir/web-search.lock");
  assert.match(defaultLockPath({}), /\.pi\/agent\/web-search\.lock$/);

  let discoveries = 0;
  const { connector } = rig(t, {
    discover: async () => {
      discoveries += 1;
      return ENDPOINT;
    },
  });
  await connector.connect();
  assert.equal(discoveries, 1, "a successful connect discovers once");
});

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

test("one work tab per engine, reused across acquirePage calls", async (t) => {
  const { connector, session } = rig(t);
  const firstPage = await connector.acquirePage("google");
  const secondPage = await connector.acquirePage("google");

  assert.equal(firstPage, secondPage, "the same engine must reuse its page");
  assert.equal(createTargets(session).length, 2, "bootstrap + one google tab");

  const yandexPage = await connector.acquirePage("yandex");
  assert.notEqual(yandexPage, firstPage);
  assert.equal(createTargets(session).length, 3, "a second engine gets exactly one more tab");

  const info = requireInfo(connector);
  const engines = info.ownedTargets.map((target) => target.engine);
  assert.deepEqual(new Set(engines), new Set<EngineId | null>([null, "google", "yandex"]));
  assert.equal(createTargets(session).filter((call) => call.newWindow === false).length, 2);
});

test("a lost tab is replaced once, without leaking the old record", async (t) => {
  const { connector, session } = rig(t);
  const first = await connector.acquirePage("google");
  const firstId = engineTarget(connector, "google");

  // The user closes the tab: it vanishes from Target.getTargets.
  session.targetsById.delete(firstId);
  session.sessionByTarget.delete(firstId);

  const second = await connector.acquirePage("google");
  assert.notEqual(second, first);
  assert.notEqual(engineTarget(connector, "google"), firstId);
  assert.equal(createTargets(session).length, 3, "bootstrap + lost tab + replacement");
  const info = requireInfo(connector);
  assert.equal(info.ownedTargets.filter((target) => target.engine === "google").length, 1);
});

test("attach happens before the page is handed out", async (t) => {
  const { connector, session } = rig(t);
  const page = await connector.acquirePage("google");
  const targetId = engineTarget(connector, "google");

  const createIndex = session.calls.findIndex(
    (call) => call.method === "createTarget" && call.targetId === targetId,
  );
  const attachIndex = session.calls.findIndex((call) => call.method === "attach" && call.targetId === targetId);
  if (createIndex < 0 || attachIndex < 0) assert.fail("the tab must be created and attached");
  // The tab is created, then attached; only then may any page command run.
  assert.ok(createIndex < attachIndex);

  const firstPageCall = session.calls.findIndex(
    (call) =>
      call.targetId === targetId &&
      call.method !== "createTarget" &&
      call.method !== "attach" &&
      call.method !== "closeTarget",
  );
  assert.ok(firstPageCall > attachIndex, "no page command may run on an unattached target");

  const sessionId = session.sessionIdFor(targetId);
  assert.ok(sessionId);
  await page.evaluate("1 + 1");
  const evaluateCall = session.calls.find(
    (call) => call.method === "Runtime.evaluate" && call.targetId === targetId,
  );
  if (evaluateCall === undefined) assert.fail("evaluate must reach the session");
  assert.equal(evaluateCall.sessionId, sessionId, "the page must run on the session attach allocated");
});

// ---------------------------------------------------------------------------
// window placement
// ---------------------------------------------------------------------------

test("a tab that lands in a foreign window is closed and recreated with newWindow", async (t) => {
  const { connector, session } = rig(t);
  session.addUserTarget("user-1", "https://example.com/", 1);
  // Chrome puts our plain tab in the user's window instead of the owned one.
  session.placementWindow = 99;

  await connector.connect();
  await connector.acquirePage("google");

  const created = createTargets(session);
  assert.equal(created.length, 3, "bootstrap + misplaced tab + forced dedicated tab");
  assert.equal(created[1].newWindow, false);
  assert.equal(created[2].newWindow, true);

  const misplaced = created[1].targetId;
  assert.ok(misplaced);
  assert.ok(session.closed.includes(misplaced), "the misplaced tab is ours, so we close it");
  assert.equal(
    engineTarget(connector, "google"),
    created[2].targetId,
    "the engine page must be the forced dedicated tab",
  );

  const info = requireInfo(connector);
  assert.equal(info.windowDegraded, true);
  const forced = created[2].targetId;
  assert.ok(forced);
  assert.equal(
    info.windowId,
    session.targetsById.get(forced)?.windowId,
    "the forced dedicated window becomes the owned window",
  );
  assert.notEqual(info.windowId, 10, "the bootstrap anchor is no longer the placement reference");
  assert.ok(!session.closed.includes("user-1"), "a foreign target must never be closed");
});

test("one misplacement re-anchors the window: every later engine tab reuses it", async (t) => {
  const { connector, session } = rig(t);
  session.addUserTarget("user-1", "https://example.com/", 1);
  // Chrome puts our first plain tab in the user's window once.
  session.placementWindow = 99;

  await connector.connect();
  await connector.acquirePage("google");
  // After the forced dedicated window, Chrome inherits that window again.
  session.placementWindow = null;
  await connector.acquirePage("yandex");

  const created = createTargets(session);
  assert.deepEqual(
    created.map((call) => call.newWindow),
    [true, false, true, false],
    "bootstrap, the misplaced tab, the forced window and a plain yandex tab",
  );
  const misplaced = created[1].targetId;
  assert.ok(misplaced);
  assert.deepEqual(session.closed, [misplaced], "only the misplaced tab is closed");

  const googleId = engineTarget(connector, "google");
  const yandexId = engineTarget(connector, "yandex");
  const googleWindow = session.targetsById.get(googleId)?.windowId;
  const yandexWindow = session.targetsById.get(yandexId)?.windowId;
  assert.equal(googleWindow, 11, "the forced tab owns window 11");
  assert.equal(yandexWindow, 11, "the second engine stays in the dedicated window");
  assert.equal(
    new Set([googleWindow, yandexWindow]).size,
    1,
    "exactly one dedicated window id is used for every later tab",
  );
  assert.equal(requireInfo(connector).windowId, 11, "info.windowId follows the re-anchored window");
  assert.equal(createTargets(session).filter((call) => call.newWindow === true).length, 2);
  assert.ok(!session.closed.includes("user-1"), "the user's window is never touched");
});

test("a refused plain tab creates the dedicated window once and re-anchors it", async (t) => {
  const { connector, session } = rig(t);
  session.refuseTabCreation = true;

  await connector.connect();
  await connector.acquirePage("google");

  const created = createTargets(session);
  assert.equal(created.length, 2, "bootstrap + the forced work tab, no correction round-trip");
  assert.equal(created[0].newWindow, true);
  assert.equal(created[1].newWindow, true);
  assert.deepEqual(session.closed, [], "a forced tab must not be judged foreign afterwards");

  const info = requireInfo(connector);
  const googleId = engineTarget(connector, "google");
  assert.equal(info.windowId, session.targetsById.get(googleId)?.windowId);
  assert.equal(info.windowDegraded, true);
});

test("a placement that stays in the owned window does not set windowDegraded", async (t) => {
  const { connector, session } = rig(t);
  await connector.connect();
  await connector.acquirePage("google");

  assert.equal(connector.info()?.windowDegraded, false);
  assert.equal(session.closed.length, 0);
});

// ---------------------------------------------------------------------------
// focus policy
// ---------------------------------------------------------------------------

test("focus always brings every acquire forward", async (t) => {
  const { connector, session } = rig(t, { focus: "always" });
  await connector.acquirePage("google");
  await connector.acquirePage("google");
  await connector.acquirePage("yandex");

  const google = engineTarget(connector, "google");
  const yandex = engineTarget(connector, "yandex");
  assert.equal(focusCount(session, google), 2);
  assert.equal(focusCount(session, yandex), 1);
  assert.deepEqual(connector.info()?.focusedOnce, ["google", "yandex"]);
});

test("focus session raises each engine once, then leaves the user alone", async (t) => {
  const { connector, session } = rig(t, { focus: "session" });
  await connector.acquirePage("google");
  await connector.acquirePage("google");
  await connector.acquirePage("yandex");
  await connector.acquirePage("yandex");

  const google = engineTarget(connector, "google");
  const yandex = engineTarget(connector, "yandex");
  assert.equal(focusCount(session, google), 1);
  assert.equal(focusCount(session, yandex), 1);
  assert.deepEqual(connector.info()?.focusedOnce, ["google", "yandex"]);
});

test("focus never touches Page.bringToFront", async (t) => {
  const { connector, session } = rig(t, { focus: "never" });
  await connector.acquirePage("google");
  await connector.acquirePage("yandex");

  assert.equal(session.focused.length, 0);
  assert.deepEqual(connector.info()?.focusedOnce, []);
});

// ---------------------------------------------------------------------------
// focus() command surface
// ---------------------------------------------------------------------------

test("focus() raises the owned engine tabs without creating or navigating", async (t) => {
  const { connector, session } = rig(t);
  await connector.connect();
  await connector.acquirePage("google");
  await connector.acquirePage("yandex");

  const before = createTargets(session).length;
  const info = requireInfo(connector);
  const ownedEngineTargets = info.ownedTargets
    .filter((target) => target.engine !== null)
    .map((target) => target.targetId)
    .sort();

  session.focused.length = 0;
  await connector.focus();

  assert.equal(createTargets(session).length, before, "focus must never create a tab");
  assert.equal(
    session.calls.filter((call) => call.method === "Page.navigate").length,
    0,
    "focus must never navigate",
  );
  assert.deepEqual([...session.focused].sort(), ownedEngineTargets);
  assert.ok(!session.focused.includes(bootstrapTarget(connector)));
  assert.ok(!session.focused.includes("user-1"));
});

test("focus() falls back to the bootstrap anchor when no engine tab exists", async (t) => {
  const { connector, session } = rig(t);
  await connector.connect();
  session.focused.length = 0;

  await connector.focus();
  assert.deepEqual(session.focused, [bootstrapTarget(connector)]);
  assert.equal(createTargets(session).length, 1);
});

test("focus() before connect is E_CDP_DISCONNECTED", async (t) => {
  const { connector } = rig(t);
  const error = await rejectsWithCode(connector.focus(), "E_CDP_DISCONNECTED");
  assert.ok(error.details.hint.includes("/web-doctor"));
});

test("focus() skips a tab that vanished instead of failing", async (t) => {
  const { connector, session } = rig(t);
  await connector.connect();
  await connector.acquirePage("google");
  await connector.acquirePage("yandex");
  const googleId = engineTarget(connector, "google");
  const yandexId = engineTarget(connector, "yandex");

  // The user closed the yandex tab; the connector still has its record.
  session.targetsById.delete(yandexId);
  session.sessionByTarget.delete(yandexId);
  session.focused.length = 0;

  await connector.focus();

  assert.deepEqual(session.focused, [googleId], "only the live engine tab is raised");
  assert.ok(!session.focused.includes(yandexId));
});

test("focus() survives a tab that refuses to come forward", async (t) => {
  const { connector, session, rows } = rig(t);
  await connector.connect();
  await connector.acquirePage("google");
  await connector.acquirePage("yandex");
  const googleId = engineTarget(connector, "google");
  const yandexId = engineTarget(connector, "yandex");

  session.focusFailures.add(googleId);
  session.focused.length = 0;

  await connector.focus();

  assert.deepEqual(session.focused, [yandexId], "one failing page must not stop the next");
  assert.ok(rows.some((row) => row.event === "focus_failed"), "the skipped tab is logged");
});

// ---------------------------------------------------------------------------
// releaseAll
// ---------------------------------------------------------------------------

test("releaseAll closes only owned targets, releases the lock and closes the session", async (t) => {
  const { connector, session, lockPath } = rig(t);
  session.addUserTarget("user-1", "https://example.com/", 1);

  await connector.connect();
  await connector.acquirePage("google");
  const owned = [bootstrapTarget(connector), engineTarget(connector, "google")];

  await connector.releaseAll();

  assert.deepEqual([...session.closed].sort(), [...owned].sort());
  assert.ok(!session.closed.includes("user-1"), "the user's tab must survive");
  assert.equal(session.closeCount, 1);
  assert.equal(session.isConnected(), false);
  assert.equal(existsSync(lockPath), false);
  assert.equal(connector.info(), null);
  assert.equal(connector.isConnected(), false);
  assert.deepEqual(connector.ownedTargets(), []);

  // Idempotent: a second call is a no-op, not a second close.
  await connector.releaseAll();
  assert.equal(session.closeCount, 1);
  assert.equal(session.closed.length, owned.length);
});

test("releaseAll before connect is a no-op", async (t) => {
  const { connector, session } = rig(t);
  await connector.releaseAll();
  assert.equal(session.closeCount, 0);
});

// ---------------------------------------------------------------------------
// static guarantees
// ---------------------------------------------------------------------------

test("browser.ts never signals a process and never uses any", () => {
  const source = readFileSync(new URL("../../src/cdp/browser.ts", import.meta.url), "utf8");
  assert.ok(!/process\s*\.\s*kill/.test(source), "AGENTS R3: never signal the user's Chrome");
  assert.ok(!/\bas\s+any\b|:\s*any\b|<any>|\bany\[\]/.test(source), "no `any` in production code");
  assert.ok(!/page\s*\.\s*navigate/.test(source), "the connector owns tabs, adapters own navigation");
});

test("ConnectorInfo is what the doctor reads", () => {
  const fields: Array<keyof ConnectorInfo> = [
    "endpoint",
    "browser",
    "webdriver",
    "windowId",
    "ownedTargets",
    "focusedOnce",
    "windowDegraded",
    "locked",
  ];
  assert.equal(fields.length, 8);
});

// ---------------------------------------------------------------------------
// P11/L3 — waiting for the CDP Allow prompt
// ---------------------------------------------------------------------------

const PROMPT_ERROR = () =>
  fail("E_CDP_UNAVAILABLE", "connect", {
    message: "the WebSocket handshake did not answer",
  });

test("P11: a pending Allow is waited out and the same connect call succeeds", async (t) => {
  const clock = new FakeClock();
  const seen: number[] = [];
  let attempts = 0;
  const session = new FakeSession(clock);
  const { connector } = rig(t, {
    clock,
    attachWaitMs: 60_000,
    onAwaitingAllow: (info) => seen.push(info.elapsedMs),
    connectSession: async () => {
      attempts += 1;
      if (attempts <= 2) throw PROMPT_ERROR();
      return session as unknown as CdpSession;
    },
  });

  const info = await connector.connect();
  assert.equal(info.webdriver, false);
  assert.equal(attempts, 3, "two unanswered attempts, then the allow");
  assert.deepEqual(seen, [0, 2_000], "progress is reported on every wait, with elapsed time");
});

test("P11: an expired wait is E_CDP_AWAITING_ALLOW, not a generic CDP failure", async (t) => {
  const clock = new FakeClock();
  let attempts = 0;
  const { connector } = rig(t, {
    clock,
    attachWaitMs: 4_000,
    connectSession: async () => {
      attempts += 1;
      throw PROMPT_ERROR();
    },
  });

  const error = await rejectsWithCode(connector.connect(), "E_CDP_AWAITING_ALLOW");
  assert.ok(attempts >= 2, `one attempt cannot exhaust a 4 s wait (attempts=${attempts})`);
  assert.match(error.details.hint, /inspect/);
  assert.match(error.details.message ?? "", /did not answer for \d+ms/);
});

test("P11: attachWaitMs 0 keeps the old single-attempt behaviour", async (t) => {
  const clock = new FakeClock();
  let attempts = 0;
  const { connector } = rig(t, {
    clock,
    attachWaitMs: 0,
    connectSession: async () => {
      attempts += 1;
      throw PROMPT_ERROR();
    },
  });

  await rejectsWithCode(connector.connect(), "E_CDP_UNAVAILABLE");
  assert.equal(attempts, 1);
});

test("P11: a refused socket fails immediately — no pointless 60 s wait", async (t) => {
  const clock = new FakeClock();
  let attempts = 0;
  const { connector } = rig(t, {
    clock,
    attachWaitMs: 60_000,
    connectSession: async () => {
      attempts += 1;
      throw fail("E_CDP_UNAVAILABLE", "connect", {
        message: "connect ECONNREFUSED 127.0.0.1:9222",
      });
    },
  });

  await rejectsWithCode(connector.connect(), "E_CDP_UNAVAILABLE");
  assert.equal(attempts, 1);
  assert.equal(clock.pendingCount(), 0, "a refused socket must not even start a wait");
});

test("P11: the awaiting hint names the detected browser family, not always Chrome", async (t) => {
  const clock = new FakeClock();
  const braveEndpoint: CdpEndpoint = {
    port: 9222,
    wsUrl: "ws://127.0.0.1:9222/devtools/browser/brave",
    source: "devtools-active-port",
    profileDir: "/home/u/.config/BraveSoftware/Brave-Browser",
  };
  const { connector } = rig(t, {
    clock,
    attachWaitMs: 0,
    discover: async () => braveEndpoint,
    connectSession: async () => {
      throw PROMPT_ERROR();
    },
  });

  const error = await rejectsWithCode(connector.connect(), "E_CDP_UNAVAILABLE");
  assert.match(error.details.hint, /brave:\/\/inspect/);
  assert.doesNotMatch(error.details.hint, /chrome:\/\/inspect/);
});
