/**
 * Fixture loader for adapter tests (P3/P4).
 *
 * Layout (see tests/fixtures/README.md):
 *   tests/fixtures/<name>.html.gz    gzip of the sanitized post-render HTML
 *   tests/fixtures/<name>.meta.json  engine, url path shape, query class, date
 *
 * `loadFixture()` refuses to return dirty HTML: the same rules that sanitize a
 * capture are re-run at load time, so a fixture that slipped through review fails
 * loudly in CI instead of leaking an account email or a session token.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineId } from "../../src/engines/types.ts";
import { ENGINE_IDS } from "../../src/engines/types.ts";
import { findUnsafe, gunzip, type SanitizeFinding } from "./sanitize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, "..", "fixtures");

const NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;
const QUERY_CLASS_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;
const DATE_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const QUERY_PLACEHOLDERS = new Set(["<query>", "{query}", "*", "%3cquery%3e", "%7bquery%7d"]);
const QUERY_PARAM = /[?&](?:q|text|query|word)=([^&#]*)/gi;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface FixtureMeta {
  engine: EngineId;
  /** Path with placeholders instead of the literal query, e.g. `/search?q=<query>&hl=ru`. */
  urlPathShape: string;
  /** Coarse class such as `no-ai`, `technical`, `wall` — never the query itself. */
  queryClass: string;
  /** `YYYY-MM-DD` or an ISO timestamp. */
  capturedAt: string;
  ai?: "yes" | "no";
  results?: number;
  notes?: string;
  capturedWith?: string;
  [key: string]: unknown;
}

export interface FixturePaths {
  html: string;
  meta: string;
}

export interface LoadFixtureOptions {
  /** Override the fixture root (tests build fixtures in a temp dir). */
  dir?: string;
  /** Literal personal queries used for the capture; checked in html and meta. */
  personalQueries?: readonly string[];
}

export interface LoadedFixture {
  name: string;
  html: string;
  meta: FixtureMeta;
  compressedBytes: number;
  htmlBytes: number;
  chars: number;
  paths: FixturePaths;
}

export class FixtureError extends Error {
  readonly fixtureName: string;

  constructor(fixtureName: string, message: string, options?: { cause?: unknown }) {
    super(`fixture "${fixtureName}": ${message}`, options);
    this.name = "FixtureError";
    this.fixtureName = fixtureName;
  }
}

export function fixturePaths(name: string, dir = FIXTURES_DIR): FixturePaths {
  assertName(name);
  return {
    html: join(dir, `${name}.html.gz`),
    meta: join(dir, `${name}.meta.json`),
  };
}

export function fixtureExists(name: string, dir = FIXTURES_DIR): boolean {
  // A probe/table-driven test asks about arbitrary names; an invalid one is
  // simply not a fixture, not an exception. `loadFixture()` still rejects it.
  if (!NAME_SHAPE.test(name)) return false;
  const paths = fixturePaths(name, dir);
  return existsSync(paths.html) && existsSync(paths.meta);
}

export function loadFixture(name: string, options: LoadFixtureOptions = {}): LoadedFixture {
  assertName(name);
  const dir = options.dir ?? FIXTURES_DIR;
  const paths = fixturePaths(name, dir);

  const compressed = readBytes(paths.html, name, "html.gz");
  let html: string;
  try {
    html = gunzip(compressed);
  } catch (cause) {
    throw new FixtureError(name, `${paths.html} is not valid gzip`, { cause });
  }

  const metaText = readBytes(paths.meta, name, "meta.json").toString("utf8");
  let rawMeta: unknown;
  try {
    rawMeta = JSON.parse(metaText);
  } catch (cause) {
    throw new FixtureError(name, `${paths.meta} is not valid JSON`, { cause });
  }

  const meta = validateFixtureMeta(rawMeta, name, options.personalQueries);
  assertClean(
    metaText,
    name,
    "meta.json",
    options.personalQueries,
  );
  assertClean(html, name, "html", options.personalQueries);

  return {
    name,
    html,
    meta,
    compressedBytes: compressed.byteLength,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    chars: html.length,
    paths,
  };
}

export function loadFixtureMeta(name: string, options: LoadFixtureOptions = {}): FixtureMeta {
  assertName(name);
  const dir = options.dir ?? FIXTURES_DIR;
  const paths = fixturePaths(name, dir);
  const text = readBytes(paths.meta, name, "meta.json").toString("utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new FixtureError(name, `${paths.meta} is not valid JSON`, { cause });
  }
  const meta = validateFixtureMeta(raw, name, options.personalQueries);
  assertClean(text, name, "meta.json", options.personalQueries);
  return meta;
}

/**
 * Validates the four required fields, the optional ones, and the privacy shape
 * of `urlPathShape`/`queryClass`. Error messages name the rule, not the value,
 * so a rejected capture cannot leak the query into CI logs.
 */
export function validateFixtureMeta(
  value: unknown,
  name = "<inline>",
  personalQueries: readonly string[] = [],
): FixtureMeta {
  if (!isRecord(value)) throw new FixtureError(name, "meta.json must be a JSON object");

  const engine = value.engine;
  if (typeof engine !== "string" || !(ENGINE_IDS as readonly string[]).includes(engine)) {
    throw new FixtureError(name, `meta.engine must be one of: ${ENGINE_IDS.join(", ")}`);
  }

  const urlPathShape = value.urlPathShape;
  if (typeof urlPathShape !== "string" || urlPathShape.length === 0 || /\s/.test(urlPathShape)) {
    throw new FixtureError(name, "meta.urlPathShape must be a non-empty string without whitespace");
  }
  if (!urlPathShape.startsWith("/") && !/^https?:\/\//.test(urlPathShape)) {
    throw new FixtureError(name, 'meta.urlPathShape must start with "/" or "http(s)://"');
  }
  for (const match of urlPathShape.matchAll(QUERY_PARAM)) {
    const raw = match[1] ?? "";
    const decoded = safeDecode(raw).toLowerCase();
    if (raw.length > 0 && !QUERY_PLACEHOLDERS.has(raw.toLowerCase()) && !QUERY_PLACEHOLDERS.has(decoded)) {
      throw new FixtureError(
        name,
        "meta.urlPathShape must use <query> instead of a literal q/text/query/word value",
      );
    }
  }

  const queryClass = value.queryClass;
  if (typeof queryClass !== "string" || !QUERY_CLASS_SHAPE.test(queryClass)) {
    throw new FixtureError(
      name,
      "meta.queryClass must be a short ascii slug (e.g. no-ai, technical, wall) — never the query text",
    );
  }

  const capturedAt = value.capturedAt;
  // `Date.parse("2026-02-30")` silently rolls over to March 2, so the shape
  // check must validate the calendar (month/day/leap year), not just parse.
  if (typeof capturedAt !== "string" || !isValidCapturedAt(capturedAt)) {
    throw new FixtureError(name, "meta.capturedAt must be YYYY-MM-DD or an ISO-8601 timestamp");
  }

  if (value.ai !== undefined && value.ai !== "yes" && value.ai !== "no") {
    throw new FixtureError(name, 'meta.ai must be "yes" or "no" when present');
  }
  if (value.results !== undefined && (typeof value.results !== "number" || !Number.isInteger(value.results) || value.results < 0)) {
    throw new FixtureError(name, "meta.results must be a non-negative integer when present");
  }
  if (value.notes !== undefined && typeof value.notes !== "string") {
    throw new FixtureError(name, "meta.notes must be a string when present");
  }
  if (value.capturedWith !== undefined && typeof value.capturedWith !== "string") {
    throw new FixtureError(name, "meta.capturedWith must be a string when present");
  }

  assertClean(JSON.stringify(value), name, "meta.json", personalQueries);
  return value as FixtureMeta;
}

function readBytes(path: string, name: string, label: string): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    throw new FixtureError(name, `cannot read ${label} at ${path}`, { cause });
  }
}

function assertClean(
  text: string,
  name: string,
  label: string,
  personalQueries?: readonly string[],
): void {
  const findings = findUnsafe(text, { personalQueries });
  if (findings.length === 0) return;
  throw new FixtureError(name, `${label} is not sanitized: ${summarize(findings)}`);
}

function summarize(findings: SanitizeFinding[]): string {
  return findings
    .slice(0, 5)
    .map((finding) => `${finding.rule}@${finding.index}`)
    .join(", ");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

function isValidCapturedAt(value: string): boolean {
  const match = DATE_SHAPE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertName(name: string): void {
  if (!NAME_SHAPE.test(name)) {
    throw new FixtureError(name, "fixture name must match ^[a-z0-9][a-z0-9-]*$");
  }
}
