/**
 * Session lifecycle over the fake CDP transport (PLAN P3 gate).
 *
 * The cases are the ones a live browser produces at the worst possible moment:
 * nothing listening, the Allow prompt unanswered, a socket drop mid-call, a
 * stale lock, two pi sessions, a user-closed tab and a PDF slot release. None
 * of them may need a real Chrome; all of them must stay diagnosable.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { fail } from "../../src/runtime/errors.ts";
import type { Logger } from "../../src/runtime/types.ts";
import { DEFAULT_FAKE_NOW, FakeClock } from "../helpers/fake-cdp.ts";
import { FakeCdpClient } from "../helpers/fake-cdp-client.ts";
import {
  createSession,
  parseLockRecord,
  type AwaitingAllowInfo,
  type ConnectClientOptions,
  type Session,
  type SessionOptions,
} from "../../src/session/index.ts";
import type { CdpClient, CdpEndpoint } from "../../src/cdp/types.ts";

const ENDPOINT: CdpEndpoint = {
  port: 9222,
  wsUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
  source: "env-ws",
};

const log: Logger = { async write() {}, path: () => "/dev/null" };

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function baseConfig(overrides: Partial<Config["cdp"]> = {}): Config {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.cdp = { ...config.cdp, attachWaitMs: 0, connectTimeoutMs: 2000, ...overrides };
  config.window.panel = false;
  config.window.focus = "never";
  config.window.follow = "never";
  return config;
}

async function tempLockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-chrome-session-"));
  cleanup.push(async () => await rm(dir, { recursive: true, force: true }));
  return join(dir, "web-search.lock");
}

interface Harness {
  session: Session;
  lockPath: string;
  clock: FakeClock;
}

function harness(options: {
  lockPath: string;
  connectClient: (opts: ConnectClientOptions) => Promise<CdpClient>;
  config?: Config;
  alive?: (pid: number) => boolean;
  onAwaitingAllow?: SessionOptions["onAwaitingAllow"];
  sessionId?: string;
}): Harness {
  const clock = new FakeClock();
  const session = createSession({
    config: options.config ?? baseConfig(),
    discover: async () => ENDPOINT,
    connectClient: options.connectClient,
    clock,
    log,
    lockPath: options.lockPath,
    ...(options.alive === undefined ? {} : { alive: options.alive }),
    ...(options.onAwaitingAllow === undefined ? {} : { onAwaitingAllow: options.onAwaitingAllow }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  cleanup.push(async () => await session.shutdown());
  return { session, lockPath: options.lockPath, clock };
}

function errorCode(error: unknown): string {
  assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
  return error.details.code;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the promise to reject");
}

async function lockRecord(path: string): Promise<NonNullable<ReturnType<typeof parseLockRecord>>> {
  const record = parseLockRecord(await readFile(path, "utf8"));
  assert.ok(record !== null, `expected a valid lock record at ${path}`);
  return record;
}

test("S8.4 connect refused is E_CDP_UNAVAILABLE and does not leak the lock", async () => {
  const lockPath = await tempLockPath();
  let attempts = 0;
  const { session } = harness({
    lockPath,
    connectClient: async () => {
      attempts += 1;
      throw fail("E_CDP_UNAVAILABLE", "connect", {
        message: "CDP connect to ws failed: connect ECONNREFUSED 127.0.0.1:9222",
      });
    },
  });

  const error = await rejection(session.connect());
  assert.equal(errorCode(error), "E_CDP_UNAVAILABLE");
  assert.equal(attempts, 1, "nothing is listening; waiting cannot help");
  assert.equal(session.state(), "idle");
  assert.equal(existsSync(lockPath), false, "a failed connect must release its lock");
});

test("S8.4 an unanswered Allow prompt is E_CDP_AWAITING_ALLOW, not a hang", async () => {
  const lockPath = await tempLockPath();
  const events: AwaitingAllowInfo[] = [];
  let attempts = 0;
  const { session } = harness({
    lockPath,
    config: baseConfig({ attachWaitMs: 1000 }),
    connectClient: async () => {
      attempts += 1;
      throw fail("E_CDP_DISCONNECTED", "connect", {
        message: "CDP socket closed before it was ready",
      });
    },
    onAwaitingAllow: (info) => events.push(info),
  });

  const error = await rejection(session.connect());
  assert.ok(isWebSearchError(error));
  assert.equal(error.details.code, "E_CDP_AWAITING_ALLOW");
  assert.equal(error.details.retryable, true);
  assert.equal(attempts, 2);
  assert.equal(events.length, 2, "one progress event, one final event");
  assert.equal(events.at(-1)?.final, true);
  assert.equal(events.at(-1)?.attempt, 2);
  assert.equal(events.at(-1)?.elapsedMs, 1000);
  assert.equal(existsSync(lockPath), false);
  assert.equal(session.state(), "idle");
});

test("a socket drop mid-call is E_CDP_DISCONNECTED and the session stops claiming health", async () => {
  const lockPath = await tempLockPath();
  const client = new FakeCdpClient();
  const { session } = harness({ lockPath, connectClient: async () => client });

  await session.connect();
  const page = await session.acquirePage("google");
  client.failNext(
    "Runtime.evaluate",
    fail("E_CDP_DISCONNECTED", "extract", { message: "socket dropped mid-call" }),
  );
  assert.equal(errorCode(await rejection(page.evaluate("document.title"))), "E_CDP_DISCONNECTED");
  assert.equal(session.isConnected(), true, "the fake socket itself is still open");

  client.disconnect();
  assert.equal(session.isConnected(), false);
  assert.equal(errorCode(await rejection(page.evaluate("document.title"))), "E_CDP_DISCONNECTED");
});

test("a stale foreign lock is reclaimed exactly once", async () => {
  const lockPath = await tempLockPath();
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      pid: 424242,
      sessionId: "dead-session",
      startedAt: DEFAULT_FAKE_NOW - 300_000,
      heartbeatAt: DEFAULT_FAKE_NOW - 120_000,
    }),
  );
  const client = new FakeCdpClient();
  const { session } = harness({
    lockPath,
    connectClient: async () => client,
    alive: () => false,
  });

  await session.connect();
  const record = await lockRecord(lockPath);
  assert.equal(record.pid, process.pid);
  assert.notEqual(record.sessionId, "dead-session");
  assert.equal(session.state(), "ready");
});

test("a live foreign lock is E_BUSY and is left in place", async () => {
  const lockPath = await tempLockPath();
  const holder = {
    version: 1,
    pid: process.pid,
    sessionId: "live-session",
    startedAt: DEFAULT_FAKE_NOW,
    heartbeatAt: DEFAULT_FAKE_NOW,
  };
  await writeFile(lockPath, JSON.stringify(holder));
  const { session } = harness({
    lockPath,
    connectClient: async () => new FakeCdpClient(),
    alive: () => true,
  });

  const error = await rejection(session.connect());
  assert.equal(errorCode(error), "E_BUSY");
  assert.deepEqual(await lockRecord(lockPath), holder);
  assert.equal(session.state(), "idle");
});

test("two sessions: the second is E_BUSY until the first shuts down", async () => {
  const lockPath = await tempLockPath();
  const first = harness({ lockPath, connectClient: async () => new FakeCdpClient() });
  const second = harness({ lockPath, connectClient: async () => new FakeCdpClient() });

  await first.session.connect();
  assert.equal(errorCode(await rejection(second.session.connect())), "E_BUSY");

  await first.session.shutdown();
  assert.equal(first.session.state(), "closed");

  await second.session.connect();
  assert.equal(second.session.state(), "ready");
});

test("a tab the user closed is forgotten and recreated, never reused", async () => {
  const lockPath = await tempLockPath();
  const client = new FakeCdpClient();
  const { session } = harness({ lockPath, connectClient: async () => client });

  await session.connect();
  const page = await session.acquirePage("google");
  const first = session.info()?.ownedTargets.find((target) => target.key === "google")?.targetId;
  assert.ok(first !== undefined);

  client.userCloseTarget(first);
  assert.equal(errorCode(await rejection(page.evaluate("document.title"))), "E_TARGET_LOST");
  await session.acquirePage("google");
  const second = session.info()?.ownedTargets.find((target) => target.key === "google")?.targetId;
  assert.ok(second !== undefined);
  assert.notEqual(second, first);
  assert.equal(client.created.length, 3, "anchor + first google tab + the replacement");

  await session.shutdown();
});

test("S5.6 a PDF read releases its slot for the next read", async () => {
  const lockPath = await tempLockPath();
  const client = new FakeCdpClient();
  const { session } = harness({ lockPath, connectClient: async () => client });

  await session.connect();
  await session.acquirePage("read#1");
  const first = session.info()?.ownedTargets.find((target) => target.key === "read#1")?.targetId;
  assert.ok(first !== undefined);

  await session.releasePage("read#1");
  assert.equal(client.hasTarget(first), false);
  assert.equal(session.info()?.ownedTargets.some((target) => target.key === "read#1"), false);

  await session.acquirePage("read#1");
  const second = session.info()?.ownedTargets.find((target) => target.key === "read#1")?.targetId;
  assert.ok(second !== undefined);
  assert.notEqual(second, first);
});

test("S12.3 shutdown closes owned tabs and never a foreign tab", async () => {
  const lockPath = await tempLockPath();
  const client = new FakeCdpClient();
  client.addForeignTarget("foreign-tab");
  const { session } = harness({ lockPath, connectClient: async () => client });

  await session.connect();
  await session.acquirePage("duckduckgo");
  const owned = session.ownedTargets();
  assert.equal(owned.length, 2, "one anchor and one engine tab");

  await session.shutdown();
  assert.equal(client.hasTarget("foreign-tab"), true);
  for (const targetId of owned) assert.equal(client.hasTarget(targetId), false);
  assert.equal(existsSync(lockPath), false);
});

test("the doctor reads the session and an injected probe, with no live browser", async () => {
  const { buildDoctorReport } = await import("../../src/runtime/doctor.ts");
  const { createDefaultRegistry } = await import("../../src/engines/index.ts");
  const lockPath = await tempLockPath();
  const client = new FakeCdpClient();
  const config = baseConfig();
  const { session, clock } = harness({ lockPath, connectClient: async () => client });
  const probed: string[] = [];

  await session.connect();
  const report = await buildDoctorReport({
    config,
    configPath: "/tmp/web-search.json",
    connector: session,
    registry: createDefaultRegistry(config),
    clock,
    probe: async (id) => {
      probed.push(id);
      return { ms: 1, results: 1, ai: false };
    },
  });

  assert.equal(report.cdp.status, "ok");
  assert.equal(report.cdp.webdriver, false);
  assert.equal(report.cdp.endpoint?.source, "env-ws");
  assert.equal(report.cdp.lock.owner, "self");
  assert.deepEqual(probed, ["google", "duckduckgo", "yandex"], "one probe per enabled engine");
  assert.equal(report.verdict, "ok");
});
