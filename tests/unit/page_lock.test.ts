/**
 * P9-A: the keyed FIFO page lock.
 *
 * The lock is the only thing standing between two concurrent `web_read` calls
 * and one shared tab, so the tests are about *timing*: strict FIFO order, no
 * overlap inside a key, full parallelism across keys, and no leaked waiter when
 * a task throws or a caller is aborted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createKeyedLock, pageLockFor, readSlotKeys } from "../../src/cdp/page-lock.ts";

/** Resolve on the next macrotask, so `Promise.all` really interleaves. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("same key runs one task at a time, in arrival order", async () => {
  const lock = createKeyedLock();
  const events: string[] = [];

  const make = (id: string) => async (): Promise<void> => {
    events.push(`start ${id}`);
    await tick();
    events.push(`end ${id}`);
  };

  await Promise.all([
    lock.run("read", make("a")),
    lock.run("read", make("b")),
    lock.run("read", make("c")),
  ]);

  assert.deepEqual(events, [
    "start a",
    "end a",
    "start b",
    "end b",
    "start c",
    "end c",
  ]);
});

test("different keys run in parallel", async () => {
  const lock = createKeyedLock();
  const events: string[] = [];

  await Promise.all([
    lock.run("read", async () => {
      events.push("a start");
      await tick();
      events.push("a end");
    }),
    lock.run("read#2", async () => {
      events.push("b start");
      await tick();
      events.push("b end");
    }),
  ]);

  assert.deepEqual(events.slice(0, 2), ["a start", "b start"], "slots must not serialise each other");
});

test("a throwing task releases the queue and rejects only its own caller", async () => {
  const lock = createKeyedLock();
  const order: string[] = [];

  const failing = lock.run("read", async () => {
    order.push("fail");
    throw new Error("boom");
  });
  const after = lock.run("read", async () => {
    order.push("after");
    return "ok";
  });

  await assert.rejects(failing, /boom/);
  assert.equal(await after, "ok");
  assert.deepEqual(order, ["fail", "after"]);
  assert.equal(lock.pending(), 0);
});

test("pending() counts queued and running tasks, then returns to zero", async () => {
  const lock = createKeyedLock();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = lock.run("read", async () => {
    await gate;
  });
  const second = lock.run("read", async () => {});

  assert.equal(lock.pending("read"), 2);
  assert.equal(lock.pending(), 2);

  release();
  await Promise.all([first, second]);
  assert.equal(lock.pending("read"), 0);
  assert.equal(lock.pending(), 0, "a released lock must not leak into the next session");
});

test("pick() returns the least-loaded key and keeps caller order on ties", () => {
  const lock = createKeyedLock();
  const keys = ["read", "read#2", "read#3"];

  assert.equal(lock.pick(keys), "read");
  assert.equal(lock.pick(["read#2", "read#3"]), "read#2");

  // A queued task makes its key less attractive; this is what keeps two
  // simultaneous readers on different slots instead of behind one tab.
  void lock.run("read", async () => {
    await tick();
  });
  assert.equal(lock.pick(keys), "read#2");
});

test("pageLockFor() is per connector and stable across calls", () => {
  const one = {};
  const two = {};
  assert.equal(pageLockFor(one), pageLockFor(one));
  assert.notEqual(pageLockFor(one), pageLockFor(two));
});

test("readSlotKeys() maps the pool size onto slot ids", () => {
  assert.deepEqual(readSlotKeys(1), ["read"]);
  assert.deepEqual(readSlotKeys(2), ["read", "read#2"]);
  assert.deepEqual(readSlotKeys(3), ["read", "read#2", "read#3"]);
  // Defensive: config validation already forbids these, but a pooled caller
  // must never ask the browser for a 99th read tab.
  assert.deepEqual(readSlotKeys(99), ["read", "read#2", "read#3"]);
  assert.deepEqual(readSlotKeys(0), ["read"]);
  assert.deepEqual(readSlotKeys(Number.NaN), ["read"]);
});
