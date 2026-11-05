#!/usr/bin/env node
/**
 * Headless doctor: the canonical gate output (PLAN V1.3/V1.5).
 *
 * `node src/cli/doctor.ts --json` builds the report through `buildDoctorReport`
 * and prints it. The CLI owns the three things the report module must not do
 * itself:
 *
 *  - **A real connector.** A fresh `createConnector` with the system clock and a
 *    JSONL log under `~/.pi/agent/web-search/doctor.jsonl`. The log is created
 *    only when this process builds the connector (an injected test connector
 *    must not write into the user's agent dir).
 *
 *  - **`--fix`.** Reconnect once, close only tabs this connector owns
 *    (`releaseAll`), let `connect()` reclaim a stale lock, prune artifacts when
 *    available. It never restarts/kills Chrome and never touches a captcha
 *    (AGENTS §2 rules 2 and 6); a live foreign lock is left alone.
 *
 *  - **Cleanup and exit codes.** The doctor closes the window it opened before
 *    exiting, so a diagnostic does not leave an `about:blank` tab behind. Exit
 *    0 for ok/degraded, 2 for blocked (including an unreachable CDP).
 *
 * A hung endpoint cannot stall the gate: `buildDoctorReport` bounds `connect()`
 * by `cdp.connectTimeoutMs` plus the discovery budget (PLAN V1.5).
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createConnector } from "../cdp/browser.ts";
import type { Connector, ConnectorOptions } from "../cdp/browser.ts";
import { defaultLockPath } from "../cdp/browser.ts";
import { discoverEndpoint } from "../cdp/discovery.ts";
import { loadConfig, resolveConfigPath } from "../config.ts";
import type { Config } from "../config.ts";
import { createEngineRegistry } from "../engines/index.ts";
import type { EngineRegistry } from "../engines/types.ts";
import { systemClock } from "../runtime/clock.ts";
import {
  buildDoctorReport,
  renderDoctorText,
  DOCTOR_BLOCKED_EXIT_CODE,
} from "../runtime/doctor.ts";
import type { DoctorDeps, DoctorReport, EngineProbe } from "../runtime/doctor.ts";
import { isWebSearchError } from "../runtime/error-codes.ts";
import type { FailureDetails } from "../runtime/error-codes.ts";
import { fail, renderFailureText, toFailure } from "../runtime/errors.ts";
import { createLogger } from "../runtime/log.ts";
import type { Artifacts, Cache, Clock, Logger } from "../runtime/types.ts";
import { STATE_DIR_NAME } from "../version.ts";

/** Same shape as `resolveConfigPath`; kept local so the CLI owns no config logic. */
function stateDir(env: NodeJS.ProcessEnv): string {
  const raw = env.PI_CODING_AGENT_DIR?.trim();
  const base = raw !== undefined && raw !== "" ? expandHome(raw) : join(homedir(), ".pi", "agent");
  return join(base, STATE_DIR_NAME);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(homedir(), path);
}

export interface DoctorCliArgs {
  json: boolean;
  /** False for `--no-probe`. */
  probe: boolean;
  fix: boolean;
  configPath?: string;
  help: boolean;
}

/**
 * Injectable seams. Every field is optional: production leaves them unset and
 * gets `loadConfig` + a real connector; tests pass a fake connector so the
 * suite never opens a socket or reads the user's config.
 */
export interface DoctorCliDeps {
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  loadConfig?: (opts: { path?: string; env: NodeJS.ProcessEnv }) => Config;
  /** Pre-built connector (tests). When set, no logger is created. */
  connector?: Connector;
  createConnector?: (options: ConnectorOptions) => Connector;
  registry?: EngineRegistry;
  cache?: Cache;
  artifacts?: Artifacts;
  probe?: EngineProbe;
  /** Stdout sink; defaults to `process.stdout.write`. */
  write?: (text: string) => void;
  /** Stderr sink for `--fix` notes in `--json` mode; defaults to `process.stderr.write`. */
  writeError?: (text: string) => void;
  /** Override the doctor JSONL logger (tests). */
  log?: Logger;
}

function usage(): string {
  return [
    "usage: node src/cli/doctor.ts [--json] [--no-probe] [--fix] [--config <path>]",
    "",
    "  --json        machine-readable report (schema: tests/fixtures/doctor.schema.json)",
    "  --no-probe    skip the per-engine live probe",
    "  --fix         reconnect once, close owned tabs, reclaim a stale lock, prune artifacts",
    "  --config P    read config from P instead of ~/.pi/agent/web-search.json",
    "",
    "exit 0 = ok/degraded, 2 = blocked/unavailable",
  ].join("\n");
}

/** Parse the CLI flags; an unknown flag or a missing `--config` value is E_CONFIG. */
export function parseDoctorArgs(argv: readonly string[]): DoctorCliArgs {
  const args: DoctorCliArgs = { json: false, probe: true, fix: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--no-probe") {
      args.probe = false;
    } else if (arg === "--fix") {
      args.fix = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        throw fail("E_CONFIG", "config", {
          message: "--config needs a file path",
          hint: `run \`node src/cli/doctor.ts --config <path>\`, e.g. ${resolveConfigPath()}`,
        });
      }
      args.configPath = value;
      index += 1;
    } else {
      throw fail("E_CONFIG", "config", {
        message: `unknown doctor argument ${JSON.stringify(arg)}`,
        hint: "supported flags: --json, --no-probe, --fix, --config <path>",
      });
    }
  }

  return args;
}

/**
 * `connect()` once with the same bound the report uses, so `--fix` cannot hang
 * either. The connector itself already times out the socket.
 */
async function boundedConnect(connector: Connector, config: Config): Promise<void> {
  const timeoutMs = config.cdp.connectTimeoutMs + 2_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connector.connect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`the CDP connect did not settle within ${timeoutMs}ms`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `--fix` actions, in order. Each is best-effort and reported as a line; a
 * failure never aborts the run because the report that follows is the product.
 */
async function applyFix(
  connector: Connector,
  config: Config,
  artifacts: Artifacts | undefined,
): Promise<string[]> {
  const actions: string[] = [];

  if (!connector.isConnected()) {
    try {
      await boundedConnect(connector, config);
      actions.push("connected to CDP");
    } catch (error) {
      actions.push(`connect failed: ${toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" }).code}`);
      // Exactly one retry (SPEC §10.3: reconnect), never a loop.
      try {
        await boundedConnect(connector, config);
        actions.push("reconnected to CDP once");
      } catch (retryError) {
        const details = toFailure(retryError, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
        actions.push(`reconnect failed: ${details.code}`);
      }
    }
  }

  if (connector.isConnected()) {
    let owned = 0;
    try {
      owned = connector.ownedTargets().length;
    } catch {
      owned = 0;
    }
    try {
      // `releaseAll` closes only targets this connector created and releases its
      // own lock; orphan tabs from a crashed session are the connector's `#owned`
      // set, never a foreign tab.
      await connector.releaseAll();
      actions.push(owned > 0 ? `closed ${owned} owned tab(s)` : "released connector state");
    } catch (error) {
      const details = toFailure(error, { code: "E_CDP_DISCONNECTED", stage: "connect" });
      actions.push(`release failed: ${details.code}`);
    }

    try {
      await boundedConnect(connector, config);
      actions.push("reconnected to CDP once");
    } catch (error) {
      const details = toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
      actions.push(`reconnect failed: ${details.code}`);
    }
  }

  if (artifacts !== undefined) {
    try {
      const pruned = await artifacts.prune();
      actions.push(`pruned artifacts: ${pruned.removed} removed, ${pruned.kept} kept`);
    } catch (error) {
      const details = toFailure(error, { code: "E_CONFIG", stage: "config" });
      actions.push(`artifact prune failed: ${details.code}`);
    }
  }

  return actions;
}

function detailsOf(error: unknown): FailureDetails {
  return isWebSearchError(error) ? error.details : toFailure(error, { code: "E_CONFIG", stage: "config" });
}

function formatFailure(details: FailureDetails, json: boolean): string {
  if (!json) return `${renderFailureText(details, { tool: "web_doctor" })}\n`;
  // The report is the canonical JSON; a failure before a report exists still
  // needs a machine-readable shape, and it must match `FailureDetails` fields.
  const payload = {
    ok: false,
    code: details.code,
    ...(details.engine === undefined ? {} : { engine: details.engine }),
    stage: details.stage,
    retryable: details.retryable,
    hint: details.hint,
    ...(details.message === undefined ? {} : { message: details.message }),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Run the doctor. Returns the process exit code instead of exiting, so tests
 * (and `main`) can assert it. Never throws: a config/flag error is printed and
 * maps to 2.
 */
export async function runDoctorCli(
  argv: readonly string[],
  deps: DoctorCliDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? systemClock;
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));
  const writeError = deps.writeError ?? ((text: string) => void process.stderr.write(text));

  let json = argv.includes("--json");
  let args: DoctorCliArgs;
  try {
    args = parseDoctorArgs(argv);
  } catch (error) {
    const details = detailsOf(error);
    write(formatFailure(details, json));
    return DOCTOR_BLOCKED_EXIT_CODE;
  }

  if (args.help) {
    write(`${usage()}\n`);
    return 0;
  }
  json = args.json;

  const load = deps.loadConfig ?? loadConfig;
  const configPath = args.configPath ?? resolveConfigPath(env);

  let config: Config;
  try {
    config = load({ ...(args.configPath === undefined ? {} : { path: args.configPath }), env });
  } catch (error) {
    write(formatFailure(detailsOf(error), json));
    return DOCTOR_BLOCKED_EXIT_CODE;
  }

  // A logger is only needed by a connector this process builds; an injected
  // connector (tests, or a caller with its own log) never gets a file here.
  let log: Logger | undefined = deps.log;

  let connector: Connector;
  try {
    if (deps.connector !== undefined) {
      connector = deps.connector;
    } else {
      log ??= createLogger({ path: join(stateDir(env), "doctor.jsonl"), clock });
      connector = (deps.createConnector ?? createConnector)({
        config,
        discover: () =>
          discoverEndpoint({
            ws: config.cdp.ws,
            ports: config.cdp.ports,
            env,
            timeoutMs: config.cdp.connectTimeoutMs,
          }),
        clock,
        log,
        // `defaultLockPath` reads `process.env`; the CLI may run with an injected env.
        lockPath: defaultLockPath(env),
      });
    }
  } catch (error) {
    write(formatFailure(detailsOf(error), json));
    return DOCTOR_BLOCKED_EXIT_CODE;
  }

  const registry = deps.registry ?? createEngineRegistry({}, config);

  if (args.fix) {
    const actions = await applyFix(connector, config, deps.artifacts);
    if (actions.length > 0) {
      const text = actions.map((action) => `fix: ${action}\n`).join("");
      // JSON on stdout must stay schema-valid, so fix notes go to stderr there.
      if (json) writeError(text);
      else write(text);
    }
  }

  const doctorDeps: DoctorDeps = {
    config,
    configPath,
    connector,
    registry,
    clock,
    ...(deps.cache === undefined ? {} : { cache: deps.cache }),
    ...(deps.artifacts === undefined ? {} : { artifacts: deps.artifacts }),
    ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    env,
  };

  let report: DoctorReport;
  try {
    report = await buildDoctorReport(doctorDeps, { probe: args.probe });
  } catch (error) {
    // buildDoctorReport is total by contract; this is the last line of defence
    // against a bug there turning a diagnostic into a crash.
    write(formatFailure(detailsOf(error), json));
    await releaseQuietly(connector);
    return DOCTOR_BLOCKED_EXIT_CODE;
  }

  if (json) write(`${JSON.stringify(report, null, 2)}\n`);
  else write(renderDoctorText(report));

  // A diagnostic must not leave the window/lock it opened behind. `releaseAll`
  // closes only this connector's own targets, so a concurrent pi session is safe.
  await releaseQuietly(connector);

  if (log !== undefined) {
    void log
      .write({
        level: "info",
        event: "doctor",
        verdict: report.verdict,
        cdp: report.cdp.status,
        engines: report.engines.map((engine) => ({ id: engine.id, verdict: engine.verdict })),
      })
      .catch(() => undefined);
  }

  return report.verdict === "blocked" ? DOCTOR_BLOCKED_EXIT_CODE : 0;
}

async function releaseQuietly(connector: Connector): Promise<void> {
  try {
    if (connector.isConnected()) await connector.releaseAll();
  } catch {
    // Cleanup is best-effort: the report was already produced, and a failure
    // here must not change the exit code.
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runDoctorCli(process.argv.slice(2));
  } catch (error) {
    // `runDoctorCli` is total by contract; this is the process boundary's last
    // guard so a bug prints a diagnosable line instead of a stack trace.
    process.stderr.write(`${renderFailureText(detailsOf(error), { tool: "web_doctor" })}\n`);
    process.exitCode = DOCTOR_BLOCKED_EXIT_CODE;
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  void main();
}
