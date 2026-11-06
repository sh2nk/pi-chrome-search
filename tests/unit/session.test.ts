/**
 * P1-B: raw CDP session + CdpPage against the fake loopback CDP server.
 *
 * Everything is offline; the only socket is the fake server. The fake models
 * the browser behaviours that would let a broken transport pass a naive test:
 * flattened sessions, Page.enable gating, target-loss events, per-socket
 * session ownership, a refused Browser.close, withheld requests and dropped
 * sockets.
 *
 *   node --test tests/unit/session.test.ts
 */

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import type { ErrorCode } from "../../src/runtime/error-codes.ts";
import type { WebSearchError } from "../../src/runtime/error-codes.ts";
import { CdpSession } from "../../src/cdp/session.ts";
import type { CdpSessionOptions } from "../../src/cdp/session.ts";
import { createCdpPage } from "../../src/cdp/session.ts";
import type { CdpPageHandle } from "../../src/cdp/session.ts";
import { FakeCdpServer } from "../helpers/fake-cdp-server.ts";
import type { FakeCdpOptions } from "../helpers/fake-cdp-server.ts";
import { FakeClock } from "../helpers/clock.ts";

interface Setup {
  server: FakeCdpServer;
  session: CdpSession;
  attached: { targetId: string; sessionId: string };
  page: CdpPageHandle;
}

async function setup(
  t: TestContext,
  fake: FakeCdpOptions = {},
  sessionOptions: Partial<CdpSessionOptions> = {},
): Promise<Setup> {
  const server = new FakeCdpServer(fake);
  await server.start();
  const session = await CdpSession.connect({
    wsUrl: server.wsUrl(),
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 500,
    ...sessionOptions,
  });
  t.after(async () => {
    await session.close().catch(() => undefined);
    await server.stop();
  });
  // P1-D attaches the owned tab before handing the page to an adapter; the
  // tests do the same so every page call starts from a realistic state.
  const attached = await session.attach("target-1");
  const page = createCdpPage(session, "target-1");
  return { server, session, attached, page };
}

/** Assert a task fails with a taxonomy error, returning it for message checks. */
async function rejectsWithCode(task: Promise<unknown>, code: ErrorCode): Promise<WebSearchError> {
  let caught: unknown;
  try {
    await task;
  } catch (error) {
    caught = error;
  }
  assert.ok(isWebSearchError(caught), `expected WebSearchError, got ${String(caught)}`);
  assert.equal(caught.details.code, code);
  assert.equal(typeof caught.details.stage, "string");
  assert.ok(caught.details.hint.length > 0, "every failure must carry a hint");
  return caught;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("condition was not met before the deadline");
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test("connect + Browser.getVersion", async (t) => {
  const { server, session } = await setup(t);

  assert.equal(session.isConnected(), true);
  const version = await session.version();
  assert.equal(version.product, "Chrome/157.0.8103.38");
  assert.equal(version.protocolVersion, "1.3");
  assert.match(version.userAgent, /Chrome\/157/);
  assert.equal(version.revision, "@fake-cdp");
  assert.ok(server.methods().includes("Browser.getVersion"));
});

test("connect failure is E_CDP_UNAVAILABLE with a hint, not a bare error", async () => {
  await rejectsWithCode(
    CdpSession.connect({ wsUrl: "ws://127.0.0.1:1/devtools/browser/none", connectTimeoutMs: 100 }),
    "E_CDP_UNAVAILABLE",
  );
});

test("targets + attach uses flatten and allocates a session", async (t) => {
  const { server, session } = await setup(t);

  const targets = await session.targets();
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0], {
    id: "target-1",
    type: "page",
    title: "about:blank",
    url: "about:blank",
    attached: true,
  });

  const attached = await session.attach("target-1");
  assert.equal(attached.targetId, "target-1");
  assert.match(attached.sessionId, /^session-\d+$/);
  assert.equal(session.sessionIdFor("target-1"), attached.sessionId);

  const call = server.lastCall("Target.attachToTarget");
  assert.equal(call?.params.targetId, "target-1");
  assert.equal(call?.params.flatten, true);

  await session.detach(attached.sessionId);
  assert.equal(session.sessionIdFor("target-1"), undefined);
  assert.equal(server.lastCall("Target.detachFromTarget")?.params.sessionId, attached.sessionId);
});

test("createTarget/closeTarget and newWindow forwarding", async (t) => {
  const { server, session } = await setup(t);

  const created = await session.createTarget("https://example.com/new");
  assert.match(created, /^target-\d+$/);
  assert.ok(server.targets().some((target) => target.id === created));
  assert.equal(server.lastCall("Target.createTarget")?.params.url, "https://example.com/new");

  const windowed = await session.createTarget("https://example.com/window", { newWindow: true });
  assert.equal(server.lastCall("Target.createTarget")?.params.newWindow, true);
  assert.ok(server.targets().some((target) => target.id === windowed));

  await session.closeTarget(created);
  assert.equal(server.targets().some((target) => target.id === created), false);
  assert.equal(server.lastCall("Target.closeTarget")?.params.targetId, created);
});

test("a request that is never answered times out with E_TIMEOUT", async (t) => {
  const server = new FakeCdpServer();
  await server.start();
  const session = await CdpSession.connect({ wsUrl: server.wsUrl(), requestTimeoutMs: 40 });
  t.after(async () => {
    await session.close().catch(() => undefined);
    await server.stop();
  });

  server.holdNext("Browser.getVersion");
  const error = await rejectsWithCode(session.send("Browser.getVersion"), "E_TIMEOUT");
  assert.match(error.details.message ?? "", /Browser\.getVersion/);
  // The socket is still usable after a single request timed out.
  const version = await session.version();
  assert.match(version.product, /^Chrome\//);
});

test("a -32000 target error maps to E_TARGET_LOST", async (t) => {
  const { server, page } = await setup(t);

  server.failNext("Runtime.evaluate", { code: -32000, message: "No target with given id found" });
  const error = await rejectsWithCode(page.evaluate("1"), "E_TARGET_LOST");
  assert.match(error.details.message ?? "", /No target with given id/);
});

test("a -32001 dead session maps to E_CDP_DISCONNECTED", async (t) => {
  const { server, session, attached } = await setup(t);

  server.setError("Runtime.evaluate", { code: -32001, message: "Session with given id not found." });
  await rejectsWithCode(
    session.send("Runtime.evaluate", { expression: "1" }, attached.sessionId),
    "E_CDP_DISCONNECTED",
  );
  server.setError("Runtime.evaluate", null);
});

test("a sessionId is bound to the socket that attached it", async (t) => {
  const server = new FakeCdpServer();
  await server.start();
  const first = await CdpSession.connect({ wsUrl: server.wsUrl(), requestTimeoutMs: 500 });
  const second = await CdpSession.connect({ wsUrl: server.wsUrl(), requestTimeoutMs: 500 });
  t.after(async () => {
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await server.stop();
  });

  const attached = await first.attach("target-1");
  const error = await rejectsWithCode(
    second.send("Runtime.evaluate", { expression: "navigator.webdriver" }, attached.sessionId),
    "E_CDP_DISCONNECTED",
  );
  assert.match(error.details.message ?? "", /Session with given id not found/);

  // The rightful owner still works with the same id.
  const own = await first.send<{ result: { value?: unknown } }>(
    "Runtime.evaluate",
    { expression: "navigator.webdriver", returnByValue: true },
    attached.sessionId,
  );
  assert.equal(own.result.value, false);
});

test("Browser.close is refused by the harness and surfaces as E_UNSUPPORTED", async (t) => {
  const { server, session } = await setup(t);

  const error = await rejectsWithCode(session.send("Browser.close"), "E_UNSUPPORTED");
  assert.match(error.details.message ?? "", /Browser\.close is not supported/);
  assert.equal(session.isConnected(), true);
  assert.equal(server.clientCount(), 1);
});

// ---------------------------------------------------------------------------
// Target loss / reconnect
// ---------------------------------------------------------------------------

test("Target.detachedFromTarget rejects a waiting navigation with E_TARGET_LOST", async (t) => {
  const { server, session, attached, page } = await setup(t, { emitLoadEvent: false });

  const navigation = page.navigate("https://example.com/hangs", { timeoutMs: 5_000 });
  await server.waitFor("Page.navigate");
  server.loseTarget("target-1");

  await rejectsWithCode(navigation, "E_TARGET_LOST");
  const detached = server.eventsSent("Target.detachedFromTarget");
  assert.equal(detached.length, 1);
  // Real Chrome emits this at browser level: no sessionId envelope, ids in params.
  assert.equal(detached[0]?.sessionId, undefined);
  assert.equal(detached[0]?.params.sessionId, attached.sessionId);
  assert.equal(detached[0]?.params.targetId, "target-1");

  // The page is dead, not hung: every later call fails fast.
  await rejectsWithCode(page.evaluate("1"), "E_TARGET_LOST");
});

test("a browser-level Target.detachedFromTarget without an envelope still prunes the page", async (t) => {
  const { server, session, attached, page } = await setup(t);

  // Same event shape as Chrome: params identify the session, no envelope.
  server.sendEvent("Target.detachedFromTarget", {
    sessionId: attached.sessionId,
    targetId: "target-1",
  });
  await waitUntil(() => session.sessionIdFor("target-1") === undefined);

  const event = server.eventsSent("Target.detachedFromTarget")[0];
  assert.equal(event?.sessionId, undefined);
  assert.equal(event?.params.sessionId, attached.sessionId);

  // The page listener reads params.sessionId, so it marks the target lost even
  // though the event itself arrived browser-wide.
  await rejectsWithCode(page.evaluate("1"), "E_TARGET_LOST");
});

test("a socket drop reconnects once, re-attaches and the page keeps working", async (t) => {
  // The delayed attach keeps the reconnect window observable: the fresh socket
  // is open, but `isConnected()` must stay false until the target is bound.
  const { server, session, attached: first, page } = await setup(t, {
    attachDelayMs: 40,
    readyState: ["complete"],
  });

  await page.navigate("https://example.com/one", { timeoutMs: 1_000 });
  assert.equal(server.calls("Page.enable").length, 1);

  const reattached = server.waitFor("Target.attachToTarget", { count: 2 });
  server.dropConnections();
  await reattached;
  // The re-attach request is in flight: the client is NOT connected yet.
  assert.equal(session.isConnected(), false);

  await waitUntil(
    () =>
      session.isConnected() &&
      session.sessionIdFor("target-1") !== undefined &&
      session.sessionIdFor("target-1") !== first.sessionId,
  );

  // Chrome allocated a new flattened session after the socket died.
  const secondSession = session.sessionIdFor("target-1");
  assert.notEqual(secondSession, first.sessionId);
  assert.equal(server.sessionBindings().some((binding) => binding.sessionId === secondSession), true);

  // A fresh session has Page disabled again; navigate re-enables it and settles.
  await page.navigate("https://example.com/two", { timeoutMs: 1_000 });
  assert.equal(page.url(), "https://example.com/two");
  assert.equal(server.calls("Page.enable").length, 2);

  server.setEvaluateResult("after-reconnect");
  assert.equal(await page.evaluate("1"), "after-reconnect");
});

test("a second drop is E_CDP_DISCONNECTED with no retry loop", async (t) => {
  const { server, session } = await setup(t);

  const reattached = server.waitFor("Target.attachToTarget", { count: 2 });
  server.dropConnections();
  await reattached;
  await waitUntil(() => session.isConnected());

  server.dropConnections();
  await waitUntil(() => !session.isConnected());
  // Give the close handler one turn to reach its final state.
  await sleep(20);

  const error = await rejectsWithCode(session.send("Browser.getVersion"), "E_CDP_DISCONNECTED");
  assert.match(error.details.message ?? "", /reconnect|socket is (?:not open|down)|dropped/i);
  assert.equal(session.isConnected(), false);
  assert.equal(server.calls("Target.attachToTarget").length, 2);
});

test("a socket drop keeps each pending request's own stage", async (t) => {
  const { server, page } = await setup(t, { emitLoadEvent: false });

  // Hold the navigate response so the request is still in flight on the drop.
  server.holdNext("Page.navigate");
  const navigation = page.navigate("https://example.com/hangs", { timeoutMs: 5_000 });
  await server.waitFor("Page.navigate");
  server.dropConnections();

  const error = await rejectsWithCode(navigation, "E_CDP_DISCONNECTED");
  assert.equal(error.details.stage, "navigate", "a dropped navigate is not a connect failure");
  assert.match(error.details.message ?? "", /closed unexpectedly/);
});

test("close() rejects pending requests and is idempotent", async (t) => {
  const { server, session } = await setup(t);

  server.holdNext("Browser.getVersion");
  const pending = session.send("Browser.getVersion");
  const outcome = pending.then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
  await server.waitFor("Browser.getVersion");

  await session.close();
  const error = await outcome;
  assert.ok(isWebSearchError(error));
  assert.equal(error.details.code, "E_CDP_DISCONNECTED");

  await session.close();
  assert.equal(session.isConnected(), false);
});

// ---------------------------------------------------------------------------
// Navigation: commit, then readiness
// ---------------------------------------------------------------------------

/** Number of `document.readyState` probes the client made (readiness polling). */
function readyStateProbes(server: FakeCdpServer): number {
  return server
    .calls("Runtime.evaluate")
    .filter((call) => /document\.readyState/.test(String(call.params.expression))).length;
}

/** The `frame` payload of a `Page.frameNavigated` event, for loaderId assertions. */
function frameOf(event: { params: Record<string, unknown> }): Record<string, unknown> {
  const frame = event.params.frame;
  assert.ok(typeof frame === "object" && frame !== null, "frameNavigated must carry a frame");
  return frame as Record<string, unknown>;
}

test("navigate commits, polls readyState to complete and enables Page once", async (t) => {
  const { server, page } = await setup(t);

  const started = Date.now();
  await page.navigate("https://example.com/search?q=x", { timeoutMs: 2_000 });
  const elapsed = Date.now() - started;

  assert.equal(page.url(), "https://example.com/search?q=x");
  assert.equal(server.calls("Page.navigate").length, 1);
  assert.equal(server.lastCall("Page.navigate")?.params.url, "https://example.com/search?q=x");
  assert.equal(server.calls("Page.getFrameTree").length, 1, "the pre-navigate loaderId is read first");
  assert.equal(server.calls("Page.enable").length, 1);
  assert.equal(server.eventsSent("Page.frameNavigated").length, 1);
  // The default sequence is loading → interactive → complete, so readiness can
  // only be reached by polling; a load event is not treated as readiness.
  assert.ok(readyStateProbes(server) >= 2, "readiness must be polled, not assumed");
  assert.ok(elapsed < 1_500, `a local commit should not take ${elapsed}ms`);

  await page.navigate("https://example.com/second", { timeoutMs: 2_000 });
  assert.equal(server.calls("Page.enable").length, 1, "Page.enable is per session, not per navigate");
  assert.equal(page.url(), "https://example.com/second");
});

test("navigate times out when the navigation never commits", async (t) => {
  const { page } = await setup(t, { emitFrameNavigated: false, navigateUpdatesUrl: false });

  const error = await rejectsWithCode(
    page.navigate("https://example.com/blocked", { timeoutMs: 60 }),
    "E_TIMEOUT",
  );
  assert.match(error.details.message ?? "", /did not finish loading/);
  assert.equal(error.details.stage, "navigate");
});

test("a stale frameNavigated from the previous document does not commit the next navigation", async (t) => {
  const { server, session, page } = await setup(t, { readyState: ["complete"] });

  await page.navigate("https://example.com/first", { timeoutMs: 1_000 });
  const firstLoader = server.frameLoaderId("target-1");
  assert.ok(firstLoader !== undefined);
  const sessionId = session.sessionIdFor("target-1");
  assert.ok(sessionId !== undefined);

  // The tab no longer commits: Chrome answers with a frameId but neither a new
  // URL nor a new loaderId, so the old document is still current.
  server.setNavigateUpdatesUrl(false);
  server.setEmitFrameNavigated(false);
  const started = Date.now();
  const next = page.navigate("https://example.com/second", { timeoutMs: 450 });
  await server.waitFor("Page.navigate", { count: 2 });

  // Replay the previous page's commit (same loaderId) plus its load event while
  // the new document is uncommitted. Neither may settle the wait.
  server.sendEvent(
    "Page.frameNavigated",
    {
      frame: {
        id: "frame-1",
        loaderId: firstLoader,
        url: "https://example.com/first",
        mimeType: "text/html",
        securityOrigin: "https://example.com",
      },
    },
    sessionId,
  );
  server.sendEvent("Page.loadEventFired", { timestamp: 1 }, sessionId);

  await rejectsWithCode(next, "E_TIMEOUT");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 300, `a stale commit settled the wait after only ${elapsed}ms`);
  assert.equal(page.url(), "https://example.com/first");
});

test("a redirect chain emits several commits and resolves on the first new loaderId", async (t) => {
  const { server, page } = await setup(t, {
    redirectChain: ["https://consent.example/continue"],
    readyState: ["complete"],
  });

  const started = Date.now();
  await page.navigate("https://www.google.com/search?q=x&hl=ru", { timeoutMs: 2_000 });
  const elapsed = Date.now() - started;

  const commits = server.eventsSent("Page.frameNavigated");
  assert.equal(commits.length, 2, "one commit per redirect hop plus the final document");
  const loaders = commits.map((event) => String(frameOf(event).loaderId));
  assert.notEqual(loaders[0], loaders[1], "each hop must carry its own loaderId");
  assert.equal(loaders[1], server.frameLoaderId("target-1"), "the final document is the committed one");
  assert.equal(page.url(), "https://www.google.com/search?q=x&hl=ru");
  assert.ok(elapsed < 1_500, `a redirect chain should resolve quickly, took ${elapsed}ms`);
  t.diagnostic(`redirect chain (2 commits) resolved in ${elapsed}ms via ${loaders.join(" → ")}`);
});

test("a same-document navigation resolves on navigatedWithinDocument and keeps the loaderId", async (t) => {
  const { server, session, page } = await setup(t, {
    sameDocumentNavigation: true,
    readyState: ["complete"],
  });
  const sessionId = session.sessionIdFor("target-1");
  assert.ok(sessionId !== undefined);
  const tree = await session.send<{ frameTree: { frame: { loaderId: string } } }>(
    "Page.getFrameTree",
    {},
    sessionId,
  );
  const before = tree.frameTree.frame.loaderId;

  await page.navigate("https://example.com/search?q=x#results", { timeoutMs: 1_000 });

  assert.equal(server.eventsSent("Page.frameNavigated").length, 0);
  assert.equal(server.eventsSent("Page.navigatedWithinDocument").length, 1);
  assert.equal(page.url(), "https://example.com/search?q=x#results");
  assert.equal(server.frameLoaderId("target-1"), before, "no new document, no new loaderId");
});

test("a page that never fires load but reaches interactive resolves", async (t) => {
  const { server, page } = await setup(t, { emitLoadEvent: false, readyState: ["interactive"] });

  const started = Date.now();
  await page.navigate("https://example.com/slow-tail", { timeoutMs: 2_000 });
  const elapsed = Date.now() - started;

  assert.equal(page.url(), "https://example.com/slow-tail");
  assert.equal(server.eventsSent("Page.loadEventFired").length, 0);
  // `interactive` is accepted only after its grace window, not on first sight.
  assert.ok(elapsed >= 180, `interactive was accepted too early (${elapsed}ms)`);
  assert.ok(elapsed < 1_500, `interactive should not wait for the deadline (${elapsed}ms)`);
  assert.ok(readyStateProbes(server) >= 2, "the grace window needs at least one extra poll");
  t.diagnostic(`interactive-only page resolved in ${elapsed}ms`);
});

test("a page stalled at readyState loading hits the deadline with E_TIMEOUT", async (t) => {
  const { server, page } = await setup(t, { readyState: ["loading"] });

  const started = Date.now();
  const error = await rejectsWithCode(
    page.navigate("https://example.com/stall", { timeoutMs: 400 }),
    "E_TIMEOUT",
  );
  const elapsed = Date.now() - started;

  assert.equal(error.details.stage, "navigate");
  assert.match(error.details.message ?? "", /did not finish loading/);
  assert.ok(elapsed >= 350, `timed out before the deadline (${elapsed}ms)`);
  assert.ok(elapsed < 1_500, `timed out far past the deadline (${elapsed}ms)`);
  assert.ok(readyStateProbes(server) >= 2, "a stalled page must still be polled");
  t.diagnostic(`stalled page hit the 400ms deadline after ${elapsed}ms`);
});

test("a navigation that returns without a commit event resolves on the target URL after the grace", async (t) => {
  const { server, page } = await setup(t, {
    emitFrameNavigated: false,
    readyState: ["complete"],
  });

  const started = Date.now();
  await page.navigate("https://example.com/silent", { timeoutMs: 2_000 });
  const elapsed = Date.now() - started;

  assert.equal(page.url(), "https://example.com/silent");
  assert.equal(server.eventsSent("Page.frameNavigated").length, 0);
  assert.ok(elapsed >= 200, `the URL fallback must wait for its grace (${elapsed}ms)`);
  assert.ok(
    server
      .calls("Runtime.evaluate")
      .some((call) => /location\.href|document\.URL/.test(String(call.params.expression))),
    "the fallback reads the target URL",
  );
  t.diagnostic(`URL fallback resolved a silent navigation in ${elapsed}ms`);
});

test("a transient renderer error during the readyState poll does not fail the navigation", async (t) => {
  // Chrome destroys the old execution context on commit; one probe can fail
  // with "Cannot find context with specified id". That is not a dead tab.
  const { server, page } = await setup(t);
  server.failNext("Runtime.evaluate", {
    code: -32000,
    message: "Cannot find context with specified id",
  });

  await page.navigate("https://example.com/context-race", { timeoutMs: 2_000 });
  assert.equal(page.url(), "https://example.com/context-race");
  assert.ok(readyStateProbes(server) >= 2, "the poll must survive the first failed probe");
});

test("Page.loadEventFired is only emitted after Page.enable", async (t) => {
  const { server, session, attached, page } = await setup(t, { readyState: ["complete"] });

  await session.send("Page.navigate", { url: "https://example.com/unenabled" }, attached.sessionId);
  await sleep(25);
  assert.equal(server.isPageEnabled(attached.sessionId), false);
  assert.equal(server.eventsSent("Page.loadEventFired").length, 0);

  // The real page enables the domain before navigating, so it settles. The
  // deadline is generous because `node --test` runs files concurrently and a
  // loaded machine can delay the fake server by more than a second.
  await page.navigate("https://example.com/enabled", { timeoutMs: 5_000 });
  assert.equal(server.isPageEnabled(attached.sessionId), true);
  assert.equal(server.calls("Page.enable").length, 1);
  assert.equal(server.eventsSent("Page.loadEventFired").length, 1);
});

test("navigate rejects an already-aborted signal with E_CANCELLED", async (t) => {
  const { page } = await setup(t);
  const controller = new AbortController();
  controller.abort();

  await rejectsWithCode(
    page.navigate("https://example.com/abort", { timeoutMs: 1_000, signal: controller.signal }),
    "E_CANCELLED",
  );
});

test("abort during the commit wait is E_CANCELLED", async (t) => {
  // No commit event and no URL change: the navigation is unambiguously inside
  // the commit phase when the abort lands.
  const { server, page } = await setup(t, {
    emitFrameNavigated: false,
    navigateUpdatesUrl: false,
  });
  const controller = new AbortController();
  const navigation = page.navigate("https://example.com/commit-abort", {
    timeoutMs: 2_000,
    signal: controller.signal,
  });
  await server.waitFor("Page.navigate");
  controller.abort();

  await rejectsWithCode(navigation, "E_CANCELLED");
  assert.equal(server.eventsSent("Page.frameNavigated").length, 0);
});

test("abort during the readyState poll is E_CANCELLED", async (t) => {
  const { server, page } = await setup(t, { readyState: ["loading"] });
  const controller = new AbortController();
  const navigation = page.navigate("https://example.com/ready-abort", {
    timeoutMs: 2_000,
    signal: controller.signal,
  });
  // The first Runtime.evaluate is the readiness probe: the commit has happened.
  await server.waitFor("Runtime.evaluate");
  controller.abort();

  await rejectsWithCode(navigation, "E_CANCELLED");
  assert.ok(readyStateProbes(server) >= 1);
});

// ---------------------------------------------------------------------------
// Runtime / page surface
// ---------------------------------------------------------------------------

test("evaluate sends returnByValue and awaitPromise, and returns the value", async (t) => {
  const { server, page } = await setup(t);

  server.setEvaluateResult({ answer: 42 });
  assert.deepEqual(await page.evaluate("({ answer: 42 })"), { answer: 42 });
  const call = server.lastCall("Runtime.evaluate");
  assert.equal(call?.params.returnByValue, true);
  assert.equal(call?.params.awaitPromise, false);

  server.setEvaluateHandler(() => Promise.resolve("later"));
  assert.equal(await page.evaluate("Promise.resolve('later')", { awaitPromise: true }), "later");
  assert.equal(server.lastCall("Runtime.evaluate")?.params.awaitPromise, true);
});

test("an evaluate exception becomes E_PARSE with the exception text and no stack", async (t) => {
  const { server, page } = await setup(t);

  server.setEvaluateHandler(() => {
    throw new Error("boom from the page");
  });
  const error = await rejectsWithCode(page.evaluate("throw new Error('boom')"), "E_PARSE");
  assert.equal(error.details.stage, "extract");
  assert.match(error.details.message ?? "", /boom from the page/);
  assert.equal((error.details.message ?? "").includes("    at "), false);
});

test("innerText returns body text and an empty string for a missing selector", async (t) => {
  const { server, page } = await setup(t);

  server.setEvaluateResult("Hello world");
  assert.equal(await page.innerText(), "Hello world");

  server.setEvaluateResult(null);
  assert.equal(await page.innerText("#missing"), "");

  const selectorCall = server.lastCall("Runtime.evaluate");
  assert.match(String(selectorCall?.params.expression), /querySelector\("#missing"\)/);
});

test("html returns the outer document HTML", async (t) => {
  const { server, page } = await setup(t);
  server.setEvaluateResult("<html><body>x</body></html>");
  assert.equal(await page.html(), "<html><body>x</body></html>");
  assert.match(String(server.lastCall("Runtime.evaluate")?.params.expression), /outerHTML/);
});

test("click by selector scrolls, rounds the center and presses/releases", async (t) => {
  const { server, page } = await setup(t);

  server.setEvaluateHandler((expression) =>
    expression.includes("querySelector") ? { x: 10.4, y: 20.6 } : null,
  );
  await page.click("#go");

  const expression = String(server.lastCall("Runtime.evaluate")?.params.expression);
  assert.match(expression, /scrollIntoView/);
  assert.match(expression, /getBoundingClientRect/);

  const clicks = server.calls("Input.dispatchMouseEvent");
  assert.equal(clicks.length, 2);
  assert.deepEqual(
    clicks.map((call) => call.params.type),
    ["mousePressed", "mouseReleased"],
  );
  for (const call of clicks) {
    assert.equal(call.params.x, 10);
    assert.equal(call.params.y, 21);
    assert.equal(call.params.button, "left");
    assert.equal(call.params.clickCount, 1);
  }
});

test("click by point rounds fractions and misses fail fast", async (t) => {
  const { server, page } = await setup(t);

  await page.click({ x: 5.5, y: 6.4 });
  const clicks = server.calls("Input.dispatchMouseEvent");
  assert.equal(clicks[0]?.params.x, 6);
  assert.equal(clicks[0]?.params.y, 6);

  server.setEvaluateResult(null);
  await rejectsWithCode(page.click("#missing"), "E_PARSE");
});

test("typeText sends rawKeyDown/char/keyUp so each character is inserted once", async (t) => {
  const { server, session } = await setup(t);
  const clock = new FakeClock();
  const page = createCdpPage(session, "target-1", { clock });

  await page.typeText("abc");

  const durations = clock.durations();
  assert.equal(durations.length, 3, "one human delay per character");
  for (const duration of durations) {
    assert.ok(duration >= 30 && duration <= 80, `delay ${duration} outside 30-80ms`);
  }

  const keys = server.keyEvents();
  assert.equal(keys.length, 9);
  assert.deepEqual(
    keys.map((event) => event.type),
    [
      "rawKeyDown",
      "char",
      "keyUp",
      "rawKeyDown",
      "char",
      "keyUp",
      "rawKeyDown",
      "char",
      "keyUp",
    ],
  );

  // Chrome inserts text on `keyDown`, so the key-down half must be rawKeyDown
  // and carry no text; otherwise keyDown + char double every character.
  const downs = keys.filter((event) => event.type === "rawKeyDown");
  assert.deepEqual(downs.map((event) => event.key), ["a", "b", "c"]);
  for (const down of downs) {
    assert.equal(down.text, undefined, "rawKeyDown must not carry text");
    assert.equal(down.unmodifiedText, undefined, "rawKeyDown must not carry unmodifiedText");
  }
  assert.equal(keys.some((event) => event.type === "keyDown"), false);

  assert.deepEqual(
    keys.filter((event) => event.type === "char").map((event) => event.text),
    ["a", "b", "c"],
  );

  // The fake inserts on char/keyDown, so a doubled sequence would read "aabbcc".
  const sessionId = session.sessionIdFor("target-1");
  assert.ok(sessionId !== undefined);
  assert.equal(server.typedText(sessionId), "abc");

  // No atomic insertText shortcut: that is the bot-like pattern we avoid.
  assert.equal(server.calls("Input.insertText").length, 0);
});

test("typeText accepts a custom delay range and stops when aborted", async (t) => {
  const { session } = await setup(t);
  const clock = new FakeClock();
  const page = createCdpPage(session, "target-1", { clock });

  await page.typeText("xy", { minMs: 10, maxMs: 12 });
  const durations = clock.durations();
  assert.equal(durations.length, 2);
  for (const duration of durations) assert.ok(duration >= 10 && duration <= 12);

  const controller = new AbortController();
  controller.abort();
  await rejectsWithCode(
    page.typeText("more", { minMs: 1, maxMs: 2, signal: controller.signal }),
    "E_CANCELLED",
  );
});

test("press Enter sends keyDown/keyUp with windowsVirtualKeyCode 13", async (t) => {
  const { server, page } = await setup(t);

  await page.press("Enter");
  const keys = server.calls("Input.dispatchKeyEvent");
  assert.equal(keys.length, 2);
  assert.deepEqual(
    keys.map((call) => call.params.type),
    ["keyDown", "keyUp"],
  );
  for (const call of keys) {
    assert.equal(call.params.key, "Enter");
    assert.equal(call.params.windowsVirtualKeyCode, 13);
    assert.equal(call.params.code, "Enter");
  }
  assert.equal(keys[0]?.params.text, "\r");
});

test("press maps Tab, Escape and ArrowDown to their virtual key codes", async (t) => {
  const { server, attached, page } = await setup(t);
  const expected = [
    { key: "Tab", vk: 9 },
    { key: "Escape", vk: 27 },
    { key: "ArrowDown", vk: 40 },
  ] as const;

  for (const item of expected) await page.press(item.key);

  const keys = server.calls("Input.dispatchKeyEvent");
  assert.equal(keys.length, expected.length * 2);
  expected.forEach((item, index) => {
    const down = keys[index * 2];
    const up = keys[index * 2 + 1];
    assert.equal(down?.params.type, "keyDown");
    assert.equal(up?.params.type, "keyUp");
    for (const call of [down, up]) {
      assert.equal(call?.params.key, item.key);
      assert.equal(call?.params.code, item.key);
      assert.equal(call?.params.windowsVirtualKeyCode, item.vk);
      assert.equal(call?.params.nativeVirtualKeyCode, item.vk);
      // Only Enter inserts text; navigation keys must not.
      assert.equal(call?.params.text, undefined);
    }
  });
  // The fake's input only sees insertions, so these keys leave it empty.
  assert.equal(server.typedText(attached.sessionId), "");
});

test("scroll uses window.scrollBy with the numeric delta", async (t) => {
  const { server, page } = await setup(t);
  server.setEvaluateResult(null);

  await page.scroll(400);
  assert.match(String(server.lastCall("Runtime.evaluate")?.params.expression), /window\.scrollBy\(0, 400\)/);

  await rejectsWithCode(page.scroll(Number.NaN), "E_PARSE");
});

test("screenshot requests jpeg/70 and returns a Buffer", async (t) => {
  const { server, page } = await setup(t, { screenshot: "shot-bytes" });

  const shot = await page.screenshot();
  assert.ok(Buffer.isBuffer(shot));
  assert.equal(shot.toString("utf8"), "shot-bytes");
  const call = server.lastCall("Page.captureScreenshot");
  assert.equal(call?.params.format, "jpeg");
  assert.equal(call?.params.quality, 70);
});

test("cookiesFor asks Chrome to scope cookies to the given URLs", async (t) => {
  const { server, page } = await setup(t, {
    cookies: [
      { name: "SID", value: "google-session", domain: ".google.com", path: "/" },
      { name: "yandexuid", value: "yandex-session", domain: ".yandex.ru", path: "/" },
      { name: "OTHER", value: "other", domain: ".example.com", path: "/" },
    ],
  });

  const cookies = await page.cookiesFor(["https://www.google.com/search?q=x"]);
  assert.deepEqual(cookies, [{ name: "SID", value: "google-session", domain: ".google.com" }]);
  assert.deepEqual(server.lastCall("Network.getCookies")?.params.urls, [
    "https://www.google.com/search?q=x",
  ]);

  const none = await page.cookiesFor(["https://www.yandex.ru/search/?text=x"]);
  assert.deepEqual(none, [{ name: "yandexuid", value: "yandex-session", domain: ".yandex.ru" }]);
});

test("bringToFront sends Page.bringToFront", async (t) => {
  const { server, page } = await setup(t);
  await page.bringToFront();
  assert.equal(server.calls("Page.bringToFront").length, 1);
});

test("title returns document.title", async (t) => {
  const { page } = await setup(t);
  assert.equal(await page.title(), "about:blank");
});

test("url() is populated from the target after createTarget and attach", async (t) => {
  const { server, session } = await setup(t);

  const created = await session.createTarget("https://example.com/created");
  // Chrome returns only a targetId from createTarget; without the cached URL a
  // page created here would report "" until its first navigation commits.
  const createdPage = createCdpPage(session, created);
  assert.equal(createdPage.url(), "https://example.com/created");

  await session.attach(created);
  const attachedPage = createCdpPage(session, created);
  assert.equal(attachedPage.url(), "https://example.com/created");

  // An existing tab keeps its current URL: attachToTarget has no URL, so it is
  // read with Target.getTargetInfo.
  const existing = server.addTarget({
    id: "target-existing",
    url: "https://example.com/existing",
  });
  await session.attach(existing.id);
  assert.equal(session.targetUrlFor(existing.id), "https://example.com/existing");
  assert.equal(createCdpPage(session, existing.id).url(), "https://example.com/existing");
});
