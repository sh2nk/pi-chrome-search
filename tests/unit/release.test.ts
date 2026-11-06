/**
 * Release classification (V16.7): the bump table, and the two properties the
 * workflow depends on — `[skip release]` wins over everything, and an
 * unclassifiable commit is a patch rather than a silent skip.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyBump, classifyCommit, nextVersion } from "../../scripts/release.mjs";

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
