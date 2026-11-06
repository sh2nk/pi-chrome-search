/**
 * P12-A unit tests: `captureBytes` over a structural fake CDP session.
 *
 * The fake implements only the methods `captureBytes` uses (`createTarget`,
 * `attach`, `sessionIdFor`, `send`, `on`, `closeTarget`) so the assertions are
 * about behaviour, not about a mock library: which commands are sent, that the
 * capture target is always closed, and that a redirect chain is followed until
 * the body hop while `Content-Length` is enforced before the body is read.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { captureBytes } from "../../src/cdp/bytes.ts";
import type { CdpSession } from "../../src/cdp/session.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";

type Handler = (params: unknown, sessionId?: string) => void;

interface SentCommand {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface FakeResponseInput {
  requestId?: string;
  status?: number;
  contentType?: string;
  contentLength?: string;
  url?: string;
  body?: string;
  failBody?: Error;
}

interface FakeResponse extends FakeResponseInput {
  requestId: string;
  status: number;
}

class FakeSession {
  readonly handlers = new Map<string, Set<Handler>>();
  readonly sent: SentCommand[] = [];
  readonly closed: string[] = [];
  readonly responses: FakeResponse[];
  body = "PDFBYTES";
  throwOnFetch = false;
  emitOnEvaluate = true;

  constructor(responses: FakeResponseInput[] = [{}]) {
    this.responses = responses.map((entry, index) => {
      const normalized: FakeResponse = {
        ...entry,
        requestId: entry.requestId ?? `r${index + 1}`,
        status: entry.status ?? 200,
      };
      return normalized;
    });
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  createTarget(_url: string, _opts?: { background?: boolean }): Promise<string> {
    return Promise.resolve("capture-target");
  }

  attach(): Promise<{ targetId: string; sessionId: string }> {
    return Promise.resolve({ targetId: "capture-target", sessionId: "capture-session" });
  }

  sessionIdFor(): string | undefined {
    return "capture-session";
  }

  closeTarget(targetId: string): Promise<void> {
    this.closed.push(targetId);
    return Promise.resolve();
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    this.sent.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    if (method === "Fetch.getResponseBody") {
      const requestId = String(params.requestId ?? "");
      const response = this.responses.find((entry) => entry.requestId === requestId);
      if (response?.failBody !== undefined) throw response.failBody;
      const body = response?.body ?? this.body;
      return { body: Buffer.from(body).toString("base64"), base64Encoded: true } as T;
    }
    if (method === "Runtime.evaluate") {
      if (this.throwOnFetch) throw new Error("Runtime.evaluate rejected");
      if (this.emitOnEvaluate) {
        queueMicrotask(() => {
          for (const response of this.responses) {
            this.emit("Fetch.requestPaused", {
              requestId: response.requestId,
              request: { url: response.url ?? `https://example.test/${response.requestId}` },
              responseStatusCode: response.status,
              responseHeaders: [
                ...(response.contentType === undefined ? [] : [{ name: "content-type", value: response.contentType }]),
                ...(response.contentLength === undefined ? [] : [{ name: "content-length", value: response.contentLength }]),
              ],
            });
          }
        });
      }
    }
    return {} as T;
  }

  emit(method: string, params: unknown, sessionId = "capture-session"): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
  }

  methods(): string[] {
    return this.sent.map((command) => command.method);
  }
}

function asSession(fake: FakeSession): CdpSession {
  return fake as unknown as CdpSession;
}

test("captureBytes reads the body, returns the final URL and always closes its target", async () => {
  const fake = new FakeSession([{ contentType: "application/pdf; charset=binary", body: "PDFDATA" }]);
  const result = await captureBytes(asSession(fake), "https://example.test/doc.pdf");
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.status, 200);
  assert.equal(result.url, "https://example.test/r1");
  assert.equal(result.bytes.toString(), "PDFDATA");

  const methods = fake.methods();
  assert.ok(methods.includes("Fetch.enable"));
  assert.ok(methods.includes("Fetch.getResponseBody"));
  assert.ok(methods.includes("Fetch.failRequest"), "the request is failed so Chrome never renders it");
  assert.ok(methods.includes("Fetch.disable"));
  assert.deepEqual(fake.closed, ["capture-target"]);
  const create = fake.sent.find((command) => command.method === "Runtime.evaluate");
  assert.match(String(create?.params.expression), /fetch\("https:\/\/example\.test\/doc\.pdf"/);
  assert.match(String(create?.params.expression), /credentials/);
  const enable = fake.sent.find((command) => command.method === "Fetch.enable");
  assert.deepEqual(enable?.params.patterns, [{ urlPattern: "*", requestStage: "Response" }]);
});

test("a redirect chain is continued until the final response", async () => {
  const fake = new FakeSession([
    { status: 302, contentType: "text/html", url: "https://example.test/start" },
    { status: 200, contentType: "application/pdf", url: "https://cdn.example.test/doc.pdf", body: "FINAL" },
  ]);
  const result = await captureBytes(asSession(fake), "https://example.test/start");
  assert.equal(result.url, "https://cdn.example.test/doc.pdf");
  assert.equal(result.bytes.toString(), "FINAL");
  const continues = fake.sent.filter((command) => command.method === "Fetch.continueResponse");
  assert.equal(continues.length, 1, "the 302 is continued, not captured");
  assert.equal(continues[0]?.params.requestId, "r1");
});

test("Content-Length over the ceiling fails before the body is read (V12.5)", async () => {
  const fake = new FakeSession([
    { contentType: "application/pdf", contentLength: String(25 * 1024 * 1024), body: "never" },
  ]);
  await assert.rejects(
    () => captureBytes(asSession(fake), "https://example.test/big.pdf", { maxBytes: 10 * 1024 * 1024 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_UNSUPPORTED");
      assert.match(error.details.message ?? "", /25\.0 MB/);
      assert.match(error.details.message ?? "", /read\.pdfMaxBytes/);
      return true;
    },
  );
  assert.equal(
    fake.methods().includes("Fetch.getResponseBody"),
    false,
    "an oversized response must not be downloaded into the agent process",
  );
  assert.deepEqual(fake.closed, ["capture-target"]);
});

test("a chunked response is size-checked after the transfer", async () => {
  const fake = new FakeSession([{ contentType: "application/pdf", body: "0123456789" }]);
  await assert.rejects(
    () => captureBytes(asSession(fake), "https://example.test/doc.pdf", { maxBytes: 4 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_UNSUPPORTED");
      assert.match(error.details.message ?? "", /10 B/);
      return true;
    },
  );
  assert.deepEqual(fake.closed, ["capture-target"]);
});

test("a stalled capture times out and still closes the target", async () => {
  const fake = new FakeSession([{}]);
  fake.emitOnEvaluate = false;
  await assert.rejects(
    () => captureBytes(asSession(fake), "https://example.test/slow.pdf", { timeoutMs: 20 }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_TIMEOUT");
      assert.match(error.details.message ?? "", /example\.test/);
      return true;
    },
  );
  assert.deepEqual(fake.closed, ["capture-target"]);
});

test("an already-aborted signal refuses before creating a target", async () => {
  const fake = new FakeSession();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => captureBytes(asSession(fake), "https://example.test/doc.pdf", { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(isWebSearchError(error));
      assert.equal(error.details.code, "E_CANCELLED");
      return true;
    },
  );
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.closed.length, 0);
});
