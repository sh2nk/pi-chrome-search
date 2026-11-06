#!/usr/bin/env node
/**
 * pi-chrome-search — hard-rule audit.
 *
 * Zero dependencies, read-only, no side effects. Run with `node scripts/audit.mjs` or
 * `npm run audit`; add `--json` for machine output; add `--self-test` to prove the newest rules fire
 * (it writes throwaway fixtures under /tmp/opencode and never touches the repo).
 * Exit codes: 0 clean, 1 violation, 2 usage error.
 *
 * The checks mirror AGENTS.md §2 and PLAN.md §4.1:
 *
 *   R1  attach only: no automation/browser launch in src/ or tests/ (any Playwright, Puppeteer,
 *       WebdriverIO or generic `.launch(`, plus headless/automation flags — also when the name is
 *       reached through a bracket/template key or a destructured alias)
 *   R2  no fingerprint spoofing (UA, Emulation, init scripts, navigator.webdriver assignment)
 *   R3  never kill/restart the user's Chrome (including child_process in src/)
 *   R4  no captcha solving (surface the window instead — E_WALL)
 *   R5  no paid search APIs or keys (ctx.modelRegistry classifiers are not matched)
 *   R6  no secrets in tracked files (values redacted in the report)
 *   R7  no personal data in tests/fixtures/** (values redacted in the report)
 *   R8  repo hygiene: tracked build/output dirs, .env files, tracked screenshots, .gitignore
 *   R9  tool-description budget hook (approximate; authoritative gate is the P2 unit test)
 *   R10 docs consistency: SPEC ↔ PLAN ↔ AGENTS agree on commands, config paths and tool exposures
 *   R11 evidence completeness: every phase the status table claims has an evidence file with a
 *       recorded command and a verdict
 *   R12 packaging sanity: package.json metadata, no install hooks, `files` limited to shipped paths
 *   R13 host confinement: platform facts, OS paths, executable probes and process liveness live only
 *       in src/runtime/host.ts (PO1–PO4)
 *
 * Scope (also printed with the report, so the deliberate exclusions are never a mystery):
 *   R1 = src/ + tests/   R2–R5 = src/   R6 = everything except node_modules/, .git/, research/
 *   R7 = tests/fixtures/**   R8 = repo hygiene   R9 = approximate
 *   R10 = SPEC.md, PLAN.md, AGENTS.md (+ package.json scripts)   R11 = PLAN.md §5 + evidence/
 *   R12 = package.json   R13 = src/ except src/runtime/host.ts
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
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
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
let selfTest = false;
for (const arg of argv) {
  if (arg === "--json") {
    json = true;
  } else if (arg === "--self-test") {
    selfTest = true;
  } else {
    process.stderr.write(`audit: unknown argument ${JSON.stringify(arg)}\n\n${usage()}\n`);
    process.exit(2);
  }
}

function usage() {
  return [
    "usage: node scripts/audit.mjs [--json] [--self-test]",
    "",
    "  default     readable report per rule (R1..R13)",
    "  --json      machine-readable report on stdout",
    "  --self-test run the R1/R2/R3 launch-detection and the R10–R13 rules against",
    "              throwaway fixtures in /tmp/opencode and assert that each one fires",
    "              (and stays quiet on a clean fixture); exits 1 if a rule is not live",
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
  // A launcher reached through a computed key is still a launcher: the dotted patterns above only
  // see `chromium.launch(`, so `chromium[`launch`](…)` would have slipped through. The receiver is
  // deliberately not constrained — `c[\`launch\`]()` after an import alias is the same call. Template
  // bodies survive `stripComments`, so the `["'`]` alternation covers a template-key spelling too.
  {
    re: /[A-Za-z_$][\w$]*\s*\[\s*["'`](?:launch|launchPersistentContext|launchServer)["'`]\s*\]\s*\(/,
    family: "launch",
    hint: "a computed launcher key is still a launch; attach over raw CDP",
  },
  // The key itself may be computed (`c[launcherKey]()`, `c["lau"+"nch"]()`): any bracket access whose
  // expression mentions `launch` is treated as a launcher, with or without an optional-call `?.`.
  {
    re: /\[[^\]\n]*launch[^\]\n]*\]\s*(?:\?\.)?\s*\(/i,
    family: "launch",
    hint: "a computed launcher key (variable or concatenated) is still a launch; attach over raw CDP",
  },
  {
    re: /\.\s*launch(?:PersistentContext|Server)?\s*\?\.\s*\(/,
    family: "launch",
    hint: "an optional-call launcher is still a launcher; attach over raw CDP",
  },
  // Destructuring hides the receiver (`const { launch } = chromium; launch()`). No code in src/ or
  // tests/ may call a bare launch*(), so the shape itself is forbidden rather than resolved.
  {
    re: /\b(?:launch|launchPersistentContext|launchServer)\s*\(/,
    family: "launch",
    hint: "no bare launch*() call (aliased or destructured launcher); attach over raw CDP",
  },
  {
    re: /\bheadless\s*:\s*true\b/i,
    family: "headless",
    hint: "the browser must be real and headed (AGENTS §2.4)",
  },
  { re: /--enable-automation/, hint: "an automation flag makes the session detectable; attach instead" },
  { re: /--headless/, family: "headless", hint: "the browser must be real and headed (AGENTS §2.4)" },
  // A flag split across a concatenation (`"--head" + "less"`, `"--hea" + "dless"`) renders the same
  // argv entry. Rather than enumerating split points, any `--flag`-shaped literal concatenated with
  // another string literal is suspicious: argv flags belong in user instructions, not in our code.
  {
    re: /["'`]--[a-z][a-z-]*["'`]\s*\+/i,
    family: "headless",
    hint: "a split or concatenated command-line flag; the browser must stay headed and unattended-free",
  },
  {
    re: /\+\s*["'`](?:less|mation|dless|automation)["'`]/i,
    family: "headless",
    hint: "a split command-line flag is still that flag",
  },
];

const R2_PATTERNS = [
  { re: /addScriptToEvaluateOnNewDocument/, hint: "no init-script injection; extract with one-off Runtime.evaluate" },
  {
    re: /addScriptToEvaluate["'`]\s*\+/,
    hint: "a split addScriptToEvaluateOnNewDocument is still an init-script injection",
  },
  { re: /Emulation\.set/, hint: "never override device/UA/locale/timezone emulation" },
  { re: /\bEmulation\s*\[\s*["'`]set/, hint: "never override device/UA/locale/timezone emulation" },
  { re: /setUserAgentOverride/, hint: "do not spoof the user agent" },
  { re: /navigator\s*\.\s*webdriver\s*=(?!=)/, hint: "never assign navigator.webdriver; reading it for the doctor is fine" },
  {
    re: /navigator\s*\[\s*["'`]webdriver["'`]\s*\]\s*=(?!=)/,
    hint: "never assign navigator.webdriver; reading it for the doctor is fine",
  },
  // Assignment is not the only way to patch it: defineProperty/Reflect/delete all change the value
  // the page and the doctor observe.
  {
    re: /Object\s*\.\s*defineProperty\s*\(\s*(?:window\s*\.\s*)?navigator\s*,/,
    hint: "never redefine a navigator property (webdriver/platform/…) — that is fingerprint spoofing",
  },
  // `Object["defineProperty"](globalThis.navigator, …)` / `Reflect["set"](…)` bypass the dotted forms.
  {
    re: /Object\s*\[\s*["'`]defineProperty["'`]\s*\]\s*\([\s\S]{0,120}?navigator/,
    hint: "never redefine a navigator property through a computed Object key",
  },
  {
    re: /Reflect\s*\[\s*["'`](?:set|defineProperty|deleteProperty)["'`]\s*\]\s*\([\s\S]{0,120}?navigator/,
    hint: "never patch navigator through a computed Reflect key",
  },
  {
    re: /(?:Object|Reflect)\s*\.\s*(?:defineProperty|set)\s*\(\s*(?:globalThis\s*\.\s*|window\s*\.\s*)?navigator/,
    hint: "never patch navigator, including through globalThis/window",
  },
  {
    re: /\bdelete\s+navigator\s*(?:\.\s*webdriver\b|\[\s*["'`]webdriver)/,
    hint: "never delete navigator.webdriver; the real value must stay observable",
  },
  {
    re: /Reflect\s*\.\s*(?:set|defineProperty)\s*\(\s*navigator/,
    hint: "never patch navigator through Reflect",
  },
];

const R3_PATTERNS = [
  // `kill(pid, 0)` is the portable liveness probe (PO4), and it lives only in
  // src/runtime/host.ts. Every other call, and any signal other than 0, is a
  // kill-adjacent operation against the user's session.
  {
    re: /\bprocess\.kill\s*\((?!\s*[^)\n]*,\s*0\s*\))/,
    hint: "only kill(pid, 0) (liveness, host layer) is allowed; never signal the user's Chrome",
  },
  {
    re: /\bprocess\s*\[\s*["'`]kill["'`]\s*\]/,
    hint: "a computed process.kill is still a signal; liveness lives in src/runtime/host.ts",
  },
  // src/ never needs to spawn a process: CDP is a WebSocket, not a subprocess. `child_process` is
  // therefore forbidden wholesale (this also covers `node:child_process` and require() forms).
  {
    re: /\bchild_process\b/,
    hint: "no child_process in src/: never spawn, kill or restart Chrome — attach over CDP and ask the user",
  },
  // `"node:child" + "_process"` is the same import after concatenation.
  {
    re: /["'`](?:node:)?child["'`]\s*\+\s*["'`]_?process["'`]/,
    hint: "a split child_process import is still a process spawner",
  },
  { re: /\bpkill\b/, hint: "never kill the user's Chrome; ask the user" },
  { re: /\btaskkill\b/, hint: "never kill the user's Chrome; ask the user" },
  { re: /chrome[^\n]*--restart/i, hint: "never restart Chrome; attach to the running instance" },
];

/**
 * R13 — host confinement (PLAN v2 §2.1, PO1–PO4).
 *
 * The only allowed module is src/runtime/host.ts. Everything else is a leak:
 * importing `node:os`, reading `$HOME`/`PATH`/`LOCALAPPDATA`, naming an OS path,
 * spawning an executable, or checking a pid. Patterns run on comment-blanked
 * code, so the doctrine can be documented anywhere without tripping the rule.
 */
const HOST_MODULE = "src/runtime/host.ts";

const R13_PATTERNS = [
  {
    re: /["'`]node:os["'`]/,
    hint: "platform/home facts live in src/runtime/host.ts; import them from there",
  },
  {
    re: /\bprocess\s*\.\s*env\s*\.\s*(?:HOME|PATH|PATHEXT|LOCALAPPDATA|APPDATA|USERPROFILE|XDG_[A-Z0-9_]+)\b/,
    hint: "read host environment only through src/runtime/host.ts (home, PATH, capability)",
  },
  {
    re: /\bprocess\s*\.\s*env\s*\[\s*["'`](?:HOME|PATH|PATHEXT|LOCALAPPDATA|APPDATA|USERPROFILE|XDG_[A-Z0-9_]+)["'`]\s*\]/,
    hint: "a computed host env read is still a host read; use src/runtime/host.ts",
  },
  {
    re: /["'`][^"'`\n]*\/proc\/[^"'`\n]*["'`]/,
    hint: "no /proc parsing; liveness is process.kill(pid, 0) in src/runtime/host.ts (PO4)",
  },
  {
    re: /["'`][^"'`\n]*\/(?:usr\/)?(?:s?bin|etc)\/[^"'`\n]*["'`]/,
    hint: "no hardcoded system binary/config directories; resolve capabilities through src/runtime/host.ts",
  },
  {
    re: /["'`][^"'`\n]*\.config\/[^"'`\n]*["'`]/,
    hint: "profile paths are a host table (src/runtime/host.ts); no .config/ literals elsewhere (PO2)",
  },
  {
    re: /Library\/Application Support/,
    hint: "macOS profile paths live in the src/runtime/host.ts table",
  },
  {
    re: /\bstartsWith\s*\(\s*["'`]~[\\/]/,
    hint: "use expandHome() from src/runtime/host.ts instead of ~/ string surgery",
  },
  {
    re: /\bprocess\.kill\b/,
    hint: "process facts live in src/runtime/host.ts (isProcessAlive, signal 0 only)",
  },
  {
    re: /\bchild_process\b/,
    hint: "src/ never spawns; a capability is probed with access(X_OK), never executed (PO1)",
  },
  {
    re: /\b(?:execFileSync|execSync|spawnSync)\s*\(/,
    hint: "no synchronous process spawn outside a declared capability fallback (PO1)",
  },
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
  "R1 = src/ + tests/ (browsers: playwright, puppeteer, webdriverio, launchPersistentContext, any `.launch(`, computed/aliased launchers, headless, --enable-automation)",
  "R2–R5 = src/ only (production code that ships; R3 also forbids child_process)",
  "R6 = all files except node_modules/, .git/, research/",
  "R7 = tests/fixtures/** (excluding *.md docs)",
  "R8 = repo hygiene: every tracked path + .gitignore",
  "R9 = approximate (description/promptSnippet literals in src/tools/*.ts); authoritative gate is tests/unit/tool_budget.test.ts",
  "R10 = SPEC.md + PLAN.md + AGENTS.md (commands, config paths, tool exposure) cross-checked with package.json scripts",
  "R11 = PLAN.md §5 status table + the evidence files it cites (a missing file or a file with no command/verdict fails)",
  "R12 = package.json (metadata, install hooks, `files` allowlist); the real tarball listing is gate V7.1",
  "R13 = src/ except src/runtime/host.ts (node:os, $HOME/PATH/LOCALAPPDATA, /proc/, .config/, app-support/LOCALAPPDATA tables, process.kill, child_process)",
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
const AVATAR_URL_RE = /avatars\.mds\.yandex\.net\/get-yapic\/[^\s"'<>]*/gi;
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
// R10 — docs consistency (SPEC ↔ PLAN ↔ AGENTS)
//
// These are not code greps: the three documents are the contract surface, and a reader who follows
// them must not be told two different things. The assertions are deliberately narrow and checkable:
// the five gate commands, the two runtime paths, and the tool exposure. "Must not contradict" is
// implemented as (a) presence in every doc, (b) no non-canonical variant of a canonical path, and
// (c) no doc calling a non-web_search tool `direct`.
// ---------------------------------------------------------------------------

// README is user-facing: a doc that tells people `web_read` is direct, or names a script that does
// not exist, is the same defect as SPEC drifting. It must name the same gate commands.
const DOC_FILES = ["SPEC.md", "PLAN.md", "AGENTS.md", "README.md"];

/** Commands every document must name; PLAN §3 uses them as the gates. */
const DOC_COMMANDS = [
  { command: "npm run typecheck", why: "the type gate" },
  { command: "npm test", why: "the offline test gate" },
  { command: "npm run audit", why: "the hard-rules gate" },
  { command: "node src/cli/doctor.ts --json", why: "the canonical doctor output (PLAN V1.3)" },
  { command: "pi -e ./src/index.ts", why: "the extension load gate" },
];

const CANONICAL_CONFIG_PATH = "~/.pi/agent/web-search.json";
const CANONICAL_CONFIG_PATH_ENV = "$PI_CODING_AGENT_DIR/web-search.json";
const CANONICAL_ARTIFACTS_PATH = "~/.pi/agent/web-search/artifacts";
const CANONICAL_ARTIFACTS_PATH_ENV = "$PI_CODING_AGENT_DIR/web-search/artifacts";

const DIRECT_TOOL = "web_search";
const DEFERRED_TOOLS = ["web_read", "image_search", "web_research"];

/**
 * Strings a specific document must contain. A path that exists only in SPEC but is contradicted by
 * AGENTS is worse than a path missing from one file, so the presence list stays short and the
 * surrounding scan catches wrong variants everywhere.
 */
const DOC_REQUIRED_STRINGS = new Map([
  [
    "SPEC.md",
    [
      { text: CANONICAL_CONFIG_PATH, why: "SPEC §12 fixes the config path" },
      { text: CANONICAL_ARTIFACTS_PATH, why: "SPEC §9/§10 fixes the artifact directory" },
    ],
  ],
  ["AGENTS.md", [{ text: CANONICAL_ARTIFACTS_PATH, why: "AGENTS §7 must name the directory the code writes" }]],
  ["PLAN.md", []],
]);

/** A tool line that says "<deferred tool> is direct" — the contradiction SPEC §7.5 forbids. */
const DECLARES_DIRECT_RE = /^`?\s*(?:is|are)\s+`?direct\b|^`?\s*:\s*`?direct\b/i;

function readRepoText(root, store, rel) {
  // Read directly: `store.readText` records a skip entry for every missing path, and R10/R11 probe
  // paths that are legitimately absent (evidence for a phase that has not started). A missing file
  // here is a finding to report, not a skip in the report header.
  try {
    const abs = join(root, rel);
    const st = lstatSync(abs);
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) return store.readText(rel);
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function repoScripts(root, store) {
  const text = readRepoText(root, store, "package.json");
  if (text == null) return null;
  try {
    const pkg = JSON.parse(text);
    const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
    return new Map(Object.entries(scripts).map(([key, value]) => [key, String(value)]));
  } catch {
    return null;
  }
}

/** Start of the line containing `index`, so a finding can quote the left context of a path. */
function linePrefix(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(start, index);
}

const PI_PATH_PREFIX_RE = /(?:~\/\.pi\/agent\/|\$PI_CODING_AGENT_DIR\/)$/;

function checkDocs(root, store) {
  const findings = [];
  const notes = [];
  const seen = new Set();
  const add = (file, line, match, hint) => {
    const key = `${file}:${line}:${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, line, match, hint });
  };

  const docs = new Map();
  for (const rel of DOC_FILES) {
    const text = readRepoText(root, store, rel);
    if (text == null) {
      add(rel, 0, "documentation file missing", "SPEC.md, PLAN.md and AGENTS.md are the contract surface; restore the file");
      continue;
    }
    docs.set(rel, text);
  }

  // (a) the same five gate commands, verbatim, in every document.
  for (const [rel, text] of docs) {
    for (const { command, why } of DOC_COMMANDS) {
      if (text.includes(command)) continue;
      add(rel, 1, `missing documented command \`${command}\``,
        `${why}: SPEC, PLAN and AGENTS must document the same command surface`);
    }
  }

  // (b) a doc may only name scripts that exist; `npm run typechek` is a broken instruction.
  const scripts = repoScripts(root, store);
  if (!scripts) {
    notes.push("package.json scripts unreadable — doc script references were not cross-checked");
  } else {
    for (const [rel, text] of docs) {
      const re = /\bnpm (?:run ([A-Za-z0-9:_.-]+)|(test|start|stop|restart))\b/g;
      let match;
      while ((match = re.exec(text)) !== null) {
        const name = match[1] ?? match[2];
        if (scripts.has(name)) continue;
        add(rel, lineOf(text, match.index),
          `npm ${match[1] ? "run " : ""}${name} is not a package.json script`,
          "docs must only name scripts that exist; fix the doc or add the script");
      }
    }
  }

  // (c) one canonical config path and one canonical artifact dir, everywhere.
  for (const [rel, text] of docs) {
    for (const match of text.matchAll(/([^\s`"'|,()[\]{}]*)web[-_]?search\.json/g)) {
      const prefix = linePrefix(text, match.index).trimEnd();
      const canonicalName = match[0].endsWith("/web-search.json") || match[0] === "web-search.json";
      const canonicalPrefix = PI_PATH_PREFIX_RE.test(match[1]) || PI_PATH_PREFIX_RE.test(prefix);
      // A bare `web-search.json` with no directory context ("the config file web-search.json") names
      // the same file; only a spelled-out path is held to the canonical directory.
      const bareName = match[1] === "" && !/[/\\]/.test(prefix);
      if (canonicalName && (canonicalPrefix || bareName)) continue;
      add(rel, lineOf(text, match.index), `non-canonical config path \`${clip(match[0], 70)}\``,
        `use ${CANONICAL_CONFIG_PATH} (or ${CANONICAL_CONFIG_PATH_ENV}); SPEC §12 is the source of truth`);
    }

    for (const match of text.matchAll(/artifacts\b/g)) {
      const prefix = linePrefix(text, match.index).trimEnd();
      // Only judge paths that claim to live under the pi config dir; "artifacts/" as prose or
      // bench/results/ is a different thing and not this assertion's business.
      if (!/(?:~\/\.pi|\$PI_CODING_AGENT_DIR)/.test(prefix)) continue;
      if (/(?:web-search\/)$/.test(prefix)) continue;
      add(rel, lineOf(text, match.index), "non-canonical artifacts path",
        `use ${CANONICAL_ARTIFACTS_PATH}/ (or ${CANONICAL_ARTIFACTS_PATH_ENV}/)`);
    }
  }

  // (d) documented strings that must exist somewhere in a specific doc.
  for (const [rel, text] of docs) {
    for (const required of DOC_REQUIRED_STRINGS.get(rel) ?? []) {
      if (text.includes(required.text)) continue;
      add(rel, 1, `missing \`${required.text}\``, required.why);
    }
  }

  // (e) tool exposure: web_search direct, the rest deferred — in every doc, and never inverted.
  for (const [rel, text] of docs) {
    const lines = text.split(/\r?\n/);
    let directLine = 0;
    let deferredLine = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!directLine && line.includes(DIRECT_TOOL) && /\bdirect\b/.test(line)) directLine = i + 1;
      if (!deferredLine && /\bdeferred\b/.test(line)) {
        const named = DEFERRED_TOOLS.some((tool) => line.includes(tool));
        const generic = /everything else|others?\b/i.test(line);
        if (named || generic) deferredLine = i + 1;
      }
      for (const tool of [...DEFERRED_TOOLS, "web_doctor"]) {
        const at = line.indexOf(tool);
        if (at < 0) continue;
        const tail = line.slice(at + tool.length, at + tool.length + 40);
        if (!DECLARES_DIRECT_RE.test(tail)) continue;
        add(rel, i + 1, `\`${tool}\` is documented as direct`,
          `only \`${DIRECT_TOOL}\` is direct; the rest stay deferred (SPEC §7.5, AGENTS §2.10)`);
      }
    }
    if (!directLine) {
      add(rel, 1, `\`${DIRECT_TOOL}\` is not documented as the direct tool`,
        "SPEC §7.5, PLAN V4.5 and AGENTS §2.10 must agree: web_search is the only direct tool");
    }
    if (!deferredLine) {
      add(rel, 1, "no line documents the deferred tools",
        "web_read / image_search / web_research (and web_doctor) are deferred; say so where the tool surface is described");
    }
  }

  notes.push(
    `checked: ${DOC_COMMANDS.length} gate command(s), npm script references against package.json, ` +
      `canonical paths (${CANONICAL_CONFIG_PATH}, ${CANONICAL_ARTIFACTS_PATH}/), tool exposure ` +
      `(${DIRECT_TOOL} direct; ${DEFERRED_TOOLS.join(", ")} deferred)`,
  );
  notes.push("exercised by `node scripts/audit.mjs --self-test` (good and broken doc fixtures)");

  return { findings, files: docs.size, notes };
}

// ---------------------------------------------------------------------------
// R11 — evidence completeness
//
// PLAN §5 is the claim table and evidence/ is the proof. A started phase (`[~]`, `[x]`, `[!]`, `[-]`)
// must have its file, and the file must record at least one runnable command and one verdict. A
// not-started `[ ]` phase is exempt (there is nothing to prove yet); when it turns green this rule
// starts demanding its file, which is exactly the V7.6 gate.
//
// "Command" accepts the two forms the repo actually uses: a fenced block with command lines (P1,
// P4, P5) and a markdown table cell with an inline `command` span (P0, P2, P3). Requiring fences
// only would have failed three committed evidence files that do record their commands.
// ---------------------------------------------------------------------------

const EVIDENCE_COMMAND_RE =
  /^(?:\$ )?(?:[A-Za-z_][A-Za-z0-9_]*=\S+ )*(?:npm|npx|node|pi|git|curl|jq|tsc|bash|sh|python3?)\b/;

function evidenceSignals(text) {
  let commands = 0;
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence && EVIDENCE_COMMAND_RE.test(line)) commands += 1;
  }
  if (commands === 0) {
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      if (EVIDENCE_COMMAND_RE.test(match[1].trim())) commands += 1;
    }
  }
  // A verdict token, or an explicit outcome record. Uppercase only: prose "pass"/"failed" is not a
  // gate verdict, and a table *header* (`| # | Command | Exit | … |`) must not satisfy this either —
  // the value has to be in the cell after the label or after the colon.
  const verdict =
    /\b(?:PASS|FAIL|BLOCKED|WAIVED)\b/.test(text) ||
    /^\s*\|?\s*(?:Verdict|Status|Exit)\s*(?:\||:)\s*\S/im.test(text);
  return { commands, verdict };
}

function checkEvidence(root, store) {
  const findings = [];
  const notes = [];
  const seen = new Set();
  const add = (file, line, match, hint) => {
    const key = `${file}:${line}:${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, line, match, hint });
  };

  const plan = readRepoText(root, store, "PLAN.md");
  if (plan == null) {
    add("PLAN.md", 0, "PLAN.md missing", "R11 reads the §5 status table; without PLAN there is no claim set");
    return { findings, files: 0, notes: ["PLAN.md missing — no evidence to check"] };
  }

  const rows = [];
  // Only PLAN §5 is the claim table: the lane tables elsewhere (`| P4-D | … |`) also start with a
  // phase id, and their third column is a file list, not a status.
  let inStatusSection = false;
  plan.split(/\r?\n/).forEach((line, index) => {
    if (/^## 5\.\s/.test(line)) {
      inStatusSection = true;
      return;
    }
    if (inStatusSection && /^## (?!#)/.test(line)) {
      inStatusSection = false;
      return;
    }
    if (!inStatusSection || !/^\|\s*P\d\b/.test(line)) return;
    const cells = line.split("|").map((cell) => cell.trim());
    const phase = cells[1] ?? "";
    const statusCell = cells[2] ?? "";
    const evidenceCell = cells[3] ?? "";
    const statusMatch = /\[([ x~!-])\]/.exec(statusCell);
    if (!statusMatch) return;
    rows.push({
      line: index + 1,
      phase: phase.split(/\s+/)[0] ?? phase,
      status: statusMatch[1],
      paths: [...evidenceCell.matchAll(/`(evidence\/[^`]+\.md)`/g)].map((match) => match[1]),
    });
  });

  if (rows.length === 0) {
    add("PLAN.md", 0, "no §5 phase rows found",
      "keep the `| P<N> … | `[x]` | `evidence/P<N>.md` |` status table; R11 parses it");
    return { findings, files: 0, notes: ["no phase rows parsed — the table format changed"] };
  }

  let checked = 0;
  let exempt = 0;
  for (const row of rows) {
    const started = row.status !== " ";
    if (started && row.paths.length === 0) {
      add("PLAN.md", row.line, `${row.phase} is \`[${row.status}]\` but cites no evidence file`,
        "add the `evidence/P<N>.md` path to the gate-evidence column, or mark the phase not started");
    }
    for (const rel of row.paths) {
      const text = readRepoText(root, store, rel);
      if (text == null) {
        if (!started) {
          exempt += 1;
          continue;
        }
        add("PLAN.md", row.line, `${row.phase} is \`[${row.status}]\` but ${rel} is missing`,
          "record the gate commands in that file, or mark the phase not started (`[ ]`)");
        continue;
      }
      checked += 1;
      const signals = evidenceSignals(text);
      if (signals.commands === 0) {
        add(rel, 1, "no recorded command",
          "evidence is command → exit → result: paste a gate command (fenced block or an inline `npm run …` span)");
      }
      if (!signals.verdict) {
        add(rel, 1, "no PASS/FAIL/BLOCKED verdict",
          "state the outcome (PASS / FAIL / BLOCKED / WAIVED, or a `| Verdict | … |` / `| Exit | … |` row)");
      }
    }
  }

  notes.push(
    `${rows.length} phase row(s) parsed; ${checked} evidence file(s) checked; ` +
      `${exempt} not-started reference(s) exempt (\`[ ]\` claims nothing yet)`,
  );
  notes.push("a started phase with no evidence file, or a file with no command/verdict, is a violation; the hash is not checked");
  notes.push("exercised by `node scripts/audit.mjs --self-test` (complete/incomplete evidence fixtures)");

  return { findings, files: checked, notes };
}

// ---------------------------------------------------------------------------
// R12 — packaging sanity
//
// Static by design: the audit does not spawn `npm pack --dry-run` (it is not free — it walks the
// tree, runs lifecycle scripts and can reach for the registry), so the model is the declared
// `files` allowlist. Gate V7.1 runs the real `npm pack --dry-run --json` and is the authoritative
// check for the tarball listing; this rule makes the allowlist itself trustworthy before that.
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACK_FORBIDDEN_PREFIXES = [
  "tests", "bench", "research", "evidence", "node_modules", "artifacts", "coverage", "dist", ".git",
];

function packageKeyLine(text, key) {
  const index = text.indexOf(`"${key}"`);
  return index < 0 ? 0 : lineOf(text, index);
}

/** Line of `"value"` inside the array that follows `"key"`, so a finding points at the entry. */
function packageValueLine(text, key, value) {
  const keyIndex = text.indexOf(`"${key}"`);
  const index = keyIndex < 0 ? -1 : text.indexOf(`"${value}"`, keyIndex);
  return index < 0 ? packageKeyLine(text, key) : lineOf(text, index);
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `files` entry vs. a packed path: a directory covers its subtree, `*` matches inside one segment. */
function filesEntryCovers(entry, target) {
  const normalised = entry.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalised) return false;
  if (target === normalised || target.startsWith(`${normalised}/`)) return true;
  if (!normalised.includes("*")) return false;
  const pattern = normalised.split("*").map(escapeForRegExp).join("[^/]*");
  return new RegExp(`^${pattern}(?:/|$)`).test(target);
}

function checkPackaging(root, store, files) {
  const findings = [];
  const notes = [];
  const seen = new Set();
  const rel = "package.json";
  const add = (line, match, hint) => {
    const key = `${rel}:${line}:${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: rel, line, match, hint });
  };

  const text = readRepoText(root, store, rel);
  if (text == null) {
    add(0, "package.json missing", "the package manifest is the install surface; restore it");
    return { findings, files: 0, notes: ["package.json missing"] };
  }

  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    add(0, `invalid JSON (${error.message})`, "npm cannot publish a manifest that does not parse");
    return { findings, files: 1, notes: ["package.json does not parse — nothing else could be checked"] };
  }

  if (typeof pkg.name !== "string" || pkg.name.trim() === "") {
    add(packageKeyLine(text, "name"), "missing `name`", "the registry identity; set it before publishing");
  } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) {
    add(packageKeyLine(text, "name"), `non-npm-safe name ${JSON.stringify(pkg.name)}`,
      "lowercase npm-safe characters only; the name is the install identity");
  }

  if (typeof pkg.version !== "string" || !SEMVER_RE.test(pkg.version)) {
    add(packageKeyLine(text, "version"), `\`version\` is not semver${typeof pkg.version === "string" ? ` (${JSON.stringify(pkg.version)})` : ""}`,
      "use MAJOR.MINOR.PATCH (npm rejects anything else)");
  }

  if (typeof pkg.license !== "string" || pkg.license.trim() === "") {
    add(packageKeyLine(text, "license"), "missing `license`",
      "state the license (MIT + LICENSE file in this repo); npm warns and redistributors need it");
  }

  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  for (const hook of ["preinstall", "postinstall"]) {
    if (typeof scripts[hook] !== "string") continue;
    add(packageKeyLine(text, hook), `\`${hook}\` script runs on user install`,
      "the extension must not execute repo code at install time; remove the lifecycle hook");
  }

  const declared = pkg.files;
  if (declared === undefined) {
    const wouldShip = files.filter((file) =>
      PACK_FORBIDDEN_PREFIXES.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
    );
    const roots = [...new Set(wouldShip.map((file) => file.split("/")[0] ?? file))].sort();
    notes.push(
      `no \`files\` allowlist: npm would ship ${wouldShip.length} non-shipped path(s)` +
        (roots.length > 0 ? ` (${roots.join(", ")})` : "") +
        "; add `files` before publishing — gate V7.1 runs the real `npm pack --dry-run`",
    );
    notes.push(
      "a missing allowlist is a note, not a violation: a pre-packaging manifest is an unfinished " +
        "publish surface (V7.1 fails the tarball), not a hard-rule break; once `files` exists every entry is strict",
    );
  } else if (!Array.isArray(declared) || declared.length === 0) {
    add(packageKeyLine(text, "files"), "`files` must be a non-empty array",
      "list the shipped paths (e.g. [\"src/\", \"README.md\", \"LICENSE\"]); npm ships everything otherwise");
  } else {
    for (const entry of declared) {
      if (typeof entry !== "string" || entry.trim() === "") {
        add(packageKeyLine(text, "files"), "empty or non-string `files` entry",
          "every entry must be a relative path string");
        continue;
      }
      const normalised = entry.trim().replace(/^\.\//, "").replace(/\/+$/, "");
      const line = packageValueLine(text, "files", entry);
      if (normalised.startsWith("/") || normalised.split("/").includes("..")) {
        add(line, `\`files\` entry \`${entry}\` escapes the package root`,
          "only relative paths inside the package are allowed");
        continue;
      }
      const rootSegment = normalised.split("/")[0] ?? "";
      if (normalised === "*" || normalised === "**" || normalised === ".") {
        add(line, `\`files\` entry \`${entry}\` ships the whole tree`,
          "an allowlist entry of `*`/`.` is the same as no allowlist; list the shipped paths");
        continue;
      }
      const forbidden =
        PACK_FORBIDDEN_PREFIXES.includes(rootSegment) ||
        /^\.env(?:\.|$)/.test(normalised) ||
        /fixture/i.test(normalised) ||
        /\.(?:html|htm)\.gz$/i.test(normalised);
      if (!forbidden) continue;
      add(line, `\`files\` entry \`${entry}\` is not a shipped path`,
        "tests/, bench/, research/, evidence/, node_modules/, artifacts/, .env* and fixtures never ship");
    }

    const extensions = pkg.pi && Array.isArray(pkg.pi.extensions) ? pkg.pi.extensions : [];
    for (const extension of extensions) {
      if (typeof extension !== "string") continue;
      const target = extension.replace(/^\.\//, "");
      if (declared.some((entry) => typeof entry === "string" && filesEntryCovers(entry, target))) continue;
      add(packageValueLine(text, "extensions", extension), `\`pi.extensions\` entry \`${extension}\` is not covered by \`files\``,
        "the packed tarball would load an entry point it does not contain");
    }

    // What the allowlist would actually carry: every tracked path it covers is packed. Fixtures,
    // artifact snapshots and gzipped fixtures must never be reachable from a `files` entry, even via
    // a broad directory that also holds shipped code.
    const smuggled = files.filter(
      (file) =>
        (/(?:^|\/)fixtures?\//.test(file) || /\.(?:html|htm)\.gz$/i.test(file) || /(?:^|\/)artifacts\//.test(file)) &&
        declared.some((entry) => typeof entry === "string" && filesEntryCovers(entry, file)),
    );
    for (const file of smuggled) {
      add(packageKeyLine(text, "files"), `\`files\` allowlist ships \`${file}\``,
        "a directory entry can pull fixtures/artifacts into the tarball; narrow it or add an ignore");
    }
  }

  notes.push(
    "static check: `npm pack` is not spawned (it runs lifecycle scripts and walks the whole tree); " +
      "the model is the `files` allowlist, and V7.1's `npm pack --dry-run --json` is authoritative",
  );
  notes.push(
    `enforced: name, semver version, license, no preinstall/postinstall, files entries limited to shipped paths, ` +
      `pi.extensions coverage; never shippable: ${PACK_FORBIDDEN_PREFIXES.join(", ")}, .env*, *fixture*, *.html.gz`,
  );
  notes.push("exercised by `node scripts/audit.mjs --self-test` (sane/broken/wildcard/fixture-smuggling manifests)");

  return { findings, files: 1, notes };
}

/**
 * R13 — host confinement. A custom check rather than `addCodeCheck` because the
 * allowlist is per file: src/runtime/host.ts is the one module allowed to own
 * these facts. R3 also runs on src/ and permits exactly `kill(pid, 0)` there.
 */
function hostConfinementCheck(store, files) {
  const scoped = filesUnder(files, ["src/"]).filter(hasCodeExtension).filter((rel) => rel !== HOST_MODULE);
  const scan = scanPatterns(store, scoped, R13_PATTERNS, { stripComments: true });
  return {
    id: "R13",
    title: "host access is confined to the host layer",
    scope: "src/ except src/runtime/host.ts",
    files: readableCount(store, scoped),
    findings: scan.findings,
    total: scan.total,
    truncated: scan.truncated,
    capped: scan.capped,
    notes: [
      "allowed module: src/runtime/host.ts (platform, paths, profile tables, capability(), isProcessAlive)",
      "forbidden elsewhere: node:os, $HOME/PATH/PATHEXT/LOCALAPPDATA, /proc/, /usr/bin|/bin|/etc, .config/, ~/ string surgery, process.kill, child_process",
      "PO1: a capability is probed with access(X_OK) and never spawned; a missing one is null plus a hint",
    ],
  };
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
      "patterns: playwright, puppeteer, webdriverio, launchPersistentContext, any .launch(, computed [\"launch\"] keys, bare launch*() after destructuring, headless: true, --enable-automation/--headless (also split across a concatenation)",
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
    ["reading navigator.webdriver is allowed; assignments, defineProperty/Reflect patches, delete and init scripts are flagged"],
  );

  // R3 — never kill/restart the user's Chrome.
  addCodeCheck(
    "R3",
    "never kill/restart the user's Chrome",
    "src/",
    ["src/"],
    R3_PATTERNS,
    [
      "patterns: process.kill with a real signal, child_process (any spawn/kill form), pkill, taskkill, chrome…--restart",
      "allowed: signal-free `process.kill(pid, 0)` (the liveness probe); R13 confines it to src/runtime/host.ts",
    ],
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

        for (const _m of line.matchAll(new RegExp(AVATAR_URL_RE.source, "gi"))) {
          push(rel, lineNo, "profile avatar asset (redacted)",
            "strip the avatar asset path: it encodes the account identity");
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

  // R10 — docs consistency.
  {
    const result = checkDocs(root, store);
    checks.push({
      id: "R10",
      title: "docs consistency (SPEC ↔ PLAN ↔ AGENTS ↔ README)",
      scope: "SPEC.md, PLAN.md, AGENTS.md (+ package.json scripts)",
      files: result.files,
      findings: result.findings,
      total: result.findings.length,
      truncated: false,
      capped: false,
      notes: result.notes,
    });
  }

  // R11 — evidence completeness.
  {
    const result = checkEvidence(root, store);
    checks.push({
      id: "R11",
      title: "evidence completeness (PLAN §5 status ↔ evidence/)",
      scope: "PLAN.md §5 + the evidence files it references",
      files: result.files,
      findings: result.findings,
      total: result.findings.length,
      truncated: false,
      capped: false,
      notes: result.notes,
    });
  }

  // R12 — packaging sanity.
  {
    const result = checkPackaging(root, store, files);
    checks.push({
      id: "R12",
      title: "packaging sanity (manifest + files allowlist)",
      scope: "package.json",
      files: result.files,
      findings: result.findings,
      total: result.findings.length,
      truncated: false,
      capped: false,
      notes: result.notes,
    });
  }

  // R13 — host confinement.
  checks.push(hostConfinementCheck(store, files));

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
// --self-test
//
// The repo has no test runner for this script, and a rule that only ever says "ok" proves nothing.
// `--self-test` builds throwaway mini-repos under /tmp/opencode, runs the real audit over them and
// asserts each new/strengthened rule both fires on the bad fixture and stays quiet on the good one.
// It is intentionally not part of `npm run audit`: it writes to disk and would be noise on every
// wave. The orchestrator runs it once at the P7 gate (V7.4) and records the output.
// ---------------------------------------------------------------------------

/** The five documented commands, so the doc fixtures cannot drift from the assertions in R10. */
function docsFixture(overrides = {}) {
  const commands = DOC_COMMANDS.map(({ command }) => `\`${command}\``).join(", ");
  const files = {
    "SPEC.md": [
      "# SPEC",
      "",
      `Gate commands: ${commands}.`,
      `Config: \`${CANONICAL_CONFIG_PATH}\` (or \`${CANONICAL_CONFIG_PATH_ENV}\`).`,
      `Artifacts: \`${CANONICAL_ARTIFACTS_PATH}/<ts>-google-abc/\`.`,
      "",
      "- `web_search`: `direct`.",
      "- `web_read`, `image_search`, `web_research`: `deferred`.",
      "",
    ].join("\n"),
    "PLAN.md": [
      "# PLAN",
      "",
      `Every wave: ${commands}, plus \`npm run bench\`.`,
      "",
      "- `web_search` is direct; others deferred.",
      "",
    ].join("\n"),
    "AGENTS.md": [
      "# AGENTS",
      "",
      `Commands: ${commands}.`,
      "",
      "`web_search` is the only `direct` tool. Everything else is `deferred`.",
      "",
      `Artifacts: \`${CANONICAL_ARTIFACTS_PATH}/<ts>-<engine>-<hash>/\`.`,
      "",
    ].join("\n"),
    "README.md": [
      "# README",
      "",
      `Commands: ${commands}.`,
      "",
      "`web_search` is `direct`; `web_read`, `image_search`, `web_research` are `deferred`.",
      "",
      `Config: \`${CANONICAL_CONFIG_PATH}\`.`,
      "",
    ].join("\n"),
    "package.json": JSON.stringify({
      name: "audit-doc-fixture",
      version: "0.1.0",
      license: "MIT",
      scripts: { typecheck: "tsc --noEmit", test: "node --test", audit: "node scripts/audit.mjs", bench: "node bench/run.ts" },
      files: ["src/"],
    }, null, 2),
    "src/index.ts": "export const ok = true;\n",
  };
  return { ...files, ...overrides };
}

const SELF_TEST_CASES = [
  {
    name: "launch spellings",
    files: {
      "src/looks-fine.ts": [
        "/* docs: we never call chromium.launch(), never use playwright, never process.kill() */",
        "export const headlessFlag = `--headless=new`;",
        "export const splitFlag = \"--head\" + \"less\";",
        "const chromium = { launch: () => 1 };",
        "chromium.launch();",
        "const alias = chromium;",
        "alias[`launch`]();",
        "const { launch } = chromium;",
        "launch();",
        "import { execFileSync } from \"node:child_process\";",
        "",
      ].join("\n"),
    },
    expect: [
      { check: "R1", min: 3, label: "template/computed/aliased launch + split flag" },
      { check: "R3", min: 1, label: "child_process in src/" },
      { check: "R1", max: 5, label: "one finding per shape, not per pattern" },
    ],
    guards: [
      {
        label: "overlapping patterns dedupe to one finding per line",
        run: (report) => {
          const findings = report.checks.find((check) => check.id === "R1").findings;
          return new Set(findings.map((finding) => `${finding.file}:${finding.line}`)).size === findings.length;
        },
      },
    ],
  },
  {
    name: "fingerprint patches",
    files: {
      "src/fp.ts": [
        "Object.defineProperty(navigator, \"webdriver\", { get: () => false });",
        "delete navigator.webdriver;",
        "Reflect.set(navigator, \"webdriver\", false);",
        "await page.evaluate(`navigator.webdriver = false`);",
        "page.send(`Page.addScriptToEvaluateOnNewDocument`, {});",
        "const split = \"addScriptToEvaluate\" + \"OnNewDocument\";",
        "Emulation[\"setDeviceMetricsOverride\"]({});",
        "",
      ].join("\n"),
    },
    expect: [
      { check: "R2", min: 5, label: "defineProperty/delete/Reflect/template assignment/init-script/Emulation" },
    ],
  },
  {
    name: "comments do not fire",
    files: {
      "src/clean.ts": [
        "/* we never call chromium.launch(), never use playwright, never process.kill() */",
        "// also never addScriptToEvaluateOnNewDocument and never assign navigator.webdriver",
        "export async function probe(page) {",
        "  const webdriver = await page.evaluate(\"navigator.webdriver\");",
        "  return webdriver === false;",
        "}",
        "",
      ].join("\n"),
    },
    expect: [
      { check: "R1", max: 0, label: "comment-only mention of a launcher" },
      { check: "R2", max: 0, label: "reading navigator.webdriver" },
      { check: "R3", max: 0, label: "comment-only mention of process.kill" },
      { check: "R13", max: 0, label: "no host access in clean src" },
    ],
  },
  {
    name: "bypass spellings",
    files: {
      "src/bypass.ts": [
        "export function go(c: Record<string, () => void>, launcherKey: string): void {",
        "  c[launcherKey]();",
        '  const flag = "--hea" + "dless";',
        '  Object["defineProperty"](globalThis.navigator, "webdriver", { value: false });',
        '  void import("node:child" + "_process");',
        "  void flag;",
        "}",
        "",
      ].join("\n"),
    },
    expect: [
      { check: "R1", min: 2, label: "variable launcher key + split flag" },
      { check: "R2", min: 1, label: "computed defineProperty on globalThis.navigator" },
      { check: "R3", min: 1, label: "split child_process import" },
    ],
  },
  {
    name: "host access leaks",
    files: {
      "src/cdp/leak.ts": [
        'import { homedir } from "node:os";',
        'import { spawnSync } from "node:child_process";',
        'export const signal = () => process.kill(1, "SIGKILL");',
        "export const home = process.env.HOME;",
        'export const proc = "/proc/1/status";',
        'export const bin = "/usr/bin/chromium";',
        'export const cfg = ".config/google-chrome";',
        'export const tilde = (p: string) => p.startsWith("~/");',
        "export const pid = () => process.kill(8000, 0);",
        'export const mac = "Library/Application Support/Google/Chrome";',
        "",
      ].join("\n"),
      // The allowlist file itself may own these facts; it must never be reported.
      "src/runtime/host.ts": [
        'import { homedir } from "node:os";',
        'export const home = process.env.HOME;',
        'export const proc = "/proc/1/status";',
        "export const live = (pid: number) => process.kill(pid, 0);",
        "",
      ].join("\n"),
    },
    expect: [
      { check: "R13", min: 8, label: "node:os, $HOME, /proc/, /usr/bin/, .config/, ~/ surgery, kill, child_process, app support" },
      { check: "R3", min: 1, label: "a real signal outside the host layer" },
    ],
    guards: [
      {
        label: "src/runtime/host.ts is the allowlist even when it owns the same tokens",
        run: (report) =>
          !report.checks
            .find((check) => check.id === "R13")
            .findings.some((finding) => finding.file === "src/runtime/host.ts"),
      },
      {
        label: "signal-free kill(pid, 0) in host.ts is not an R3 finding",
        run: (report) => !report.checks.find((check) => check.id === "R3").findings.some((f) => f.file === "src/runtime/host.ts"),
      },
      {
        label: "a real SIGKILL outside host.ts is an R3 finding",
        run: (report) =>
          report.checks
            .find((check) => check.id === "R3")
            .findings.some((finding) => finding.file === "src/cdp/leak.ts" && /process\.kill/.test(finding.match)),
      },
    ],
  },
  {
    name: "docs agree",
    files: docsFixture(),
    expect: [{ check: "R10", max: 0, label: "consistent SPEC/PLAN/AGENTS" }],
  },
  {
    name: "docs disagree",
    files: docsFixture({
      "AGENTS.md": [
        "# AGENTS",
        "",
        "`web_read` is `direct`.",
        "Run `npm run typechek` before committing.",
        "Config lives at `~/.config/pi/web_search.json`.",
        "`web_search` is the only `direct` tool. Everything else is `deferred`.",
        `Artifacts: \`${CANONICAL_ARTIFACTS_PATH}/x/\`.`,
        `Gate commands: ${DOC_COMMANDS.map(({ command }) => `\`${command}\``).join(", ")}.`,
        "",
      ].join("\n"),
    }),
    expect: [{ check: "R10", min: 3, label: "wrong tool exposure, bogus script, wrong config path" }],
  },
  {
    name: "evidence complete",
    files: {
      "PLAN.md": [
        "# PLAN",
        "",
        "## 5. Status tracking",
        "",
        "| Phase | Status | Gate evidence | Blocker / note |",
        "|---|---|---|---|",
        "| P0 contracts | `[x]` | `evidence/P0.md` | ok |",
        "| P1 attach | `[ ]` | `evidence/P1.md` | not started |",
        "",
        "## 6. Next",
        "",
        "| P9 lane | `[x]` | `evidence/P9.md` | not a status row |",
        "",
      ].join("\n"),
      "evidence/P0.md": [
        "# P0",
        "",
        "| # | Command | Exit | Verdict |",
        "|---|---|---|---|",
        "| V0.1 | `npm run typecheck` | 0 | PASS |",
        "",
      ].join("\n"),
    },
    expect: [{ check: "R11", max: 0, label: "started phase with a command and a verdict" }],
    guards: [
      {
        label: "a `[x]` row outside §5 is not a claim",
        run: (report) => !report.checks.find((check) => check.id === "R11").findings.some((f) => f.match.includes("P9")),
      },
    ],
  },
  {
    name: "evidence incomplete",
    files: {
      "PLAN.md": [
        "# PLAN",
        "",
        "## 5. Status tracking",
        "",
        "| Phase | Status | Gate evidence | Blocker / note |",
        "|---|---|---|---|",
        "| P0 contracts | `[x]` | `evidence/P0.md` | claims done |",
        "| P1 attach | `[x]` | `evidence/P1.md` | claims done, file missing |",
        "| P2 plumbing | `[ ]` | `evidence/P2.md` | not started, file missing is fine |",
        "| P3 engines | `[x]` | `evidence/P3.md` | header-only table proves nothing |",
        "",
      ].join("\n"),
      "evidence/P0.md": "# P0\n\nAll gates look good.\n",
      "evidence/P3.md": [
        "# P3",
        "",
        "| # | Command | Exit | Result | Verdict |",
        "|---|---|---|---|---|",
        "",
      ].join("\n"),
    },
    expect: [{ check: "R11", min: 5, label: "no command, no verdict, missing file, header-only table" }],
    guards: [
      {
        label: "not-started phase is exempt",
        run: (report) => !report.checks.find((check) => check.id === "R11").findings.some((f) => f.match.includes("P2.md") || f.file.includes("P2.md")),
      },
      {
        label: "missing started file is named",
        run: (report) => report.checks.find((check) => check.id === "R11").findings.some((f) => f.match.includes("evidence/P1.md")),
      },
    ],
  },
  {
    name: "packaging sane",
    files: {
      "package.json": JSON.stringify({
        name: "audit-pack-fixture",
        version: "0.1.0",
        license: "MIT",
        files: ["src/", "README.md", "LICENSE"],
        pi: { extensions: ["./src/index.ts"] },
      }, null, 2),
      "src/index.ts": "export const ok = true;\n",
    },
    expect: [{ check: "R12", max: 0, label: "metadata + allowlist that covers pi.extensions" }],
  },
  {
    name: "packaging broken",
    files: {
      "package.json": JSON.stringify({
        name: "Audit Pack Fixture",
        version: "1.0",
        scripts: { postinstall: "node scripts/x.mjs" },
        files: ["src/", "tests/", "evidence/P0.md", "tests/fixtures/page.html.gz"],
        pi: { extensions: ["./bench/harness.ts"] },
      }, null, 2),
    },
    expect: [{ check: "R12", min: 6, label: "name/version/license/postinstall/files/entry coverage" }],
  },
  {
    name: "packaging wildcard",
    files: {
      "package.json": JSON.stringify({
        name: "audit-pack-wildcard",
        version: "0.1.0",
        license: "MIT",
        files: ["*"],
      }, null, 2),
    },
    expect: [{ check: "R12", min: 1, label: "a `*` allowlist is no allowlist" }],
  },
  {
    name: "packaging smuggles a fixture",
    files: {
      "package.json": JSON.stringify({
        name: "audit-pack-smuggle",
        version: "0.1.0",
        license: "MIT",
        files: ["src/", "tests/fixtures/"],
        pi: { extensions: ["./src/index.ts"] },
      }, null, 2),
      "src/index.ts": "export const ok = true;\n",
      "tests/fixtures/page.html.gz": "not really gzip\n",
    },
    expect: [
      { check: "R12", min: 1, label: "fixtures reachable through the allowlist" },
      { check: "R12", min: 2, label: "fixture entry itself is rejected too" },
    ],
  },
];

function runSelfTest() {
  const base = join(
    process.env.PI_AUDIT_SELFTEST_DIR || "/tmp/opencode",
    `pi-audit-selftest-${process.pid}`,
  );
  const lines = ["pi-chrome-search audit — self-test (rules provably live)"];
  let assertions = 0;
  let failed = 0;

  try {
    rmSync(base, { recursive: true, force: true });
    for (const testCase of SELF_TEST_CASES) {
      const dir = join(base, testCase.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
      for (const [rel, content] of Object.entries(testCase.files)) {
        const abs = join(dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
      }

      let report;
      try {
        report = runAudit(dir);
      } catch (error) {
        failed += 1;
        lines.push(`FAIL  ${testCase.name}: audit threw ${error?.message ?? String(error)}`);
        continue;
      }

      for (const expectation of testCase.expect) {
        assertions += 1;
        const check = report.checks.find((entry) => entry.id === expectation.check);
        const count = check ? check.total : -1;
        const min = expectation.min ?? 0;
        const max = expectation.max ?? Number.POSITIVE_INFINITY;
        const ok = check !== undefined && count >= min && count <= max;
        if (!ok) failed += 1;
        lines.push(
          `${ok ? "ok  " : "FAIL"}  ${testCase.name} — ${expectation.check}: ${count} finding(s) ` +
            `for ${expectation.label} (want ${min}..${max === Number.POSITIVE_INFINITY ? "n" : max})`,
        );
      }

      for (const guard of testCase.guards ?? []) {
        assertions += 1;
        let ok = false;
        try {
          ok = guard.run(report);
        } catch {
          ok = false;
        }
        if (!ok) failed += 1;
        lines.push(`${ok ? "ok  " : "FAIL"}  ${testCase.name} — guard: ${guard.label}`);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  lines.push(
    `self-test: ${SELF_TEST_CASES.length} case(s), ${assertions} assertion(s), ${failed} failed ` +
      `(fixtures written under ${base}; removed afterwards)`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return { ok: failed === 0, failed, assertions };
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
  out.push(
    "note: R12 is static (`npm pack` is not spawned) — gate V7.1 runs the real pack listing; " +
      "`node scripts/audit.mjs --self-test` proves the launch, docs, evidence, packaging and host rules fire",
  );

  process.stdout.write(`${out.join("\n")}\n`);
}

if (selfTest) {
  const result = runSelfTest();
  process.exit(result.ok ? 0 : 1);
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
