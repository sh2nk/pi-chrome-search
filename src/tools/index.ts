/**
 * The single source of truth for the tool surface (S3).
 *
 * Registration in `src/index.ts`, the reachability test, the prompt-budget test
 * and the generated README table all call `createTools`, so a tool cannot be
 * added, renamed or re-exposed in one place without the others noticing.
 *
 * Exposure is the product decision (D3): `web_search` and `web_read` are
 * `direct`; the other three are `deferred`, reachable only through an active
 * `tool_search`. `src/index.ts` promotes the deferred trio to `direct` at
 * session start when that discovery tool is absent.
 */

import { createImageSearchTool } from "./image_search.ts";
import { createWebReadTool } from "./web_read.ts";
import { createWebResearchTool } from "./web_research.ts";
import type { ToolDeps } from "./types.ts";
import { createWebDoctorTool, type WebDoctorDepsGetter } from "./web_doctor.ts";
import { createWebSearchTool } from "./web_search.ts";

export type ToolDepsGetter = () => ToolDeps | Promise<ToolDeps>;

export interface ToolFactories {
  getDeps: ToolDepsGetter;
  /** The doctor needs its own dependency shape (config path, probe, artifacts). */
  getDoctorDeps: WebDoctorDepsGetter;
}

/** The names the prompt promises: search then read (S3.4). */
export const DIRECT_TOOL_NAMES = ["web_search", "web_read"] as const;
/** The rest, reachable through discovery or promoted in the fallback branch. */
export const DEFERRED_TOOL_NAMES = ["image_search", "web_research", "web_doctor"] as const;
/** pi's built-in discovery tool; the extension activates it itself (D3). */
export const DISCOVERY_TOOL_NAME = "tool_search";

export function createTools(factories: ToolFactories) {
  // Direct tools first: registration order is the order the model sees and the
  // order the generated README table presents search → read.
  return [
    createWebSearchTool(factories.getDeps),
    createWebReadTool(factories.getDeps),
    createImageSearchTool(factories.getDeps),
    createWebResearchTool(factories.getDeps),
    createWebDoctorTool(factories.getDoctorDeps),
  ];
}

export type RegisteredTool = ReturnType<typeof createTools>[number];
