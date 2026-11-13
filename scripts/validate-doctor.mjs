#!/usr/bin/env node
/**
 * Validate `node src/cli/doctor.ts --json` against the schema in the tree
 * (SPEC S6.3, A5).
 *
 *   node src/cli/doctor.ts --json | node scripts/validate-doctor.mjs
 *
 * Draft-07 subset only: type (including arrays), const, enum, required,
 * properties, additionalProperties, items, minItems, minimum, maximum,
 * minLength. No $ref and no remote resolution, so the check is offline and has
 * no dependency. The unit test calls the same `validate()` over a report built
 * through the CLI path, so the gate command and the suite cannot drift.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_PATH = join(ROOT, "tests", "fixtures", "doctor.schema.json");

export function loadSchema(path = SCHEMA_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(type, value) {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Every violation as `path: reason`; an empty array means the value conforms. */
export function validate(schema, value, path = "report") {
  const errors = [];

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((type) => matchesType(type, value))) {
      errors.push(`${path}: expected ${allowed.join("|")}, got ${typeOf(value)}`);
      return errors;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
    }
  }

  if (typeof value === "string" && typeof schema.minLength === "number") {
    if ([...value].length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} item(s)`);
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => {
        errors.push(...validate(schema.items, item, `${path}[${index}]`));
      });
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          errors.push(`${path}.${key}: missing required key`);
        }
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const property = properties[key];
      if (property === undefined) {
        if (schema.additionalProperties === false) {
          errors.push(`${path}.${key}: additional property not allowed`);
        } else if (isPlainObject(schema.additionalProperties)) {
          errors.push(...validate(schema.additionalProperties, item, `${path}.${key}`));
        }
        continue;
      }
      errors.push(...validate(property, item, `${path}.${key}`));
    }
  }

  return errors;
}

/** Read all of stdin; the CLI writes one JSON document. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const text = (await readStdin()).trim();
  if (text === "") {
    process.stderr.write("usage: node src/cli/doctor.ts --json | node scripts/validate-doctor.mjs\n");
    process.exitCode = 2;
    return;
  }

  let report;
  try {
    report = JSON.parse(text);
  } catch {
    process.stderr.write("validate-doctor: stdin is not JSON\n");
    process.exitCode = 1;
    return;
  }

  const errors = validate(loadSchema(), report);
  if (errors.length > 0) {
    process.stderr.write(`${errors.map((error) => `validate-doctor: ${error}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("validate-doctor: report matches tests/fixtures/doctor.schema.json\n");
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  await main();
}
