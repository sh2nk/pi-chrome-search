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
 *  - **`--fix`.** The safe action set lives in `runtime/doctor.ts`
 *    (`applyDoctorFix`): reconnect once, close only tabs this connector owns
 *    (`releaseAll`), prune artifacts to retention, and remove a lock whose owner
 *    is provably dead. It never signals a process, restarts/kills Chrome or
 *    touches a captcha (AGENTS §2 rules 2 and 6); a lock the connector reports
 *    as `E_BUSY` is left alone.
 *
 *  - **Cleanup and exit codes.** The doctor closes the window it opened before
 *    exiting, so a diagnostic does not leave an `about:blank` tab behind. Exit
 *    0 for ok/degraded, 2 for blocked (including an unreachable CDP).
 *
 * A hung endpoint cannot stall the gate: `buildDoctorReport` bounds `connect()`
 * by `cdp.connectTimeoutMs` plus the discovery budget (PLAN V1.5).
 */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createConnector } from "../cdp/browser.ts";
import type { Connector, ConnectorOptions } from "../cdp/browser.ts";
import { defaultLockPath } from "../cdp/browser.ts";
import { discoverEndpoint } from "../cdp/discovery.ts";
import { loadConfig, resolveConfigPath } from "../config.ts";
import type { Config } from "../config.ts";
import { createDefaultRegistry } from "../engines/index.ts";
import type { EngineRegistry } from "../engines/types.ts";
import { createArtifacts } from "../runtime/artifacts.ts";
import { systemClock } from "../runtime/clock.ts";
import {
  applyDoctorFix,
  buildDoctorReport,
  createEngineProbe,
  renderDoctorText,
  DOCTOR_BLOCKED_EXIT_CODE,
} from "../runtime/doctor.ts";
import type { DoctorDeps, DoctorReport, EngineProbe } from "../runtime/doctor.ts";
import { isWebSearchError } from "../runtime/error-codes.ts";
import type { FailureDetails } from "../runtime/error-codes.ts";
import { fail, renderFailureText, toFailure } from "../runtime/errors.ts";
import { agentDir } from "../runtime/host.ts";
import { createLimiter } from "../runtime/limiter.ts";
import { createLogger } from "../runtime/log.ts";
import type { Artifacts, Cache, Clock, Limiter, Logger } from "../runtime/types.ts";
import { STATE_DIR_NAME } from "../version.ts";

/** Same resolution as `resolveConfigPath`; the host layer owns the agent dir. */
function stateDir(env: NodeJS.ProcessEnv): string {
  return join(agentDir(env), STATE_DIR_NAME);
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
  /**
   * Pacing for the live probe. Production leaves it unset and gets the real
   * limiter over `~/.pi/agent/web-search/state.json`, so `--fix`/`--json` never
   * fire three unthrottled searches (AGENTS §2 rule 7); tests inject a fake.
   */
  limiter?: Limiter;
  /**
   * Test seams for the safe `--fix` stale-lock reclaim. Production leaves both
   * unset and gets the host layer's signal-free liveness check plus `fs.unlink`;
   * no code here ever signals a process.
   */
  alive?: (pid: number) => boolean;
  removeLock?: (path: string) => Promise<void>;
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

  // The CLI must report the same registry the extension uses: an empty map made
  // every engine look unregistered even after P3 shipped the adapters.
  const registry = deps.registry ?? createDefaultRegistry(config);

  // The same runtime objects the extension uses: the probe acquires an owned
  // work tab through this connector, extracts with the real adapters and paces
  // through the same limiter as `web_search`. The factory itself is lazy, so
  // `--no-probe` never touches the browser; the limiter only reads its state.
  const limiter =
    deps.limiter ?? createLimiter({ config, clock, statePath: join(stateDir(env), "state.json") });
  const probe: EngineProbe =
    deps.probe ?? createEngineProbe({ config, connector, registry, clock, limiter });

  // Artifacts are reported and pruned through the same root the tools use. An
  // injected instance (tests) always wins; nothing is created on disk until a
  // `save()` or `prune()` actually runs.
  const artifacts = deps.artifacts ?? createArtifacts({ config, clock, env });

  const doctorDeps: DoctorDeps = {
    config,
    configPath,
    connector,
    registry,
    clock,
    ...(deps.cache === undefined ? {} : { cache: deps.cache }),
    artifacts,
    probe,
    limiter,
    env,
  };

  if (args.fix) {
    const actions = await applyDoctorFix(doctorDeps, {
      ...(deps.alive === undefined ? {} : { alive: deps.alive }),
      ...(deps.removeLock === undefined ? {} : { remove: deps.removeLock }),
    });
    if (actions.length > 0) {
      const text = actions.map((action) => `fix: ${action}\n`).join("");
      // JSON on stdout must stay schema-valid, so fix notes go to stderr there.
      if (json) writeError(text);
      else write(text);
    }
  }

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
