/**
 * Strict config schema (S13.1): one hand-rolled spec, exact key paths in errors,
 * no dependency. Unknown keys, wrong types and out-of-range values are
 * `E_CONFIG` naming the dotted path.
 */

import { ENGINE_IDS } from "../engines/types.ts";
import { WebSearchError, type FailureDetails } from "../runtime/error-codes.ts";
import { DEFAULT_CONFIG, type Config } from "./defaults.ts";

export type Spec =
  | { kind: "string"; nonEmpty?: boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "number"; integer?: boolean; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "array"; item: Spec; minItems?: number; maxItems?: number }
  | { kind: "tuple"; items: readonly [Spec, Spec] }
  | { kind: "nullable"; of: Spec }
  | { kind: "object"; fields: Record<string, Spec> };

const STRING_NE: Spec = { kind: "string", nonEmpty: true };
const BOOL: Spec = { kind: "boolean" };
const NUM = (min = 0, integer = true, max?: number): Spec =>
  max === undefined ? { kind: "number", min, integer } : { kind: "number", min, integer, max };

/** The one schema. `src/config/doc.ts` renders `docs/config.md` from it. */
export const CONFIG_SPEC: Spec = {
  kind: "object",
  fields: {
    cdp: {
      kind: "object",
      fields: {
        ports: { kind: "array", item: NUM(1, true, 65535), minItems: 1 },
        ws: { kind: "nullable", of: STRING_NE },
        connectTimeoutMs: NUM(1),
        attachWaitMs: NUM(0, true, 600_000),
      },
    },
    window: {
      kind: "object",
      fields: {
        focus: { kind: "enum", values: ["session", "always", "never"] },
        raiseOnPrompt: { kind: "enum", values: ["auto", "never"] },
        panel: BOOL,
        follow: { kind: "enum", values: ["work", "anchor", "never"] },
        idleMs: NUM(0, true, 60_000),
      },
    },
    humanize: { kind: "enum", values: ["auto", "always", "typing"] },
    engines: {
      kind: "object",
      fields: {
        google: { kind: "object", fields: { enabled: BOOL, lang: STRING_NE, gl: STRING_NE } },
        duckduckgo: { kind: "object", fields: { enabled: BOOL, kl: STRING_NE } },
        yandex: { kind: "object", fields: { enabled: BOOL, lr: STRING_NE } },
      },
    },
    pacing: {
      kind: "object",
      fields: {
        google: { kind: "tuple", items: [NUM(0), NUM(0)] },
        duckduckgo: { kind: "tuple", items: [NUM(0), NUM(0)] },
        yandex: { kind: "tuple", items: [NUM(0), NUM(0)] },
      },
    },
    search: {
      kind: "object",
      fields: {
        n: NUM(1),
        nMax: NUM(1),
        summaryMaxChars: NUM(1),
        snippetMaxChars: NUM(1),
        outputMaxChars: NUM(1),
        aiWaitMs: NUM(0, true, 60_000),
        aiExpand: BOOL,
      },
    },
    read: {
      kind: "object",
      fields: {
        defaultMaxChars: NUM(1),
        maxCharsCeiling: NUM(1),
        pool: NUM(1, true, 3),
        pdfMaxBytes: NUM(1),
        keepPdf: BOOL,
        pdfPageMaxChars: NUM(1),
      },
    },
    image: { kind: "object", fields: { attachMaxBytes: NUM(1) } },
    cache: { kind: "object", fields: { serpTtlMs: NUM(0), gotoTtlMs: NUM(0), maxEntries: NUM(1) } },
    artifacts: { kind: "object", fields: { enabled: BOOL, keep: NUM(1), maxBytes: NUM(1) } },
    debug: BOOL,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string, source: string): WebSearchError {
  const details: FailureDetails = {
    code: "E_CONFIG",
    stage: "config",
    retryable: false,
    hint: `check ${source}: ${message}`,
    message,
  };
  return new WebSearchError(details);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validate(spec: Spec, value: unknown, path: string, source: string): unknown {
  switch (spec.kind) {
    case "string": {
      if (typeof value !== "string") {
        throw configError(`${path}: expected string, got ${describe(value)}`, source);
      }
      if (spec.nonEmpty && value.trim() === "") {
        throw configError(`${path}: expected a non-empty string`, source);
      }
      return value;
    }
    case "enum": {
      if (typeof value !== "string" || !spec.values.includes(value)) {
        throw configError(`${path}: expected one of ${spec.values.join(" | ")}, got ${describe(value)}`, source);
      }
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw configError(`${path}: expected number, got ${describe(value)}`, source);
      }
      if (spec.integer && !Number.isInteger(value)) {
        throw configError(`${path}: expected an integer, got ${value}`, source);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw configError(`${path}: must be >= ${spec.min}, got ${value}`, source);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw configError(`${path}: must be <= ${spec.max}, got ${value}`, source);
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw configError(`${path}: expected boolean, got ${describe(value)}`, source);
      }
      return value;
    }
    case "null": {
      if (value !== null) {
        throw configError(`${path}: expected null, got ${describe(value)}`, source);
      }
      return value;
    }
    case "nullable": {
      return value === null ? null : validate(spec.of, value, path, source);
    }
    case "array": {
      if (!Array.isArray(value)) {
        throw configError(`${path}: expected array, got ${describe(value)}`, source);
      }
      if (spec.minItems !== undefined && value.length < spec.minItems) {
        throw configError(`${path}: expected at least ${spec.minItems} item(s)`, source);
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        throw configError(`${path}: expected at most ${spec.maxItems} item(s)`, source);
      }
      return value.map((item, index) => validate(spec.item, item, `${path}[${index}]`, source));
    }
    case "tuple": {
      if (!Array.isArray(value) || value.length !== spec.items.length) {
        throw configError(`${path}: expected a ${spec.items.length}-item array`, source);
      }
      const [first, second] = spec.items;
      return [
        validate(first, value[0], `${path}[0]`, source),
        validate(second, value[1], `${path}[1]`, source),
      ];
    }
    case "object": {
      if (!isPlainObject(value)) {
        throw configError(`${path}: expected an object, got ${describe(value)}`, source);
      }
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(spec.fields, key)) {
          throw configError(`${path}.${key}: unknown key (unknown keys are rejected)`, source);
        }
      }
      const result: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(spec.fields)) {
        if (!Object.hasOwn(value, key)) {
          throw configError(`${path}.${key}: missing required key`, source);
        }
        result[key] = validate(field, value[key], `${path}.${key}`, source);
      }
      return result;
    }
  }
}

/**
 * Deep-merge a partial config over defaults. Objects merge recursively; arrays
 * (including pacing tuples) are replaced by the patch.
 */
function mergeConfig(base: unknown, patch: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = Object.hasOwn(base, key) ? mergeConfig(base[key], value) : value;
    }
    return merged;
  }
  return patch;
}

function assertCrossField(config: Config, source: string): void {
  if (config.search.n > config.search.nMax) {
    throw configError(`config.search.n: ${config.search.n} exceeds config.search.nMax (${config.search.nMax})`, source);
  }
  if (config.search.nMax > 10) {
    throw configError(`config.search.nMax: ${config.search.nMax} exceeds the supported ceiling of 10`, source);
  }
  for (const engine of ENGINE_IDS) {
    const window = config.pacing[engine];
    if (window[0] > window[1]) {
      throw configError(`config.pacing.${engine}: min gap ${window[0]} > max ${window[1]}`, source);
    }
  }
  if (config.read.defaultMaxChars > config.read.maxCharsCeiling) {
    throw configError(
      `config.read.defaultMaxChars: ${config.read.defaultMaxChars} exceeds maxCharsCeiling (${config.read.maxCharsCeiling})`,
      source,
    );
  }
  if (!ENGINE_IDS.some((id) => config.engines[id].enabled)) {
    throw configError("config.engines: at least one engine must be enabled", source);
  }
}

/**
 * Merge a partial config over defaults, then validate the result strictly.
 * Unknown keys survive the merge and are rejected by the validator.
 */
export function parseConfig(raw: unknown, opts: { source?: string } = {}): Config {
  const source = opts.source ?? "config";
  if (!isPlainObject(raw)) {
    throw configError("top level: expected a JSON object", source);
  }
  const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), raw);
  const validated = validate(CONFIG_SPEC, merged, "config", source) as Config;
  assertCrossField(validated, source);
  return validated;
}

export { configError };
