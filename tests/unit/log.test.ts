/**
 * JSONL log contract (PLAN P1-C): append/one-line, rotation before append,
 * write-time redaction, and a tolerant reader for the doctor.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import {
  chmod,
  lstat,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import { createLogger, readJsonl } from "../../src/runtime/log.ts";
import type { Clock, Logger } from "../../src/runtime/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-chrome-search-log-"));
  tempDirs.push(dir);
  return dir;
}

/** Epoch 0 makes the injected `ts` deterministic and easy to assert. */
const clock: Clock = { now: () => 0, sleep: async () => {} };

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("appends one compact JSON object per line and flushes immediately", async () => {
  const file = join(tempDir(), "decisions.jsonl");
  const logger: Logger = createLogger({ path: file, clock });
  assert.equal(logger.path(), file);

  await logger.write({ decision: "triage", verdict: "search" });
  await logger.write({ decision: "route", verdict: "auto" });

  const rows = await readJsonl(file);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    decision: "triage",
    verdict: "search",
    ts: "1970-01-01T00:00:00.000Z",
  });

  const raw = await readFile(file, "utf8");
  const lines = raw.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(!raw.includes("\n  "), "file must not be pretty-printed");
});

test("a caller-provided ts is preserved", async () => {
  const file = join(tempDir(), "explicit.jsonl");
  const logger = createLogger({ path: file, clock });
  await logger.write({ ts: "2026-11-06T12:00:00.000Z", n: 1 });

  const [row] = await readJsonl(file);
  assert.equal(row.ts, "2026-11-06T12:00:00.000Z");
});

test("rotation moves all rows to .1 before the next append, replacing an old .1", async () => {
  const file = join(tempDir(), "rotate.jsonl");
  // ~43 bytes per line: two lines fit under 100, the third append would exceed it.
  const logger = createLogger({ path: file, clock, maxBytes: 100 });
  await writeFile(`${file}.1`, "stale backup\n", "utf8");

  await logger.write({ n: 1 });
  await logger.write({ n: 2 });
  await logger.write({ n: 3 });

  const backup = await readJsonl(`${file}.1`);
  const current = await readJsonl(file);
  assert.deepEqual(backup.map((row) => row.n), [1, 2]);
  assert.deepEqual(current.map((row) => row.n), [3]);
  assert.ok(backup.every((row) => row.n !== undefined), "stale .1 must be replaced");
  assert.equal(backup.length + current.length, 3, "rotation must not drop rows");
});

test("redacts secret-looking keys at any depth without mutating the caller's row", async () => {
  const file = join(tempDir(), "redact.jsonl");
  const logger = createLogger({ path: file, clock });
  const shared = { keep: "ok" };
  const row = {
    token: "tok_live_123",
    cookieHeader: "SID=abc",
    nested: {
      authorization: "Bearer xyz",
      list: [{ api_key: "k1" }, { password: "p1" }],
      sharedA: shared,
      sharedB: shared,
    },
  };

  await logger.write(row);
  const [stored] = await readJsonl(file);
  assert.equal(stored.token, "[redacted]");
  assert.equal(stored.cookieHeader, "[redacted]");

  const nested = stored.nested as Record<string, unknown>;
  assert.equal(nested.authorization, "[redacted]");
  const list = nested.list as Record<string, unknown>[];
  assert.equal(list[0].api_key, "[redacted]");
  assert.equal(list[1].password, "[redacted]");
  assert.deepEqual(nested.sharedA, { keep: "ok" });
  assert.deepEqual(nested.sharedB, { keep: "ok" }, "non-circular shared refs must not be dropped");

  // Redaction is a write-time transform, not a mutation of live data.
  assert.equal(row.token, "tok_live_123");
  assert.equal(row.nested.authorization, "Bearer xyz");
});

test("hyphenated, header-style and bare auth keys are all redacted", async () => {
  const file = join(tempDir(), "secret-names.jsonl");
  const logger = createLogger({ path: file, clock });

  const secretKeys = [
    "auth",
    "authorization",
    "x-api-key",
    "api-key",
    "api_key",
    "apikey",
    "cookie",
    "set-cookie",
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "credentials",
    "sessionid",
    "session_id",
    "sxsrf",
    "reqid",
  ] as const;

  const row: Record<string, unknown> = {};
  for (const key of secretKeys) row[key] = `value-of-${key}`;
  row.headers = { Authorization: "Bearer y", "X-Api-Key": "k5", Cookie: "SID=2" };
  // Not credentials: over-redaction makes the decision log useless.
  row.author = "Ada Lovelace";
  row.inputTokens = 7;

  await logger.write(row);
  const [stored] = await readJsonl(file);
  for (const key of secretKeys) {
    assert.equal(stored[key], "[redacted]", `${key} must be redacted`);
  }

  const headers = stored.headers as Record<string, unknown>;
  assert.equal(headers.Authorization, "[redacted]");
  assert.equal(headers["X-Api-Key"], "[redacted]");
  assert.equal(headers.Cookie, "[redacted]");

  assert.equal(stored.author, "Ada Lovelace");
  assert.equal(stored.inputTokens, 7);
});

test("usage token counters and costUsd survive redaction (SPEC §9.3)", async () => {
  const file = join(tempDir(), "usage.jsonl");
  const logger = createLogger({ path: file, clock });

  const row = {
    usage: {
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 11,
      cacheWriteTokens: 2,
      maxTokens: 1024,
    },
    costUsd: 0.0001,
    // A bare token key is still a credential holder.
    token: "tok_live_123",
    // ...and so is a *Tokens key whose prefix still names a secret.
    secretTokens: ["tok_a", "tok_b"],
  };

  await logger.write(row);
  const [stored] = await readJsonl(file);
  assert.deepEqual(stored.usage, {
    inputTokens: 7,
    outputTokens: 3,
    cacheReadTokens: 11,
    cacheWriteTokens: 2,
    maxTokens: 1024,
  });
  assert.equal(stored.costUsd, 0.0001);
  assert.equal(stored.token, "[redacted]");
  assert.equal(stored.secretTokens, "[redacted]");
});

test("the token-counter exemption is load-bearing, not decoration", async () => {
  const file = join(tempDir(), "token-counters.jsonl");
  const logger = createLogger({ path: file, clock });

  const row = {
    // SPEC §9.3 counters: removing the `isTokenCounter` exemption would redact
    // these, because `tokens` is now a secret segment.
    inputTokens: 7,
    totalTokens: 10,
    // Real token holders: allowlisted? No. Redacted.
    refresh_tokens: "rt_live_123",
    accessTokens: "at_live_123",
    tokens: ["tok_a", "tok_b"],
    // A counter-shaped key with a secret prefix is still a credential.
    authInputTokens: 5,
  };

  await logger.write(row);
  const [stored] = await readJsonl(file);
  assert.equal(stored.inputTokens, 7, "inputTokens must survive (exemption removed?)");
  assert.equal(stored.totalTokens, 10, "totalTokens must survive");
  assert.equal(stored.refresh_tokens, "[redacted]");
  assert.equal(stored.accessTokens, "[redacted]");
  assert.equal(stored.tokens, "[redacted]");
  assert.equal(stored.authInputTokens, "[redacted]");
});

test("circular structures become [circular] instead of throwing", async () => {
  const file = join(tempDir(), "circular.jsonl");
  const logger = createLogger({ path: file, clock });
  const row: Record<string, unknown> = { name: "loop" };
  row.self = row;

  await logger.write(row);
  const [stored] = await readJsonl(file);
  assert.equal(stored.name, "loop");
  assert.equal(stored.self, "[circular]");
});

test("concurrent writes are serialized into complete lines", async () => {
  const file = join(tempDir(), "concurrent.jsonl");
  const logger = createLogger({ path: file, clock });
  await Promise.all(Array.from({ length: 25 }, (_, n) => logger.write({ n })));

  const rows = await readJsonl(file);
  assert.equal(rows.length, 25);
  assert.deepEqual(
    rows.map((row) => row.n),
    Array.from({ length: 25 }, (_, n) => n),
  );
});

test("readJsonl skips malformed lines and a missing file reads as empty", async () => {
  const file = join(tempDir(), "mixed.jsonl");
  await writeFile(
    file,
    ['not json', '{"a":1}', "", "[1,2]", '"str"', '{"b":2}', ""].join("\n"),
    "utf8",
  );

  assert.deepEqual(await readJsonl(file), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(await readJsonl(join(tempDir(), "absent.jsonl")), []);
});

test("the parent directory is created with no group/other permissions", async () => {
  const root = tempDir();
  const file = join(root, "nested", "deeper", "decisions.jsonl");
  const logger = createLogger({ path: file, clock });

  await logger.write({ ok: true });
  assert.deepEqual(await readJsonl(file), [{ ok: true, ts: "1970-01-01T00:00:00.000Z" }]);

  const dir = await stat(dirname(file));
  assert.equal(dir.mode & 0o077, 0, "log directory must be private (0700)");
});

test("the log file is created 0600 and an existing permissive file is tightened", async () => {
  const root = tempDir();

  const created = join(root, "created.jsonl");
  const logger = createLogger({ path: created, clock });
  await logger.write({ n: 1 });
  assert.equal(statSync(created).mode & 0o077, 0, "a new log must not be group/world readable");

  // Simulate a log left behind by an older build or a permissive umask.
  const existing = join(root, "existing.jsonl");
  await writeFile(existing, "", { encoding: "utf8", mode: 0o644 });
  await chmod(existing, 0o644);
  assert.notEqual(statSync(existing).mode & 0o077, 0, "precondition: file starts permissive");

  await createLogger({ path: existing, clock }).write({ n: 1 });
  assert.equal(statSync(existing).mode & 0o077, 0, "opening a log must force 0600");
});

test("rotation never drops an oversized row", async () => {
  const file = join(tempDir(), "oversized.jsonl");
  const logger = createLogger({ path: file, clock, maxBytes: 64 });
  const blob = "x".repeat(100);

  for (let n = 0; n < 10; n += 1) await logger.write({ n, blob });

  const current = await readJsonl(file);
  const backup = await readJsonl(`${file}.1`);
  const all = [...backup, ...current];
  assert.equal(all.length, 10, "no oversized row may evict another row");
  assert.deepEqual(
    all.map((row) => row.n).sort((a, b) => Number(a) - Number(b)),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  for (const row of all) assert.equal(row.blob, blob);
});

test("a symlinked log path rotates the target, not the link", async () => {
  const root = tempDir();
  const target = join(root, "real.jsonl");
  const link = join(root, "link.jsonl");
  await writeFile(target, "", "utf8");
  await symlink(target, link);

  const logger = createLogger({ path: link, clock, maxBytes: 100 });
  assert.equal(logger.path(), link, "the caller's path stays observable");
  await logger.write({ n: 1 });
  await logger.write({ n: 2 });
  await logger.write({ n: 3 });

  // Renaming the link would move the symlink and leave the real target growing.
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(await readlink(link), target);
  assert.deepEqual((await readJsonl(`${target}.1`)).map((row) => row.n), [1, 2]);
  assert.deepEqual((await readJsonl(target)).map((row) => row.n), [3]);
  assert.deepEqual((await readJsonl(link)).map((row) => row.n), [3]);
});

test("an unwritable log path fails as a diagnosable E_CONFIG", async () => {
  const root = tempDir();
  const blocker = join(root, "blocker");
  await writeFile(blocker, "this is a file, not a directory\n", "utf8");

  const logger = createLogger({ path: join(blocker, "decisions.jsonl"), clock });
  await assert.rejects(logger.write({ n: 1 }), (error: unknown) => {
    assert.ok(isWebSearchError(error));
    assert.equal(error.details.code, "E_CONFIG");
    assert.equal(error.details.stage, "config");
    assert.equal(error.details.retryable, false);
    assert.ok(error.details.hint.includes(join(blocker, "decisions.jsonl")), error.details.hint);
    assert.ok(!(error.details.message ?? "").includes("this is a file"));
    return true;
  });
});

test("invalid maxBytes is rejected up front", () => {
  assert.throws(
    () => createLogger({ path: join(tempDir(), "x.jsonl"), maxBytes: 0 }),
    (error: unknown) => isWebSearchError(error) && error.details.code === "E_CONFIG",
  );
});
