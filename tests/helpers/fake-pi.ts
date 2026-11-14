/**
 * Minimal in-memory `ExtensionAPI` used to test the registration path.
 *
 * It models the three facts the reachability contract depends on:
 *  - `direct`/`model-only` tools activate on registration unless `defaultActive: false`;
 *  - `deferred` tools stay inactive, but `tool_search` can load them;
 *  - re-registering a name replaces its definition (how the direct fallback works).
 *
 * Nothing here touches pi or the filesystem. The fake deliberately implements
 * only the API surface the extension registration uses; tests cast it once at
 * the call boundary rather than pretending to be a complete pi.
 */

import type { SourceInfo, ToolAnnotations, ToolDefinition, ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";

const SOURCE_INFO: SourceInfo = {
  path: "src/tools",
  source: "extension",
  scope: "temporary",
  origin: "top-level",
};

export interface FakePiOptions {
  /** Pre-register the built-in discovery tool, inactive as the CLI does. */
  withDiscovery?: boolean;
}

export interface FakePi {
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, options: { description?: string; handler: () => Promise<void> | void }): void;
  on(event: "session_start" | "session_shutdown", handler: () => Promise<void> | void): () => void;
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  setActiveTools(names: string[]): void;
  /** Fire a session event and await every handler. */
  emit(event: "session_start" | "session_shutdown"): Promise<void>;
  /** Tools the model sees: active declarations, never deferred/hidden ones. */
  visible(): string[];
}

function toInfo(tool: ToolDefinition): ToolInfo {
  const info: ToolInfo = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    exposure: tool.exposure ?? "direct",
    annotations: tool.annotations as ToolAnnotations | undefined,
    sourceInfo: SOURCE_INFO,
  };
  if (tool.promptGuidelines !== undefined) info.promptGuidelines = [...tool.promptGuidelines];
  if (tool.reachesTools !== undefined) info.reachesTools = tool.reachesTools;
  return info;
}

export function createFakePi(options: FakePiOptions = {}): FakePi {
  const tools = new Map<string, ToolInfo>();
  const handlers = new Map<string, Array<() => Promise<void> | void>>();
  let active: string[] = [];

  const declares = (exposure: ToolExposure): boolean => exposure === "direct" || exposure === "model-only";

  function registerTool(tool: ToolDefinition): void {
    const info = toInfo(tool);
    tools.set(info.name, info);
    if (declares(info.exposure) && tool.defaultActive !== false) {
      if (!active.includes(info.name)) active.push(info.name);
      return;
    }
    active = active.filter((name) => name !== info.name);
  }

  const pi: FakePi = {
    registerTool,
    registerCommand() {},
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
      };
    },
    getActiveTools: () => [...active],
    getAllTools: () => [...tools.values()],
    setActiveTools(names) {
      // pi ignores unknown and hidden names; keep that behaviour so a typo in
      // the extension cannot look like a successful activation.
      const known = new Set([...tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name));
      active = [...new Set(names)].filter((name) => known.has(name));
    },
    async emit(event) {
      for (const handler of handlers.get(event) ?? []) await handler();
    },
    visible: () =>
      active
        .map((name) => tools.get(name))
        .filter((tool): tool is ToolInfo => tool !== undefined && declares(tool.exposure))
        .map((tool) => tool.name),
  };

  if (options.withDiscovery === true) {
    // Shape matches the built-in: model-only, inactive until setActiveTools,
    // and it declares `reachesTools` so it can reach deferred tools.
    registerTool({
      name: "tool_search",
      label: "tool_search",
      description: "Search for tools that are not loaded yet and load the matches",
      parameters: {},
      exposure: "model-only",
      defaultActive: false,
      reachesTools: () => "all",
      execute: async () => ({ content: [], details: {} }),
    } as unknown as ToolDefinition);
  }

  return pi;
}
