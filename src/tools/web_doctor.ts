/**
 * `web_doctor` — the deferred tool surface of the doctor (SPEC §10.3, D11,
 * PLAN P4-C).
 *
 * One report builder serves the CLI, `/web-doctor` and this tool:
 * `buildDoctorReport()` is reused verbatim, so the three surfaces cannot drift.
 * Two constraints shape the output:
 *
 *  - **Compact text, not the report JSON.** The agent already pays for a tool
 *    result; returning the whole report would duplicate `/web-doctor --json`.
 *    Details carry only `{ verdict, cdp, engines }`, and the text is a short
 *    per-engine summary.
 *  - **No new browser.** The tool is handed the extension's lazy deps, exactly
 *    like `web_search`; it never constructs a connector or an artifact writer.
 *
 * `fix` runs the same safe action set as `node src/cli/doctor.ts --fix`:
 * reconnect once, close only this connector's owned tabs, prune artifacts and
 * clear a lock whose owner is dead. It never signals a process and never closes
 * a foreign tab.
 *
 * `readOnlyHint` is **false**, deliberately: with `fix: true` the tool closes
 * owned tabs and prunes artifact files, which mutates the browser and the disk.
 * Claiming read-only would let a caller batch it with genuinely inert tools.
 * It is still `openWorldHint` (it talks to the live browser) and
 * `idempotentHint` (a repeat call converges on the same state).
 */

import { Type, type Static } from "typebox";

import type { DoctorCdp, DoctorDeps, DoctorEngine, DoctorReport, DoctorVerdict } from "../runtime/doctor.ts";
import { applyDoctorFix, buildDoctorReport } from "../runtime/doctor.ts";
import type { FailureJson, ToolTextBlock } from "../runtime/errors.ts";
import { fail, renderToolFailure, toFailure } from "../runtime/errors.ts";

// ---------------------------------------------------------------------------
// Input schema (plain literals: provider-safe, no enum helper)
// ---------------------------------------------------------------------------

export const webDoctorSchema = Type.Object({
  probe: Type.Optional(Type.Boolean()),
  fix: Type.Optional(Type.Boolean()),
});

export type WebDoctorInput = Static<typeof webDoctorSchema>;

export interface WebDoctorDetails {
  verdict: DoctorVerdict;
  /**
   * Full CDP section: endpoint/browser/lock/error are already in the report's
   * public shape (loopback URL + local paths only, never cookies or page HTML).
   */
  cdp: DoctorCdp;
  engines: DoctorEngine[];
}

export interface WebDoctorSuccess {
  content: ToolTextBlock[];
  details: WebDoctorDetails;
}

export interface WebDoctorFailure {
  content: ToolTextBlock[];
  details: FailureJson;
  isError: true;
}

export type WebDoctorResult = WebDoctorSuccess | WebDoctorFailure;

export type WebDoctorDepsGetter = (ctx?: unknown) => DoctorDeps | Promise<DoctorDeps>;

/** Same contract as every other tool; `createTools`/`src/index.ts` wires it. */
export interface WebDoctorTool {
  name: "web_doctor";
  label: string;
  description: string;
  parameters: typeof webDoctorSchema;
  exposure: "deferred";
  annotations: { readOnlyHint: false; openWorldHint: true; idempotentHint: true };
  execute(
    toolCallId: string,
    params: WebDoctorInput,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx?: unknown,
  ): Promise<WebDoctorResult>;
}

/** Kept well under the 350-char per-tool cap; measured in the lane test. */
export const WEB_DOCTOR_DESCRIPTION =
  "Diagnose CDP attach, lock, window, per-engine probe verdicts and canaries. Optional fix reconnects, closes only owned tabs and prunes artifacts.";

const INPUT_HINT = "check the web_doctor arguments: probe and fix are booleans";

interface NormalizedInput {
  probe: boolean;
  fix: boolean;
}

type Validation = { ok: true; value: NormalizedInput } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The schema is the first line of defence, but codemode and a repeat tool call
 * bypass it; a string is rejected here rather than being coerced to `true`.
 */
function normalizeInput(raw: unknown): Validation {
  if (raw === undefined || raw === null) return { ok: true, value: { probe: true, fix: false } };
  if (!isRecord(raw)) return { ok: false, message: "arguments: expected an object" };

  for (const key of ["probe", "fix"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      return { ok: false, message: `${key}: expected a boolean, got ${JSON.stringify(raw[key])}` };
    }
  }

  return {
    ok: true,
    value: { probe: raw.probe !== false, fix: raw.fix === true },
  };
}

function failure(error: unknown): WebDoctorFailure {
  const rendered = renderToolFailure(
    "web_doctor",
    toFailure(error, { code: "E_CONFIG", stage: "config" }),
  );
  return { content: rendered.content, details: rendered.details, isError: true };
}

function failureFor(message: string): WebDoctorFailure {
  const rendered = renderToolFailure(
    "web_doctor",
    // The rendered text uses the hint; put the concrete cause there so the agent
    // does not have to open `details` to learn which field was wrong.
    fail("E_CONFIG", "config", { hint: `${message}; ${INPUT_HINT}`, message }).details,
  );
  return { content: rendered.content, details: rendered.details, isError: true };
}

/** Short, deterministic text: verdict + per-engine one-liners + fix actions. */
export function renderWebDoctorText(report: DoctorReport, actions: readonly string[] = []): string {
  const lines: string[] = [];
  const webdriver = report.cdp.webdriver === null ? "unknown" : String(report.cdp.webdriver);
  lines.push(
    `web_doctor: ${report.verdict} — cdp ${report.cdp.status}, webdriver ${webdriver}, ` +
      `lock ${report.cdp.lock.locked ? "held" : "free"}`,
  );
  if (report.cdp.error !== undefined) {
    lines.push(`cdp error [${report.cdp.error.code}] ${report.cdp.error.stage}: ${report.cdp.error.hint}`);
  }

  lines.push("engines:");
  for (const engine of report.engines) {
    const probe =
      engine.probe === undefined
        ? ""
        : ` (${engine.probe.results} results, ai=${engine.probe.ai ? "yes" : "no"}, ${engine.probe.ms}ms)`;
    const note = engine.note === undefined ? "" : ` — ${engine.note}`;
    lines.push(`  ${engine.id} ${engine.verdict}${probe}${note}`);
  }

  for (const action of actions) lines.push(`fix: ${action}`);
  return `${lines.join("\n")}\n`;
}

export function createWebDoctorTool(getDeps: WebDoctorDepsGetter): WebDoctorTool {
  async function execute(
    _toolCallId: string,
    params: WebDoctorInput,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: unknown,
  ): Promise<WebDoctorResult> {
    const validation = normalizeInput(params as unknown);
    if (!validation.ok) return failureFor(validation.message);
    if (signal?.aborted === true) {
      const rendered = renderToolFailure(
        "web_doctor",
        fail("E_CANCELLED", "config", { message: "aborted by the caller" }).details,
      );
      return { content: rendered.content, details: rendered.details, isError: true };
    }

    let deps: DoctorDeps;
    try {
      deps = await getDeps(ctx);
    } catch (error) {
      return failure(error);
    }

    const actions = validation.value.fix ? await applyDoctorFix(deps) : [];
    // P9-D: after a fix the report must describe the repaired session, so a fix
    // re-probes even when the caller passed probe:false. Reporting the state
    // from before the fix (or "skipped") would hide whether the repair worked.
    const probe = validation.value.fix ? true : validation.value.probe;
    const report = await buildDoctorReport(deps, { probe });

    return {
      content: [{ type: "text", text: renderWebDoctorText(report, actions) }],
      details: { verdict: report.verdict, cdp: report.cdp, engines: report.engines },
    };
  }

  return {
    name: "web_doctor",
    label: "Web Doctor",
    description: WEB_DOCTOR_DESCRIPTION,
    parameters: webDoctorSchema,
    exposure: "deferred",
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    execute,
  };
}
