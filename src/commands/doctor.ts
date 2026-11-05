/**
 * `/web-doctor` command handler (SPEC §10.3, PLAN P1-E).
 *
 * The command is a compact, non-blocking summary; `node src/cli/doctor.ts
 * --json` stays the canonical machine surface. Two rules matter here:
 *
 *  - **Never throw into pi.** A command handler that rejects can take down the
 *    session's input loop, so every failure becomes a notification built from
 *    the shared error taxonomy.
 *  - **Build the report lazily.** The handler runs inside a live session; the
 *    deps factory is only called when the user actually runs the command, so an
 *    unused command costs nothing at load time.
 */

import type { DoctorDeps, DoctorReport } from "../runtime/doctor.ts";
import { buildDoctorReport } from "../runtime/doctor.ts";
import { toFailure } from "../runtime/errors.ts";

/** The slice of pi's `ExtensionCommandContext` this module needs. */
export interface NotifyContext {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export type DoctorDepsFactory = () => DoctorDeps | Promise<DoctorDeps>;

export interface DoctorCommandOptions {
  /** Canonical JSON surface, printed by the handler when a direct run needs it. */
  cliCommand?: string;
}

function parsedProbe(args: string): boolean {
  return !args.split(/\s+/).includes("--no-probe");
}

function engineSummary(report: DoctorReport): string {
  return report.engines.map((engine) => `${engine.id}=${engine.verdict}`).join(", ");
}

function statusLine(report: DoctorReport): string {
  const webdriver = report.cdp.webdriver === null ? "unknown" : String(report.cdp.webdriver);
  const lock = report.cdp.lock.locked ? "held" : "free";
  return (
    `web-doctor: ${report.verdict} — cdp ${report.cdp.status}, webdriver ${webdriver}, lock ${lock}; ` +
    `engines ${engineSummary(report)}`
  );
}

/** One compact notification, plus a hint line when the CDP layer failed. */
export async function handleDoctorCommand(
  args: string,
  ctx: NotifyContext,
  depsFactory: DoctorDepsFactory,
  options: DoctorCommandOptions = {},
): Promise<void> {
  try {
    if (args.split(/\s+/).includes("--json")) {
      // Print mode has no structured notification channel; name the real surface.
      const cli = options.cliCommand ?? "node src/cli/doctor.ts --json";
      ctx.ui.notify(`web-doctor: JSON output is canonical at \`${cli}\``, "warning");
      return;
    }

    const deps = await depsFactory();
    const report = await buildDoctorReport(deps, { probe: parsedProbe(args) });
    const type = report.verdict === "ok" ? "info" : report.verdict === "degraded" ? "warning" : "error";
    ctx.ui.notify(statusLine(report), type);

    if (report.cdp.error !== undefined) {
      ctx.ui.notify(
        `web-doctor: [${report.cdp.error.code}] ${report.cdp.error.hint}`,
        report.verdict === "blocked" ? "error" : "warning",
      );
    }
  } catch (error) {
    const details = toFailure(error, { code: "E_CONFIG", stage: "config" });
    ctx.ui.notify(`web-doctor failed [${details.code}] ${details.hint}`, "error");
  }
}
