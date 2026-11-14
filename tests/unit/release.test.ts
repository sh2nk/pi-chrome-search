/**
 * Release classification (V16.7): the bump table, and the two properties the
 * workflow depends on — `[skip release]` wins over everything, and an
 * unclassifiable commit is a patch rather than a silent skip.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyBump,
  classifyCommit,
  manualReleaseRequired,
  nextVersion,
  planRelease,
  publishMode,
  releaseSteps,
} from "../../scripts/release.mjs";

test("the bump table covers feat/fix/refactor/breaking/docs-only/skip", () => {
  const cases = [
    ["feat: add freshness filters", "minor"],
    ["feat(search)!: change the default engine order", "major"],
    ["fix(parse): yandex neuro selector", "patch"],
    ["perf: reuse the CDP socket", "patch"],
    ["refactor: split the read pipeline", "patch"],
    ["docs: rewrite the README", "none"],
    ["test: cover the offset window", "none"],
    ["chore: bump devDependencies", "none"],
    ["chore: release\n\nBREAKING CHANGE: config key renamed", "major"],
    ["fix: a real fix\n\n[skip release]", "none"],
    ["not a conventional commit at all", "patch"],
  ] as const;

  for (const [message, expected] of cases) {
    assert.equal(classifyCommit(message), expected, message);
  }
});

test("a mixed log takes the highest bump, and an empty log releases nothing", () => {
  assert.equal(classifyBump([]), "none");
  assert.equal(classifyBump(["docs: readme", "fix: typo"]), "patch");
  assert.equal(classifyBump(["fix: typo", "feat: new tool"]), "minor");
  assert.equal(classifyBump(["feat: new tool", "feat!: drop attach mode"]), "major");
  assert.equal(
    classifyBump(["feat!: drop attach mode", "chore: x\n\n[skip release]"]),
    "major",
    "[skip release] only opts out its own commit",
  );
});

test("nextVersion is semver arithmetic without a dependency", () => {
  assert.equal(nextVersion("0.1.0", "none"), "0.1.0");
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(nextVersion("1.9.9", "major"), "2.0.0");
  assert.equal(nextVersion("1.2.3-beta.1", "patch"), "1.2.4");
  assert.throws(() => nextVersion("v1", "patch"), /not a semver version/);
  assert.throws(() => nextVersion("1.0.0", "huge"), /unknown bump/);
});

test("publishMode: a token wins, GitHub Actions falls back to OIDC, a local run publishes nothing", () => {
  assert.equal(publishMode({ NPM_TOKEN: "npm_secret" }), "token");
  assert.equal(publishMode({ GITHUB_ACTIONS: "true", NPM_TOKEN: "npm_secret" }), "token");
  assert.equal(publishMode({ GITHUB_ACTIONS: "true" }), "oidc");
  assert.equal(publishMode({ GITHUB_ACTIONS: "  " }), "none");
  assert.equal(publishMode({ NPM_TOKEN: "   " }), "none");
  assert.equal(publishMode({ CI: "true", GH_TOKEN: "x" }), "none");
  assert.equal(publishMode({}), "none");
});

test("publish precedes the tag, so a failed publish leaves no trace", () => {
  const ci = releaseSteps("0.1.1", "oidc").map(([command, args]) => `${command} ${args.join(" ")}`);
  const publishAt = ci.findIndex((step) => step.startsWith("npm publish"));
  const tagAt = ci.findIndex((step) => step.startsWith("git tag"));
  const pushAt = ci.findIndex((step) => step.startsWith("git push"));
  assert.ok(publishAt >= 0, "a CI run publishes");
  assert.ok(publishAt < tagAt && tagAt < pushAt, ci.join(" | "));
  assert.equal(ci.at(-1), "gh release create v0.1.1 --generate-notes --title v0.1.1");

  const local = releaseSteps("0.1.1", "none").map(([command, args]) => `${command} ${args.join(" ")}`);
  assert.equal(local.filter((step) => step.startsWith("npm publish")).length, 0);
  assert.ok(local.some((step) => step.startsWith("git tag -a v0.1.1")));
});

test("a manifest ahead of the last tag is the pending release, never a second bump", () => {
  const pending = planRelease("2.0.0", "v0.1.1", ["feat!: v2"]);
  assert.equal(pending.pending, true);
  assert.equal(pending.next, "2.0.0", "a prepared 2.0.0 must not become 3.0.0");
  assert.equal(manualReleaseRequired(pending, {}), true);
  assert.equal(manualReleaseRequired(pending, { RELEASE_MANUAL: "1" }), false);

  const ordinary = planRelease("2.0.0", "v2.0.0", ["fix: typo"]);
  assert.equal(ordinary.pending, false);
  assert.equal(ordinary.next, "2.0.1");
  assert.equal(manualReleaseRequired(ordinary, {}), false);
});

test("a pending release skips the version bump and the release commit", () => {
  const steps = releaseSteps("2.0.0", "oidc", { bump: false }).map(
    ([command, args]) => `${command} ${args.join(" ")}`,
  );
  assert.equal(steps.some((step) => step.startsWith("npm version")), false);
  assert.equal(steps.some((step) => step.startsWith("git commit")), false);
  assert.ok(steps.some((step) => step.startsWith("npm publish")));
  assert.ok(steps.some((step) => step.startsWith("git tag -a v2.0.0")));
});
