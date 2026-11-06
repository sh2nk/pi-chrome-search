/**
 * Fixture loader + sanitizer + DOM harness.
 *
 * A fixture is a sanitized, gzipped capture of the page *after* settle:
 * `tests/fixtures/<name>.html.gz`. `loadFixture()` decompresses it and refuses
 * to return dirty HTML — the same rules that sanitize a capture are re-run at
 * load time, so a fixture that slipped through review fails loudly instead of
 * leaking an account email, a session token or the personal query.
 *
 * `fixtureDocument()`/`runInPage()` run the shipped extractors exactly the way
 * the browser does: the adapter function is stringified into a `node:vm`
 * context with the fixture document, so a selector or a free variable that
 * would fail in Chrome fails here too. `linkedom` is a devDependency for tests
 * only; `innerText` is not implemented there, which is why extractors use
 * `textContent` plus explicit whitespace normalisation.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";

import { parseHTML } from "linkedom";

/**
 * Fixture sanitizer (SPEC §7.1 / PLAN P3 fixture rule).
 *
 * Fixtures are captured from a real, logged-in browser. Before a single byte is
 * committed they lose: cookies and auth headers, token/session values (sxsrf,
 * reqid, sca_esv, …), account emails, IPv4 addresses and the literal query.
 * `127.0.0.1` and `0.0.0.0` stay as harmless placeholders; every replacement is
 * tagged `[redacted…]` so `findUnsafe()` can tell an already-sanitized fixture
 * from a dirty one.
 *
 * Personal queries cannot be detected heuristically — callers pass the explicit
 * list used for the capture (`loadFixture({ personalQueries })`, or the audit
 * script). Never put that list in a committed file.
 */


export const REDACTED_SECRET = "[redacted]";
export const REDACTED_EMAIL = "[redacted-email]";
export const REDACTED_IP = "[redacted-ip]";
export const REDACTED_QUERY = "[redacted-query]";

/** Marker shared by every replacement; used to avoid reporting sanitized text again. */
const REDACTED_MARKER = "[redacted";

export interface SanitizeRule {
  name: string;
  pattern: RegExp;
  replace: string | ((match: string, ...groups: unknown[]) => string);
  /** Return false to leave a match alone (e.g. loopback IP placeholders). */
  allow?: (match: string) => boolean;
}

export interface SanitizeOptions {
  /**
   * Literal personal queries used for the capture. Raw, percent-encoded,
   * form-encoded (`+`) and HTML-escaped variants are all redacted.
   */
  personalQueries?: readonly string[];
  /** Extra rules applied after the built-ins. */
  extraRules?: readonly SanitizeRule[];
}

export interface SanitizeFinding {
  rule: string;
  /** Matched text; callers must not print this into shared logs. */
  match: string;
  index: number;
}

/**
 * Query parameters whose values are session/user scoped. Keep this list in sync
 * with `research/FINDINGS.md` when a new engine token shows up in a capture.
 */
const SECRET_PARAMS = [
  "sxsrf",
  "reqid",
  "sca_esv",
  "ei",
  "gs_lcp",
  "vet",
  "ved",
  "usg",
  "sa",
  "sourceid",
  "cd",
  "cad",
  "uact",
  "fbs",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "sid",
  "csrf",
  "csrf_token",
  "xsrf",
  "api_key",
  "apikey",
  "api-key",
].join("|");

/**
 * Cookie/auth field names used by the JSON and HTML-attribute rules. These are
 * *field* names (a JSON key or an `name=`/`id=` attribute), not URL params; the
 * Google/Yandex correlation tokens are included because captures also carry them
 * as hidden inputs (`<input name="ei" value=…>`) and inline JSON.
 */
const JSON_SECRET_FIELDS = [
  "cookie",
  "cookies",
  "set-cookie",
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "sessionid",
  "sessionId",
  // Profile identity a signed-in SERP embeds in its bootstrap JSON. The Yandex
  // captures shipped a display name, an avatar id and a stable user id because
  // these keys were not in the list.
  "displayUserName",
  "userName",
  "userLogin",
  "avatarId",
  "yandexUid",
  "userUid",
  "csrf",
  "csrfToken",
  "csrf_token",
  "session_id",
  "xsrf",
  "sxsrf",
  "reqid",
  "sca_esv",
  "api_key",
  "apiKey",
  // Correlation tokens a SERP embeds in hidden inputs / inline config.
  "ei",
  "ved",
  "gs_lcp",
  "vet",
  "usg",
  "sa",
  "cd",
];

const JSON_SECRET_FIELD_PATTERN = JSON_SECRET_FIELDS.join("|");

const IPV4 =
  /(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)/g;

export function isIpPlaceholder(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "0.0.0.0";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function personalQueryRules(queries: readonly string[]): SanitizeRule[] {
  const rules: SanitizeRule[] = [];
  const seen = new Set<string>();
  for (const raw of queries) {
    const query = raw.trim();
    if (query.length < 2) continue;
    const encoded = encodeURIComponent(query);
    const variants = [query, encoded, encoded.replace(/%20/g, "+"), escapeHtml(query)];
    for (const variant of variants) {
      if (variant.length < 2 || seen.has(variant)) continue;
      seen.add(variant);
      rules.push({
        // Deliberately no query text in the rule name: findings may be logged.
        name: "personal-query",
        pattern: new RegExp(escapeRegExp(variant), "gi"),
        replace: REDACTED_QUERY,
      });
    }
  }
  return rules;
}

/** Rules that do not depend on caller input. Exported for the audit script's reference. */
export function builtinRules(): SanitizeRule[] {
  return [
    {
      name: "cookie-header",
      // A real header carries at least one `name=value` pair. Without that
      // requirement, prose such as "How to set a cookie: a guide" was redacted
      // and reported by findUnsafe(), which made clean fixtures unfixable.
      pattern: /\b((?:set-)?cookie\s*:\s*)(?=[\w!#$%&'*+.^`|~-]+\s*=)[^\r\n<]+/gi,
      replace: (_match, ...groups) => `${String(groups[0] ?? "")}${REDACTED_SECRET}`,
    },
    {
      name: "auth-header",
      pattern: /\bauthorization\s*:\s*[^\r\n<]+/gi,
      replace: `Authorization: ${REDACTED_SECRET}`,
    },
    {
      name: "bearer-token",
      pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
      replace: `Bearer ${REDACTED_SECRET}`,
    },
    {
      name: "document-cookie",
      pattern: /\bdocument\.cookie\s*=\s*(['"])[\s\S]*?\1/g,
      replace: `document.cookie = "${REDACTED_SECRET}"`,
    },
    {
      name: "json-secret",
      pattern: new RegExp(
        `("(?:${JSON_SECRET_FIELD_PATTERN})"\\s*:\\s*")(?:\\\\.|[^"\\\\])*(")`,
        "gi",
      ),
      replace: (_match, ...groups) =>
        `${String(groups[0] ?? "")}${REDACTED_SECRET}${String(groups[1] ?? "")}`,
    },
    {
      name: "json-secret-single",
      // JS object literals inside inline scripts use single quotes; Chrome's
      // bootstrap config is quoted with one or the other depending on the build.
      pattern: new RegExp(
        `('(?:${JSON_SECRET_FIELD_PATTERN})'\\s*:\\s*')(?:\\\\.|[^'\\\\])*(')`,
        "gi",
      ),
      replace: (_match, ...groups) =>
        `${String(groups[0] ?? "")}${REDACTED_SECRET}${String(groups[1] ?? "")}`,
    },
    {
      name: "secret-input",
      pattern: new RegExp(
        `(<[^>]*\\b(?:name|id)=["'](?:${JSON_SECRET_FIELD_PATTERN})["'][^>]*\\bvalue=)(["'])[^"']*(["'])`,
        "gi",
      ),
      replace: (_match, ...groups) =>
        `${String(groups[0] ?? "")}${String(groups[1] ?? '"')}${REDACTED_SECRET}${String(groups[2] ?? '"')}`,
    },
    {
      name: "secret-input-reversed",
      // Attribute order is not guaranteed; a hidden input can put value first.
      pattern: new RegExp(
        `(<[^>]*\\bvalue=)(["'])[^"']*(["'][^>]*\\b(?:name|id)=["'](?:${JSON_SECRET_FIELD_PATTERN})["'])`,
        "gi",
      ),
      replace: (_match, ...groups) =>
        `${String(groups[0] ?? "")}${String(groups[1] ?? '"')}${REDACTED_SECRET}${String(groups[2] ?? '"')}`,
    },
    {
      name: "secret-input-unquoted",
      // HTML permits unquoted attribute values; Google's generated SERPs use
      // them and a capture like `<input name=ei value=SECRET>` leaked before
      // this rule existed. Only an *unquoted* value is matched here, so the
      // quoted rules above keep their exact replacement shape.
      pattern: new RegExp(
        `(<[^>]*\\b(?:name|id)=["']?(?:${JSON_SECRET_FIELD_PATTERN})["']?[^>]*?\\bvalue=)(?!["'])([^\\s>]+)`,
        "gi",
      ),
      replace: (_match, ...groups) => `${String(groups[0] ?? "")}${REDACTED_SECRET}`,
    },
    {
      name: "secret-input-unquoted-name",
      // Name unquoted, value quoted: `<input name=ei value="SECRET">`.
      pattern: new RegExp(
        `(<[^>]*\\b(?:name|id)=["']?(?:${JSON_SECRET_FIELD_PATTERN})["']?[^>]*?\\bvalue=)(["'])[^"']*\\2`,
        "gi",
      ),
      replace: (_match, ...groups) =>
        `${String(groups[0] ?? "")}${String(groups[1] ?? '"')}${REDACTED_SECRET}${String(groups[1] ?? '"')}`,
    },
    {
      name: "json-secret-escaped",
      // Inline JSON is often embedded in a JS string, so its quotes are
      // backslash-escaped (`{\"ved\":\"…\"}`). The unescaped json-secret rules
      // would miss it and a real SERP capture would ship the token.
      pattern: new RegExp(
        `(\\\\"(?:${JSON_SECRET_FIELD_PATTERN})\\\\"\\s*:\\s*\\\\")(?:\\\\.|[^"\\\\])*(\\\\")`,
        "gi",
      ),
      replace: (_match, ...groups) =>
        `${String(groups[0] ?? "")}${REDACTED_SECRET}${String(groups[1] ?? '\\"')}`,
    },
    {
      name: "secret-param",
      // A prefixed name (`parent-reqid`, `utm_reqid`) is still the same token;
      // the live Yandex capture kept `parent-reqid=` because the separator was
      // a hyphen rather than `?`/`&`/`;`.
      pattern: new RegExp(`([?&;][A-Za-z0-9_-]*(?:${SECRET_PARAMS})=)[^&#\\s"'<>]*`, "gi"),
      replace: (_match, ...groups) => `${String(groups[0] ?? "")}${REDACTED_SECRET}`,
    },
    {
      name: "secret-attribute",
      pattern: new RegExp(
        `\\b((?:${SECRET_PARAMS})=["'])[^"']*(["'])`,
        "gi",
      ),
      replace: (_match, ...groups) => `${String(groups[0] ?? "")}${REDACTED_SECRET}${String(groups[1] ?? "")}`,
    },
    {
      name: "secret-param-encoded",
      // A SERP nests a second URL inside an attribute or a JS string, so the
      // token arrives percent-encoded (`…%26sxsrf%3DAKL5…`). The plain rules
      // above miss it and the live Google capture shipped 37 such values.
      pattern: new RegExp(`((?:${SECRET_PARAMS})%3D)[^%&#'"\\s<>]*`, "gi"),
      replace: (_match, ...groups) => `${String(groups[0] ?? "")}${REDACTED_SECRET}`,
    },
    {
      name: "yandex-avatar-url",
      // The signed-in Yandex header embeds the account avatar as
      // `avatars.mds.yandex.net/get-yapic/<uid>/<hash>/…`; the uid is stable and
      // identifies the profile, so the whole asset path is replaced.
      pattern: /(?:https?:)?\/\/avatars\.mds\.yandex\.net\/get-yapic\/[^\s"'<>]*/gi,
      replace: "[redacted-avatar]",
    },
    {
      name: "long-token",
      // Opaque capability payloads (protobuf `url=` in /goto, signed `fbs=`,
      // inline data URIs) carry no value for an adapter test and cannot be
      // judged safe, so anything this long becomes a marker. The audit's R7
      // treats a 200+ char base64-like run as a leak; this keeps the two
      // contracts aligned by construction.
      pattern: /[A-Za-z0-9+/=_-]{200,}/g,
      replace: REDACTED_SECRET,
    },
    {
      name: "secret-assignment",
      pattern:
        /\b(sxsrf|reqid|sca_esv|csrfToken|access_token|refresh_token|id_token|apiKey|api_key)\s*[:=]\s*(['"])[^'"]*\2/g,
      replace: (_match, ...groups) =>
        `${String(groups[0] ?? "")} = ${String(groups[1] ?? '"')}${REDACTED_SECRET}${String(groups[1] ?? '"')}`,
    },
    {
      name: "email",
      pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      replace: REDACTED_EMAIL,
    },
    {
      name: "email-encoded",
      pattern: /[A-Za-z0-9._%+-]+%40[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi,
      replace: REDACTED_EMAIL,
    },
    {
      name: "ipv4",
      pattern: IPV4,
      replace: REDACTED_IP,
      allow: isIpPlaceholder,
    },
    {
      name: "ipv4-glued",
      // Redaction can leave an IP-shaped tail next to the marker
      // (`[redacted-ip].701.431.3`); the audit's own regex would still report
      // it, so collapse the whole run into the marker once.
      pattern: /\[redacted-ip\](?:\.\d{1,3})+/g,
      replace: REDACTED_IP,
    },
  ];
}

function rulesFor(options: SanitizeOptions): SanitizeRule[] {
  return [
    ...personalQueryRules(options.personalQueries ?? []),
    ...builtinRules(),
    ...(options.extraRules ?? []),
  ];
}

function applyRule(text: string, rule: SanitizeRule): string {
  return text.replace(rule.pattern, (match, ...groups: unknown[]) => {
    if (rule.allow !== undefined && rule.allow(match)) return match;
    if (typeof rule.replace === "function") return rule.replace(match, ...groups);
    return rule.replace;
  });
}

/** Apply every rule once, in a stable order. Idempotent for already-clean text. */
export function sanitizeFixture(text: string, options: SanitizeOptions = {}): string {
  let output = text;
  for (const rule of rulesFor(options)) output = applyRule(output, rule);
  return output;
}

/**
 * Report what still looks unsafe. Matches are returned for debugging, but the
 * assertion helper never prints them (a finding may itself be personal data).
 */
export function findUnsafe(text: string, options: SanitizeOptions = {}): SanitizeFinding[] {
  const findings: SanitizeFinding[] = [];
  for (const rule of rulesFor(options)) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (value.includes(REDACTED_MARKER)) continue;
      if (rule.allow !== undefined && rule.allow(value)) continue;
      findings.push({ rule: rule.name, match: value, index: match.index ?? 0 });
    }
  }
  return findings;
}

export function isFixtureClean(text: string, options: SanitizeOptions = {}): boolean {
  return findUnsafe(text, options).length === 0;
}

/** Throws an AssertionError listing rule names and offsets only — never the values. */
export function assertFixtureClean(text: string, options: SanitizeOptions = {}): void {
  const findings = findUnsafe(text, options);
  if (findings.length === 0) return;
  const summary = findings
    .slice(0, 5)
    .map((finding) => `${finding.rule}@${finding.index}`)
    .join(", ");
  assert.fail(`fixture is not sanitized: ${findings.length} finding(s) [${summary}]`);
}

export function gunzip(data: Uint8Array): string {
  return gunzipSync(data).toString("utf8");
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, "..", "fixtures");
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

export interface LoadFixtureOptions {
  /** Override the fixture root (tests build fixtures in a temp dir). */
  dir?: string;
  /** Literal personal queries used for the capture; checked in the HTML. */
  personalQueries?: readonly string[];
}

export interface LoadedFixture {
  name: string;
  html: string;
  compressedBytes: number;
  htmlBytes: number;
  chars: number;
  path: string;
}

export class FixtureError extends Error {
  readonly fixtureName: string;

  constructor(fixtureName: string, message: string, options?: { cause?: unknown }) {
    super(`fixture "${fixtureName}": ${message}`, options);
    this.name = "FixtureError";
    this.fixtureName = fixtureName;
  }
}

export function loadFixture(name: string, options: LoadFixtureOptions = {}): LoadedFixture {
  if (!NAME_SHAPE.test(name)) {
    throw new FixtureError(name, "fixture name must match ^[a-z0-9][a-z0-9-]*$");
  }
  const dir = options.dir ?? FIXTURES_DIR;
  const path = join(dir, `${name}.html.gz`);
  let compressed: Buffer;
  try {
    compressed = readFileSync(path);
  } catch (cause) {
    throw new FixtureError(name, `cannot read ${path}`, { cause });
  }
  let html: string;
  try {
    html = gunzipSync(compressed).toString("utf8");
  } catch (cause) {
    throw new FixtureError(name, `${path} is not valid gzip`, { cause });
  }
  const findings = findUnsafe(html, { personalQueries: options.personalQueries ?? [] });
  if (findings.length > 0) {
    const summary = findings.slice(0, 5).map((f) => `${f.rule}@${f.index}`).join(", ");
    throw new FixtureError(name, `html is not sanitized: ${summary}`);
  }
  return {
    name,
    html,
    compressedBytes: compressed.byteLength,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    chars: html.length,
    path,
  };
}

// ---------------------------------------------------------------------------
// DOM harness
// ---------------------------------------------------------------------------

/**
 * Fixture DOM harness for engine adapter tests (P3).
 *
 * Adapters extract from the *live* DOM, so they must run the same code in the
 * browser and in a test. The convention this harness enforces:
 *
 *   - an adapter exposes `extractFromDocument(doc, query)` as a self-contained
 *     function (no imports, no closures) returning plain JSON;
 *   - live code sends it with `page.evaluate(\`(${extractFromDocument})(document, …)\`)`,
 *     which only works because the function serialises with `toString()`;
 *   - tests here parse a captured fixture with linkedom and call the *same*
 *     source through `runInPage`, which stringifies it inside a `node:vm`
 *     context — so a fixture test fails when a selector or a free variable is
 *     wrong, exactly like the browser would.
 *
 * `linkedom` is a devDependency for tests only; nothing in `src/` imports it.
 * `innerText` is not implemented there, which is why extractors use
 * `textContent` plus explicit whitespace normalisation.
 */



/**
 * Parse sanitized fixture HTML into a document the extractors can query.
 * `window` is provided for extractors that read `location` or `document`.
 */
export function fixtureDocument(html: string, url = "https://example.test/search"): Document {
  const { document, window } = parseHTML(html);
  // Keep the document addressable the way a live page is: extractors may need
  // `baseURI`/`location` to resolve relative links.
  Object.defineProperty(document, "baseURI", { value: url, configurable: true });
  Object.defineProperty(document, "URL", { value: url, configurable: true });
  if (window !== undefined && window !== null) {
    Object.defineProperty(window, "location", {
      value: new URL(url),
      configurable: true,
    });
  }
  return document as unknown as Document;
}

/**
 * Run an extractor the way the browser does: `fn` is stringified, so it may not
 * capture anything from its module. Throws if the function is not serialisable
 * (arrow functions with comments are fine; closures fail at call time).
 */
export function runInPage<T>(fn: (doc: Document, arg: unknown) => T, document: Document, arg: unknown): T {
  const source = `(${fn.toString()})`;
  const context = vm.createContext({
    document,
    window: (document as unknown as { defaultView?: unknown }).defaultView,
    location: (document as unknown as { location?: unknown }).location,
    Node: (document.defaultView as unknown as { Node?: unknown } | null)?.Node,
    Element: (document.defaultView as unknown as { Element?: unknown } | null)?.Element,
    HTMLElement: (document.defaultView as unknown as { HTMLElement?: unknown } | null)?.HTMLElement,
    URL,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    decodeURIComponent,
    encodeURIComponent,
  });
  const script = new vm.Script(
    `(${source})`,
    { filename: "extract-in-page.js" },
  );
  const callable = script.runInContext(context) as (doc: Document, value: unknown) => T;
  return callable(document, arg);
}
