/**
 * P0-C self-tests: the harness must be trustworthy before P1/P2/P3 rely on it.
 * Everything here is offline — the only socket is the fake CDP server on loopback.
 *
 *   node --test tests/unit/harness.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { WebSocket, type RawData } from "ws";

import type { CdpPage } from "../../src/cdp/types.ts";
import { FakeCdpServer } from "../helpers/fake-cdp-server.ts";
import { FakePage, type EvaluateHandler } from "../helpers/fake-page.ts";
import { FakeClock, isAbortError } from "../helpers/clock.ts";
import { FixtureError, fixtureExists, loadFixture } from "../helpers/load-fixture.ts";
import {
  assertFixtureClean,
  findUnsafe,
  gzip,
  gunzip,
  isFixtureClean,
  sanitizeFixture,
} from "../helpers/sanitize.ts";

// ---------------------------------------------------------------------------
// Minimal CDP test client (only what the harness needs)
// ---------------------------------------------------------------------------

interface CdpMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** Shape of a `Runtime.evaluate` response, for the harness assertions. */
interface EvaluateResponse {
  result: {
    type?: string;
    value?: unknown;
    subtype?: string;
    description?: string;
    objectId?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; objectId?: string };
  };
}

interface PendingResponse {
  resolve: (message: CdpMessage) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  method: string;
  resolve: (message: CdpMessage) => void;
  reject: (reason: unknown) => void;
}

function rawText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

function parseCdpMessage(raw: RawData): CdpMessage | undefined {
  try {
    const value: unknown = JSON.parse(rawText(raw));
    if (typeof value !== "object" || value === null) return undefined;
    return value as CdpMessage;
  } catch {
    return undefined;
  }
}

function resultOf<T>(message: CdpMessage): T {
  assert.equal(message.error, undefined, `expected a result, got ${message.error?.message ?? "unknown error"}`);
  assert.ok(message.result !== undefined, "response has neither result nor error");
  return message.result as T;
}

class TestClient {
  #ws: WebSocket;
  #closed: Promise<void>;
  #nextId = 1;
  #pending = new Map<number, PendingResponse>();
  #events: CdpMessage[] = [];
  #eventWaiters: EventWaiter[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.#closed = new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });
    ws.on("message", (raw) => {
      const message = parseCdpMessage(raw);
      if (message === undefined) return;
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
        return;
      }
      if (typeof message.method === "string") {
        this.#events.push(message);
        this.#flushEvents();
      }
    });
    ws.on("close", () => {
      const closed = new DOMException("fake CDP connection closed", "AbortError");
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(closed);
      }
      this.#pending.clear();
      for (const waiter of this.#eventWaiters) waiter.reject(closed);
      this.#eventWaiters = [];
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        ws.off("open", onOpen);
        reject(error);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
    return new TestClient(ws);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpMessage> {
    const id = this.#nextId++;
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    return new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new DOMException(`no response to ${method}`, "TimeoutError"));
      }, 2_000);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(payload, (error) => {
        if (error === undefined || error === null) return;
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  nextEvent(method: string, timeoutMs = 2_000): Promise<CdpMessage> {
    const index = this.#events.findIndex((event) => event.method === method);
    if (index >= 0) {
      const [event] = this.#events.splice(index, 1);
      return Promise.resolve(event!);
    }
    return new Promise<CdpMessage>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: EventWaiter = {
        method,
        resolve: (message) => {
          if (timer !== undefined) clearTimeout(timer);
          resolve(message);
        },
        reject,
      };
      timer = setTimeout(() => {
        this.#eventWaiters = this.#eventWaiters.filter((item) => item !== waiter);
        reject(new DOMException(`timed out waiting for event ${method}`, "TimeoutError"));
      }, timeoutMs);
      timer.unref();
      this.#eventWaiters.push(waiter);
    });
  }

  /**
   * Events received so far (already-consumed ones are gone). The two-client
   * isolation test uses this to prove an event did *not* arrive.
   */
  receivedEvents(method?: string): CdpMessage[] {
    const selected =
      method === undefined ? this.#events : this.#events.filter((event) => event.method === method);
    return selected.map((event) => ({ ...event }));
  }

  async waitClosed(timeoutMs = 2_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new DOMException("socket did not close", "TimeoutError")),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    const state = this.#ws.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) this.#ws.close();
    await this.#closed;
  }

  #flushEvents(): void {
    for (const waiter of [...this.#eventWaiters]) {
      const index = this.#events.findIndex((event) => event.method === waiter.method);
      if (index < 0) continue;
      const [event] = this.#events.splice(index, 1);
      this.#eventWaiters = this.#eventWaiters.filter((item) => item !== waiter);
      waiter.resolve(event!);
    }
  }
}

// ---------------------------------------------------------------------------
// FakePage
// ---------------------------------------------------------------------------

test("FakePage implements CdpPage and records every spyable call", async () => {
  const clock = new FakeClock({ now: 1_000 });
  const page = new FakePage({
    url: "https://www.google.com/search?q=example",
    title: "example - Google Search",
    text: "default visible text",
    texts: { "#rso": "serp container text" },
    html: "<html><body><h3>Example</h3></body></html>",
    cookies: [{ name: "SID", value: "secret", domain: ".google.com" }],
    screenshot: Buffer.from("png-bytes"),
    clock,
    random: () => 0.5,
    evaluate: {
      "document.title": () => "example - Google Search",
      "querySelectorAll(\"h3\")": () => 3,
    },
  });

  const contract: CdpPage = page;
  assert.equal(contract.url(), "https://www.google.com/search?q=example");
  assert.equal(await contract.title(), "example - Google Search");
  assert.equal(await contract.innerText(), "default visible text");
  assert.equal(await contract.innerText("#rso"), "serp container text");
  // Frozen contract: an unconfigured selector is empty, not the page text.
  assert.equal(await contract.innerText("#missing"), "");
  assert.equal(await contract.html(), "<html><body><h3>Example</h3></body></html>");

  await contract.navigate("https://www.google.com/search?q=second");
  assert.equal(contract.url(), "https://www.google.com/search?q=second");

  await contract.click("#q");
  await contract.click({ x: 10, y: 20 });
  await contract.typeText("abc");
  await contract.press("Enter");
  await contract.scroll(500);
  await contract.scroll(-120);
  await contract.bringToFront();
  await contract.bringToFront();

  const shot = await contract.screenshot();
  assert.deepEqual(shot, Buffer.from("png-bytes"));
  const cookies = await contract.cookiesFor(["https://www.google.com"]);
  assert.deepEqual(cookies, [{ name: "SID", value: "secret", domain: ".google.com" }]);

  assert.equal(await contract.evaluate<number>('document.querySelectorAll("h3").length'), 3);
  assert.equal(await page.evaluate("unmatched expression"), null);

  // Spies: sequence, counts, payloads.
  assert.deepEqual(page.navigations(), [
    "https://www.google.com/search?q=second",
  ]);
  assert.equal(page.callCount("navigate"), 1);
  assert.deepEqual(page.clicks(), ["#q", { x: 10, y: 20 }]);
  assert.deepEqual(page.presses(), ["Enter"]);
  assert.deepEqual(page.scrolls(), [500, -120]);
  assert.equal(page.scrollY(), 380);
  assert.equal(page.bringToFrontCount(), 2);
  assert.deepEqual(page.evaluateCalls().map((call) => call.expression), [
    'document.querySelectorAll("h3").length',
    "unmatched expression",
  ]);

  // Deterministic per-character delay: 30 + floor(0.5 * 51) = 55 ms.
  assert.deepEqual(page.typedTexts(), ["abc"]);
  assert.deepEqual(page.typeDelays(), [55, 55, 55]);
  assert.deepEqual(clock.durations(), [55, 55, 55]);
  for (const delay of page.typeDelays()) assert.ok(delay >= 30 && delay <= 80);

  // Abort is observed before the navigate mutates state.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => contract.navigate("https://example.com/blocked", { signal: controller.signal }),
    (error: unknown) => isAbortError(error),
  );
  assert.equal(contract.url(), "https://www.google.com/search?q=second");
  assert.equal(page.lastNavigation(), "https://example.com/blocked");
});

test("FakePage accepts function/map evaluate handlers and async values", async () => {
  const byFunction = new FakePage({ evaluate: async (expression) => expression.length });
  assert.equal(await byFunction.evaluate<number>("abc"), 3);

  const byMap = new FakePage({
    evaluate: new Map<string | RegExp, EvaluateHandler>([
      [/organic result/i, () => ["a", "b"]],
      ["h3", () => 2],
    ]),
  });
  assert.deepEqual(await byMap.evaluate<string[]>("/organic result/gi"), ["a", "b"]);
  assert.equal(await byMap.evaluate<number>("count h3"), 2);
  assert.equal(await byMap.evaluate("nothing"), null);
});

test("FakePage onNavigate can swap the document for wall/empty scenarios", async () => {
  const page = new FakePage({
    text: "normal serp",
    onNavigate: (url, current) => {
      if (url.includes("showcaptcha")) current.setText("Я не робот SmartCaptcha");
    },
  });
  await page.navigate("https://yandex.ru/search/?text=x");
  assert.equal(await page.innerText(), "normal serp");
  await page.navigate("https://yandex.ru/showcaptcha?retpath=x");
  assert.equal(await page.innerText(), "Я не робот SmartCaptcha");
});

test("FakePage.innerText returns an empty string for an unconfigured selector", async () => {
  const page = new FakePage({ text: "page text" });
  assert.equal(await page.innerText(), "page text");
  assert.equal(await page.innerText("#rso"), "");
  // No lazy fallback: a second miss is still empty.
  assert.equal(await page.innerText("#rso"), "");

  page.setText("results", "#rso");
  assert.equal(await page.innerText("#rso"), "results");
  assert.equal(await page.innerText(), "page text");

  // A function is an explicit selector-aware document and owns "missing".
  const dynamic = new FakePage({
    text: (selector) => (selector === "#rso" ? "dynamic results" : ""),
  });
  assert.equal(await dynamic.innerText(), "");
  assert.equal(await dynamic.innerText("#rso"), "dynamic results");
  assert.equal(await dynamic.innerText("#missing"), "");
  dynamic.setText("override", "#missing");
  assert.equal(await dynamic.innerText("#missing"), "override");
});

test("FakePage.cookiesFor filters by url instead of returning the whole jar", async () => {
  const page = new FakePage({
    cookies: [
      { name: "SID", value: "google", domain: ".google.com" },
      { name: "SESSION", value: "yandex", domain: ".yandex.ru" },
      { name: "HOSTONLY", value: "example", domain: "example.com" },
    ],
  });

  assert.deepEqual(
    (await page.cookiesFor(["https://www.google.com/search?q=x"])).map((cookie) => cookie.name),
    ["SID"],
  );
  // The leading dot matches the bare domain too.
  assert.deepEqual(
    (await page.cookiesFor(["https://google.com/"])).map((cookie) => cookie.name),
    ["SID"],
  );
  assert.deepEqual(
    (await page.cookiesFor(["https://yandex.ru/search/?text=x"])).map((cookie) => cookie.name),
    ["SESSION"],
  );
  // Host-only cookies still match their own host and its subdomains.
  assert.deepEqual(
    (await page.cookiesFor(["https://example.com/page"])).map((cookie) => cookie.name),
    ["HOSTONLY"],
  );
  assert.deepEqual(
    (await page.cookiesFor(["https://sub.example.com/page"])).map((cookie) => cookie.name),
    ["HOSTONLY"],
  );
  // A suffix match needs a dot boundary.
  assert.deepEqual(await page.cookiesFor(["https://notexample.com/page"]), []);
  // Union across the requested urls, no duplicates.
  assert.deepEqual(
    (await page.cookiesFor(["https://www.google.com", "https://yandex.ru"])).map(
      (cookie) => cookie.name,
    ),
    ["SID", "SESSION"],
  );
  assert.deepEqual(await page.cookiesFor(["about:blank"]), []);
  assert.equal((await page.cookiesFor([])).length, 3);
  assert.deepEqual(page.calls("cookiesFor").at(-1)?.urls, []);
});

// ---------------------------------------------------------------------------
// Fake CDP server
// ---------------------------------------------------------------------------

test("fake CDP server answers the P1-B subset over a real loopback socket", async (t) => {
  const server = new FakeCdpServer({
    cookies: [{ name: "SID", value: "secret", domain: ".google.com", path: "/" }],
    screenshot: "shot-bytes",
  });
  await server.start();
  const client = await TestClient.connect(server.wsUrl());
  t.after(async () => {
    await client.close();
    await server.stop();
  });

  assert.ok(server.port() > 0);
  assert.match(server.wsUrl(), /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
  assert.equal(server.clientCount(), 1);

  const version = resultOf<{ product: string; userAgent: string }>(
    await client.send("Browser.getVersion"),
  );
  assert.match(version.product, /^Chrome\//);
  assert.match(version.userAgent, /Chrome\//);

  const targets = resultOf<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
    await client.send("Target.getTargets"),
  );
  assert.ok(targets.targetInfos.length >= 1);
  const targetId = targets.targetInfos[0]!.targetId;

  const info = resultOf<{ targetInfo: { targetId: string } }>(
    await client.send("Target.getTargetInfo", { targetId }),
  );
  assert.equal(info.targetInfo.targetId, targetId);

  const attached = resultOf<{ sessionId: string }>(
    await client.send("Target.attachToTarget", { targetId, flatten: true }),
  );
  const sessionId = attached.sessionId;
  assert.match(sessionId, /^session-\d+$/);

  await client.send("Page.enable", {}, sessionId);
  const loadEvent = client.nextEvent("Page.loadEventFired");
  const navigate = resultOf<{ frameId: string; loaderId: string }>(
    await client.send("Page.navigate", { url: "https://example.com/search?q=x" }, sessionId),
  );
  assert.equal(navigate.frameId, "frame-1");
  const event = await loadEvent;
  assert.equal(event.sessionId, sessionId);
  assert.equal(event.method, "Page.loadEventFired");

  // Default evaluator answers the doctor's webdriver check.
  const webdriver = resultOf<{ result: { value?: unknown } }>(
    await client.send("Runtime.evaluate", {
      expression: "navigator.webdriver",
      returnByValue: true,
    }, sessionId),
  );
  assert.equal(webdriver.result.value, false);

  server.setEvaluateResult({ answer: 42 });
  const staticEval = resultOf<{ result: { value?: unknown } }>(
    await client.send("Runtime.evaluate", {
      expression: "({ answer: 42 })",
      returnByValue: true,
    }, sessionId),
  );
  assert.deepEqual(staticEval.result.value, { answer: 42 });

  server.setEvaluateHandler((expression) => (expression.includes("title") ? "from-handler" : "other"));
  const handlerEval = resultOf<{ result: { value?: unknown } }>(
    await client.send("Runtime.evaluate", { expression: "document.title" }, sessionId),
  );
  assert.equal(handlerEval.result.value, "from-handler");
  server.setEvaluateHandler(null);

  const cookies = resultOf<{ cookies: Array<{ name: string; value: string }> }>(
    await client.send("Network.getCookies", { urls: ["https://www.google.com"] }, sessionId),
  );
  assert.equal(cookies.cookies[0]?.name, "SID");

  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    text: "\r",
  }, sessionId);
  assert.equal(server.keyEvents()[0]?.key, "Enter");

  const screenshot = resultOf<{ data: string }>(
    await client.send("Page.captureScreenshot", { format: "jpeg" }, sessionId),
  );
  assert.equal(Buffer.from(screenshot.data, "base64").toString("utf8"), "shot-bytes");
  await client.send("Page.bringToFront", {}, sessionId);

  const unknown = await client.send("Nope.nope");
  assert.equal(unknown.error?.code, -32601);

  // Deterministic ids and a complete client→server log.
  const sent = server.sent();
  assert.ok(sent.some((request) => request.method === "Browser.getVersion"));
  assert.ok(sent.some((request) => request.method === "Target.attachToTarget" && request.params.flatten === true));
  assert.equal(server.calls("Page.navigate").length, 1);
  const navigateRequest = server.lastCall("Page.navigate");
  assert.equal(navigateRequest?.sessionId, sessionId);
  assert.equal(typeof navigateRequest?.id, "number");

  // waitFor() is fulfilled by a request, including ones already in flight.
  const awaited = server.waitFor("Target.getTargets", { count: server.calls("Target.getTargets").length + 1 });
  await client.send("Target.getTargets");
  assert.equal((await awaited).method, "Target.getTargets");

  // Error injection is one-shot and keeps the id.
  server.failNext("Target.createTarget", { code: -32000, message: "injected" });
  const failed = await client.send("Target.createTarget", { url: "https://example.com" });
  assert.equal(failed.error?.message, "injected");
  const created = resultOf<{ targetId: string }>(
    await client.send("Target.createTarget", { url: "https://example.com/created" }),
  );
  assert.equal(server.targets().length, 2);
  await client.send("Target.closeTarget", { targetId: created.targetId });
  assert.equal(server.targets().length, 1);

  // Target loss: commands on the dead session map to E_TARGET_LOST material.
  assert.equal(server.loseTarget(targetId), targetId);
  const lost = await client.send("Runtime.evaluate", { expression: "1" }, sessionId);
  assert.equal(lost.error?.code, -32000);
  assert.equal(lost.error?.message, "Target closed.");
  const destroyed = server.eventsSent("Target.targetDestroyed");
  assert.equal(destroyed.filter((event) => event.params.targetId === targetId).length, 1);
  assert.equal(destroyed.length, 2); // created + lost
  assert.equal(server.eventsSent("Inspector.detached").length, 1);
  assert.equal(server.eventsSent("Inspector.detached")[0]?.sessionId, sessionId);
});

test("Target.attachToTarget allocates a fresh session per attach and keeps the stale one usable", async (t) => {
  const server = new FakeCdpServer();
  await server.start();
  const client = await TestClient.connect(server.wsUrl());
  t.after(async () => {
    await client.close();
    await server.stop();
  });

  const targetId = resultOf<{ targetInfos: Array<{ targetId: string }> }>(
    await client.send("Target.getTargets"),
  ).targetInfos[0]!.targetId;

  const first = resultOf<{ sessionId: string }>(
    await client.send("Target.attachToTarget", { targetId, flatten: true }),
  );
  const second = resultOf<{ sessionId: string }>(
    await client.send("Target.attachToTarget", { targetId, flatten: true }),
  );
  assert.notEqual(first.sessionId, second.sessionId, "a second attach must not reuse the old sessionId");
  assert.match(first.sessionId, /^session-\d+$/);
  assert.match(second.sessionId, /^session-\d+$/);

  // Both mappings stay usable — Chrome does not silently invalidate the older one.
  for (const sessionId of [first.sessionId, second.sessionId]) {
    const evaluated = resultOf<EvaluateResponse>(
      await client.send("Runtime.evaluate", { expression: "navigator.webdriver", returnByValue: true }, sessionId),
    );
    assert.equal(evaluated.result.value, false);
  }

  // A stale (but still attached) session still drives navigation and gets its event.
  // Page events require the Page domain to be enabled on that session (real CDP).
  await client.send("Page.enable", {}, first.sessionId);
  const loadEvent = client.nextEvent("Page.loadEventFired");
  const navigate = resultOf<{ frameId: string }>(
    await client.send("Page.navigate", { url: "https://example.com/stale" }, first.sessionId),
  );
  assert.equal(navigate.frameId, "frame-1");
  assert.equal((await loadEvent).sessionId, first.sessionId);

  // Detaching one session leaves the other attached; the detached id is a clear error.
  await client.send("Target.detachFromTarget", { sessionId: second.sessionId });
  const detached = await client.send("Runtime.evaluate", { expression: "1" }, second.sessionId);
  assert.equal(detached.error?.code, -32001);
  assert.equal(detached.error?.message, "Session with given id not found.");
  const stillAttached = resultOf<{ targetInfo: { attached: boolean } }>(
    await client.send("Target.getTargetInfo", { targetId }),
  );
  assert.equal(stillAttached.targetInfo.attached, true);
  const alive = resultOf<EvaluateResponse>(
    await client.send("Runtime.evaluate", { expression: "navigator.webdriver", returnByValue: true }, first.sessionId),
  );
  assert.equal(alive.result.value, false);
});

test("Runtime.evaluate honours returnByValue, awaitPromise and exceptionDetails", async (t) => {
  const server = new FakeCdpServer();
  await server.start();
  const client = await TestClient.connect(server.wsUrl());
  t.after(async () => {
    await client.close();
    await server.stop();
  });

  const targetId = resultOf<{ targetInfos: Array<{ targetId: string }> }>(
    await client.send("Target.getTargets"),
  ).targetInfos[0]!.targetId;
  const { sessionId } = resultOf<{ sessionId: string }>(
    await client.send("Target.attachToTarget", { targetId, flatten: true }),
  );

  // returnByValue: true → the value is inlined.
  server.setEvaluateResult({ answer: 42 });
  const byValue = resultOf<EvaluateResponse>(
    await client.send("Runtime.evaluate", { expression: "({answer:42})", returnByValue: true }, sessionId),
  );
  assert.deepEqual(byValue.result.value, { answer: 42 });
  assert.equal(byValue.result.objectId, undefined);

  // returnByValue: false → an objectId and no value, as Chrome returns it.
  const byReference = resultOf<EvaluateResponse>(
    await client.send("Runtime.evaluate", { expression: "({answer:42})" }, sessionId),
  );
  assert.equal(byReference.result.value, undefined);
  assert.equal(byReference.result.description, "Object");
  assert.match(byReference.result.objectId ?? "", /^object-\d+$/);

  // awaitPromise: true resolves the handler's promise before serialising.
  server.setEvaluateHandler(() => Promise.resolve("settled"));
  const awaited = resultOf<EvaluateResponse>(
    await client.send(
      "Runtime.evaluate",
      { expression: "Promise.resolve('settled')", returnByValue: true, awaitPromise: true },
      sessionId,
    ),
  );
  assert.equal(awaited.result.value, "settled");
  assert.equal(awaited.exceptionDetails, undefined);

  // Without awaitPromise the response is a Promise objectId, never the value.
  const notAwaited = resultOf<EvaluateResponse>(
    await client.send(
      "Runtime.evaluate",
      { expression: "Promise.resolve('settled')", returnByValue: true },
      sessionId,
    ),
  );
  assert.equal(notAwaited.result.value, undefined);
  assert.equal(notAwaited.result.subtype, "promise");
  assert.match(notAwaited.result.objectId ?? "", /^object-\d+$/);

  // A synchronous throw is a normal response with exceptionDetails.
  server.setEvaluateHandler(() => {
    throw new Error("handler boom");
  });
  const thrown = resultOf<EvaluateResponse>(
    await client.send("Runtime.evaluate", { expression: "1", returnByValue: true }, sessionId),
  );
  assert.equal(thrown.exceptionDetails?.text, "Uncaught");
  assert.match(thrown.exceptionDetails?.exception?.description ?? "", /handler boom/);

  // A rejected promise with awaitPromise is "Uncaught (in promise)".
  server.setEvaluateHandler(async () => {
    throw new Error("async boom");
  });
  const rejected = resultOf<EvaluateResponse>(
    await client.send(
      "Runtime.evaluate",
      { expression: "Promise.reject(new Error('x'))", returnByValue: true, awaitPromise: true },
      sessionId,
    ),
  );
  assert.equal(rejected.exceptionDetails?.text, "Uncaught (in promise)");
  assert.match(rejected.exceptionDetails?.exception?.description ?? "", /async boom/);
  server.setEvaluateHandler(null);
});

test("Network.getCookies filters by url while getAllCookies returns the jar", async (t) => {
  const server = new FakeCdpServer({
    cookies: [
      { name: "SID", value: "google", domain: ".google.com", path: "/" },
      { name: "SESSION", value: "yandex", domain: ".yandex.ru", path: "/" },
      { name: "HOSTONLY", value: "example", domain: "example.com" },
    ],
  });
  await server.start();
  const client = await TestClient.connect(server.wsUrl());
  t.after(async () => {
    await client.close();
    await server.stop();
  });

  const targetId = resultOf<{ targetInfos: Array<{ targetId: string }> }>(
    await client.send("Target.getTargets"),
  ).targetInfos[0]!.targetId;
  const { sessionId } = resultOf<{ sessionId: string }>(
    await client.send("Target.attachToTarget", { targetId, flatten: true }),
  );

  const google = resultOf<{ cookies: Array<{ name: string }> }>(
    await client.send("Network.getCookies", { urls: ["https://www.google.com/search?q=x"] }, sessionId),
  );
  assert.deepEqual(google.cookies.map((cookie) => cookie.name), ["SID"]);

  const yandexSub = resultOf<{ cookies: Array<{ name: string }> }>(
    await client.send("Network.getCookies", { urls: ["https://mail.yandex.ru/"] }, sessionId),
  );
  assert.deepEqual(yandexSub.cookies.map((cookie) => cookie.name), ["SESSION"]);

  const union = resultOf<{ cookies: Array<{ name: string }> }>(
    await client.send(
      "Network.getCookies",
      { urls: ["https://www.google.com", "https://yandex.ru"] },
      sessionId,
    ),
  );
  assert.deepEqual(union.cookies.map((cookie) => cookie.name), ["SID", "SESSION"]);

  const none = resultOf<{ cookies: Array<{ name: string }> }>(
    await client.send("Network.getCookies", { urls: ["https://notgoogle.com/"] }, sessionId),
  );
  assert.deepEqual(none.cookies, []);

  // No urls (or an empty list) means the whole jar, as in real CDP.
  const wholeJar = resultOf<{ cookies: Array<{ name: string }> }>(
    await client.send("Network.getCookies", {}, sessionId),
  );
  assert.equal(wholeJar.cookies.length, 3);
  const emptyUrls = resultOf<{ cookies: Array<{ name: string }> }>(
    await client.send("Network.getCookies", { urls: [] }, sessionId),
  );
  assert.equal(emptyUrls.cookies.length, 3);

  const all = resultOf<{ cookies: Array<{ name: string }> }>(
    await client.send("Network.getAllCookies", {}, sessionId),
  );
  assert.equal(all.cookies.length, 3);
});

test("fake CDP server routes session events only to the owning client", async (t) => {
  const server = new FakeCdpServer();
  await server.start();
  const a = await TestClient.connect(server.wsUrl());
  const b = await TestClient.connect(server.wsUrl());
  t.after(async () => {
    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    await server.stop();
  });

  const firstTarget = resultOf<{ targetInfos: Array<{ targetId: string }> }>(
    await a.send("Target.getTargets"),
  ).targetInfos[0]!.targetId;
  const secondTarget = server.addTarget({ url: "https://example.com/second" }).id;

  const sessionA = resultOf<{ sessionId: string }>(
    await a.send("Target.attachToTarget", { targetId: firstTarget, flatten: true }),
  ).sessionId;
  const sessionB = resultOf<{ sessionId: string }>(
    await b.send("Target.attachToTarget", { targetId: secondTarget, flatten: true }),
  ).sessionId;
  assert.notEqual(sessionA, sessionB);

  // Real CDP only emits Page lifecycle events after Page.enable.
  await a.send("Page.enable", {}, sessionA);
  const loadOnA = a.nextEvent("Page.loadEventFired");
  await a.send("Page.navigate", { url: "https://example.com/a" }, sessionA);
  assert.equal((await loadOnA).sessionId, sessionA);

  // Synchronise B: a broadcast event would already be queued on its socket
  // before this response arrives.
  await b.send("Browser.getVersion");
  assert.deepEqual(b.receivedEvents("Page.loadEventFired"), []);

  // Browser-level events broadcast; Inspector.detached stays with its session.
  server.loseTarget(secondTarget);
  const destroyedOnB = b.nextEvent("Target.targetDestroyed");
  const destroyedOnA = a.nextEvent("Target.targetDestroyed");
  assert.equal((await destroyedOnB).params?.targetId, secondTarget);
  assert.equal((await destroyedOnA).params?.targetId, secondTarget);

  await a.send("Browser.getVersion");
  assert.equal(a.receivedEvents("Inspector.detached").length, 0);
  const detachedOnB = b.receivedEvents("Inspector.detached");
  assert.equal(detachedOnB.length, 1);
  assert.equal(detachedOnB[0]?.sessionId, sessionB);
});

test("fake CDP server drops a socket and accepts a reconnect", async (t) => {
  const server = new FakeCdpServer();
  await server.start();
  const first = await TestClient.connect(server.wsUrl());
  t.after(async () => {
    await first.close().catch(() => undefined);
    await server.stop();
  });

  server.dropOnNext("Browser.getVersion");
  const closed = first.waitClosed();
  const pending = first.send("Browser.getVersion").then(
    () => "resolved",
    (error: unknown) => error,
  );
  await closed;
  assert.ok((await pending) instanceof Error);
  assert.equal(server.clientCount(), 0);

  const second = await TestClient.connect(server.wsUrl());
  t.after(async () => {
    await second.close();
  });
  const version = resultOf<{ product: string }>(await second.send("Browser.getVersion"));
  assert.match(version.product, /^Chrome\//);
  assert.equal(server.clientCount(), 1);

  const closedSecond = second.waitClosed();
  server.dropConnections();
  await closedSecond;
  assert.equal(server.clientCount(), 0);
});

// ---------------------------------------------------------------------------
// FakeClock
// ---------------------------------------------------------------------------

test("FakeClock advances, records sleeps and wakes on abort", async () => {
  const clock = new FakeClock({ now: 1_000 });
  assert.equal(clock.now(), 1_000);

  await clock.sleep(250);
  assert.equal(clock.now(), 1_250);
  assert.deepEqual(clock.durations(), [250]);
  assert.equal(clock.totalSleptMs(), 250);
  assert.equal(clock.pendingCount(), 0);

  clock.setAutoAdvance(false);
  const pending = clock.sleep(500);
  assert.equal(clock.pendingCount(), 1);
  clock.advance(200);
  assert.equal(clock.now(), 1_450);
  assert.equal(clock.pendingCount(), 1);
  clock.advance(300);
  await pending;
  assert.equal(clock.now(), 1_750);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(clock.sleepLog().at(-1)?.resolvedAt, 1_750);

  const controller = new AbortController();
  const aborted = clock.sleep(10_000, controller.signal);
  controller.abort();
  await assert.rejects(aborted, (error: unknown) => isAbortError(error));
  assert.equal(clock.pendingCount(), 0);

  const reason = new Error("custom cancellation");
  const reasonController = new AbortController();
  const withReason = clock.sleep(5_000, reasonController.signal);
  reasonController.abort(reason);
  await assert.rejects(withReason, (error: unknown) => error === reason);

  assert.throws(() => clock.sleep(-1), RangeError);
  assert.throws(() => clock.advance(-1), RangeError);
});

// ---------------------------------------------------------------------------
// Sanitizer + fixtures
// ---------------------------------------------------------------------------

test("sanitizer removes session values, cookies, emails, IPs and personal queries", () => {
  const personalQueries = ["very specific personal query", "buy cheap vpn"];
  const dirty = [
    "<html><head><script>var sxsrf = \"AbCdEf\";</script></head><body>",
    '<a href="https://www.google.com/search?q=buy+cheap+vpn&sxsrf=AbCdEf&reqid=0x1234&sca_esv=999&hl=ru">x</a>',
    '<input name="csrf_token" value="deadbeef">',
    "Cookie: SID=secret; HSID=also-secret",
    "<p>Authorization: Bearer token123</p>",
    "<p>contact user@example.com and encoded user%40example.com</p>",
    "<p>server 203.0.113.42 and loopback 127.0.0.1 and 0.0.0.0</p>",
    "<p>query: very specific personal query</p>",
    '<p>{"cookies":"abc","access_token":"t0ken"}</p>',
    "</body></html>",
  ].join("");

  const clean = sanitizeFixture(dirty, { personalQueries });

  for (const secret of [
    "AbCdEf",
    "0x1234",
    "sca_esv=999",
    "deadbeef",
    "also-secret",
    "token123",
    "user@example.com",
    "user%40example.com",
    "203.0.113.42",
    "very specific personal query",
    "buy+cheap+vpn",
    "t0ken",
  ]) {
    assert.equal(clean.includes(secret), false, `sanitizer left ${secret}`);
  }
  assert.ok(clean.includes("127.0.0.1"));
  assert.ok(clean.includes("0.0.0.0"));
  assert.ok(clean.includes("[redacted-email]"));
  assert.ok(clean.includes("[redacted-ip]"));
  assert.ok(clean.includes("[redacted-query]"));

  assert.equal(isFixtureClean(clean, { personalQueries }), true);
  assertFixtureClean(clean, { personalQueries });
  assert.ok(findUnsafe(dirty, { personalQueries }).length > 0);
  assert.equal(findUnsafe(clean).length, 0);
  assert.throws(() => assertFixtureClean(dirty), /not sanitized/);
});

test("sanitizer keeps cookie prose but redacts real headers, inputs and JSON fields", () => {
  const prose = [
    "<p>How to set a cookie: a guide for authors</p>",
    "<p>cookie: no pair here either</p>",
    "<p>set cookie header: see the docs</p>",
  ].join("");
  // Negative: prose must survive sanitizing *and* not be reported as a finding.
  assert.equal(sanitizeFixture(prose), prose);
  assert.deepEqual(findUnsafe(prose), []);
  assert.equal(isFixtureClean(prose), true);

  // Positive: a header with a name=value pair is redacted, both cased forms.
  assert.equal(sanitizeFixture("Cookie: SID=secret"), "Cookie: [redacted]");
  assert.equal(sanitizeFixture("cookie: sid=secret"), "cookie: [redacted]");
  assert.equal(
    sanitizeFixture("Set-Cookie: SID=secret; Path=/; HttpOnly"),
    "Set-Cookie: [redacted]",
  );
  assert.ok(findUnsafe("Cookie: SID=secret").some((finding) => finding.rule === "cookie-header"));

  // Positive: SERP correlation tokens as hidden inputs and inline JSON, in both
  // double- and single-quoted forms.
  const tokens = [
    "tok-ei",
    "tok-ved",
    "tok-gs",
    "tok-vet",
    "tok-usg",
    "tok-sa",
    "tok-cd",
    "tok-single",
  ];
  const dirty = [
    '<input type="hidden" name="ei" value="tok-ei">',
    '<input name="ved" value="tok-ved">',
    '<input value="tok-gs" name="gs_lcp">',
    '<p>{"vet":"tok-vet","usg":"tok-usg"}</p>',
    "<p>{'sa': 'tok-sa', 'cd': 'tok-cd'}</p>",
    "<input id='ei' value='tok-single'>",
  ].join("");
  const clean = sanitizeFixture(dirty);
  for (const token of tokens) assert.equal(clean.includes(token), false, `sanitizer left ${token}`);
  assert.ok(findUnsafe(dirty).length > 0);
  assert.deepEqual(findUnsafe(clean), []);
});

test("sanitizer redacts unquoted attributes and escaped inline JSON tokens", () => {
  // A real SERP emits hidden inputs without quotes and embeds its config as a
  // JSON string inside a script, so the tokens are escaped. Both shapes leaked
  // before the dedicated rules existed.
  const secrets = ["plain-ei", "plain-ved", "quoted-name", "escaped-ved", "escaped-ei"];
  const dirty = [
    '<input type="hidden" name=ei value=plain-ei>',
    '<input name=ved value="plain-ved">',
    '<input name="ei" value=quoted-name>',
    '<script>var cfg = {\\"ved\\":\\"escaped-ved\\",\\"ei\\":\\"escaped-ei\\"};</script>',
  ].join("");

  const clean = sanitizeFixture(dirty);
  for (const secret of secrets) {
    assert.equal(clean.includes(secret), false, `sanitizer left ${secret}`);
  }
  assert.ok(findUnsafe(dirty).length > 0);
  assert.deepEqual(findUnsafe(clean), []);
});

test("sanitizer redacts percent-encoded tokens in nested URLs", () => {
  // Live Google capture: the SERP carries its own URL inside attributes/JS with
  // `%26sxsrf%3D…` separators, and the plain rules missed every one of them.
  const secrets = ["AKL5yDh4encoded", "367e406cencoded"];
  const dirty =
    "<a href=\"/search?q=x%26sca_esv%3D367e406cencoded%26hl%3Dru%26sxsrf%3DAKL5yDh4encoded%26udm%3D2\">x</a>";

  const clean = sanitizeFixture(dirty);
  for (const secret of secrets) {
    assert.equal(clean.includes(secret), false, `sanitizer left ${secret}`);
  }
  assert.ok(clean.includes("sxsrf%3D"), "the parameter name must survive for adapter debugging");
  assert.ok(findUnsafe(dirty).length > 0);
  assert.deepEqual(findUnsafe(clean), []);
});

test("gzip/gunzip round-trip", () => {
  const sample = "<html><body><h3>Example</h3></body></html>";
  const compressed = gzip(sample);
  assert.ok(Buffer.isBuffer(compressed));
  assert.equal(gunzip(compressed), sample);
});

function makeFixtureDir(t: TestContext): string {
  const base = "/tmp/opencode";
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "pi-chrome-search-p0c-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFixture(dir: string, name: string, html: string, meta: unknown): void {
  writeFileSync(join(dir, `${name}.html.gz`), gzip(html));
  writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify(meta));
}

test("load-fixture round-trips a gzipped sample and rejects dirty metadata", (t) => {
  const dir = makeFixtureDir(t);
  const html =
    '<html><body><h3>Example result</h3><a href="https://example.com/page">Example</a></body></html>';
  const meta = {
    engine: "google",
    urlPathShape: "/search?q=<query>&hl=ru",
    queryClass: "no-ai",
    capturedAt: "2026-11-05",
    ai: "no",
    results: 1,
  };
  writeFixture(dir, "google-no-ai", html, meta);

  assert.equal(fixtureExists("google-no-ai", dir), true);
  assert.equal(fixtureExists("google-missing", dir), false);

  const loaded = loadFixture("google-no-ai", { dir });
  assert.equal(loaded.name, "google-no-ai");
  assert.equal(loaded.meta.engine, "google");
  assert.equal(loaded.meta.ai, "no");
  assert.equal(loaded.html, html);
  assert.equal(loaded.chars, html.length);
  assert.ok(loaded.compressedBytes > 0);
  assert.equal(loaded.paths.html, join(dir, "google-no-ai.html.gz"));

  writeFixture(dir, "google-bad-engine", html, { ...meta, engine: "bing" });
  assert.throws(
    () => loadFixture("google-bad-engine", { dir }),
    (error: unknown) => error instanceof FixtureError && /engine/.test(error.message),
  );

  writeFixture(dir, "google-bad-shape", html, {
    ...meta,
    urlPathShape: "/search?q=literal+query&hl=ru",
  });
  assert.throws(
    () => loadFixture("google-bad-shape", { dir }),
    (error: unknown) => error instanceof FixtureError && /urlPathShape/.test(error.message),
  );

  writeFixture(dir, "google-bad-class", html, { ...meta, queryClass: "Not A Slug" });
  assert.throws(
    () => loadFixture("google-bad-class", { dir }),
    (error: unknown) => error instanceof FixtureError && /queryClass/.test(error.message),
  );

  writeFixture(dir, "google-bad-date", html, { ...meta, capturedAt: "yesterday" });
  assert.throws(
    () => loadFixture("google-bad-date", { dir }),
    (error: unknown) => error instanceof FixtureError && /capturedAt/.test(error.message),
  );

  writeFixture(dir, "google-dirty", '<a href="mailto:user@example.com">mail</a>' + html, meta);
  assert.throws(
    () => loadFixture("google-dirty", { dir }),
    (error: unknown) =>
      error instanceof FixtureError && /not sanitized/.test(error.message) && /email/.test(error.message),
  );

  const personalQuery = "very specific personal query";
  writeFixture(dir, "google-personal", html.replace("Example result", personalQuery), meta);
  assert.equal(loadFixture("google-personal", { dir }).html.includes(personalQuery), true);
  assert.throws(
    () => loadFixture("google-personal", { dir, personalQueries: [personalQuery] }),
    (error: unknown) => error instanceof FixtureError && /not sanitized/.test(error.message),
  );

  assert.throws(
    () => loadFixture("google-missing", { dir }),
    (error: unknown) => error instanceof FixtureError && /cannot read/.test(error.message),
  );
  assert.throws(
    () => loadFixture("../escape", { dir }),
    (error: unknown) => error instanceof FixtureError && /name/.test(error.message),
  );
});

test("load-fixture validates real calendar dates and tolerates bad names in fixtureExists", (t) => {
  const dir = makeFixtureDir(t);
  const html = "<html><body>ok</body></html>";
  const meta = {
    engine: "google",
    urlPathShape: "/search?q=<query>&hl=ru",
    queryClass: "no-ai",
    capturedAt: "2026-11-05",
  };

  // Date.parse("2026-02-30") rolls over to March 2, so the loader must check
  // the calendar itself: month range, day range and leap years.
  const impossible = [
    "2026-02-30",
    "2025-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-11-05T24:00:00Z",
    "2026-11-05T23:60:00Z",
    "2026-11-05T23:59:60Z",
  ];
  for (const [index, capturedAt] of impossible.entries()) {
    const name = `bad-date-${index}`;
    writeFixture(dir, name, html, { ...meta, capturedAt });
    assert.throws(
      () => loadFixture(name, { dir }),
      (error: unknown) => error instanceof FixtureError && /capturedAt/.test(error.message),
      `accepted impossible capturedAt ${capturedAt}`,
    );
  }

  writeFixture(dir, "good-leap-day", html, { ...meta, capturedAt: "2024-02-29" });
  assert.equal(loadFixture("good-leap-day", { dir }).meta.capturedAt, "2024-02-29");
  writeFixture(dir, "good-timestamp", html, {
    ...meta,
    capturedAt: "2026-11-05T23:59:59.123+03:00",
  });
  assert.equal(
    loadFixture("good-timestamp", { dir }).meta.capturedAt,
    "2026-11-05T23:59:59.123+03:00",
  );

  // A probe or table-driven test may ask about any string; an invalid name is
  // simply not a fixture, while loadFixture() still rejects it loudly.
  assert.equal(fixtureExists("a/b", dir), false);
  assert.equal(fixtureExists("../escape", dir), false);
  assert.equal(fixtureExists("UPPER", dir), false);
  assert.equal(fixtureExists("", dir), false);
  assert.throws(
    () => loadFixture("a/b", { dir }),
    (error: unknown) => error instanceof FixtureError && /name/.test(error.message),
  );
});

test("load-fixture reports a truncated or non-gzip html.gz without crashing", (t) => {
  const dir = makeFixtureDir(t);
  const meta = {
    engine: "yandex",
    urlPathShape: "/search/?text=<query>",
    queryClass: "wall",
    capturedAt: "2026-11-05",
  };
  const writeMeta = (name: string): void => {
    writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify(meta));
  };

  writeMeta("plain-bytes");
  writeFileSync(join(dir, "plain-bytes.html.gz"), Buffer.from("<html>not gzip</html>"));
  assert.throws(
    () => loadFixture("plain-bytes", { dir }),
    (error: unknown) => error instanceof FixtureError && /not valid gzip/.test(error.message),
  );

  const full = gzip("<html><body>truncated capture</body></html>");
  const truncated = full.subarray(0, Math.floor(full.length / 2));
  assert.ok(truncated.byteLength > 0 && truncated.byteLength < full.byteLength);
  writeMeta("truncated-gzip");
  writeFileSync(join(dir, "truncated-gzip.html.gz"), truncated);
  assert.throws(
    () => loadFixture("truncated-gzip", { dir }),
    (error: unknown) => error instanceof FixtureError && /not valid gzip/.test(error.message),
  );

  writeMeta("empty-gzip");
  writeFileSync(join(dir, "empty-gzip.html.gz"), Buffer.alloc(0));
  assert.throws(
    () => loadFixture("empty-gzip", { dir }),
    (error: unknown) => error instanceof FixtureError && /not valid gzip/.test(error.message),
  );

  // A valid gzip of empty HTML still loads: emptiness is a parser concern, not
  // a loader error.
  writeFixture(dir, "empty-html", "", meta);
  assert.equal(loadFixture("empty-html", { dir }).html, "");
});

test("sanitizer removes profile identity from SERP bootstrap JSON", () => {
  // A signed-in Yandex SERP embeds the account in its JSON: the live captures
  // shipped a display name, an avatar id and a stable user id, none of which the
  // earlier field list covered.
  const dirty = [
    '<script>window.cfg={"displayUserName":"Test Name","userName":"Tester",',
    '"userLogin":"tester","avatarId":"6218514/abcdef","yandexUid":"3509591631759753405"};</script>',
  ].join("");

  const clean = sanitizeFixture(dirty);
  for (const secret of ["Test Name", "Tester", "tester", "6218514/abcdef", "3509591631759753405"]) {
    assert.equal(clean.includes(secret), false, `sanitizer left ${secret}`);
  }
  assert.ok(clean.includes("displayUserName"), "the key must survive for debugging");
  assert.ok(findUnsafe(dirty).length > 0);
  assert.deepEqual(findUnsafe(clean), []);
});

test("sanitizer removes the Yandex avatar asset path", () => {
  // The signed-in header embeds `avatars.mds.yandex.net/get-yapic/<uid>/…`; the
  // uid is stable and identifies the profile even when every JSON key is gone.
  const dirty = '<img src="https://avatars.mds.yandex.net/get-yapic/6218514/wm9S4XEsTKcTl8Wg2Olh/50">';
  const clean = sanitizeFixture(dirty);
  assert.equal(clean.includes("6218514"), false);
  assert.match(clean, /\[redacted-avatar\]/);
  assert.deepEqual(findUnsafe(clean), []);
});
