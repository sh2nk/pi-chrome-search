/**
 * Offline session harness for the window/panel behaviour (PLAN P7).
 *
 * It builds the real `BrowserSession` over the in-memory CDP client, so focus,
 * follow, the idle hand-back and the anchor panel are exercised through the
 * production code paths with no socket, no Chrome and no user profile. The
 * recorder answers the two questions these tests ask: which owned tab was raised
 * (`Page.bringToFront`, mapped back to its target id) and which expressions the
 * anchor evaluated.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CdpClient, CdpEndpoint, PageKey } from "../../src/cdp/types.ts";
import { DEFAULT_CONFIG, type Config } from "../../src/config/index.ts";
import type { Logger } from "../../src/runtime/types.ts";
import { createSession, type Session } from "../../src/session/index.ts";
import { FakeClock } from "./fake-cdp.ts";
import { FakeCdpClient } from "./fake-cdp-client.ts";

export const HARNESS_ENDPOINT: CdpEndpoint = {
  port: 9222,
  wsUrl: "ws://127.0.0.1:9222/devtools/browser/harness",
  source: "env-ws",
};

export interface SessionHarnessOptions {
  /** Mutate the cloned defaults: focus, follow, idleMs, panel, humanize. */
  configure?: (config: Config) => void;
  /** Answer `Runtime.evaluate`; the default is a healthy page. */
  evaluate?: (expression: string) => unknown;
  /** Use a pre-built client (e.g. one with foreign targets). */
  client?: FakeCdpClient;
  /** `false` keeps sleeps pending until `clock.advance()` (the idle hand-back). */
  autoAdvance?: boolean;
}

export interface SessionHarness {
  session: Session;
  client: FakeCdpClient;
  clock: FakeClock;
  config: Config;
  /** Every `Logger.write` row, in order. */
  logs: Array<Record<string, unknown>>;
  /** Target id of the anchor tab. */
  anchorTarget(): string;
  /** Target id an owned key maps to (`"google"`, `"read"`, …). */
  targetFor(key: PageKey): string;
  /** Target ids raised by `Page.bringToFront`, in call order. */
  raises(): string[];
  /** Every `Runtime.evaluate` expression sent to an owned tab. */
  evaluations(): string[];
  cleanup(): Promise<void>;
}

export async function createSessionHarness(options: SessionHarnessOptions = {}): Promise<SessionHarness> {
  const client = options.client ?? new FakeCdpClient();
  if (options.evaluate !== undefined) client.setEvaluate(options.evaluate);

  const clock = new FakeClock({ autoAdvance: options.autoAdvance ?? true });
  const logs: Array<Record<string, unknown>> = [];
  const log: Logger = {
    async write(row) {
      logs.push(row);
    },
    path: () => "/dev/null",
  };

  const config: Config = structuredClone(DEFAULT_CONFIG);
  config.cdp = { ...config.cdp, attachWaitMs: 0, connectTimeoutMs: 1_000 };
  config.window.panel = false;
  config.window.focus = "never";
  config.window.follow = "never";
  options.configure?.(config);

  const dir = await mkdtemp(join(tmpdir(), "pi-chrome-window-"));
  const session = createSession({
    config,
    discover: async () => HARNESS_ENDPOINT,
    connectClient: async () => client,
    clock,
    log,
    lockPath: join(dir, "web-search.lock"),
    sessionId: "harness-session",
  });

  function targetForSession(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined;
    for (const id of client.targetIds()) {
      if (client.sessionIdFor(id) === sessionId) return id;
    }
    return undefined;
  }

  function ownedTarget(key: PageKey | null): string {
    const target = session.info()?.ownedTargets.find((entry) => entry.key === key);
    assert.ok(target !== undefined, `expected an owned target for ${String(key)}`);
    return target.targetId;
  }

  // Record raises as they happen: a released tab is gone from the client by the
  // time a test asks, so a lazy lookup would lose the earlier target id.
  const raiseTargets: string[] = [];
  const send = client.send.bind(client) as CdpClient["send"];
  client.send = (async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    if (method === "Page.bringToFront") {
      raiseTargets.push(targetForSession(sessionId) ?? "unknown-target");
    }
    return await send(method, params, sessionId);
  }) as CdpClient["send"];

  return {
    session,
    client,
    clock,
    config,
    logs,
    anchorTarget: () => ownedTarget(null),
    targetFor: (key) => ownedTarget(key),
    raises: () => [...raiseTargets],
    evaluations: () =>
      client.commands
        .filter((command) => command.method === "Runtime.evaluate")
        .map((command) => String(command.params.expression ?? "")),
    async cleanup(): Promise<void> {
      await session.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
