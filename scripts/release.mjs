#!/usr/bin/env node
/**
 * Version bump driver for the release workflow (and for a local dry run).
 *
 * The classification is the contract, so it is a pure function with a table
 * test (`tests/unit/release.test.ts`), not a shell one-liner:
 *
 *   `!` / `BREAKING CHANGE:`      → major
 *   feat                          → minor
 *   fix / perf / refactor         → patch
 *   docs / test / chore / style / build / ci only → no release
 *   `[skip release]` anywhere     → no release (wins over everything)
 *
 * Anything that is not a conventional commit counts as a patch: a commit that
 * refuses to be classified must not silently skip a release.
 *
 * `node scripts/release.mjs --dry-run` prints the current version, the bump and
 * the next version and touches nothing. Without `--dry-run` it tags, pushes,
 * creates the GitHub release and publishes to npm through whichever credential
 * the environment offers (`publishMode`): a token, or the job's OIDC id-token
 * when the package has a trusted publisher configured.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BUMP_RANK = ["none", "patch", "minor", "major"];
const NO_RELEASE_TYPES = new Set(["docs", "test", "tests", "chore", "style", "build", "ci"]);
const PATCH_TYPES = new Set(["fix", "perf", "refactor", "revert"]);
const SUBJECT = /^(\w+)(?:\([^)]*\))?(!)?:\s+\S/;

export function classifyCommit(message) {
  const text = String(message);
  if (/\[skip release\]/i.test(text)) return "none";
  if (/^BREAKING[ -]CHANGE:/im.test(text)) return "major";

  const subject = text.split("\n", 1)[0]?.trim() ?? "";
  const match = SUBJECT.exec(subject);
  if (match === null) return "patch";
  const [, type, bang] = match;
  if (bang === "!") return "major";
  const kind = (type ?? "").toLowerCase();
  if (kind === "feat") return "minor";
  if (PATCH_TYPES.has(kind)) return "patch";
  if (NO_RELEASE_TYPES.has(kind)) return "none";
  return "patch";
}

/** Highest bump over a list of commit messages; an empty log means no release. */
export function classifyBump(messages) {
  let best = "none";
  for (const message of messages) {
    const bump = classifyCommit(message);
    if (BUMP_RANK.indexOf(bump) > BUMP_RANK.indexOf(best)) best = bump;
  }
  return best;
}

/** Semver arithmetic without a dependency. Prerelease/build parts are dropped. */
export function nextVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (match === null) throw new Error(`not a semver version: ${version}`);
  let [, major, minor, patch] = match.map(Number);
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else if (bump === "patch") {
    patch += 1;
  } else if (bump !== "none") {
    throw new Error(`unknown bump: ${bump}`);
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * How a release authenticates to the registry:
 *
 *   `token`  NPM_TOKEN is set — the legacy path, still used until the package
 *            has a trusted publisher configured on npmjs.com.
 *   `oidc`   running on GitHub Actions: npm exchanges the job's id-token for a
 *            short-lived publish token itself, so the workflow must not set
 *            NODE_AUTH_TOKEN (setup-node would write it into `.npmrc` and that
 *            wins over OIDC). Provenance is automatic in this mode.
 *   `none`   a local run without a token: tag and release, never publish.
 */
export function publishMode(env) {
  if ((env.NPM_TOKEN ?? "").trim() !== "") return "token";
  if ((env.GITHUB_ACTIONS ?? "").trim() === "true") return "oidc";
  return "none";
}

/**
 * The shell steps of a real release, in order. Publish comes before the tag on
 * purpose: a publish that fails (expired trusted publisher, wrong allowed
 * action, registry hiccup) must leave no `v<x>` tag and no GitHub release
 * pointing at a version that the registry does not have. A local run
 * (`mode === "none"`) still tags and releases, it just never publishes.
 *
 * A pending release (package.json already names the version) has no version
 * bump and no release commit, so those steps are skipped.
 *
 * @param {string} next
 * @param {"token" | "oidc" | "none"} mode
 * @param {{ bump?: boolean }} [options]
 * @returns {Array<[string, string[]]>}
 */
export function releaseSteps(next, mode, options = {}) {
  const bump = options.bump ?? true;
  const steps = [];
  if (bump) steps.push(["npm", ["version", next, "--no-git-tag-version"]]);
  if (mode !== "none") steps.push(["npm", ["publish", "--provenance", "--access", "public"]]);
  if (bump) {
    steps.push(
      ["git", ["add", "package.json", "package-lock.json"]],
      ["git", ["commit", "-m", `chore(release): v${next}`]],
    );
  }
  steps.push(
    ["git", ["tag", "-a", `v${next}`, "-m", `v${next}`]],
    ["git", ["push", "origin", "HEAD", "--follow-tags"]],
    ["gh", ["release", "create", `v${next}`, "--generate-notes", "--title", `v${next}`]],
  );
  return steps;
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...options,
  }).trim();
}

function hasTag(tag) {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

function lastTag() {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
  } catch {
    return null;
  }
}

/** `<lastTag>..HEAD`, or the whole history when there is no tag yet. */
export function commitsSince(tag, log = (range) => git(["log", "--format=%B%x00", range])) {
  const range = tag === null ? "HEAD" : `${tag}..HEAD`;
  return String(log(range))
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * What a release would ship. A manifest version that already differs from the
 * last tag is the pending release: it must not be bumped again (that turned a
 * prepared 2.0.0 into 3.0.0 on the next merge).
 */
export function planRelease(current, lastTag, messages) {
  const tagged = lastTag === null ? null : lastTag.replace(/^v/, "");
  const pending = tagged !== null && tagged !== current;
  const bump = classifyBump(messages);
  const next = pending ? current : nextVersion(current, bump);
  return { current, lastTag, pending, bump, next };
}

/** The first publish of a prepared major version is an explicit owner action. */
export function manualReleaseRequired(plan, env) {
  return plan.pending && (env.RELEASE_MANUAL ?? "").trim() !== "1";
}

function run(command, args, options = {}) {
  process.stdout.write(`+ ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const tag = lastTag();
  const plan = planRelease(manifest.version, tag, commitsSince(tag));
  const { bump, next } = plan;

  process.stdout.write(
    [
      `last tag:   ${tag ?? "(none)"}`,
      `current:    ${manifest.version}`,
      `bump:       ${plan.pending ? "pending manifest version" : bump}`,
      `next:       ${next}`,
    ].join("\n") + "\n",
  );
  if (dryRun) return 0;
  if (manualReleaseRequired(plan, process.env)) {
    process.stdout.write(
      [
        `pending: package.json already names ${next}, last tag is ${tag ?? "(none)"}`,
        "publish: skipped: the first publish of a prepared major is manual",
        `run: RELEASE_MANUAL=1 node scripts/release.mjs  (or dispatch the release workflow with manual=true)`,
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (!plan.pending && bump === "none") {
    process.stdout.write("no release: the commits since the last tag are docs/test/chore only\n");
    return 0;
  }
  if (git(["status", "--porcelain"]) !== "") {
    process.stderr.write("release: working tree is dirty\n");
    return 1;
  }
  if (hasTag(`v${next}`)) {
    process.stderr.write(`release: tag v${next} already exists\n`);
    return 1;
  }

  const mode = publishMode(process.env);
  process.stdout.write(
    mode === "none"
      ? "publish: skipped: not on GitHub Actions and no NPM_TOKEN\n"
      : `publish: authenticating with ${mode}\n`,
  );
  for (const [command, args] of releaseSteps(next, mode, { bump: !plan.pending })) run(command, args);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === (process.argv[1].startsWith("/") ? process.argv[1] : join(process.cwd(), process.argv[1]));

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
