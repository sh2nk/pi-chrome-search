/**
 * The single source of truth for the tool surface (P2-E + P4-D).
 *
 * Registration in `src/index.ts` and the prompt-budget test both call
 * `createTools`, so a tool cannot be added to one without the other. Deferred
 * tools (P4: web_read, image_search, web_research) are appended here and stay
 * out of the prompt until `tool_search` activates them.
 */

import type { ToolDeps } from "./types.ts";
import { createWebSearchTool } from "./web_search.ts";

export type ToolDepsGetter = () => ToolDeps | Promise<ToolDeps>;

export function createTools(getDeps: ToolDepsGetter) {
  return [createWebSearchTool(getDeps)];
}

export type RegisteredTool = ReturnType<typeof createTools>[number];
