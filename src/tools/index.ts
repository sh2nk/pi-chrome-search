/**
 * The single source of truth for the tool surface (P2-E + P4).
 *
 * Registration in `src/index.ts` and the prompt-budget test both call
 * `createTools`, so a tool cannot be added to one without the other.
 *
 * Exposure matters: `web_search` is `direct` (the agent sees it immediately),
 * everything else is `deferred` — findable via tool search and callable from
 * codemode scripts, but not paid for in every prompt (SPEC §7.1, §8).
 */

import type { ToolDeps } from "./types.ts";
import { createWebDoctorTool, type WebDoctorDepsGetter } from "./web_doctor.ts";
import { createWebSearchTool } from "./web_search.ts";

export type ToolDepsGetter = () => ToolDeps | Promise<ToolDeps>;

export interface ToolFactories {
  getDeps: ToolDepsGetter;
  /** The doctor needs its own dependency shape (config path, probe, artifacts). */
  getDoctorDeps: WebDoctorDepsGetter;
}

export function createTools(factories: ToolFactories) {
  return [createWebSearchTool(factories.getDeps), createWebDoctorTool(factories.getDoctorDeps)];
}

export type RegisteredTool = ReturnType<typeof createTools>[number];
