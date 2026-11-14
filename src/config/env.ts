/**
 * Environment overrides, applied after the file (S13.1).
 *
 * `ENV_OVERRIDES` is also the documentation source: `docs/config.md` is
 * generated from it, so a new variable cannot ship undocumented.
 */

import { join } from "node:path";

import { agentDir } from "../runtime/host.ts";
import type { Config } from "./defaults.ts";
import { configError } from "./schema.ts";

export interface EnvOverride {
  name: string;
  effect: string;
}

export const ENV_OVERRIDES: readonly EnvOverride[] = [
  { name: "PI_CODING_AGENT_DIR", effect: "Directory holding `web-search.json`, artifacts and logs." },
  { name: "PI_CHROME_CDP_WS", effect: "Full CDP WebSocket URL; skips discovery. Must be `ws://` or `wss://`." },
  { name: "PI_CHROME_CDP_PORTS", effect: "Comma-separated ports to probe (`9223,9224`)." },
  { name: "PI_CHROME_SEARCH_PROFILE", effect: "Profile directory inspected first for `DevToolsActivePort`." },
  { name: "PI_CHROME_SEARCH_DEBUG", effect: "`1`/`true` turns decision logging on (`debug`)." },
  { name: "PI_CHROME_SEARCH_HOST_PLATFORM", effect: "Diagnostic only: force the platform (`linux`/`darwin`/`win32`)." },
];

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "web-search.json");
}

export function applyEnv(config: Config, env: NodeJS.ProcessEnv = process.env, source = "env"): Config {
  const next: Config = structuredClone(config);

  const ws = env.PI_CHROME_CDP_WS?.trim();
  if (ws) {
    if (!ws.startsWith("ws://") && !ws.startsWith("wss://")) {
      throw configError("PI_CHROME_CDP_WS: expected a ws:// or wss:// URL", source);
    }
    next.cdp.ws = ws;
  }

  const ports = env.PI_CHROME_CDP_PORTS?.trim();
  if (ports) {
    const parsed = ports.split(",").map((part) => Number(part.trim()));
    if (parsed.length === 0 || parsed.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw configError(`PI_CHROME_CDP_PORTS: expected comma-separated ports, got "${ports}"`, source);
    }
    next.cdp.ports = parsed;
  }

  const debug = env.PI_CHROME_SEARCH_DEBUG?.trim();
  if (debug !== undefined && debug !== "") {
    next.debug = debug === "1" || debug.toLowerCase() === "true";
  }

  return next;
}
