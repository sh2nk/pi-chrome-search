/**
 * Rendering helpers for the generated parts of `README.md` (S13.3 pattern).
 *
 * The tool table is derived from the same `createTools()` definitions the
 * extension registers, so it cannot advertise an argument that the schema does
 * not accept or an exposure the session does not use. The README keeps only the
 * markers; `scripts/gen-readme.mjs --check` fails when the block drifts.
 */

export const README_TOOLS_START = "<!-- tools:start -->";
export const README_TOOLS_END = "<!-- tools:end -->";

export interface SurfaceTool {
  readonly name: string;
  readonly description: string;
  readonly exposure?: string;
  readonly parameters: unknown;
}

export interface ToolSurfaceRow {
  name: string;
  exposure: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function range(node: Record<string, unknown>): string {
  const min = typeof node.minimum === "number" ? node.minimum : undefined;
  const max = typeof node.maximum === "number" ? node.maximum : undefined;
  if (min !== undefined && max !== undefined) return ` ${min}..${max}`;
  if (min !== undefined) return ` >=${min}`;
  if (max !== undefined) return ` <=${max}`;
  return "";
}

/** One schema node as a table-safe label. No `|`, because it breaks a row. */
function typeLabel(node: unknown, nested = false): string {
  if (!isRecord(node)) return "value";

  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union)) {
    const parts = union.map((entry) => typeLabel(entry, true));
    return nested ? `(${parts.join(" or ")})` : parts.join(" or ");
  }

  if (typeof node.const === "string") return `"${node.const}"`;
  if (isStringArray(node.enum)) return node.enum.join("/");

  if (node.type === "array") {
    const item = typeLabel(node.items, true);
    const min = typeof node.minItems === "number" ? node.minItems : undefined;
    const max = typeof node.maxItems === "number" ? node.maxItems : undefined;
    const count = min !== undefined && max !== undefined ? ` ${min}..${max}` : "";
    return `list of ${item}${count}`;
  }

  if (node.type === "integer") return `integer${range(node)}`;
  if (node.type === "number") return `number${range(node)}`;
  if (node.type === "boolean") return "boolean";
  if (node.type === "string") return `string${range(node)}`;
  return "value";
}

function argumentList(schema: unknown): string {
  if (!isRecord(schema) || !isRecord(schema.properties)) return "";
  const required = new Set(isStringArray(schema.required) ? schema.required : []);
  const parts: string[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    const optional = required.has(name) ? "" : "?";
    parts.push(`\`${name}${optional}\` ${typeLabel(property)}`);
  }
  return parts.join("; ");
}

export function toolSurfaceRows(tools: readonly SurfaceTool[]): ToolSurfaceRow[] {
  return tools.map((tool) => ({
    name: tool.name,
    exposure: tool.exposure ?? "direct",
    arguments: argumentList(tool.parameters),
  }));
}

export function renderReadmeToolTable(tools: readonly SurfaceTool[]): string {
  const rows = toolSurfaceRows(tools);
  return [
    "| Tool | Exposure | Arguments |",
    "|---|---|---|",
    ...rows.map((row) => `| \`${row.name}\` | ${row.exposure} | ${row.arguments} |`),
  ].join("\n");
}
