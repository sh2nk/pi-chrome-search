/**
 * The cross-process session lock (SPEC S8.4, S12.3; PLAN P3).
 *
 * One live session drives the user's browser at a time. The lock names a PID,
 * a session id and a heartbeat; a second pi process gets `E_BUSY` while the
 * holder is alive and fresh, and reclaims a stale or corrupt file exactly once.
 *
 * Two behaviours are deliberate:
 *
 *  - **Published with `link(2)`.** A fully written and fsynced temporary file is
 *    linked into place, which fails with EEXIST for the loser. `open(path, "wx")`
 *    plus a later write would let a second session see an empty file, call it
 *    corrupt and reclaim a lock that is still being written.
 *  - **PID liveness without signalling.** The host layer's `isProcessAlive()`
 *    calls `kill(pid, 0)` — a signal-free existence check — and the heartbeat
 *    remains the authority for anything it cannot classify. No code here sends
 *    a real signal (AGENTS rule 2).
 */

import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fail } from "../runtime/errors.ts";
import { agentDir, isProcessAlive, type ProcessProbe } from "../runtime/host.ts";
import type { Clock } from "../runtime/types.ts";

export const LOCK_VERSION = 1;
/** 20 s is one third of the 60 s stale window: two missed beats still look alive. */
export const DEFAULT_HEARTBEAT_MS = 20_000;
export const DEFAULT_STALE_MS = 60_000;
const LOCK_MODE = 0o600;

export interface LockRecord {
  version: number;
  pid: number;
  sessionId: string;
  startedAt: number;
  heartbeatAt: number;
}

type LockRead = { kind: "ok"; record: LockRecord } | { kind: "corrupt" };

export interface SessionLockOptions {
  path: string;
  sessionId: string;
  clock: Clock;
  heartbeatMs?: number;
  staleMs?: number;
  /** Test seam; defaults to the host layer's signal-free liveness check. */
  alive?: (pid: number) => boolean;
  warn?: (event: string, detail: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
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

/** Kept as the session layer's public name; the implementation lives in the host layer. */
export function pidAlive(pid: number, probe?: ProcessProbe): boolean {
  return isProcessAlive(pid, probe);
}

export function defaultLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "web-search.lock");
}

export class SessionLock {
  readonly path: string;
  readonly #clock: Clock;
  readonly #sessionId: string;
  readonly #heartbeatMs: number;
  readonly #staleMs: number;
  readonly #alive: (pid: number) => boolean;
  readonly #warn: (event: string, detail: string) => void;

  #record: LockRecord | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /** A 1 ms heartbeat (tests) can overlap its own atomic rewrite. */
  #heartbeatBusy = false;

  constructor(options: SessionLockOptions) {
    this.path = options.path;
    this.#clock = options.clock;
    this.#sessionId = options.sessionId;
    this.#heartbeatMs = positiveInt(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
    this.#staleMs = positiveInt(options.staleMs, DEFAULT_STALE_MS);
    this.#alive = options.alive ?? ((pid) => pidAlive(pid));
    this.#warn = options.warn ?? (() => undefined);
  }

  get held(): boolean {
    return this.#record !== undefined;
  }

  /** Acquire the lock, reclaiming a stale or corrupt file exactly once. */
  async acquire(): Promise<void> {
    if (this.#record !== undefined) return;

    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw fail("E_CONFIG", "connect", {
        message: `cannot create the lock directory ${dirname(this.path)}: ${describeError(error)}`,
        hint: "check that the pi agent directory is writable; the lock stops two sessions from driving the same tab",
      });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if ((await this.#attempt()) === "acquired") return;
    }

    throw fail("E_BUSY", "connect", {
      message: `could not acquire ${this.path} even after reclaiming it once`,
      hint: `another process keeps recreating ${this.path}; run /web-doctor or remove the file by hand`,
    });
  }

  /** Release only a lock this session wrote; never delete another session's file. */
  async release(): Promise<void> {
    this.#stopHeartbeat();
    const record = this.#record;
    this.#record = undefined;
    if (record === undefined) return;

    const current = await this.#read();
    if (current === undefined) return;
    if (current.kind === "corrupt") {
      this.#warn("lock_release_skipped", `lock file at ${this.path} is unreadable; leaving it in place`);
      return;
    }
    if (current.record.sessionId !== this.#sessionId) {
      this.#warn(
        "lock_release_skipped",
        `lock file at ${this.path} belongs to session ${current.record.sessionId}; not removing it`,
      );
      return;
    }

    try {
      await unlink(this.path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) this.#warn("lock_release_failed", describeError(error));
    }
  }

  async #attempt(): Promise<"acquired" | "reclaim"> {
    const record: LockRecord = {
      version: LOCK_VERSION,
      pid: process.pid,
      sessionId: this.#sessionId,
      startedAt: this.#clock.now(),
      heartbeatAt: this.#clock.now(),
    };

    try {
      await this.#publish(record);
      this.#record = record;
      this.#startHeartbeat();
      return "acquired";
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw fail("E_CONFIG", "connect", {
          message: `cannot create the lock file ${this.path}: ${describeError(error)}`,
          hint: `check that ${dirname(this.path)} is writable; the lock stops two pi sessions from driving the same tab`,
        });
      }
    }

    const holder = await this.#read();
    if (holder === undefined) return "reclaim";
    if (holder.kind === "corrupt") {
      this.#warn(
        "lock_corrupt",
        `unparsable lock file at ${this.path}; reclaiming it (a corrupt lock must not brick the extension)`,
      );
      await this.#unlinkQuietly(this.path);
      return "reclaim";
    }

    const current = holder.record;
    if (current.sessionId === this.#sessionId) {
      this.#record = { ...current, pid: process.pid, heartbeatAt: this.#clock.now() };
      await this.#write();
      this.#startHeartbeat();
      return "acquired";
    }

    const alive = this.#alive(current.pid);
    const age = this.#clock.now() - current.heartbeatAt;
    if (alive && age <= this.#staleMs) {
      throw fail("E_BUSY", "connect", {
        message: `another pi session holds ${this.path} (pid ${current.pid}, heartbeat ${Math.max(0, age)}ms old)`,
        hint:
          `pid ${current.pid} is still alive and its heartbeat is fresh; close that session or wait ` +
          `until ${this.path} is older than ${this.#staleMs}ms, then retry`,
      });
    }

    this.#warn(
      "lock_reclaim",
      `reclaiming stale lock at ${this.path} (pid ${current.pid}, heartbeat ${Math.max(0, age)}ms old)`,
    );
    await this.#unlinkQuietly(this.path);
    return "reclaim";
  }

  async #publish(record: LockRecord): Promise<void> {
    const tmp = `${this.path}.tmp-${this.#sessionId}-${randomUUID()}`;
    let handle: FileHandle;
    try {
      handle = await open(tmp, "wx", LOCK_MODE);
    } catch (error) {
      throw fail("E_CONFIG", "connect", {
        message: `cannot create the lock temporary file ${tmp}: ${describeError(error)}`,
        hint: `check that ${dirname(this.path)} is writable and not full; the lock stops two pi sessions from driving the same tab`,
      });
    }

    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await chmod(tmp, LOCK_MODE);
      await link(tmp, this.path);
    } finally {
      await this.#unlinkQuietly(tmp);
    }
  }

  async #read(): Promise<LockRead | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      return { kind: "corrupt" };
    }
    const record = parseLockRecord(text);
    return record === null ? { kind: "corrupt" } : { kind: "ok", record };
  }

  async #write(): Promise<void> {
    const record = this.#record;
    if (record === undefined) return;
    const tmp = `${this.path}.${process.pid}.${this.#sessionId}.tmp`;
    await writeFile(tmp, JSON.stringify(record), "utf8");
    await chmod(tmp, LOCK_MODE);
    await rename(tmp, this.path);
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
      void this.#tick();
    }, this.#heartbeatMs);
    timer.unref();
    this.#heartbeat = timer;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat === undefined) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  async #tick(): Promise<void> {
    if (this.#heartbeatBusy) return;
    const record = this.#record;
    if (record === undefined) {
      this.#stopHeartbeat();
      return;
    }
    this.#heartbeatBusy = true;
    record.heartbeatAt = this.#clock.now();

    try {
      const current = await this.#read();
      if (current === undefined) {
        this.#stopHeartbeat();
        return;
      }
      if (current.kind === "corrupt" || current.record.sessionId !== record.sessionId) {
        this.#stopHeartbeat();
        return;
      }
      await this.#write();
    } catch (error) {
      this.#warn("lock_heartbeat_failed", describeError(error));
    } finally {
      this.#heartbeatBusy = false;
    }
  }
}
