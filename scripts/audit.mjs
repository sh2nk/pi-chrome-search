#!/usr/bin/env node
/**
 * pi-chrome-search — hard-rule audit. Read-only, zero dependencies.
 * Usage: `node scripts/audit.mjs [--json]` (`npm run audit`). Exit 0 clean, 1 violation, 2 usage.
 *
 *   R1  attach only — no Playwright/Puppeteer/WebDriver launch, no headless/automation flags
 *   R2  no fingerprint spoofing (UA, Emulation, init scripts, navigator.* assignment)
 *   R3  never kill or restart the user's Chrome
 *   R4  no captcha solving
 *   R5  no paid search APIs or search keys
 *   R6  no secrets in tracked files (values are never printed)
 *   R7  no personal data in tests/fixtures/**
 *   R8  repo hygiene: no development apparatus (research/, evidence/, bench/, archived PLAN-vN),
 *       no tracked build output or screenshots. The normative SPEC.md/PLAN.md are allowed by name.
 *   R9  packaging sanity (`files` allowlist, metadata, no install hooks)
 *   R10 tool-description budget (approximate; the authoritative check is a unit test)
 *   R13 host facts live only in src/runtime/host.ts (PO1–PO4)
 *   R14 documentation budgets (README ≤90, AGENTS ≤150, SPEC ≤320, PLAN ≤260, docs/*.md ≤120,
 *       docs total ≤400)
 *   R15 docs↔code drift (DEFAULT_CONFIG keys, error codes, registered tools)
 *
 * Code is read with comments blanked and literals kept, so a comment documenting "never launch
 * Playwright" is not a violation while `import "playwright"` still is.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 4 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TOOL_BUDGET_CHARS = 1200;
const DOC_BUDGET = { README: 90, AGENTS: 150, SPEC: 320, PLAN: 260, doc: 120, docsTotal: 400 };

const json = process.argv.includes("--json");
if (process.argv.slice(2).some((arg) => arg !== "--json")) {
  process.stderr.write("usage: node scripts/audit.mjs [--json]\n");
  process.exit(2);
}

// --------------------------------------------------------------------------- files

function walk(dir, rel = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(join(dir, entry.name), relPath));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

function listFiles() {
  try {
    const git = (args) => execFileSync("git", ["-C", ROOT, ...args], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    git(["rev-parse", "--show-toplevel"]);
    return git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .split("\0")
      .filter((rel) => rel !== "" && rel !== "node_modules")
      .filter((rel) => {
        try {
          return lstatSync(join(ROOT, rel)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return walk(ROOT);
  }
}

const FILES = listFiles();
const cache = new Map();

function readText(rel) {
  if (cache.has(rel)) return cache.get(rel);
  let value = null;
  try {
    const st = lstatSync(join(ROOT, rel));
    if (st.isFile() && st.size <= MAX_BYTES) {
      const buf = readFileSync(join(ROOT, rel));
      if (!buf.includes(0)) value = buf.toString("utf8");
    }
  } catch {
    value = null;
  }
  cache.set(rel, value);
  return value;
}

/** Blank `//` and block comments, keep strings and templates verbatim. */
function stripComments(text) {
  const out = text.split("");
  let state = "code";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] ?? "";
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line"; out[i] = " "; out[i + 1] = " "; i += 1;
      } else if (ch === "/" && next === "*") {
        state = "block"; out[i] = " "; out[i + 1] = " "; i += 1;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        state = "string"; quote = ch;
      }
    } else if (state === "line") {
      if (ch === "\n") state = "code"; else out[i] = " ";
    } else if (state === "block") {
      if (ch === "*" && next === "/") {
        out[i] = " "; out[i + 1] = " "; i += 1; state = "code";
      } else if (ch !== "\n") out[i] = " ";
    } else if (ch === "\\") {
      i += 1;
    } else if (ch === "\n" && quote !== "`") {
      state = "code"; // an unterminated quote is a file-wide hazard; recover at the newline
    } else if (ch === quote) {
      state = "code";
    }
  }
  return out.join("");
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < Math.min(index, text.length); i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function scan(files, patterns, { comments = true } = {}) {
  const findings = [];
  for (const rel of files) {
    const raw = readText(rel);
    if (raw === null) continue;
    const text = comments ? stripComments(raw) : raw;
    for (const [rule, re] of patterns) {
      const pattern = re.global ? re : new RegExp(re.source, `${re.flags}g`);
      for (const match of text.matchAll(pattern)) {
        findings.push({ file: rel, line: lineOf(text, match.index ?? 0), rule, detail: match[0].slice(0, 60) });
      }
    }
  }
  return findings;
}

const codeFiles = (prefixes) => FILES.filter((rel) => CODE_EXT.test(rel) && prefixes.some((p) => rel.startsWith(p)));
const srcFiles = codeFiles(["src/"]);
const codeAll = codeFiles(["src/", "tests/", "index.ts"]);

const checks = [];
const add = (id, title, findings, scope) => checks.push({ id, title, scope, findings });

// --------------------------------------------------------------------------- hard rules

add("R1", "attach only: no browser launch, automation profile or headless mode", scan(codeAll, [
  ["playwright", /\bplaywright|puppeteer|webdriverio|selenium\b/],
  ["launch", /\.launch(?:PersistentContext)?\s*\(/],
  ["automation-flag", /--?(?:enable-automation|headless)\b/],
]), "src/, tests/, index.ts");

add("R2", "no fingerprint spoofing", scan(srcFiles, [
  ["ua-override", /setUserAgentOverride|Emulation\.set|navigator\.(?:webdriver|userAgent|language|platform)\s*=/],
  ["init-script", /addScriptToEvaluateOnNewDocument/],
  ["webdriver", /Object\.defineProperty\(\s*navigator/],
]), "src/");

add("R3", "never kill or restart the user's Chrome", scan(srcFiles, [
  ["kill-browser", /(?:kill|terminate|shutdown|restart)[A-Za-z]*\s*\(\s*(?:["'`]|[a-zA-Z]*[Cc]hrome)/],
  ["pkill", /\bpkill\b|\bkillall\b/],
]), "src/");

add("R4", "never solve a captcha", scan(srcFiles, [
  ["solver", /anti[-_]?captcha|2captcha|rucaptcha|capsolver|solveCaptcha|captchaSolver/i],
  ["click-robot", /(?:click|press)(?:Element|Page)?[^\n]{0,60}(?:я не робот|i'?m not a robot|recaptcha)/i],
]), "src/");

add("R5", "no paid search APIs or search keys", scan(srcFiles, [
  ["paid-api", /\b(?:serpapi|serper|brave-?search|tavily|exa\.ai|kagi)\b/i],
  ["search-key", /\b(?:SERPAPI|SERPER|TAVILY|BRAVE_SEARCH|EXA)_(?:API_)?KEY\b/],
]), "src/");

add("R6", "no secrets in tracked files", scan(FILES, [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["openai-style", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["openrouter", /\bsk-or-v1-[A-Za-z0-9]{20,}/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["secret-assignment", /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-/+]{24,}["']/i],
], { comments: false }).map((f) => ({ ...f, detail: f.rule })), "every tracked text file");

const FIXTURE_RULES = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["ipv4", /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/],
  ["cookie", /\b(?:set-)?cookie\s*:\s*\S+=/i],
  ["long-token", /\b[A-Za-z0-9+/=_-]{200,}\b/],
  ["session-param", /[?&;](?:sxsrf|reqid|sca_esv|ved|ei)=[^\s"&;<]*/],
];
const fixtureFindings = [];
for (const rel of FILES.filter((f) => f.startsWith("tests/fixtures/") && !f.endsWith(".md"))) {
  let text = "";
  try {
    const abs = join(ROOT, rel);
    text = rel.endsWith(".gz")
      ? execFileSync("gzip", ["-dc", abs], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      : readFileSync(abs).toString("latin1");
  } catch {
    continue;
  }
  for (const [rule, re] of FIXTURE_RULES) {
    for (const match of text.matchAll(re.global ? re : new RegExp(re.source, `${re.flags}g`))) {
      const value = match[0];
      if (rule === "ipv4" && (value === "127.0.0.1" || value === "0.0.0.0")) continue;
      if (rule === "session-param" && /=\s*$/.test(value)) continue;
      if (value.includes("[redacted")) continue;
      fixtureFindings.push({ file: rel, line: 0, rule, detail: rule });
    }
  }
}
add("R7", "no personal data in fixtures", fixtureFindings, "tests/fixtures/**");

/** The two normative docs of the rewrite, allowed by exact name (an archived PLAN-vN is apparatus). */
const NORMATIVE_DOCS = new Set(["SPEC.md", "PLAN.md"]);

const hygiene = [];
for (const rel of FILES) {
  const rule = /^(?:research|evidence|bench)\//.test(rel) || (!NORMATIVE_DOCS.has(rel) && /^(?:SPEC|PLAN[^/]*)\.md$/.test(rel)) ? "apparatus"
    : rel.startsWith("node_modules/") ? "tracked-node_modules"
    : /(?:^|\/)\.env(?:\.|$)/.test(rel) ? "env-file"
    : /\.(?:png|jpe?g|webp)$/i.test(rel) ? "screenshot"
    : null;
  if (rule !== null) hygiene.push({ file: rel, line: 0, rule, detail: rel });
}
add("R8", "repo hygiene and no development apparatus", hygiene, "tracked paths");

const packaging = [];
let manifest = null;
try {
  manifest = JSON.parse(readText("package.json") ?? "null");
} catch {
  packaging.push({ file: "package.json", line: 0, rule: "json", detail: "unreadable" });
}
if (manifest !== null) {
  for (const key of ["name", "version", "description", "license", "repository", "bugs", "homepage", "type", "engines"]) {
    if (manifest[key] === undefined) packaging.push({ file: "package.json", line: 0, rule: "missing", detail: key });
  }
  if (manifest.publishConfig?.access !== "public") packaging.push({ file: "package.json", line: 0, rule: "publishConfig", detail: "access" });
  if (manifest.publishConfig?.provenance !== true) packaging.push({ file: "package.json", line: 0, rule: "publishConfig", detail: "provenance" });
  const allowedFiles = new Set(["index.ts", "src", "assets", "README.md", "LICENSE", "docs"]);
  for (const entry of manifest.files ?? []) {
    if (!allowedFiles.has(entry)) packaging.push({ file: "package.json", line: 0, rule: "files", detail: entry });
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    if (manifest.scripts?.[hook] !== undefined) packaging.push({ file: "package.json", line: 0, rule: "install-hook", detail: hook });
  }
  if (manifest.pi?.extensions?.[0] !== "./index.ts") packaging.push({ file: "package.json", line: 0, rule: "pi-entry", detail: "pi.extensions" });
}
add("R9", "packaging sanity", packaging, "package.json");

const toolFiles = srcFiles.filter((rel) => rel.startsWith("src/tools/") && !rel.endsWith("/types.ts"));
let descriptionTotal = 0;
for (const rel of toolFiles) {
  for (const match of (readText(rel) ?? "").matchAll(/export const [A-Z_]+_DESCRIPTION\s*=\s*([\s\S]*?);\n/g)) {
    const literal = (match[1] ?? "").match(/"((?:[^"\\]|\\.)*)"/);
    if (literal !== null) descriptionTotal += (literal[1] ?? "").length;
  }
}
add("R10", "tool-description budget (approximate)",
  descriptionTotal > TOOL_BUDGET_CHARS
    ? [{ file: "src/tools/", line: 0, rule: "budget", detail: `${descriptionTotal} > ${TOOL_BUDGET_CHARS}` }]
    : [],
  "src/tools/*.ts");

const HOST_FILE = "src/runtime/host.ts";
add("R13", "host facts live only in the host layer", scan(srcFiles.filter((rel) => rel !== HOST_FILE), [
  ["node:os", /from\s+"node:os"/],
  ["home-env", /\bprocess\.env\.(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_[A-Z_]+)\b|\bos\.homedir\(/],
  ["proc", /["'`]\/proc\//],
  ["dot-config", /["'`](?:\.config|Library\/Application Support)\//],
  ["probe-binary", /(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'](?:which|where|command)["']/],
]), `src/ except ${HOST_FILE}`);

// --------------------------------------------------------------------------- docs

const lines = (rel) => (readText(rel) ?? "").replace(/\n$/, "").split("\n").length;
const docs = FILES.filter((rel) => /^docs\/[^/]+\.md$/.test(rel));
const docFindings = [];
for (const [file, budget] of [
  ["README.md", DOC_BUDGET.README],
  ["AGENTS.md", DOC_BUDGET.AGENTS],
  ["SPEC.md", DOC_BUDGET.SPEC],
  ["PLAN.md", DOC_BUDGET.PLAN],
]) {
  if (lines(file) > budget) docFindings.push({ file, line: lines(file), rule: "budget", detail: `> ${budget}` });
}
let docsTotal = 0;
for (const rel of docs) {
  docsTotal += lines(rel);
  if (lines(rel) > DOC_BUDGET.doc) docFindings.push({ file: rel, line: lines(rel), rule: "budget", detail: `> ${DOC_BUDGET.doc}` });
}
if (docsTotal > DOC_BUDGET.docsTotal) docFindings.push({ file: "docs/", line: docsTotal, rule: "budget", detail: `> ${DOC_BUDGET.docsTotal}` });
add("R14", "documentation budgets", docFindings, "README.md, AGENTS.md, SPEC.md, PLAN.md, docs/*.md");

/** Dotted key paths of `export const DEFAULT_CONFIG = { … }`, walked by brace depth. */
function configKeys() {
  const text = readText("src/config.ts") ?? "";
  const start = text.indexOf("export const DEFAULT_CONFIG");
  if (start === -1) return [];
  const body = text.slice(start);
  const keys = [];
  const names = [""];
  let depth = 0;
  let lastKey = null;
  let i = body.indexOf("{") + 1;
  while (i > 0 && i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < body.length && body[i] !== quote) i += body[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === "{") {
      depth += 1; names[depth] = lastKey ?? ""; lastKey = null; i += 1; continue;
    }
    if (ch === "}") {
      if (depth === 0) break;
      depth -= 1; lastKey = null; i += 1; continue;
    }
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(body.slice(i, i + 80));
    if (key !== null) {
      lastKey = key[1];
      const prefix = names[depth] ?? "";
      keys.push(prefix === "" ? lastKey : `${prefix}.${lastKey}`);
      i += key[0].length;
      continue;
    }
    i += 1;
  }
  return keys;
}

const drift = [];
const configDoc = readText("docs/config.md") ?? "";
for (const key of configKeys()) {
  if (!configDoc.includes(key)) drift.push({ file: "docs/config.md", line: 0, rule: "config-key", detail: key });
}
const errorDoc = readText("docs/errors.md") ?? "";
for (const match of (readText("src/runtime/error-codes.ts") ?? "").matchAll(/\bE_[A-Z_]+\b/g)) {
  if (!errorDoc.includes(match[0])) drift.push({ file: "docs/errors.md", line: 0, rule: "error-code", detail: match[0] });
}
const readme = readText("README.md") ?? "";
const tools = new Set();
for (const rel of toolFiles) {
  for (const match of (readText(rel) ?? "").matchAll(/^\s{2}name:\s*"([a-z_]+)"/gm)) tools.add(match[1]);
}
for (const tool of tools) {
  if (!readme.includes(`\`${tool}\``)) drift.push({ file: "README.md", line: 0, rule: "tool", detail: tool });
}
add("R15", "docs ↔ code drift", drift, "docs/config.md, docs/errors.md, README.md");

// --------------------------------------------------------------------------- report

const violations = checks.reduce((sum, check) => sum + check.findings.length, 0);
if (json) {
  process.stdout.write(`${JSON.stringify({ ok: violations === 0, toolDescriptionChars: descriptionTotal, checks })}\n`);
} else {
  for (const check of checks) {
    const status = check.findings.length === 0 ? "ok" : `${check.findings.length} finding(s)`;
    process.stdout.write(`${check.id.padEnd(4)} ${check.title}: ${status}  [${check.scope}]\n`);
    for (const finding of check.findings.slice(0, 20)) {
      process.stdout.write(`     ${finding.file}${finding.line > 0 ? `:${finding.line}` : ""} ${finding.rule} ${finding.detail}\n`);
    }
    if (check.findings.length > 20) process.stdout.write(`     … ${check.findings.length - 20} more\n`);
  }
  process.stdout.write(
    `\n${checks.length} rules, ${violations} violation(s), tool descriptions ≈${descriptionTotal} chars (budget ${TOOL_BUDGET_CHARS})\n`,
  );
}
process.exit(violations === 0 ? 0 : 1);
