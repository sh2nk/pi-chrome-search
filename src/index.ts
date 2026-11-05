/**
 * Extension entry point (M0 wiring).
 *
 * The factory does no I/O: config, connector, logger and the engine registry are
 * created lazily on the first command/tool call, and released on shutdown. That
 * keeps `pi --print` and `pi --list-models` from touching Chrome or the disk.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createConnector, type Connector } from "./cdp/browser.ts";
import { discoverEndpoint } from "./cdp/discovery.ts";
import { handleDoctorCommand } from "./commands/doctor.ts";
import { handleFocusCommand } from "./commands/focus.ts";
import { loadConfig, resolveConfigPath, type Config } from "./config.ts";
import { createDefaultRegistry } from "./engines/index.ts";
import type { EngineRegistry } from "./engines/types.ts";
import { createArtifacts } from "./runtime/artifacts.ts";
import { createCache } from "./runtime/cache.ts";
import { createSystemClock } from "./runtime/clock.ts";
import { createLimiter } from "./runtime/limiter.ts";
import { createLogger } from "./runtime/log.ts";
import type { Artifacts, Cache, Clock, Limiter, Logger } from "./runtime/types.ts";
import { createTools } from "./tools/index.ts";
import type { ToolDeps } from "./tools/types.ts";
import { EXTENSION_NAME, EXTENSION_VERSION } from "./version.ts";

interface Runtime {
  config: Config;
  configPath: string;
  clock: Clock;
  log: Logger;
  cache: Cache;
  limiter: Limiter;
  artifacts: Artifacts;
  connector: Connector;
  registry: EngineRegistry;
}

let runtimePromise: Promise<Runtime> | null = null;

function agentDir(env: NodeJS.ProcessEnv): string {
  const raw = env.PI_CODING_AGENT_DIR?.trim();
  if (raw && raw.length > 0) return raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  return join(homedir(), ".pi", "agent");
}

function createRuntime(): Runtime {
  const env = process.env;
  const config = loadConfig({ env });
  const configPath = resolveConfigPath(env);
  const clock = createSystemClock();
  const stateDir = join(agentDir(env), "web-search");
  const log = createLogger({ path: join(stateDir, "decisions.jsonl"), clock });
  const cache = createCache({ maxEntries: config.cache.maxEntries, clock });
  const limiter = createLimiter({ config, clock, statePath: join(stateDir, "state.json") });
  const artifacts = createArtifacts({ config, clock });
  const connector = createConnector({
    config,
    clock,
    log,
    discover: () =>
      discoverEndpoint({
        ports: config.cdp.ports,
        ws: config.cdp.ws,
        timeoutMs: config.cdp.connectTimeoutMs,
      }),
  });
  const registry = createDefaultRegistry(config);
  return { config, configPath, clock, log, cache, limiter, artifacts, connector, registry };
}

function toToolDeps(runtime: Runtime): ToolDeps {
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

export default function register(pi: ExtensionAPI): void {
  for (const tool of createTools(async () => toToolDeps(await getRuntime()))) {
    // ToolDetails is success | failure details; pi's inference pins it to the
    // success branch of the union, so register the structural definition.
    pi.registerTool(tool as ToolDefinition);
  }

  pi.on("session_shutdown", async () => {
    const pending = runtimePromise;
    runtimePromise = null;
    if (pending === null) return;
    const runtime = await pending.catch(() => null);
    if (runtime === null) return;
    await runtime.connector.releaseAll().catch(() => {});
  });

  pi.registerCommand("web-doctor", {
    description: "Diagnose CDP attach, lock, window, per-engine probes and the reflex layer",
    handler: async (args, ctx: ExtensionContext) => {
      await handleDoctorCommand(
        args,
        ctx,
        async () => {
          const runtime = await getRuntime();
          return {
            config: runtime.config,
            configPath: runtime.configPath,
            connector: runtime.connector,
            registry: runtime.registry,
            cache: runtime.cache,
            clock: runtime.clock,
            extensionVersion: EXTENSION_VERSION,
            nodeVersion: process.version,
          };
        },
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
