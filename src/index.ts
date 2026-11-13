/**
 * Extension entry point (M0 wiring).
 *
 * The factory does no I/O: config, connector, logger and the engine registry are
 * created lazily on the first command/tool call, and released on shutdown. That
 * keeps `pi --print` and `pi --list-models` from touching Chrome or the disk.
 */

import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createSession, discoverEndpoint, type Session } from "./session/index.ts";
import { handleDoctorCommand } from "./commands/doctor.ts";
import { handleFocusCommand } from "./commands/focus.ts";
import { loadConfig, resolveConfigPath, type Config } from "./config/index.ts";
import { createDefaultRegistry } from "./engines/index.ts";
import type { EngineRegistry } from "./engines/types.ts";
import { createArtifacts } from "./runtime/artifacts.ts";
import { createAllowAttention } from "./runtime/attention.ts";
import { createCache } from "./runtime/cache.ts";
import { createSystemClock } from "./runtime/clock.ts";
import { createLimiter } from "./runtime/limiter.ts";
import { createEngineProbe } from "./runtime/doctor.ts";
import type { DoctorDeps } from "./runtime/doctor.ts";
import { agentDir } from "./runtime/host.ts";
import { createLogger } from "./runtime/log.ts";
import type { Artifacts, Cache, Clock, Limiter, Logger } from "./runtime/types.ts";
import { DISCOVERY_TOOL_NAME, createTools } from "./tools/index.ts";
import type { RegisteredTool } from "./tools/index.ts";
import type { ToolDeps } from "./tools/types.ts";
import { EXTENSION_NAME, EXTENSION_VERSION } from "./version.ts";

/** The lazily-built runtime the tools, commands and doctor share. */
export interface Runtime {
  config: Config;
  configPath: string;
  clock: Clock;
  log: Logger;
  cache: Cache;
  limiter: Limiter;
  artifacts: Artifacts;
  connector: Session;
  registry: EngineRegistry;
}

let runtimePromise: Promise<Runtime> | null = null;

function createRuntime(): Runtime {
  const env = process.env;
  const config = loadConfig({ env });
  const configPath = resolveConfigPath(env);
  const clock = createSystemClock();
  const stateDir = join(agentDir(env), "web-search");
  const log = createLogger({ path: join(stateDir, "decisions.jsonl"), clock });
  const cache = createCache({ maxEntries: config.cache.maxEntries, clock });
  const limiter = createLimiter({ config, clock });
  const artifacts = createArtifacts({ config, clock });
  // P11: while a CDP handshake waits for the user's Allow, fire exactly one
  // desktop notification and (unless `window.raiseOnPrompt: "never"`) one
  // best-effort raise. The extension has no terminal to print progress into.
  const attention = createAllowAttention({
    config,
    onProgress: (line) => {
      void log.write({ level: "info", event: "awaiting_allow", message: line }).catch(() => undefined);
    },
  });
  const connector = createSession({
    config,
    clock,
    log,
    discover: () =>
      discoverEndpoint({
        ports: config.cdp.ports,
        ws: config.cdp.ws,
        timeoutMs: config.cdp.connectTimeoutMs,
      }),
    onAwaitingAllow: (info) => attention.onAwaitingAllow(info),
  });
  const registry = createDefaultRegistry(config);
  return { config, configPath, clock, log, cache, limiter, artifacts, connector, registry };
}

/** Tool dependencies for one execution context. */
export function toToolDeps(runtime: Runtime): ToolDeps {
  return {
    config: runtime.config,
    engines: runtime.registry,
    cdp: runtime.connector,
    cache: runtime.cache,
    limiter: runtime.limiter,
    artifacts: runtime.artifacts,
    log: runtime.log,
    clock: runtime.clock,
  };
}

function getRuntime(): Promise<Runtime> {
  if (runtimePromise === null) {
    runtimePromise = Promise.resolve(createRuntime());
  }
  return runtimePromise;
}

/**
 * The doctor's view of the same runtime the tools use. The probe is the
 * production factory, not a stub: the shipped `web_doctor` must exercise the
 * same connector, adapters and limiter as `web_search`, or every engine would
 * report `unavailable` in real use. Building the closure does no I/O.
 *
 * Exported so the doctor suite can prove that wiring — a `web_doctor` without a
 * probe was the one bug this shape invites.
 */
export function toDoctorDeps(runtime: Runtime): DoctorDeps {
  return {
    config: runtime.config,
    configPath: runtime.configPath,
    connector: runtime.connector,
    registry: runtime.registry,
    cache: runtime.cache,
    artifacts: runtime.artifacts,
    clock: runtime.clock,
    limiter: runtime.limiter,
    probe: createEngineProbe({
      config: runtime.config,
      connector: runtime.connector,
      registry: runtime.registry,
      clock: runtime.clock,
      limiter: runtime.limiter,
    }),
    extensionVersion: EXTENSION_VERSION,
    nodeVersion: process.version,
  };
}

/**
 * Whether this pi build has a discovery tool that can actually reach a deferred
 * tool. The built-in `tool_search` declares `reachesTools`; a same-named tool
 * without it cannot load our deferred set, so it does not count (S3.1).
 */
function hasDiscoveryTool(pi: ExtensionAPI): boolean {
  return pi.getAllTools().some(
    (tool) => tool.name === DISCOVERY_TOOL_NAME && typeof tool.reachesTools === "function",
  );
}

/**
 * Register the canonical surface, then make every tool reachable without asking
 * the user to edit settings (S3.1, D3):
 *
 * - discovery present: activate `tool_search` so the deferred trio is findable;
 * - discovery absent: re-register the deferred tools as `direct`, because a
 *   deferred tool with no loader is the v1 defect this phase exists to remove.
 *
 * Re-registering a name replaces its definition and activates a `direct` tool,
 * which is how pi supports promotion after registration.
 */
export function ensureToolReachability(pi: ExtensionAPI, tools: readonly RegisteredTool[]): "discovery" | "direct-fallback" {
  if (hasDiscoveryTool(pi)) {
    const active = pi.getActiveTools();
    if (!active.includes(DISCOVERY_TOOL_NAME)) pi.setActiveTools([...active, DISCOVERY_TOOL_NAME]);
    return "discovery";
  }
  for (const tool of tools) {
    if (tool.exposure === "direct") continue;
    pi.registerTool({ ...tool, exposure: "direct" } as ToolDefinition);
  }
  return "direct-fallback";
}

export default function register(pi: ExtensionAPI): void {
  const tools = createTools({
    getDeps: async () => toToolDeps(await getRuntime()),
    getDoctorDeps: async () => toDoctorDeps(await getRuntime()),
  });
  for (const tool of tools) {
    // ToolDetails is success | failure details; pi's inference pins it to the
    // success branch of the union, so register the structural definition.
    pi.registerTool(tool as ToolDefinition);
  }

  // Extensions finish loading before the first session starts, so this is the
  // first point where pi.getAllTools() has the built-in discovery tool.
  pi.on("session_start", () => {
    ensureToolReachability(pi, tools);
  });

  pi.on("session_shutdown", async () => {
    const pending = runtimePromise;
    runtimePromise = null;
    if (pending === null) return;
    const runtime = await pending.catch(() => null);
    if (runtime === null) return;
    await runtime.connector.releaseAll().catch(() => {});
  });

  pi.registerCommand("web-doctor", {
    description: "Diagnose CDP attach, lock, window and per-engine probe verdicts",
    handler: async (args, ctx: ExtensionContext) => {
      await handleDoctorCommand(
        args,
        ctx,
        async () => toDoctorDeps(await getRuntime()),
        { cliCommand: "node src/cli/doctor.ts --json" },
      );
    },
  });

  pi.registerCommand("web-focus", {
    description: "Bring the extension's Chrome window to the front",
    handler: async (_args, ctx: ExtensionContext) => {
      await handleFocusCommand(ctx, async () => {
        const runtime = await getRuntime();
        return { connector: runtime.connector };
      });
    },
  });
}

export { EXTENSION_NAME, EXTENSION_VERSION };
