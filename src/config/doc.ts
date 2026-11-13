/**
 * Documentation data for `docs/config.md` (S13.3).
 *
 * The generator walks `CONFIG_SPEC` and `DEFAULT_CONFIG`, so a key, default,
 * range or enum member cannot drift from this page. Every leaf must have a
 * meaning here; a missing entry fails generation instead of shipping a blank.
 */

import { DEFAULT_CONFIG } from "./defaults.ts";
import { ENV_OVERRIDES } from "./env.ts";
import { CONFIG_SPEC, type Spec } from "./schema.ts";

const CONFIG_DOCS: Readonly<Record<string, string>> = {
  "cdp.ports": "Ports probed when no `DevToolsActivePort` and no env URL exists.",
  "cdp.ws": "Explicit WebSocket URL; `null` means discover.",
  "cdp.connectTimeoutMs": "Per-attempt connect budget.",
  "cdp.attachWaitMs": "How long to wait for the CDP Allow click before `E_CDP_AWAITING_ALLOW`; `0` disables the wait.",
  "window.focus": "`session` raises on the first search, `always` on every stage, `never` never.",
  "window.raiseOnPrompt": "Best-effort raise while the Allow prompt waits; `never` keeps the session passive.",
  "window.panel": "Host the local anchor control panel (`assets/anchor.html`).",
  "window.follow": "`work` raises the work tab, `anchor` the panel tab, `never` nothing.",
  "window.idleMs": "Delay before the anchor returns after a stage ends.",
  humanize: "`auto` types the first search per session, `always` every search, `typing` uses per-engine profiles.",
  "engines.google.enabled": "Use Google.",
  "engines.google.lang": "`hl`; `auto` omits it.",
  "engines.google.gl": "`gl`; `auto` omits it.",
  "engines.duckduckgo.enabled": "Use DuckDuckGo.",
  "engines.duckduckgo.kl": "Region/language; `auto` omits it.",
  "engines.yandex.enabled": "Use Yandex.",
  "engines.yandex.lr": "`lr`; `auto` omits it.",
  "pacing.google": "Min/max gap in ms between Google searches.",
  "pacing.duckduckgo": "Min/max gap in ms between DuckDuckGo searches.",
  "pacing.yandex": "Min/max gap in ms between Yandex searches.",
  "search.budgetMs": "Whole-call deadline in ms; pacing, settle, AI wait and link resolution draw from it (S8.1).",
  "search.n": "Default result count.",
  "search.nMax": "Hard ceiling for `n`; never above 10.",
  "search.summaryMaxChars": "Cap for the AI answer block.",
  "search.snippetMaxChars": "Cap for one snippet.",
  "search.outputMaxChars": "Cap for the whole Markdown output.",
  "search.aiWaitMs": "Deadline for the native AI block; `0` disables waiting.",
  "search.aiExpand": "Click the engine's \"show more\" on the AI card once.",
  "read.budgetMs": "Whole-call deadline in ms; navigation, readiness, extraction and the PDF ladder draw from it (S8.1).",
  "read.defaultMaxChars": "Default `maxChars` window.",
  "read.maxCharsCeiling": "`maxChars` above this is clamped and reported.",
  "read.pool": "Concurrent read slots; each holds its own tab and exclusive lock.",
  "read.pdfMaxBytes": "Refuse larger PDFs.",
  "read.keepPdf": "Keep the downloaded PDF in the artifact directory.",
  "read.pdfPageMaxChars": "Per-page cap for PDF text.",
  "image.attachMaxBytes": "Size ceiling for one attached image.",
  "cache.serpTtlMs": "SERP cache TTL (10 min).",
  "cache.gotoTtlMs": "Resolved `/goto` links TTL (24 h).",
  "cache.maxEntries": "LRU size.",
  "artifacts.enabled": "Write `page.html`/`page.txt`/`screenshot.jpg`/`meta.json` on failures.",
  "artifacts.keep": "Artifact directories to keep.",
  "artifacts.maxBytes": "Artifact root budget.",
  debug: "Verbose decision logging.",
};

export interface ConfigDocRow {
  path: string;
  defaultValue: string;
  constraint: string;
  meaning: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatDefault(value: unknown): string {
  return JSON.stringify(value);
}

function constraint(spec: Spec): string {
  switch (spec.kind) {
    case "string":
      return spec.nonEmpty ? "non-empty string" : "string";
    case "enum":
      return `one of ${spec.values.map((value) => `\`${value}\``).join(", ")}`;
    case "number": {
      const type = spec.integer ? "integer" : "number";
      if (spec.min !== undefined && spec.max !== undefined) return `${type} ${spec.min}..${spec.max}`;
      if (spec.min !== undefined) return `${type} ≥ ${spec.min}`;
      if (spec.max !== undefined) return `${type} ≤ ${spec.max}`;
      return type;
    }
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "nullable":
      return `null or ${constraint(spec.of)}`;
    case "array": {
      const item = constraint(spec.item);
      const count =
        spec.minItems !== undefined && spec.maxItems !== undefined
          ? ` (${spec.minItems}..${spec.maxItems} items)`
          : spec.minItems !== undefined
            ? ` (≥${spec.minItems} items)`
            : "";
      return `array of ${item}${count}`;
    }
    case "tuple":
      return `[${spec.items.map(constraint).join(", ")}]`;
    case "object":
      return "object";
  }
}

function valueAt(path: string): unknown {
  let current: unknown = DEFAULT_CONFIG;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) throw new Error(`config default is missing ${path}`);
    current = current[segment];
  }
  return current;
}

function walk(spec: Spec, prefix: string, rows: ConfigDocRow[]): void {
  if (spec.kind === "object") {
    for (const [key, field] of Object.entries(spec.fields)) {
      walk(field, prefix === "" ? key : `${prefix}.${key}`, rows);
    }
    return;
  }
  const meaning = CONFIG_DOCS[prefix];
  if (meaning === undefined) throw new Error(`docs/config.md: no meaning for ${prefix}`);
  const value = valueAt(prefix);
  if (value === undefined) throw new Error(`docs/config.md: no default for ${prefix}`);
  rows.push({
    path: prefix,
    defaultValue: formatDefault(value),
    constraint: constraint(spec),
    meaning,
  });
}

export function configDocRows(): ConfigDocRow[] {
  const rows: ConfigDocRow[] = [];
  walk(CONFIG_SPEC, "", rows);
  const documented = new Set(Object.keys(CONFIG_DOCS));
  for (const row of rows) documented.delete(row.path);
  if (documented.size > 0) {
    throw new Error(`docs/config.md: stale meanings for ${[...documented].join(", ")}`);
  }
  return rows;
}

export function renderConfigDoc(): string {
  const rows = configDocRows();
  const env = ENV_OVERRIDES.map((entry) => `| \`${entry.name}\` | ${entry.effect} |`);
  return [
    "# Configuration",
    "",
    "Generated from `src/config/{defaults,schema,env}.ts`; do not hand-edit. `node scripts/gen-config-doc.mjs",
    "--check` fails when this page drifts from the schema.",
    "",
    "Path: `~/.pi/agent/web-search.json` (or `$PI_CODING_AGENT_DIR/web-search.json`). Optional: the defaults",
    "below are complete. Parsing is strict: an unknown key, wrong type or out-of-range value is `E_CONFIG`",
    "naming the dotted path.",
    "",
    "## Environment overrides (applied after the file)",
    "",
    "| Variable | Effect |",
    "|---|---|",
    ...env,
    "",
    "## Keys and defaults",
    "",
    "| Key | Default | Constraint | Meaning |",
    "|---|---|---|---|",
    ...rows.map(
      (row) => `| \`${row.path}\` | \`${row.defaultValue}\` | ${row.constraint} | ${row.meaning} |`,
    ),
    "",
    "Cross-field rules: `search.n ≤ search.nMax ≤ 10`, `read.defaultMaxChars ≤ read.maxCharsCeiling`,",
    "`pacing.*[0] ≤ pacing.*[1]`, and at least one engine enabled.",
    "",
  ].join("\n");
}
