#!/usr/bin/env node
/**
 * pi-chrome-search — hard-rule audit.
 *
 * Zero dependencies, read-only, no side effects. Run with `node scripts/audit.mjs` or
 * `npm run audit`; add `--json` for machine output. Exit codes: 0 clean, 1 violation, 2 usage error.
 *
 * The checks mirror AGENTS.md §2 and PLAN.md §4.1:
 *
 *   R1  attach only: no automation/browser launch in src/ or tests/ (any Playwright, Puppeteer,
 *       WebdriverIO or generic `.launch(`, plus headless/automation flags)
 *   R2  no fingerprint spoofing (UA, Emulation, init scripts, navigator.webdriver assignment)
 *   R3  never kill/restart the user's Chrome
 *   R4  no captcha solving (surface the window instead — E_WALL)
 *   R5  no paid search APIs or keys (ctx.modelRegistry classifiers are not matched)
 *   R6  no secrets in tracked files (values redacted in the report)
 *   R7  no personal data in tests/fixtures/** (values redacted in the report)
 *   R8  repo hygiene: tracked build/output dirs, .env files, tracked screenshots, .gitignore
 *   R9  tool-description budget hook (approximate; authoritative gate is the P2 unit test)
 *
 * Scope (also printed with the report, so the deliberate exclusions are never a mystery):
 *   R1 = src/ + tests/   R2–R5 = src/   R6 = everything except node_modules/, .git/, research/
 *   R7 = tests/fixtures/**   R8 = repo hygiene   R9 = approximate
 * `playwright-core` is allowed in research/ and bench/ for comparison (SPEC §4), so those trees are
 * intentionally outside R1; bench/ does not exist yet and is not scanned until it does.
 *
 * File discovery uses `git ls-files --cached --others --exclude-standard` so ignored paths are
 * never reported, while uncommitted-but-not-ignored work is still audited. When git is unavailable
 * (or the script runs outside a repo) it falls back to a recursive walk of the tree.
 *
 * R1–R5 read code with comments blanked (line numbers and offsets preserved), so a comment documenting
 * "never launch Playwright / never call SerpApi" is not a violation while the same token inside a
 * string, template or regex literal (e.g. `import "playwright"`) still is. The tokenizer models those
 * literal forms (see `stripComments`) instead of guessing from quotes. Findings are capped per rule and
 * per file; every report states how many findings were shown versus found.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_GZIP_BYTES = 8 * 1024 * 1024;
const MAX_FINDINGS_PER_RULE = 200;
const MAX_FINDINGS_PER_FILE = 10;
const TOOL_BUDGET_CHARS = 900;

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(usage() + "\n");
  process.exit(0);
}

let json = false;
for (const arg of argv) {
  if (arg === "--json") {
    json = true;
  } else {
    process.stderr.write(`audit: unknown argument ${JSON.stringify(arg)}\n\n${usage()}\n`);
    process.exit(2);
  }
}

function usage() {
  return [
    "usage: node scripts/audit.mjs [--json]",
    "",
    "  default  readable report per rule (R1..R9)",
    "  --json   machine-readable report on stdout",
    "",
    "exit 0 = clean, 1 = violations, 2 = usage/internal error",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// File discovery and reading
// ---------------------------------------------------------------------------

function walk(root) {
  const files = [];
  const visit = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Never descend into node_modules/.git. Symlinks are skipped entirely: following them
        // could escape the repo (node_modules is a symlink in worktrees) and loop.
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  visit(root, "");
  return files;
}

function listRepoFiles(root) {
  try {
    const git = (args) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    // Guard against `git -C <dir>` walking up to an unrelated parent repository.
    const top = realpathSync(git(["rev-parse", "--show-toplevel"]).trim());
    if (top !== realpathSync(root)) return { mode: "walk", files: walk(root) };
    const out = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    const files = [...new Set(out.split("\0").filter(Boolean))]
      // Only the untracked `node_modules` symlink is dropped (the `node_modules/` ignore pattern
      // needs a trailing slash, so the symlink itself is listed). A *tracked* node_modules path
      // must reach R8 — filtering the whole prefix here would silently hide a committed tree.
      .filter((rel) => rel !== "node_modules")
      .filter((rel) => rel !== ".git" && !rel.startsWith(".git/"))
      .filter((rel) => isRegularFile(root, rel))
      .sort();
    return { mode: "git", files };
  } catch {
    return { mode: "walk", files: walk(root) };
  }
}

/**
 * `git ls-files --others` still lists an untracked symlink named node_modules (the `node_modules/`
 * ignore pattern requires a trailing slash), and following it would leave the repo. Keep only
 * regular files.
 */
function isRegularFile(root, rel) {
  try {
    return lstatSync(join(root, rel)).isFile();
  } catch {
    return false;
  }
}

function createStore(root) {
  const buffers = new Map();
  const texts = new Map();
  const skipped = [];
  const errors = new Map();

  function readBytes(rel) {
    if (buffers.has(rel)) return buffers.get(rel);
    let buf = null;
    try {
      const abs = join(root, rel);
      const st = lstatSync(abs);
      if (!st.isFile()) {
        skipped.push({ file: rel, reason: "not a regular file" });
      } else if (st.size > MAX_FILE_BYTES) {
        skipped.push({ file: rel, reason: `larger than ${MAX_FILE_BYTES} bytes` });
      } else {
        buf = readFileSync(abs);
      }
    } catch (error) {
      const code = error.code ?? error.message;
      // A read failure is an audit gap, not a clean skip: R7 turns this into a finding.
      errors.set(rel, code);
      skipped.push({ file: rel, reason: `unreadable (${code})` });
    }
    buffers.set(rel, buf);
    return buf;
  }

  function readText(rel) {
    if (texts.has(rel)) return texts.get(rel);
    const buf = readBytes(rel);
    let value = null;
    if (buf && !buf.includes(0)) {
      value = buf.toString("utf8");
    } else if (buf) {
      skipped.push({ file: rel, reason: "binary (NUL byte)" });
    }
    texts.set(rel, value);
    return value;
  }

  /** Read failure code for `rel` (EACCES, EISDIR, …), or null when the file was readable/skipped. */
  function readError(rel) {
    readBytes(rel);
    return errors.get(rel) ?? null;
  }

  return { readText, readBytes, readError, skipped };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function extensionOf(rel) {
  const slash = rel.lastIndexOf("/");
  const dot = rel.lastIndexOf(".");
  return dot <= slash ? "" : rel.slice(dot).toLowerCase();
}

function hasCodeExtension(rel) {
  return CODE_EXTENSIONS.has(extensionOf(rel));
}

function filesUnder(all, scopes) {
  return all.filter((rel) => scopes.some((scope) => rel.startsWith(scope)));
}

function readableCount(store, files) {
  let n = 0;
  for (const rel of files) if (store.readText(rel) != null) n += 1;
  return n;
}

function lineOf(text, index) {
  let line = 1;
  const limit = Math.min(index, text.length);
  for (let i = 0; i < limit; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function clip(text, max = 110) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * A `/` starts a regex literal only in expression position. These are the tokens after which that is
 * true; anything else (identifier, number, `)`, `]`, a just-closed literal) means division.
 * `=>` is folded into `=` because an arrow body is expression position.
 */
const REGEX_PRECEDING_CHARS = new Set(["(", "=", ":", ",", "!", "&", "|", "?", "{", "}", ";", "["]);
const REGEX_PRECEDING_WORDS = new Set([
  "return", "case", "typeof", "instanceof", "in", "of", "yield", "await",
  "delete", "void", "new", "throw", "else", "do",
]);
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const VALUE = "\u0000value"; // a string/template/regex literal just closed: only division may follow
const NUMBER = "\u0000number";

/**
 * Blank out `//` and `/* … *\/` comments in TypeScript/JavaScript source for code scanning.
 *
 * Why: R1–R5 must catch APIs in code, not prose. A comment saying "never launch Playwright, never use
 * SerpApi" is documentation of the rule, not a violation; an `import "playwright"` string is.
 *
 * What is modelled — a small hand-written tokenizer, deliberately not a parser: normal code,
 * '…' and "…" strings, template literals including nested `${ … }` expressions, line comments,
 * block comments, and regex literals (`\` escapes, `[...]` character classes, trailing flags). A `/`
 * starts a regex only after `( = : , ! & | ? { } ; [`, at line start, or after
 * return/case/typeof/instanceof/in/of/yield/await/delete/void/new/throw/else/do — never after an
 * identifier, number, `)` or `]`. Comments become spaces (newlines kept, so line numbers and match
 * offsets survive); string, template and regex bodies are kept because their contents are code.
 *
 * What is NOT modelled: JSX text (an apostrophe in markup can flip the quote state), `#!` shebangs,
 * and any `/` in a position the list above does not cover (e.g. statement-initial `/re/` after `)`),
 * which is read as division. Every character is kept, so a mis-lexed region is scanned as code: a
 * forbidden token inside it is still reported. The only blind spot left is a genuine `//` comment
 * inside a region wrongly read as a regex, and that stays on one line because regexes do not span
 * lines here — the tokenizer recovers at the newline.
 */
function stripComments(text) {
  const out = text.split("");
  let state = "code";
  /** "" = start of file/line, VALUE/NUMBER markers, a single punctuation char, or a word. */
  let prev = "";
  /** Brace depth of each open `${ … }`; a stack so nested templates work. */
  const templateExprs = [];
  let i = 0;

  const blank = (index) => {
    if (text[index] !== "\n") out[index] = " ";
  };

  const regexAllowed = () => {
    if (prev === "") return true;
    if (prev === VALUE || prev === NUMBER) return false;
    if (prev.length === 1) return REGEX_PRECEDING_CHARS.has(prev);
    return REGEX_PRECEDING_WORDS.has(prev);
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? "";

    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        prev = "";
      } else {
        blank(i);
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (ch === "*" && next === "/") {
        blank(i);
        blank(i + 1);
        state = "code";
        i += 2;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }

    if (state === "single" || state === "double") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      // An unterminated string must not poison the rest of the file: recover at the newline.
      if (ch === "\n") {
        state = "code";
        prev = VALUE;
        i += 1;
        continue;
      }
      if ((state === "single" && ch === "'") || (state === "double" && ch === '"')) {
        state = "code";
        prev = VALUE;
      }
      i += 1;
      continue;
    }

    if (state === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        state = "code";
        prev = VALUE;
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        state = "code";
        templateExprs.push(0);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "regex" || state === "regexClass") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      // Regexes do not span lines; if we reach one, the `/` was division after all. Nothing was
      // blanked inside, so simply fall back to code.
      if (ch === "\n") {
        state = "code";
        prev = VALUE;
        i += 1;
        continue;
      }
      if (state === "regexClass") {
        if (ch === "]") state = "regex";
        i += 1;
        continue;
      }
      if (ch === "[") {
        state = "regexClass";
        i += 1;
        continue;
      }
      if (ch === "/") {
        state = "code";
        i += 1;
        while (i < text.length && IDENT_PART.test(text[i])) i += 1; // flags
        prev = VALUE;
        continue;
      }
      i += 1;
      continue;
    }

    // state === "code"
    if (ch === "/" && next === "/") {
      blank(i);
      blank(i + 1);
      state = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(i);
      blank(i + 1);
      state = "block";
      i += 2;
      continue;
    }
    if (ch === "/") {
      if (regexAllowed()) {
        state = "regex";
      } else {
        prev = "/";
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = "single";
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "template";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      prev = "";
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "{" && templateExprs.length > 0) {
      templateExprs[templateExprs.length - 1] += 1;
      prev = ch;
      i += 1;
      continue;
    }
    if (ch === "}" && templateExprs.length > 0) {
      const depth = templateExprs[templateExprs.length - 1];
      if (depth === 0) {
        templateExprs.pop();
        state = "template";
        i += 1;
        continue;
      }
      templateExprs[templateExprs.length - 1] = depth - 1;
      prev = ch;
      i += 1;
      continue;
    }
    if (ch === "=" && next === ">") {
      prev = "="; // arrow body is expression position
      i += 2;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j])) j += 1;
      prev = text.slice(i, j);
      i = j;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < text.length && /[0-9A-Za-z_.]/.test(text[j])) j += 1;
      prev = NUMBER;
      i = j;
      continue;
    }
    prev = ch;
    i += 1;
  }
  return out.join("");
}

/**
 * Scan files for regex patterns. Findings are deduplicated per file:line:pattern (or the pattern's
 * `family`, so overlapping patterns on one line report once), and capped. Matches beyond the caps are
 * still counted so the report can state "shown X of Y". Patterns with a `label` are sensitive: they
 * never echo the matched value to stdout/JSON.
 */
function scanPatterns(store, files, patterns, opts = {}) {
  const findings = [];
  const seen = new Set();
  let total = 0;
  let capped = false;

  for (const pattern of patterns) {
    for (const file of files) {
      const raw = store.readText(file);
      if (raw == null) continue;
      const text = opts.stripComments ? stripComments(raw) : raw;
      const flags = pattern.re.flags.includes("g") ? pattern.re.flags : `${pattern.re.flags}g`;
      const re = new RegExp(pattern.re.source, flags);
      let perFile = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const line = lineOf(text, match.index);
        const key = `${file}:${line}:${pattern.family ?? pattern.re.source}`;
        if (seen.has(key)) continue;
        seen.add(key);
        total += 1;
        if (perFile >= MAX_FINDINGS_PER_FILE) {
          // One noisy file must not fill the whole rule's budget, but it must still be counted.
          capped = true;
          continue;
        }
        if (findings.length >= MAX_FINDINGS_PER_RULE) {
          // The rule budget is exhausted: the finding is counted in `total` but not shown, so the
          // whole report must say it was capped (truncated === true implies capped === true).
          capped = true;
          continue;
        }
        findings.push({
          file,
          line,
          match: pattern.label ? `${pattern.label} (${match[0].length} chars, redacted)` : match[0],
          hint: pattern.hint,
        });
        perFile += 1;
      }
    }
  }

  return { findings, total, truncated: total > findings.length, capped };
}

// ---------------------------------------------------------------------------
// Rule patterns (R1–R5)
//
// Patterns are built so this file does not trip its own secret scan (R6): the literal
// `sk-…`/`AKIA…`/`-----BEGIN` sequences never appear verbatim in this source.
// ---------------------------------------------------------------------------

const R1_PATTERNS = [
  { re: /playwright/i, hint: "attach over raw CDP; never drive an automation browser" },
  {
    re: /\bpuppeteer\b/i,
    family: "launch",
    hint: "no Puppeteer in src/ or tests/; attach to the user's Chrome over raw CDP",
  },
  {
    re: /\bwebdriverio\b/i,
    family: "launch",
    hint: "no WebdriverIO in src/ or tests/; attach to the user's Chrome over raw CDP",
  },
  { re: /launchPersistentContext/, hint: "never start a separate browser profile; attach to the running Chrome" },
  {
    re: /\b(?:chromium|chrome|browserType|browser)\s*\.\s*launch\s*\(/,
    family: "launch",
    hint: "never call chromium.launch*/browserType.launch(); use raw CDP attach",
  },
  {
    re: /\.launch\s*\(/,
    family: "launch",
    hint: "no browser/process launcher in src/ or tests/; attach to the running Chrome",
  },
  {
    re: /\bheadless\s*:\s*true\b/i,
    family: "headless",
    hint: "the browser must be real and headed (AGENTS §2.4)",
  },
  { re: /--enable-automation/, hint: "an automation flag makes the session detectable; attach instead" },
  { re: /--headless/, family: "headless", hint: "the browser must be real and headed (AGENTS §2.4)" },
];

const R2_PATTERNS = [
  { re: /addScriptToEvaluateOnNewDocument/, hint: "no init-script injection; extract with one-off Runtime.evaluate" },
  { re: /Emulation\.set/, hint: "never override device/UA/locale/timezone emulation" },
  { re: /setUserAgentOverride/, hint: "do not spoof the user agent" },
  { re: /navigator\s*\.\s*webdriver\s*=(?!=)/, hint: "never assign navigator.webdriver; reading it for the doctor is fine" },
  {
    re: /navigator\s*\[\s*["'`]webdriver["'`]\s*\]\s*=(?!=)/,
    hint: "never assign navigator.webdriver; reading it for the doctor is fine",
  },
];

const R3_PATTERNS = [
  { re: /\bprocess\.kill\b/, hint: "never kill the user's Chrome or its process tree; ask the user" },
  { re: /\bpkill\b/, hint: "never kill the user's Chrome; ask the user" },
  { re: /\btaskkill\b/, hint: "never kill the user's Chrome; ask the user" },
  { re: /chrome[^\n]*--restart/i, hint: "never restart Chrome; attach to the running instance" },
];

const R4_PATTERNS = [
  { re: /2captcha/i, hint: "never use a captcha solver; surface the window and return E_WALL" },
  { re: /anti-?captcha/i, hint: "never use a captcha solver; surface the window and return E_WALL" },
  {
    re: /\bsolve\w*captcha\s*\(/i,
    hint: "never solve captchas; the user solves them in the visible window",
  },
];

const R5_PATTERNS = [
  { re: /serpapi/i, hint: "no paid search API; search through the user's Chrome" },
  { re: /serper\.dev/i, hint: "no paid search API; search through the user's Chrome" },
  { re: /api\.search\.brave/i, hint: "no paid search API; search through the user's Chrome" },
  { re: /\btavily\b/i, hint: "no paid search API; search through the user's Chrome" },
  { re: /\bexa\.ai\b/i, hint: "no paid search API; search through the user's Chrome" },
  { re: /\bkagi\b/i, hint: "no paid search API; search through the user's Chrome" },
];

// ---------------------------------------------------------------------------
// R6 — secrets
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  {
    label: "OPENROUTER_API_KEY assignment",
    re: new RegExp("OPENROUTER_API_KEY" + "\\s*[=:]\\s*[\"'`]?[A-Za-z0-9_\\-]{12,}"),
    hint: "remove the key; classifiers use the pi OpenRouter session via ctx.modelRegistry",
  },
  {
    label: "OpenAI-style secret key",
    re: /sk-[A-Za-z0-9_-]{20,}/,
    hint: "remove the key from the repo and rotate it",
  },
  {
    label: "AWS access key id",
    re: new RegExp("AKIA" + "[0-9A-Z]{16}"),
    hint: "remove the credential and rotate it",
  },
  {
    label: "private key block",
    re: new RegExp("-{5}BEGIN " + "[A-Z ]*PRIVATE KEY-{5}"),
    hint: "never commit private keys; remove and rotate",
  },
  {
    label: "Slack bot token",
    re: new RegExp("xox" + "b-[A-Za-z0-9-]{8,}"),
    hint: "remove the token and revoke it",
  },
];

const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * Scope of every rule, printed with the report. The exclusions are deliberate (SPEC §4 allows
 * playwright-core in research/ and bench/), so they must be visible instead of looking like a miss.
 */
const SCOPE_NOTES = [
  "R1 = src/ + tests/ (browsers: playwright, puppeteer, webdriverio, launchPersistentContext, any `.launch(`, headless, --enable-automation)",
  "R2–R5 = src/ only (production code that ships)",
  "R6 = all files except node_modules/, .git/, research/",
  "R7 = tests/fixtures/** (excluding *.md docs)",
  "R8 = repo hygiene: every tracked path + .gitignore",
  "R9 = approximate (description/promptSnippet literals in src/tools/*.ts); authoritative gate is tests/unit/tool_budget.test.ts",
  "research/ and bench/ may use playwright-core for comparison (SPEC §4) and are never scanned by R1",
  "R1–R5 match code with comments blanked; string, template and regex bodies are kept (they are code)",
];

function isEnvFile(base) {
  return /^\.env(?:\.|$)/.test(base);
}

const SECRET_SCAN_EXCLUDED_PREFIXES = ["node_modules/", ".git/", "research/"];

// ---------------------------------------------------------------------------
// R7 — fixture personal data
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const PARAM_RE = /\b(sxsrf|reqid|sessionid)\s*=\s*([^\s&"'<>;]+)/gi;
/** Profile identity fields a signed-in SERP bootstraps into the page. */
const PERSONAL_FIELD_RE = /"(displayUserName|userName|userLogin|avatarId|yandexUid|userUid)"\s*:\s*"([^"]*)"/g;
const COOKIE_RE = /\bcookie\s*:/gi;
const LONG_BASE64_RE = /[A-Za-z0-9+/=_-]{200,}/g;

const ALLOWED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "example.test",
  "example.invalid",
  "localhost",
]);

// `image@2x.png` in srcset attributes looks like an address; never treat asset names as emails.
const ASSET_TLDS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "css", "js", "mjs",
  "map", "json", "html", "htm", "woff", "woff2", "ttf", "otf", "eot",
]);

const PLACEHOLDER_VALUES = new Set([
  "redacted", "test", "dummy", "fake", "example", "placeholder", "none", "null",
  "undefined", "xxx", "x", "changeme", "secret", "token",
]);

function isAllowedEmail(address) {
  const at = address.lastIndexOf("@");
  if (at < 1) return true;
  const domain = address.slice(at + 1).toLowerCase();
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (ASSET_TLDS.has(tld)) return true;
  return ALLOWED_EMAIL_DOMAINS.has(domain);
}

function classifyIpv4(candidate) {
  const parts = candidate.split(".").map(Number);
  if (parts.length !== 4) return null;
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  if (candidate === "0.0.0.0") return "allowed";
  if (parts[0] === 127) return "allowed"; // loopback is not personal data
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return "allowed"; // TEST-NET-1
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return "allowed"; // TEST-NET-2
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return "allowed"; // TEST-NET-3
  return "violation";
}

function isPlaceholderValue(raw) {
  const value = raw.toLowerCase().replace(/^["']|["']$/g, "");
  if (value.startsWith("<") || value.startsWith("%") || value.startsWith("{") || value.startsWith("$")) {
    return true;
  }
  // The fixture sanitizer's own marker is a placeholder, not a leaked value:
  // `sxsrf=[redacted]` is the expected end state, and flagging it made R7
  // permanently red for every sanitized capture.
  if (value.includes("[redacted")) return true;
  return PLACEHOLDER_VALUES.has(value);
}

function readFixture(store, rel) {
  if (!rel.toLowerCase().endsWith(".gz")) return store.readText(rel);
  const buf = store.readBytes(rel);
  if (!buf) return null;
  return gunzipSync(buf, { maxOutputLength: MAX_GZIP_BYTES }).toString("utf8");
}

// ---------------------------------------------------------------------------
// R9 — tool-description budget (approximate)
// ---------------------------------------------------------------------------

function collectStringLiterals(text, key) {
  const results = [];
  const re = new RegExp(`\\b${key}\\s*:\\s*`, "g");
  let match;
  while ((match = re.exec(text)) !== null) {
    const quote = text[match.index + match[0].length];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let i = match.index + match[0].length + 1;
    let value = "";
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        const next = text[i + 1] ?? "";
        value += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i += 2;
        continue;
      }
      if (ch === quote) break;
      if ((ch === "\n" || ch === "\r") && quote !== "`") break;
      value += ch;
      i += 1;
    }
    results.push({ line: lineOf(text, match.index), value });
    re.lastIndex = Math.max(re.lastIndex, i + 1);
  }
  return results;
}

function charCount(value) {
  return [...value].length;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function runAudit(root) {
  const listing = listRepoFiles(root);
  const store = createStore(root);
  const files = listing.files;
  const checks = [];

  const codeIn = (scopes) => filesUnder(files, scopes).filter(hasCodeExtension);

  const addCodeCheck = (id, title, scopeLabel, scopes, patterns, notes) => {
    const scoped = codeIn(scopes);
    const { findings, total, truncated, capped } = scanPatterns(store, scoped, patterns, {
      stripComments: true,
    });
    checks.push({
      id,
      title,
      scope: scopeLabel,
      files: readableCount(store, scoped),
      findings,
      total,
      truncated,
      capped,
      notes,
    });
  };

  // R1 — attach only.
  addCodeCheck(
    "R1",
    "attach only — no automation launch",
    "src/, tests/",
    ["src/", "tests/"],
    R1_PATTERNS,
    [
      "patterns: playwright, puppeteer, webdriverio, launchPersistentContext, any .launch(, headless: true, --enable-automation, --headless",
      "research/ and bench/ may use playwright-core for comparison (SPEC §4) and are deliberately not scanned",
    ],
  );

  // R2 — no fingerprint spoofing. Reading navigator.webdriver is explicitly allowed.
  addCodeCheck(
    "R2",
    "no fingerprint spoofing",
    "src/",
    ["src/"],
    R2_PATTERNS,
    ["reading navigator.webdriver is allowed; only assignments are flagged"],
  );

  // R3 — never kill/restart the user's Chrome.
  addCodeCheck(
    "R3",
    "never kill/restart the user's Chrome",
    "src/",
    ["src/"],
    R3_PATTERNS,
    ["patterns: process.kill, pkill, taskkill, chrome…--restart"],
  );

  // R4 — no captcha solving. A bare "captcha" is legitimate (E_WALL vocabulary).
  addCodeCheck(
    "R4",
    "no captcha solving",
    "src/",
    ["src/"],
    R4_PATTERNS,
    ["bare captcha/consent vocabulary is allowed (E_WALL); only solver markers are flagged"],
  );

  // R5 — no paid search APIs. Registry classifiers never match these names.
  addCodeCheck(
    "R5",
    "no paid search APIs or keys",
    "src/",
    ["src/"],
    R5_PATTERNS,
    ["ctx.modelRegistry classifiers are allowed and do not match these patterns"],
  );

  // R6 — secrets in tracked files.
  {
    const scoped = files.filter(
      (rel) => !SECRET_SCAN_EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix)),
    );
    const scan = scanPatterns(store, scoped, SECRET_PATTERNS);
    let total = scan.total;
    for (const rel of scoped) {
      const base = rel.split("/").pop() ?? rel;
      if (!isEnvFile(base) || ENV_TEMPLATES.has(base)) continue;
      total += 1;
      if (scan.findings.length >= MAX_FINDINGS_PER_RULE) continue;
      scan.findings.push({
        file: rel,
        line: 0,
        match: `${base} file`,
        hint: "delete the env file from the index; keep only .env.example and gitignore .env*",
      });
    }
    checks.push({
      id: "R6",
      title: "no secrets in tracked files",
      scope: "all files except node_modules/, .git/, research/",
      files: readableCount(store, scoped),
      findings: scan.findings,
      total,
      truncated: total > scan.findings.length,
      capped: scan.capped || total > scan.findings.length,
      notes: [
        "scanned: OPENROUTER_API_KEY assignments, long sk- keys, AKIA…, private key blocks, xoxb- tokens, .env files",
        "matched secret values are redacted here; open the file:line to fix",
      ],
    });
  }

  // R7 — personal data in fixtures.
  {
    // Documentation is not a fixture: tests/fixtures/README.md shows sanitizer
    // examples on purpose (a cookie line, a sample email). Scanning prose would
    // flag the rules themselves; a real capture is .html/.gz/.json/.txt.
    const scoped = files.filter(
      (rel) => rel.startsWith("tests/fixtures/") && !/\.md$/i.test(rel),
    );
    const findings = [];
    const seen = new Set();
    let total = 0;
    let scannedFixtures = 0;
    let skippedFixtures = 0;
    let unreadableFixtures = 0;
    let corruptFixtures = 0;

    const push = (file, line, match, hint) => {
      const key = `${file}:${line}:${match}`;
      if (seen.has(key)) return;
      seen.add(key);
      total += 1;
      if (findings.length >= MAX_FINDINGS_PER_RULE) return;
      findings.push({ file, line, match, hint });
    };

    for (const rel of scoped) {
      let text = null;
      try {
        text = readFixture(store, rel);
      } catch (error) {
        // A corrupt gzip is a finding, not a skip: gunzipSync threw before any content was audited.
        corruptFixtures += 1;
        push(rel, 0, `corrupt gzip fixture (${error.code ?? error.message})`,
          "repair or regenerate the fixture so it can be audited");
        continue;
      }
      if (text == null) {
        skippedFixtures += 1;
        // A binary fixture is a legitimate skip; an fs error (EACCES, EISDIR, …) is an audit gap and
        // must fail the rule, otherwise a chmod 000 fixture hides personal data from the audit.
        const readError = store.readError(rel);
        if (readError) {
          unreadableFixtures += 1;
          push(rel, 0, `unreadable fixture (${readError})`,
            "make every fixture under tests/fixtures/ readable; unreadable fixtures are unaudited");
        }
        continue;
      }
      scannedFixtures += 1;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const lineNo = i + 1;

        for (const m of line.matchAll(new RegExp(EMAIL_RE.source, "g"))) {
          if (isAllowedEmail(m[0])) continue;
          push(rel, lineNo, `email address (redacted, ${m[0].length} chars)`,
            "replace with a placeholder from example.com or strip the field");
        }

        for (const m of line.matchAll(new RegExp(IPV4_RE.source, "g"))) {
          if (classifyIpv4(m[0]) !== "violation") continue;
          push(rel, lineNo, "IPv4 address (redacted)",
            "replace with 127.0.0.1, 0.0.0.0, or a 192.0.2.x / 198.51.100.x / 203.0.113.x documentation address");
        }

        for (const m of line.matchAll(new RegExp(PERSONAL_FIELD_RE.source, "g"))) {
          if (isPlaceholderValue(m[2])) continue;
          push(rel, lineNo, `${m[1]}=<redacted>`,
            "strip profile identity (display name, avatar id, user id) from the fixture");
        }

        for (const m of line.matchAll(new RegExp(PARAM_RE.source, "gi"))) {
          if (isPlaceholderValue(m[2])) continue;
          push(rel, lineNo, `${m[1].toLowerCase()}=<redacted>`,
            "remove the captured token from the fixture; keep only the parameter name if needed");
        }

        for (const _m of line.matchAll(new RegExp(COOKIE_RE.source, "gi"))) {
          push(rel, lineNo, "Cookie header (redacted)", "drop request/response cookie headers from fixtures");
        }

        for (const m of line.matchAll(new RegExp(LONG_BASE64_RE.source, "g"))) {
          push(rel, lineNo, `base64-like run (${m[0].length} chars)`,
            "strip or replace long tokens/inline data with a short placeholder");
        }
      }
    }

    checks.push({
      id: "R7",
      title: "no personal data in fixtures",
      scope: "tests/fixtures/** (excluding *.md docs)",
      files: scannedFixtures,
      findings,
      total,
      truncated: total > findings.length,
      capped: total > findings.length,
      notes: [
        scoped.length === 0
          ? "no fixture files yet (0 scanned) — check passes, not skipped"
          : `${scannedFixtures} fixture file(s) scanned${skippedFixtures ? `, ${skippedFixtures} skipped (binary/unreadable)` : ""}${corruptFixtures ? `, ${corruptFixtures} corrupt gzip (violation)` : ""}`,
        unreadableFixtures > 0
          ? `${unreadableFixtures} unreadable fixture(s) — an fs error is a violation, a binary file is only a skip`
          : "binary fixtures are skipped with a reason; fs read errors fail this rule",
        corruptFixtures > 0
          ? `${corruptFixtures} corrupt gzip fixture(s) counted as violations, not skips — the content could not be audited`
          : "a corrupt gzip is reported as a violation (its content is unaudited), a NUL-byte file is only a skip",
        "scanned: emails, IPv4 (127/8, 0.0.0.0, 192.0.2/24, 198.51.100/24, 203.0.113/24 allowed), sxsrf/reqid/sessionid, Cookie headers, base64 runs >200 chars; matches are redacted",
      ],
    });
  }

  // R8 — repo hygiene.
  {
    const findings = [];
    const seen = new Set();
    let total = 0;
    const push = (file, line, match, hint) => {
      const key = `${file}:${line}:${match}`;
      if (seen.has(key)) return;
      seen.add(key);
      total += 1;
      if (findings.length >= MAX_FINDINGS_PER_RULE) return;
      findings.push({ file, line, match, hint });
    };

    const FORBIDDEN_TRACKED = ["node_modules/", "artifacts/", "coverage/", "dist/"];
    for (const rel of files) {
      const dir = FORBIDDEN_TRACKED.find((prefix) => rel.startsWith(prefix));
      if (dir) {
        push(rel, 0, `path under ${dir}`,
          "remove from git and keep it in .gitignore; build output and artifacts never ship");
      }
      const base = rel.split("/").pop() ?? rel;
      if (isEnvFile(base) && !ENV_TEMPLATES.has(base)) {
        push(rel, 0, `${base} file`, "remove from git and keep .env* ignored (only .env.example may ship)");
      }
      if (rel.startsWith("tests/fixtures/") && /\.(?:jpe?g|png|webp)$/i.test(rel)) {
        push(rel, 0, "tracked screenshot in tests/fixtures", "fixtures are text only; keep screenshots in the ignored artifacts dir");
      }
    }

    const ignoreLines = [];
    let gitignore = "";
    try {
      gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    } catch {
      push(".gitignore", 0, "missing", "create .gitignore with node_modules/, artifacts/ and .env");
    }

    if (gitignore) {
      const raw = gitignore.split(/\r?\n/);
      raw.forEach((line, index) => ignoreLines.push({ line: line.trim(), no: index + 1 }));
      const normalise = (value) =>
        value
          .replace(/^!/, "")
          .replace(/^\/+/, "")
          .replace(/^\*\*\//, "")
          .replace(/\/+$/, "");
      const active = new Set(
        ignoreLines
          .filter((entry) => entry.line && !entry.line.startsWith("#") && !entry.line.startsWith("!"))
          .map((entry) => normalise(entry.line)),
      );
      for (const token of ["node_modules/", "artifacts/", ".env"]) {
        if (active.has(normalise(token))) continue;
        const found = ignoreLines.find((entry) => normalise(entry.line) === normalise(token));
        push(".gitignore", found?.no ?? 0, `missing ignore for ${token}`,
          "ignored paths must never be committed; add the missing pattern");
      }
    }

    checks.push({
      id: "R8",
      title: "repo hygiene",
      scope: listing.mode === "git" ? "tracked paths + .gitignore" : "walked paths + .gitignore (git unavailable)",
      files: files.length,
      findings,
      total,
      truncated: total > findings.length,
      capped: total > findings.length,
      notes: [
        "scanned: node_modules/, artifacts/, coverage/, dist/, .env*, screenshots under tests/fixtures/, .gitignore tokens",
        "tracked node_modules paths are reported: only the untracked node_modules symlink is excluded from discovery",
      ],
    });
  }

  // R9 — tool-description budget hook.
  {
    const toolFiles = files.filter((rel) => /^src\/tools\/[^/]+\.ts$/.test(rel)).sort();
    const entries = [];
    for (const rel of toolFiles) {
      const text = store.readText(rel);
      if (text == null) continue;
      for (const key of ["description", "promptSnippet"]) {
        for (const literal of collectStringLiterals(text, key)) {
          entries.push({ file: rel, line: literal.line, chars: charCount(literal.value) });
        }
      }
    }

    const total = entries.reduce((sum, entry) => sum + entry.chars, 0);
    const findings = [];
    if (total > TOOL_BUDGET_CHARS) {
      const perFile = new Map();
      for (const entry of entries) {
        const bucket = perFile.get(entry.file) ?? { chars: 0, count: 0, line: entry.line };
        bucket.chars += entry.chars;
        bucket.count += 1;
        bucket.line = Math.min(bucket.line, entry.line);
        perFile.set(entry.file, bucket);
      }
      for (const [file, bucket] of [...perFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        findings.push({
          file,
          line: bucket.line,
          match: `${bucket.chars} chars across ${bucket.count} description/promptSnippet literal(s)`,
          hint: `trim tool text; total budget is ${TOOL_BUDGET_CHARS} chars for the prompt-visible surface`,
        });
      }
    }

    const toolModuleCount = toolFiles.filter((rel) => !rel.endsWith("/types.ts")).length;
    checks.push({
      id: "R9",
      title: "tool-description budget (approximate)",
      scope: "src/tools/*.ts",
      files: toolFiles.length,
      findings,
      total: findings.length,
      truncated: false,
      capped: false,
      notes: [
        "approximate static count of description/promptSnippet string literals; the authoritative gate is tests/unit/tool_budget.test.ts (P2)",
        entries.length === 0
          ? `0 chars (no tools yet); ${toolModuleCount} tool module(s)`
          : `${total} chars across ${entries.length} literal(s) in ${toolModuleCount} tool module(s); budget ${TOOL_BUDGET_CHARS}`,
      ],
    });
  }

  const shown = checks.reduce((sum, check) => sum + check.findings.length, 0);
  const total = checks.reduce((sum, check) => sum + (check.total ?? check.findings.length), 0);
  return {
    tool: "pi-chrome-search/audit",
    version: 1,
    root,
    fileSource: listing.mode,
    filesListed: files.length,
    scopeNotes: SCOPE_NOTES,
    skipped: store.skipped,
    checks,
    summary: {
      checks: checks.length,
      violations: total,
      shown,
      capped: total > shown,
      ok: total === 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printHuman(report) {
  const out = [];
  out.push("pi-chrome-search audit — hard rules and hygiene");
  out.push(`root: ${report.root}`);
  out.push(
    report.fileSource === "git"
      ? `files: ${report.filesListed} (git ls-files: tracked + untracked, ignored excluded)`
      : `files: ${report.filesListed} (recursive walk: git unavailable, .gitignore not applied)`,
  );
  out.push("scope:");
  for (const note of report.scopeNotes) out.push(`  - ${note}`);
  out.push("");

  for (const check of report.checks) {
    const failed = check.findings.length > 0;
    const shown = check.findings.length;
    const total = check.total ?? shown;
    out.push(`${check.id} ${check.title} — ${failed ? "FAIL" : "ok"} [${check.scope}]`);
    for (const note of check.notes) out.push(`     ${note}`);
    out.push(
      total > shown
        ? `     ${check.files} file(s) scanned, ${shown} of ${total} violation(s) shown (report capped)`
        : `     ${check.files} file(s) scanned, ${total} violation(s)`,
    );
    for (const finding of check.findings) {
      const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
      out.push(`     ${location}  ${clip(finding.match)}`);
      out.push(`       fix: ${finding.hint}`);
    }
    if (check.truncated) {
      out.push(
        `     (${shown} of ${total} shown — report caps: max ${MAX_FINDINGS_PER_FILE} per file, max ${MAX_FINDINGS_PER_RULE} per rule; open the files for the rest)`,
      );
    }
    out.push("");
  }

  const unreadable = report.skipped.filter((entry) => entry.reason !== "binary (NUL byte)");
  if (unreadable.length > 0) {
    out.push("skipped while reading:");
    for (const entry of unreadable.slice(0, 10)) out.push(`  ${entry.file} — ${entry.reason}`);
    if (unreadable.length > 10) out.push(`  … and ${unreadable.length - 10} more`);
    out.push("");
  }

  const { checks, violations, shown } = report.summary;
  out.push(
    violations > shown
      ? `audit: ${checks} checks, ${violations} violation${violations === 1 ? "" : "s"} (${shown} shown; report capped)`
      : `audit: ${checks} checks, ${violations} violation${violations === 1 ? "" : "s"}`,
  );
  if (violations > 0) out.push("audit: FAIL — fix the items above (AGENTS.md §2, PLAN.md §4.1)");
  out.push(
    "note: R9 is approximate; the authoritative tool-budget gate is tests/unit/tool_budget.test.ts (added in P2)",
  );

  process.stdout.write(`${out.join("\n")}\n`);
}

let report;
try {
  report = runAudit(ROOT);
} catch (error) {
  process.stderr.write(`audit: internal error: ${error?.stack ?? String(error)}\n`);
  process.exit(2);
}

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHuman(report);
}

process.exit(report.summary.ok ? 0 : 1);
