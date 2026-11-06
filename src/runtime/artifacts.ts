/**
 * Artifact snapshots for failed/ugly searches (SPEC §10.2, PLAN P4-C).
 *
 * Layout: `<root>/<YYYYMMDD-HHMMSS>-<engine>-<hash8>/`
 *   page.html        post-render DOM, form values scrubbed (still debuggable)
 *   page.txt         `innerText()`, i.e. what the extractor actually saw
 *   screenshot.jpg   viewport JPEG (already encoded by the CDP page)
 *   meta.json        code/stage/url/query + a compact SERP summary
 *
 * Two rules shape this module:
 *
 * 1. `save()` almost always runs *while another failure is being reported*. Every
 *    browser read therefore degrades to "file missing" instead of throwing: a
 *    screenshot that fails because the tab just closed must not replace the
 *    original `E_PARSE` with a secondary error and send the reader to the wrong
 *    place. Disk failures are different — the caller asked us to persist proof,
 *    so a write that fails is `E_CONFIG` naming the path.
 * 2. Artifacts are local-only but often pasted into issues. The HTML keeps the
 *    structure adapters need (tags, names, classes) while dropping the values
 *    that are session-scoped or personal: form fields, hidden inputs, CSRF and
 *    correlation tokens, `document.cookie` assignments. Token redaction is a
 *    final global pass, because the tokens also ride in `jsdata`/`style` blobs,
 *    JSON islands and inline JS that no attribute rule can see. We never read
 *    cookies at all, so no cookie jar can reach the file.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "../config.ts";
import { ENGINE_IDS } from "../engines/types.ts";
import type { EngineId, SerpTimings } from "../engines/types.ts";
import { isWebSearchError } from "./error-codes.ts";
import type { WebSearchError } from "./error-codes.ts";
import { fail } from "./errors.ts";
import { agentDir } from "./host.ts";
import type { ArtifactInput, Artifacts, Clock, PruneResult } from "./types.ts";

/** Meta shape version; bump when a field is added/renamed. */
export const ARTIFACT_SCHEMA_VERSION = 1;
/** Writer version; bump when the on-disk layout itself changes. */
export const ARTIFACTS_VERSION = 1;

/** Regex metacharacters, so the engine alternation is derived from data and not hand-escaped. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Engine slugs that may appear in a directory name. Derived from `ENGINE_IDS`
 * (plus `unknown`) so adding an engine cannot silently orphan its artifacts:
 * `prune()` only matches this regex, and an unmatched directory is immortal.
 */
const ARTIFACT_ENGINE_SLUGS: readonly string[] = [...ENGINE_IDS, "unknown"];

/**
 * Names `prune()` is allowed to delete. Deliberately strict: the artifact root
 * lives under the user's home and a hand-made directory (`notes/`, a backup, a
 * second tool's output) must never be collateral damage. The optional numeric
 * suffix is the collision counter from `allocateDirectory`.
 */
export const ARTIFACT_DIR_NAME = new RegExp(
  `^\\d{8}-\\d{6}-(?:${ARTIFACT_ENGINE_SLUGS.map(escapeRegExp).join("|")})-[0-9a-f]{8}(?:-\\d+)?$`,
);

/**
 * Same grammar as `ARTIFACT_DIR_NAME`, but capturing: prune needs the timestamp
 * and the collision counter separately (see `orderOf`). Kept in one place with
 * the validator so the two cannot drift.
 */
const ARTIFACT_DIR_PARTS = new RegExp(
  `^(?<stamp>\\d{8}-\\d{6})-(?:${ARTIFACT_ENGINE_SLUGS.map(escapeRegExp).join("|")})-[0-9a-f]{8}(?:-(?<seq>\\d+))?$`,
);

/** Directory mode: artifacts can contain the user's query, so keep the tree private. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Same-second saves of the same `(query, url, code)` produce the same base name.
 * A fresh directory is claimed with a non-recursive `mkdir`, so a collision is a
 * hard signal (`EEXIST`) rather than a silent overwrite of earlier evidence.
 */
const MAX_DIR_ATTEMPTS = 1000;

// ---------------------------------------------------------------------------
// HTML scrubbing
// ---------------------------------------------------------------------------

/**
 * Field names whose *value* is never written. Exact matches cover the common
 * spellings; the segment regex catches forms like `_csrf`, `csrf-token`,
 * `X-CSRF-Token` and `data-sxsrf`.
 */
const SENSITIVE_NAMES = new Set([
  "_csrf",
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "cookie",
  "cookies",
  "csrf",
  "csrf-token",
  "csrf_token",
  "gs_lcp",
  "id_token",
  "nonce",
  "password",
  "passwd",
  "refresh_token",
  "reqid",
  "sca_esv",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "set-cookie",
  "sxsrf",
  "token",
  "x-xsrf-token",
  "xsrf",
]);

const SENSITIVE_SEGMENT = /(?:^|[_.:-])(?:csrf|xsrf|sxsrf|reqid|sca_esv|token|secret|password|passwd)(?:$|[_.:-])/;

function isSensitiveName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_NAMES.has(normalized) || SENSITIVE_SEGMENT.test(normalized);
}

/** Elements whose `value` attribute holds what the user typed or selected. */
const FORM_VALUE_TAGS = new Set(["button", "input", "option", "param", "textarea"]);

/** Attributes a `name=`/`id=` match makes sensitive (the value mirrors the field). */
const NAME_LIKE_ATTRS = new Set(["http-equiv", "id", "itemprop", "name", "property"]);

/** URL-carrying attributes: correlation tokens in the query string leak like form values. */
const URL_ATTRS = new Set(["action", "formaction", "href", "src"]);

const URL_SECRET_PARAM =
  /([?&;]|&amp;)(sxsrf|reqid|sca_esv|gs_lcp|ei|ved|usg|sa|cd|token|csrf|_csrf|xsrf|auth|session|sessionid|api_key|apikey)=[^&#\s"']*/gi;

/**
 * Session-scoped correlation parameters Google/Yandex append to URLs, form
 * bodies and the JSON islands they embed. They tie every request of one visitor
 * together but never carry anything an adapter needs, so the value is replaced
 * wherever it survives the structural pass. `ei`/`sa`/`cd` are short on purpose —
 * the engines use them verbatim — and are only matched as whole parameter or
 * JSON keys, never as substrings of a word.
 */
const CORRELATION_PARAMS = [
  "sxsrf",
  "reqid",
  "sca_esv",
  "ei",
  "ved",
  "usg",
  "sa",
  "cd",
  "gs_lcp",
  "vet",
  "uact",
] as const;

const CORRELATION_LIST = CORRELATION_PARAMS.join("|");

/**
 * `sxsrf=…`, `&ved=…`, `?usg=…` — in URLs, in `jsdata`/`style`/`data-url`
 * attribute values and in inline JS. Deliberately global: the structural pass
 * only knows attribute *names*, and the same tokens ride in blobs it cannot
 * parse.
 */
const TOKEN_ASSIGNMENT = new RegExp(`(${CORRELATION_LIST})=([^&"'\\s<>\\\\]+)`, "g");

/**
 * `{"sxsrf":"…"}` / `sxsrf: "…"`: the JSON islands and `AF_initDataCallback`
 * payloads Google embeds in the page carry the same tokens as `key: "value"`.
 */
const TOKEN_JSON = new RegExp(`("?(?:${CORRELATION_LIST})"?\\s*:\\s*)"([^"]*)"`, "g");

/**
 * `<attr>="…"` where the attribute itself is named after a correlation
 * parameter (`data-ved`, `data-usg`). The value is a bare token with no `=`, so
 * the assignment patterns above cannot see it; the name is the only signal.
 */
const CORRELATION_NAME = new RegExp(`^(?:[a-z][a-z0-9]*[-_.:])*(?:${CORRELATION_LIST})$`);

/**
 * Inline scripts may assign the whole jar: `document.cookie = "…"`,
 * `document["cookie"] = '…'`, ``document[`cookie`] = `…` ``. The jar itself is
 * never in the HTML, but a capture pasted into a bug report would still carry
 * the value. Only the right-hand side is neutralised; the reference stays so the
 * script remains readable.
 */
const COOKIE_ASSIGNMENT =
  /(document\s*(?:\.\s*cookie|\[\s*(?:"cookie"|'cookie'|`cookie`)\s*\]))\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

/**
 * Tag + attribute scanner. Chrome serialises `outerHTML` with quoted attributes
 * and escaped `<`/`>` inside values, which is exactly the shape this expects.
 * Doctype, comments (`<!…>`) and closing tags (`</…>`) start with `!` or `/` and
 * are left byte-identical.
 */
const TAG_PATTERN = /<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR_PATTERN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

interface ParsedAttr {
  name: string;
  /** `undefined` for a boolean attribute (`checked`, `disabled`). */
  value: string | undefined;
}

function parseAttrs(source: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = [];
  ATTR_PATTERN.lastIndex = 0;
  for (let match = ATTR_PATTERN.exec(source); match !== null; match = ATTR_PATTERN.exec(source)) {
    const name = match[1] ?? "";
    if (name === "") continue;
    const value = match[2] ?? match[3] ?? match[4];
    attrs.push({ name: name.toLowerCase(), value });
  }
  return attrs;
}

/** Only quotes are re-escaped: the serialiser already turned `&` into `&amp;`. */
function escapeAttrValue(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function sanitizeAttrValue(attr: ParsedAttr, tag: string, sensitiveTag: boolean): string | undefined {
  if (attr.value === undefined) return undefined;
  if (isSensitiveName(attr.name)) return "";
  if (CORRELATION_NAME.test(attr.name)) return "[redacted]";
  if (sensitiveTag && (attr.name === "value" || attr.name === "content")) return "";
  if (attr.name === "value" && FORM_VALUE_TAGS.has(tag)) return "";
  if (URL_ATTRS.has(attr.name)) {
    return attr.value.replace(URL_SECRET_PARAM, (_match, separator: string, param: string) => `${separator}${param}=[redacted]`);
  }
  return attr.value;
}

function rewriteTag(tagName: string, attrText: string, selfClosing: boolean): string {
  const tag = tagName.toLowerCase();
  const attrs = parseAttrs(attrText);
  // A hidden `<input name="_csrf">` (or a `<meta name="csrf-token">`) marks the
  // whole element: its value/content mirrors the same secret.
  const sensitiveTag = attrs.some(
    (attr) => attr.value !== undefined && attr.value !== "" && NAME_LIKE_ATTRS.has(attr.name) && isSensitiveName(attr.value),
  );

  const rendered = attrs.map((attr) => {
    const value = sanitizeAttrValue(attr, tag, sensitiveTag);
    return value === undefined ? attr.name : `${attr.name}="${escapeAttrValue(value)}"`;
  });

  const open = `<${tagName}${rendered.map((attr) => ` ${attr}`).join("")}`;
  return `${open}${selfClosing ? " /" : ""}>`;
}

/**
 * Strip form values and session tokens from rendered HTML while keeping the
 * markup an adapter author debugs against: element names, attributes, classes
 * and text all survive; only values that could be personal or replayable go.
 *
 * Four passes, in this order:
 *  1. tag rewrite — form values, CSRF fields, URL query secrets, token-named attrs;
 *  2. textarea bodies (the value lives in the element body, not in an attribute);
 *  3. cookie assignments in inline scripts;
 *  4. a global token redaction over the whole document. Passes 1–3 only see
 *     attributes and a handful of tags, so `jsdata="…sxsrf=…"`, `style="url(…)"`,
 *     JSON islands and the same tokens buried in inline JS would otherwise
 *     survive verbatim. Redacting last is deliberate: it must not be undone by a
 *     later serialisation.
 */
export function sanitizeHtml(html: string): string {
  let output = html.replace(TAG_PATTERN, (match, tagName: string, attrText: string) =>
    rewriteTag(tagName, attrText, match.endsWith("/>")),
  );
  output = output.replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi, "$1$2");
  output = output.replace(COOKIE_ASSIGNMENT, '$1 = ""');
  output = output.replace(TOKEN_ASSIGNMENT, "$1=[redacted]");
  output = output.replace(TOKEN_JSON, '$1"[redacted]"');
  return output;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errnoOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * UTC, not local time: the stamp is part of the directory name and prune orders
 * by that name, so a DST jump must not be able to reorder evidence. Tests are
 * also timezone-independent this way.
 */
function stamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
  ].join("-");
}

/** `<ts>-<engine>-<hash8>`; the hash ties a directory to the failing input. */
function hashOf(input: ArtifactInput): string {
  return createHash("sha256")
    .update(`${input.query}\n${input.url}\n${input.code}`, "utf8")
    .digest("hex")
    .slice(0, 8);
}

/**
 * `prune()` only matches known engine slugs, so an unexpected engine id must not
 * reach the directory name (it would create an immortal directory).
 */
function engineSlug(engine: EngineId | undefined): EngineId | "unknown" {
  return engine !== undefined && (ENGINE_IDS as readonly string[]).includes(engine) ? engine : "unknown";
}

function readCanaries(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const canaries: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count)) canaries[name] = count;
  }
  return Object.keys(canaries).length === 0 ? undefined : canaries;
}

function hasAiSummary(input: ArtifactInput): boolean {
  const ai = input.serp?.ai;
  return ai !== undefined && ai.text.trim() !== "";
}

function compactTimings(timings: SerpTimings | undefined): SerpTimings | undefined {
  if (timings === undefined) return undefined;
  return Object.keys(timings).length === 0 ? undefined : { ...timings };
}

/** Fields that the doctor/repair agent reads; no HTML, no headers, no cookies. */
export interface ArtifactMeta {
  schemaVersion: number;
  ts: string;
  code: string;
  stage: string;
  /** Always the same slug as the directory (`unknown` when the id was not recognised). */
  engine: EngineId | "unknown";
  url: string;
  query: string;
  timings?: SerpTimings;
  /** Summary only: a full `RawSerp` would duplicate page.txt. */
  serp?: { engine: EngineId; results: number; ai: boolean };
  canaries?: Record<string, number>;
  extra?: Record<string, unknown>;
  screenshot: boolean;
  artifactsVersion: number;
}

function buildMeta(
  input: ArtifactInput,
  ts: number,
  engine: EngineId | "unknown",
  screenshot: boolean,
): ArtifactMeta {
  const timings = compactTimings(input.serp?.timings);

  // `extra.canaries` is the frozen `ArtifactInput`'s only slot for selector
  // counts; lift it to the documented top-level field instead of nesting it.
  let canaries: Record<string, number> | undefined;
  let extra: Record<string, unknown> | undefined;
  if (input.extra !== undefined) {
    const { canaries: rawCanaries, ...rest } = input.extra;
    canaries = readCanaries(rawCanaries);
    extra = Object.keys(rest).length === 0 ? undefined : rest;
  }

  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    ts: new Date(ts).toISOString(),
    code: input.code,
    stage: input.stage,
    engine,
    url: input.url,
    query: input.query,
    ...(timings === undefined ? {} : { timings }),
    ...(input.serp === undefined
      ? {}
      : {
          serp: {
            engine: input.serp.engine,
            results: input.serp.results.length,
            ai: hasAiSummary(input),
          },
        }),
    ...(canaries === undefined ? {} : { canaries }),
    ...(extra === undefined ? {} : { extra }),
    screenshot,
    artifactsVersion: ARTIFACTS_VERSION,
  };
}

/** `$PI_CODING_AGENT_DIR/web-search/artifacts`, else `~/.pi/agent/web-search/artifacts`. */
export function resolveArtifactsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "web-search", "artifacts");
}

export interface ArtifactsOptions {
  config: Config;
  clock: Clock;
  /** Overrides env-based resolution (tests, doctor --fix). */
  root?: string;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createArtifacts(options: ArtifactsOptions): Artifacts {
  const rootDir = options.root ?? resolveArtifactsRoot(options.env);
  const clock = options.clock;

  /**
   * Config is read per call (not captured) so `enabled`/retention changes take
   * effect without rebuilding the object; the paths and modes stay ours.
   */
  function limits(): Config["artifacts"] {
    return options.config.artifacts;
  }

  /**
   * FS failures are `E_CONFIG` naming the path: the agent must be able to tell
   * "your disk/root is the problem" from "the SERP layout changed". The original
   * message is not embedded — it can contain file contents on some platforms and
   * the errno plus path is what makes the failure actionable.
   */
  function artifactError(path: string, action: string, error: unknown): WebSearchError {
    return fail("E_CONFIG", "config", {
      hint: `check that the artifact root is writable: ${rootDir}`,
      message: `artifact ${action} failed at ${path} (${errnoOf(error) ?? "unknown error"})`,
    });
  }

  async function fsOp<T>(path: string, action: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isWebSearchError(error)) throw error;
      throw artifactError(path, action, error);
    }
  }

  async function writeArtifact(path: string, data: string | Uint8Array): Promise<void> {
    await fsOp(path, "write", () => writeFile(path, data, { mode: FILE_MODE }));
  }

  /** Root is created on the first save, never at construction (doctor may only ask for `size()`). */
  async function ensureRoot(): Promise<void> {
    await fsOp(rootDir, "mkdir", () => mkdir(rootDir, { recursive: true, mode: DIR_MODE }));
  }

  async function allocateDirectory(base: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_DIR_ATTEMPTS; attempt += 1) {
      const name = attempt === 1 ? base : `${base}-${attempt}`;
      const path = join(rootDir, name);
      try {
        // Non-recursive mkdir is the uniqueness claim: EEXIST means another save
        // (same second, same input) already owns the name.
        await mkdir(path, { mode: DIR_MODE });
        return path;
      } catch (error) {
        if (errnoOf(error) === "EEXIST") continue;
        throw artifactError(path, "mkdir", error);
      }
    }
    throw fail("E_CONFIG", "config", {
      hint: `prune the artifact root and retry: ${rootDir}`,
      message: `cannot allocate a unique artifact directory for ${base} after ${MAX_DIR_ATTEMPTS} attempts`,
    });
  }

  /**
   * Browser reads are advisory: save() is usually called from an error path, and
   * a page that just lost its target can fail every read. Losing page.txt is
   * better than losing meta.json — and never mask the error we are documenting.
   */
  async function readPage<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch {
      return undefined;
    }
  }

  async function directoryBytes(dir: string): Promise<number> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = errnoOf(error);
      if (code === "ENOENT" || code === "ENOTDIR") return 0;
      throw artifactError(dir, "walk", error);
    }

    let total = 0;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await directoryBytes(path);
        continue;
      }
      // Symlinks are neither files nor directories here: never follow them out
      // of the root (a linked directory could make prune "own" foreign bytes).
      if (!entry.isFile()) continue;
      try {
        total += (await lstat(path)).size;
      } catch (error) {
        if (errnoOf(error) === "ENOENT") continue; // deleted by a concurrent prune
        throw artifactError(path, "stat", error);
      }
    }
    return total;
  }

  interface ArtifactDir {
    name: string;
    path: string;
    bytes: number;
  }

  async function listArtifactDirs(): Promise<ArtifactDir[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(rootDir, { withFileTypes: true });
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return [];
      throw artifactError(rootDir, "readdir", error);
    }

    const dirs: ArtifactDir[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_DIR_NAME.test(entry.name)) continue;
      const path = join(rootDir, entry.name);
      dirs.push({ name: entry.name, path, bytes: await directoryBytes(path) });
    }
    return dirs;
  }

  async function removeDir(dir: ArtifactDir): Promise<boolean> {
    try {
      await rm(dir.path, { recursive: true, force: true });
      return true;
    } catch (error) {
      // A concurrent prune/save may have removed it already; that is success for
      // our purposes (the bytes are gone), not a failure to report.
      if (errnoOf(error) === "ENOENT") return false;
      throw artifactError(dir.path, "remove", error);
    }
  }

  /**
   * Persist one failure snapshot.
   *
   * Returns the directory it wrote — or the `""` sentinel when
   * `config.artifacts.enabled === false`, in which case nothing is created and
   * the root is not even touched. Callers must treat `""` as "no artifact"
   * rather than a path. (`runtime/types.ts` is frozen and only says "returns the
   * directory"; the sentinel is the contract this module actually implements.)
   */
  async function save(input: ArtifactInput): Promise<string> {
    if (!limits().enabled) return "";

    const ts = clock.now();
    // `serp.engine` is the fallback so a save triggered by a parsed SERP names
    // the engine even when the tool did not pass it explicitly. The slug (not the
    // raw id) is used for both the directory and meta.engine, so an id that
    // `prune()`/`ARTIFACT_DIR_NAME` would not recognise cannot produce a
    // misleading meta or an immortal directory.
    const engine = engineSlug(input.engine ?? input.serp?.engine);
    await ensureRoot();
    const dir = await allocateDirectory(`${stamp(ts)}-${engine}-${hashOf(input)}`);

    let screenshot = false;
    if (input.page !== undefined) {
      const page = input.page;

      // Keep the post-render DOM (adapters fail on rendered markup, not on the
      // raw response) but scrub every value a real user session would contain.
      const html = await readPage(() => page.html());
      if (html !== undefined) await writeArtifact(join(dir, "page.html"), sanitizeHtml(html));

      const text = await readPage(() => page.innerText());
      if (text !== undefined) await writeArtifact(join(dir, "page.txt"), text);

      // The CDP page already returns JPEG bytes; a failed capture is recorded as
      // `screenshot: false` instead of aborting the snapshot.
      const jpeg = await readPage(() => page.screenshot());
      if (jpeg !== undefined) {
        await writeArtifact(join(dir, "screenshot.jpg"), jpeg);
        screenshot = true;
      }
    }

    const meta = buildMeta(input, ts, engine, screenshot);
    let json: string;
    try {
      json = `${JSON.stringify(meta, null, 2)}\n`;
    } catch {
      // A half-written artifact is worse than none: the directory looks valid to
      // `prune()` and to a reader hunting for proof, but has no meta.json. Remove
      // it before surfacing the config error, and never mask that error with a
      // secondary remove failure.
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Best effort only; the E_CONFIG below is the error the caller needs.
      }
      throw fail("E_CONFIG", "config", {
        hint: `artifact meta could not be serialised; check ArtifactInput.extra: ${dir}`,
        message: `artifact meta at ${dir} contains a non-serialisable value (cycle or BigInt)`,
      });
    }
    await writeArtifact(join(dir, "meta.json"), json);
    return dir;
  }

  /**
   * Retention order: newest first. The timestamp is the leading part of the name
   * and UTC-based, so stamp order is creation order (and immune to mtime rewrites
   * by a copy). Inside one second the `allocateDirectory` collision suffix breaks
   * ties, and it must be compared numerically: lexically `-10` sorts before `-2`,
   * which would prune the newest member of a same-second group and keep its
   * elders. The unsuffixed base name is attempt 1.
   */
  function orderOf(name: string): { stamp: string; seq: number } {
    const match = ARTIFACT_DIR_PARTS.exec(name);
    const stamp = match?.groups?.stamp;
    const suffix = match?.groups?.seq;
    if (stamp === undefined) return { stamp: name, seq: 0 };
    return { stamp, seq: suffix === undefined ? 1 : Number(suffix) };
  }

  async function prune(): Promise<PruneResult> {
    const { keep, maxBytes } = limits();

    const dirs = (await listArtifactDirs()).sort((a, b) => {
      const left = orderOf(a.name);
      const right = orderOf(b.name);
      if (left.stamp !== right.stamp) return left.stamp < right.stamp ? 1 : -1;
      return right.seq - left.seq;
    });

    let removed = 0;
    let kept = dirs.slice(0, keep);
    for (const dir of dirs.slice(keep)) {
      if (await removeDir(dir)) removed += 1;
    }

    let bytes = kept.reduce((sum, dir) => sum + dir.bytes, 0);
    while (bytes > maxBytes && kept.length > 0) {
      const oldest = kept[kept.length - 1];
      if (oldest === undefined) break;
      kept = kept.slice(0, -1);
      bytes -= oldest.bytes;
      if (await removeDir(oldest)) removed += 1;
    }

    // Re-measure: a concurrent save may have added bytes since the scan, and the
    // doctor reports this number to the user.
    return { removed, kept: kept.length, bytes: await directoryBytes(rootDir) };
  }

  return {
    save,
    prune,
    size: () => directoryBytes(rootDir),
    root: () => rootDir,
  };
}
