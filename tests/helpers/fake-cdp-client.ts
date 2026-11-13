/**
 * In-memory CDP transport for the session lifecycle tests (PLAN P3).
 *
 * It implements the same `CdpClient` seam production uses, so a test can drive
 * connect refusal, the Allow wait, a dropped socket, a user-closed tab and a
 * PDF slot release without a socket, Chrome or the user's profile.
 */

import type { CdpClient, CdpEventHandler, CdpTarget } from "../../src/cdp/types.ts";
import { fail } from "../../src/runtime/errors.ts";
import type { BrowserInfo } from "../../src/cdp/types.ts";

export interface FakeClientOptions {
  targets?: Array<{ id: string; url?: string; type?: string }>;
  browser?: BrowserInfo;
  windowId?: number;
}

interface FakeTarget {
  id: string;
  url: string;
  type: string;
}

export interface FakeCommand {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const DEFAULT_BROWSER: BrowserInfo = {
  product: "Chrome/157.0.0.0",
  protocolVersion: "1.3",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
  revision: "@fake",
  jsVersion: "15.7",
};

function disconnected(method: string): Error {
  return fail("E_CDP_DISCONNECTED", "connect", {
    message: `fake client disconnected during ${method}`,
  });
}

export class FakeCdpClient implements CdpClient {
  readonly commands: FakeCommand[] = [];
  readonly created: string[] = [];
  readonly closed: string[] = [];
  readonly attached: string[] = [];

  #targets = new Map<string, FakeTarget>();
  #sessions = new Map<string, string>();
  #handlers = new Map<string, Set<CdpEventHandler>>();
  #connected = true;
  #nextTarget = 1;
  #nextSession = 1;
  #browser: BrowserInfo;
  #windowId: number;
  #failNext: { method: string; error: Error } | undefined;
  #evaluate: (expression: string) => unknown = () => false;

  constructor(options: FakeClientOptions = {}) {
    for (const target of options.targets ?? []) {
      this.#targets.set(target.id, {
        id: target.id,
        url: target.url ?? "about:blank",
        type: target.type ?? "page",
      });
    }
    this.#browser = options.browser ?? DEFAULT_BROWSER;
    this.#windowId = options.windowId ?? 1;
  }

  // --- CdpClient -----------------------------------------------------------

  isConnected(): boolean {
    return this.#connected;
  }

  async version(): Promise<BrowserInfo> {
    return { ...this.#browser };
  }

  async targets(): Promise<CdpTarget[]> {
    this.#assertConnected("Target.getTargets");
    return [...this.#targets.values()].map((target) => ({ ...target, title: "" }));
  }

  async attach(targetId: string): Promise<{ targetId: string; sessionId: string }> {
    this.#assertConnected("Target.attachToTarget");
    if (!this.#targets.has(targetId)) {
      throw fail("E_TARGET_LOST", "connect", { message: `fake target ${targetId} is gone` });
    }
    const sessionId = `session-${this.#nextSession++}`;
    this.#sessions.set(targetId, sessionId);
    this.attached.push(targetId);
    return { targetId, sessionId };
  }

  async detach(sessionId: string): Promise<void> {
    for (const [targetId, id] of [...this.#sessions]) {
      if (id === sessionId) this.#sessions.delete(targetId);
    }
  }

  async createTarget(
    url: string,
    opts: { newWindow?: boolean; background?: boolean } = {},
  ): Promise<string> {
    this.#assertConnected("Target.createTarget");
    void opts;
    const id = `target-${this.#nextTarget++}`;
    this.#targets.set(id, { id, url, type: "page" });
    this.created.push(id);
    return id;
  }

  async closeTarget(targetId: string): Promise<void> {
    this.#assertConnected("Target.closeTarget");
    if (!this.#targets.has(targetId)) return;
    this.#targets.delete(targetId);
    this.closed.push(targetId);
    const sessionId = this.#sessions.get(targetId);
    this.#sessions.delete(targetId);
    this.#emit("Target.detachedFromTarget", { targetId, sessionId }, sessionId);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    this.commands.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    if (this.#failNext?.method === method) {
      const { error } = this.#failNext;
      this.#failNext = undefined;
      throw error;
    }
    this.#assertConnected(method);

    switch (method) {
      case "Browser.getVersion":
        return this.#browser as T;
      case "Browser.getWindowForTarget":
        return { windowId: this.#windowId } as T;
      case "Target.getTargets":
        return { targetInfos: [...this.#targets.values()].map((target) => ({ ...target, title: "" })) } as T;
      case "Target.getTargetInfo": {
        const target = this.#targets.get(String(params.targetId));
        return { targetInfo: target ?? { targetId: String(params.targetId), url: "", type: "page" } } as T;
      }
      case "Target.attachToTarget":
        return (await this.attach(String(params.targetId))) as T;
      case "Runtime.evaluate": {
        const expression = String(params.expression ?? "");
        return { result: { value: this.#evaluate(expression) } } as T;
      }
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main", loaderId: "loader-1", url: "about:blank" } } } as T;
      default:
        return {} as T;
    }
  }

  on(method: string, handler: CdpEventHandler): () => void {
    let handlers = this.#handlers.get(method);
    if (handlers === undefined) {
      handlers = new Set();
      this.#handlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.#connected = false;
    this.#handlers.clear();
  }

  sessionIdFor(targetId: string): string | undefined {
    return this.#sessions.get(targetId);
  }

  targetUrlFor(targetId: string): string | undefined {
    return this.#targets.get(targetId)?.url;
  }

  // --- test controls -------------------------------------------------------

  /** Simulate the socket dropping; the next command fails with E_CDP_DISCONNECTED. */
  disconnect(): void {
    this.#connected = false;
  }

  /** Simulate a user closing an owned tab (the target vanishes mid-session). */
  userCloseTarget(targetId: string): void {
    const sessionId = this.#sessions.get(targetId);
    this.#targets.delete(targetId);
    this.#sessions.delete(targetId);
    this.#emit("Target.detachedFromTarget", { targetId, sessionId }, sessionId);
  }

  addForeignTarget(id: string, url = "https://user.example/"): void {
    this.#targets.set(id, { id, url, type: "page" });
  }

  hasTarget(targetId: string): boolean {
    return this.#targets.has(targetId);
  }

  targetIds(): string[] {
    return [...this.#targets.keys()];
  }

  failNext(method: string, error: Error): void {
    this.#failNext = { method, error };
  }

  /** Answer `Runtime.evaluate` expressions; default `false` (navigator.webdriver). */
  setEvaluate(handler: (expression: string) => unknown): void {
    this.#evaluate = handler;
  }

  #assertConnected(method: string): void {
    if (!this.#connected) throw disconnected(method);
  }

  #emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    const handlers = this.#handlers.get(method);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) handler(params, sessionId);
  }
}
