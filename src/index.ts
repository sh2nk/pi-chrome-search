/**
 * Extension entry point (M0 wiring).
 *
 * The factory does no I/O: config, connector, logger and the engine registry are
 * created lazily on the first command/tool call, and released on shutdown. That
 * keeps `pi --print` and `pi --list-models` from touching Chrome or the disk.
 */

import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createConnector, type Connector } from "./cdp/browser.ts";
import { discoverEndpoint } from "./cdp/discovery.ts";
import { handleDoctorCommand } from "./commands/doctor.ts";
import { handleFocusCommand } from "./commands/focus.ts";
import { loadConfig, resolveConfigPath, type Config } from "./config.ts";
import { createDefaultRegistry } from "./engines/index.ts";
import type { EngineRegistry } from "./engines/types.ts";
import type { ClassifierRegistry } from "./reflex/classifier.ts";
import { createReflex, type ReflexBundle } from "./reflex/index.ts";
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
import { createTools } from "./tools/index.ts";
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
  connector: Connector;
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
  const limiter = createLimiter({ config, clock, statePath: join(stateDir, "state.json") });
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
    onAwaitingAllow: (info) => attention.onAwaitingAllow(info),
  });
  const registry = createDefaultRegistry(config);
  return { config, configPath, clock, log, cache, limiter, artifacts, connector, registry };
}

/**
 * The session's classifier API, or `undefined` when this pi build has none (or a
 * test passes no context). Narrowed structurally: the extension must not depend
 * on the full `ModelRegistry` surface, and an older pi must degrade to rules
 * instead of failing every tool call.
 */
function ctxClassifierRegistry(ctx: unknown): ClassifierRegistry | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const candidate = (ctx as { modelRegistry?: unknown }).modelRegistry;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const registry = candidate as Partial<ClassifierRegistry>;
  if (
    typeof registry.getAvailableOfType !== "function" ||
    typeof registry.findOfType !== "function" ||
    typeof registry.classify !== "function"
  ) {
    return undefined;
  }
  return registry as ClassifierRegistry;
}

/**
 * Reflex bundles are memoised per session model registry.
 *
 * The reflex must be built from the *execution context's* registry — never from a
 * module-level singleton created before a session exists — because that registry
 * is what carries pi's classifier auth. Memoising on the registry object (not on
 * this module) keeps `maxCallsPerSession`/`maxUsdPerSession` honest across tool
 * calls: a bundle built per call would reset the session cost guard on every
 * search. A weak key means a new session (or a new registry) starts clean and
 * the old bundle is collectable.
 *
 * No registry → rules-only: there is no model to budget, so a fresh bundle per
 * call is enough and nothing is retained.
 */
interface CachedReflex {
  runtime: Runtime;
  bundle: ReflexBundle;
}

const reflexBundles = new WeakMap<object, CachedReflex>();

function reflexFor(runtime: Runtime, registry: ClassifierRegistry | undefined): ReflexBundle {
  if (registry === undefined) {
    return createReflex({
      config: runtime.config,
      clock: runtime.clock,
      cache: runtime.cache,
      log: runtime.log,
    });
  }
  const cached = reflexBundles.get(registry);
  // The runtime check covers a session restart that reuses pi's registry object
  // while config, cache and log have been rebuilt underneath it.
  if (cached !== undefined && cached.runtime === runtime) return cached.bundle;
  const bundle = createReflex({
    config: runtime.config,
    clock: runtime.clock,
    cache: runtime.cache,
    log: runtime.log,
    registry,
  });
  reflexBundles.set(registry, { runtime, bundle });
  return bundle;
}

/** Tool dependencies for one execution context. `ctx` is `unknown` by contract. */
export function toToolDeps(runtime: Runtime, ctx?: unknown): ToolDeps {
  return {
    config: runtime.config,
    engines: runtime.registry,
    cdp: runtime.connector,
    cache: runtime.cache,
    limiter: runtime.limiter,
    artifacts: runtime.artifacts,
    log: runtime.log,
    clock: runtime.clock,
    reflex: reflexFor(runtime, ctxClassifierRegistry(ctx)).reflex,
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

export default function register(pi: ExtensionAPI): void {
  const tools = createTools({
    getDeps: async (ctx?: unknown) => toToolDeps(await getRuntime(), ctx),
    getDoctorDeps: async () => toDoctorDeps(await getRuntime()),
  });
  for (const tool of tools) {
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
