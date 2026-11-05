/**
 * Append-only JSONL log (SPEC §9.3, PLAN P1-C).
 *
 * One writer per file, one JSON object per line, flushed per call. Rotation
 * happens before an append rather than after, so a reader never sees a line
 * straddling two files and the fresh file is never truncated mid-write.
 */

import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { Clock, Logger } from "./types.ts";
import { isWebSearchError } from "./error-codes.ts";
import type { WebSearchError } from "./error-codes.ts";
import { fail } from "./errors.ts";

/** SPEC does not name a size; 5 MiB keeps a session's decisions cheap to scan. */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

// Retention is one backup generation (`<path>.1`): rows older than that are dropped
// on every rotation, by design — see the V1.3 note in `evidence/P1.md`.

/**
 * Credential-bearing key names, matched after splitting the key into lowercase
 * segments on camelCase and non-alphanumerics. `X-Api-Key`, `api_key` and
 * `apikey` all collapse to the same pieces; a bare `auth`/`session_id`/`sxsrf`
 * is covered without enumerating every header spelling. Plural `tokens` is a
 * segment so `refresh_tokens`/`accessTokens` redact; only the SPEC §9.3 counter
 * spellings in `TOKEN_COUNTERS` survive (see `isTokenCounter`).
 */
const SECRET_SEGMENTS = new Set([
  "auth",
  "authorization",
  "cookie",
  "token",
  "tokens",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "sessionid",
  "sxsrf",
  "reqid",
  "apikey",
  "xapikey",
  "setcookie",
]);

/** Multi-segment spellings that only appear joined (`session_id`, `x-api-key`, `reqId`). */
const SECRET_JOINED = new Set([
  "auth",
  "authorization",
  "xapikey",
  "apikey",
  "cookie",
  "setcookie",
  "token",
  "tokens",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "sessionid",
  "sxsrf",
  "reqid",
]);

/**
 * `accessToken`, `clientSecret`, `userApiKey`, `oauth_token`: the sensitive word
 * is a suffix while the prefix is context. `auth` is safe as a suffix (`author`
 * does not end in it) and catches `basicAuth`/`OAuth`.
 */
const SECRET_SUFFIXES = [
  "authorization",
  "xapikey",
  "apikey",
  "setcookie",
  "cookie",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "sessionid",
  "sxsrf",
  "reqid",
  "auth",
];

function keySegments(key: string): string[] {
  return key
    // `inputTokens` → input / Tokens; `OAuth` → O / Auth; `X-API-Key` → x / API / Key.
    .replace(/([a-z0-9])([A-Z])/g, "$1\u0000$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\u0000$2")
    .split(/[^A-Za-z0-9]+|\u0000/)
    .filter((segment) => segment !== "")
    .map((segment) => segment.toLowerCase());
}

/**
 * The exact counter spellings SPEC §9.3 requires verbatim in decisions.jsonl
 * (`usage.inputTokens` / `outputTokens` / `cacheReadTokens` / `maxTokens`, plus
 * `cacheWriteTokens`/`totalTokens`). They are counters, not credential holders,
 * and redacting them would destroy the cost telemetry. An allowlist rather than
 * a prefix rule is what keeps `accessTokens`/`refresh_tokens` redacted while
 * `cacheReadTokens` survives.
 */
const TOKEN_COUNTERS = new Set([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "maxTokens",
  "totalTokens",
]);

/** True only for the allowlisted camelCase counters with no secret-looking prefix. */
function isTokenCounter(key: string, segments: string[]): boolean {
  if (!TOKEN_COUNTERS.has(key)) return false;
  // Defensive: a future allowlist entry with a secret prefix must still redact.
  return !segments.slice(0, -1).some((segment) => SECRET_SEGMENTS.has(segment));
}

/** True when a key's value is a credential (or a token holder, not a counter). */
function isSecretKey(key: string): boolean {
  const segments = keySegments(key);
  if (isTokenCounter(key, segments)) return false;
  const joined = segments.join("");
  if (SECRET_JOINED.has(joined)) return true;
  if (segments.some((segment) => SECRET_SEGMENTS.has(segment))) return true;
  return SECRET_SUFFIXES.some((suffix) => joined.endsWith(suffix));
}

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: async () => {},
};

export interface LoggerOptions {
  /** Absolute path preferred; relative paths resolve against the process cwd. */
  path: string;
  /** Injectable for deterministic `ts` values in tests. */
  clock?: Clock;
  /** Move the current file to `<path>.1` before an append would exceed this size. */
  maxBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errnoOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * JSON.stringify replacer that (a) redacts secret-looking keys and (b) detects
 * real cycles only. A WeakSet would also turn harmless shared references into
 * `[circular]`, so we track the current ancestor chain instead.
 *
 * Redaction happens here, at write time: callers (tools, reflex, browser) must
 * not have to remember which fields are sensitive, and a crash dump of the log
 * must never contain a cookie or an Authorization header.
 */
function makeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function replacer(this: unknown, key: string, value: unknown): unknown {
    if (key !== "" && isSecretKey(key)) return "[redacted]";
    if (typeof value !== "object" || value === null) return value;

    // `this` is the holder of `value`; pop until the chain matches it. This
    // keeps detection linear and avoids a full ancestor search per value.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) return "[circular]";
    ancestors.push(value);
    return value;
  };
}

function serialize(row: Record<string, unknown>, clock: Clock): string {
  const json = JSON.stringify(row, makeReplacer());
  if (typeof json !== "string") {
    // Only possible if a caller passes a non-object at runtime despite the type.
    return `${JSON.stringify({ ts: new Date(clock.now()).toISOString(), error: "unserializable row" })}\n`;
  }

  // A row that already carries `ts` keeps it (DecisionLogRow); generic logs get
  // one so every line is sortable without the caller knowing the convention.
  if (row.ts !== undefined) return `${json}\n`;

  // Inject `ts` into the root literal instead of shallow-cloning the row: a
  // clone would change object identity and turn a self-reference into a
  // non-cycle, producing a nested duplicate object. JSON-escaped ISO strings
  // cannot break the surrounding JSON.
  const ts = JSON.stringify(new Date(clock.now()).toISOString());
  if (json === "{}") return `{"ts":${ts}}\n`;
  return `{"ts":${ts},${json.slice(1)}\n`;
}

function configError(path: string, action: string, error: unknown): WebSearchError {
  return fail("E_CONFIG", "config", {
    hint: `check that the log path is writable and its parent directory exists: ${path}`,
    message: `log ${action} failed: ${messageOf(error)}`,
  });
}

/**
 * `readJsonl` is for tests/doctor only. A partially written last line (crash)
 * or a hand-edited file must not take down the doctor, so malformed lines are
 * skipped instead of throwing.
 */
export async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return [];
    throw configError(path, "read", error);
  }

  const rows: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(parsed) && !Array.isArray(parsed)) {
      rows.push(parsed);
    }
  }
  return rows;
}

export function createLogger(options: LoggerOptions): Logger {
  const target = options.path;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;

  if (target.trim() === "") {
    throw fail("E_CONFIG", "config", {
      hint: "the log path is empty; set a writable file path such as ~/.pi/agent/web-search/decisions.jsonl",
    });
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw fail("E_CONFIG", "config", {
      hint: `maxBytes must be a positive finite number: ${target}`,
      message: `maxBytes=${String(maxBytes)}`,
    });
  }

  let dirReady = false;
  // Writes are queued so concurrent tool calls cannot interleave lines or race
  // the stat/rename rotation window. A failed write rejects only its caller.
  let queue: Promise<void> = Promise.resolve();

  /**
   * A symlinked log path must rotate the *target*: renaming the link would move
   * the symlink to `.1` and write a fresh inode, while the original target keeps
   * growing forever. Resolve on every write (cheap, low-volume log) so a link
   * created after the logger still behaves; a missing path is its own target.
   */
  async function activePath(): Promise<string> {
    try {
      return await realpath(target);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return target;
      throw error;
    }
  }

  async function ensureDir(path: string): Promise<void> {
    if (dirReady) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    dirReady = true;
  }

  async function rotateIfNeeded(path: string, rowBytes: number): Promise<void> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return; // first write: nothing to rotate
      throw error;
    }

    // A row bigger than the whole budget can never be made to fit. Rotating for
    // it would evict the previous backup on every write and silently lose rows,
    // so such a row is appended as-is; the size cap resumes for normal rows.
    if (rowBytes > maxBytes) return;
    // An empty file has nothing worth preserving, and rotating it would only
    // churn the backup.
    if (size === 0) return;
    // Rotate before the append, so the fresh file never exceeds maxBytes and a
    // reader never sees a line straddling two files.
    if (size + rowBytes <= maxBytes) return;

    const backup = `${path}.1`;
    // POSIX rename would replace .1 atomically, but rm+rename also works where
    // rename refuses an existing destination. Losing the previous .1 is the
    // intended retention policy (one backup generation).
    await rm(backup, { force: true });
    await rename(path, backup);
  }

  /**
   * `mode` in open() only applies when the file is created, so an existing 0644
   * log would stay world-readable. Force 0600 on every handle: decisions.jsonl
   * can contain URLs and queries, and a permissive parent must not leak it.
   */
  async function appendPrivate(path: string, line: string): Promise<void> {
    const handle = await open(path, "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.appendFile(line, { encoding: "utf8" });
    } finally {
      await handle.close();
    }
  }

  async function append(row: Record<string, unknown>): Promise<void> {
    try {
      const line = serialize(row, clock);
      const path = await activePath();
      await ensureDir(path);
      await rotateIfNeeded(path, Buffer.byteLength(line, "utf8"));
      await appendPrivate(path, line);
    } catch (error) {
      if (isWebSearchError(error)) throw error;
      throw configError(target, "append", error);
    }
  }

  return {
    write(row: Record<string, unknown>): Promise<void> {
      const next = queue.then(() => append(row));
      // Do not poison the queue for later writers, but keep the rejection for
      // the caller that caused it.
      queue = next.catch(() => undefined);
      return next;
    },
    path(): string {
      return target;
    },
  };
}
