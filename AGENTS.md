# AGENTS.md — pi-chrome-search

You are rewriting a pi extension that searches the web through the user's own visible Chrome. Reply to
the user in Russian; write code, comments, docs and commits in English.

**The tree you are looking at is v1.** `SPEC.md` describes the product we are building. Nothing in
`src/`, `docs/` or `README.md` is authoritative until a plan phase says it has been regenerated: v1's
docs were verified to disagree with its own code (see `SPEC.md` appendix).

## Read in this order

1. `SPEC.md` — normative requirements (`S#.#`). On any conflict, SPEC wins; fix the loser in the same PR.
2. `PLAN.md` — the phase you are in, its gate, and what it deletes.
3. `AGENTS.md` — this file: rules of engagement.
4. `docs/adr/` — decisions that changed a public contract. An ADR is binding once the owner approved it.
5. `src/`, `tests/` — v1 evidence. Useful for transport knowledge (raw CDP, discovery, locks); never
   copy its contracts.

If a phase needs a decision that changes a public contract, stop and write an ADR draft
(`docs/adr/0000-template.md`). Do not bury a decision in code.

## Hard rules (a violation is a defect, not a trade-off)

1. **Attach only.** Never `launch()`, `launchPersistentContext()`, `--enable-automation`, a separate
   automation profile, or a spawned browser. Raw CDP over WebSocket in production code. There is no
   `launch` mode in v2 (`SPEC` S1).
2. **Never restart, kill or close the user's Chrome.** Never close a tab we did not open. Never read or
   write `~/.config/google-chrome/**`, copy cookies, or edit `Local State`.
3. **No headless, no fingerprint work.** No UA/locale/timezone/screen/WebGL/`navigator.*` overrides, no
   `Page.addScriptToEvaluateOnNewDocument`. One-off `Runtime.evaluate` is fine.
4. **Never solve captchas.** Surface the window and return `E_WALL` with an artifact **at once**, so the
   human can click it. No solver, no automatic re-navigation, no wait-for-human timer (S8.5,
   ADR-0001 D5).
5. **No quality gates.** No classifier, no heuristic rules, no page/read/coverage gate: the model
   decides what to read and the tool reports what it got (ADR-0001 D1). The SSRF guard is a security
   boundary, not a quality opinion, and stays.
6. **No paid search APIs or search keys, no model calls.** Search and read traffic never goes through a
   third-party provider (S11.5). Do not add a "small classifier" back in any form.
7. **Rate-limit like a human.** One live search per engine at a time and per-engine pacing with jitter;
   there are no daily caps (ADR-0001 D8). One probe per engine per gate; never loop live probes. A wall
   means stop and ask.
8. **Every failure is diagnosable**: `code` + `stage` + `retryable` + a hint the user can actually
   execute (`S9.2`) + an artifact for page states. No bare `throw new Error("failed")`.
9. **Reachability is a requirement** (S3.1): every registered tool must be callable in a stock install.
   A `deferred` tool is acceptable only if the extension itself activates the discovery tool; otherwise
   register it `direct`. Test both branches.
10. **Honesty over convenience** (S7): every argument is honoured or reported `ignored`; `details`
    describe the emitted text; no phantom config keys, flags or docs.
11. **One deadline per call** (S8): stages derive from the remaining budget, worst case is a test.
12. **Single writer.** Live Chrome work goes through the session layer only; one writer per tab; parallel
    tool calls queue on a per-tab lock.
13. **Keep the prompt cheap** (S3.3): tool descriptions ≤1200 chars total, each ≤350; search operators are
    taught with `promptGuidelines` (≤400 chars), not with a new argument; caps live in one module.
14. **Host facts live in `src/runtime/host.ts`** (platform, paths, profile tables, `capability()`,
    process liveness). Nothing else imports `node:os`, reads `$HOME`/`PATH`, hardcodes `/proc/` or
    `.config/`, or spawns to probe a binary.
15. **Docs are code.** `docs/config.md` and the README tables are generated; never hand-edit them.

## Target layout

```
index.ts                 package entry only
src/extension.ts         registration: tools, commands, activation, shutdown
src/config/              defaults, schema, load (strict), env overrides
src/session/             one session lifecycle: discover, attach, lock, tab pool, shutdown
src/cdp/                 raw WS client, navigation commit, document access, humanize
src/engines/             google, duckduckgo, yandex, images: buildUrl + extractor + canaries
src/extract/             readability, urls, goto, pdf, compact (all caps here)
src/runtime/             errors, codes, artifacts, limiter (pacing only), cache, host, log, notify, panel
src/tools/               search, read, images, research, doctor
src/commands/            /web-doctor, /web-focus
scripts/                 audit.mjs, release.mjs, gen-config-doc.mjs
tests/{unit,live,fixtures}
docs/{adr,config.md,engines.md,errors.md}
SPEC.md PLAN.md AGENTS.md
```

## Commands

```bash
npm run lint                     # tsc --noEmit && node scripts/audit.mjs
npm test                         # offline suite, must never touch Chrome
node src/cli/doctor.ts --json    # canonical diagnosis (--no-probe, --fix, --watch)
PI_CHROME_LIVE=1 npm run test:live   # one query per engine, once; a wall = stop
pi -e ./src/index.ts             # throwaway session for a manual check
node scripts/release.mjs --dry-run
```

Run live commands **once**. They hit real engines in the owner's profile; a captcha is a stop sign, not
an obstacle to route around.

## Workflow

- One phase per branch (`P<n>` from `PLAN.md`), one PR, one logical change per commit.
- Tests first for anything that fixes a v1 defect: the failing test names the `S#.#` it proves.
- Delete the legacy module in the PR that replaces it. No phase ends with two implementations and no
  feature flag outlives its phase.
- Commit as soon as the gates pass — do not wait for an explicit request. Style: `feat: …`,
  `fix(scope): …`, `test: …`, `refactor(scope): …`, `docs: …`, `chore: …`; `!` or `BREAKING CHANGE:`
  for a major.
- Evidence of a live run goes into the PR body, never into the tree (no `evidence/`, `research/`,
  `bench/` directories — the audit rejects them).

## Conventions

- TypeScript strict ESM, Node ≥26, no build step, no `any` (use `unknown` + a guard).
- Small modules: an adapter is `buildUrl` + a DOM extractor + canaries, not a god object. Text or
  structural markers, never obfuscated class names alone.
- Every selector ships a sanitized fixture and a line in `docs/engines.md`; a selector without a fixture
  fails the audit (S13.4). Images included — v1 had none.
- Tests are offline by default: injected DNS, fake CDP, fake clock. Live tests are opt-in.
- A new runtime dependency needs an ADR with the justification in the commit message.
- Caps (chars, bytes, results) live in one module per family; no scattered literals.

## Definition of done

**Per phase:** the SPEC requirements it owns have tests; legacy code for that scope is deleted; generated
docs are regenerated; `npm run lint && npm test` green; `doctor --json` validates when transport is
touched; no new `TODO`/`FIXME` and no dead config key.

**Per release:** `SPEC.md` §14 A1–A8 demonstrated; version single-sourced (`package.json` is the only
place); the live smoke line is recorded; `npm pack --dry-run` contains no dev docs, fixtures or
artifacts; publish through OIDC trusted publishing (provenance), never an `NPM_TOKEN` secret; a brand-new
package version still needs one manual `npm publish`.

## Ask the owner instead of guessing

Removing a capability, changing a default that costs money or time, adding/renaming an error code,
changing the tool surface, anything that weakens a hard rule, or an ambiguous requirement. Ask with a
concrete proposal and the alternative — the owner answers with a decision, and you record it in an ADR.
