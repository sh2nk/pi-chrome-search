# PLAN — pi-chrome-search v2

Execution order for turning the v1 tree into the product described in `SPEC.md`. Read `AGENTS.md` for
the rules of engagement; this file only sequences the work and names the gates.

**Branch:** `feature/v2-rewrite`. **Baseline:** `main` @ v0.1.1 (27 k LOC, 315 offline tests, 18 error
codes, five tools of which one is reachable). The baseline is the source of transport knowledge, not a
source of truth: its docs describe what was built, not what must be built.

## How to work a phase

1. Read the phase, then the SPEC requirements it cites. If a requirement is ambiguous, stop and write
   an ADR draft — do not invent behaviour inside code.
2. Write tests first where the phase fixes a v1 defect: the failing test names the requirement id.
3. Delete the legacy module in the same PR that replaces it. No phase may end with two implementations
   of one behaviour, and no feature flag may survive its phase.
4. Run `npm run lint && npm test`, then `node src/cli/doctor.ts --json` when the phase touches transport.
5. Commit per logical change once the gates are green. One PR per phase, titled `P<n>: <goal>`.
6. Record the outcome in the PR body: requirement ids proven, gates, measured numbers if the phase has
   a latency or size target. Evidence does not go into the tree (no `evidence/`, no `research/`).

Global rules for every phase: no new runtime dependency without an ADR; no `any`; no build step; hard
rules from `AGENTS.md` apply to tests as well as to `src/`; a live probe runs **once** and a wall means
stop and ask.

---

## P0 — Baseline, guardrails, decisions

**Goal:** the branch can be trusted as a starting point, and the rewrite's own rules are enforced by
tooling rather than by discipline.

**Do**
- Confirm the baseline in the PR: `npm run lint && npm test` green, `node src/cli/doctor.ts --json`
  runs, and the v1 defect ledger in `SPEC.md` is reproducible (reachability, dead keys, version drift).
- Make the version single-sourced: `src/version.ts` reads the version from `package.json` (or the
  release script bumps both), plus a test asserting they agree.
- Split the doc budgets: `AGENTS.md`, `SPEC.md`, `PLAN.md` are normative docs with their own limits;
  the audit stops treating `SPEC.md`/`PLAN.md` as development apparatus.
- Add `docs/adr/0000-template.md` (context, decision, consequences, alternatives, owner approval line).
- Owner answers `SPEC.md` §15 D1–D7; the answers are recorded in `docs/adr/0001-v2-decisions.md`.

**Gate:** `npm run lint && npm test` green; ADR-0001 merged; baseline numbers recorded.
**Not done until:** the owner has signed off D1–D7 — they change the shape of P1, P2 and P6.

## P1 — Tool surface and reachability

**Goal:** an agent in a stock install can search **and** read. Nothing else matters more (S3).

**Do**
- Register `web_search` and `web_read` as `direct`; keep the rest `deferred` and activate the discovery
  tool from the extension (`pi.setActiveTools`), with a `direct` fallback when it is not registered.
- Replace the v1 test that only counts exposures with one that enumerates the model-visible set through
  the registration path, for both branches (S3.2).
- Descriptions: name the direct tools, state what each returns, keep the total ≤1200 (S3.3).
- Generate the README tool table from the same definitions the tools export (S13.3 pattern), and drop
  the hand-maintained table.
- Make `web_search` emit `unresolved` on `/goto` failures and document the field (S7.4, S3.5).

**Gate:** new reachability test fails on `main` and passes here; `web_read` is callable in a real
session (`pi -e ./src/index.ts`, one manual `web_read` on a public page); prompt-budget test green.
**Deletes:** nothing yet — this phase adds the door the rest of the work walks through.

## P2 — Config, errors, docs generation

**Goal:** the contract surface stops lying (S7.5, S9, S13).

**Do**
- Port `src/config.ts` into `src/config/{defaults,schema,load,env}.ts`, strict, one schema.
- Delete `mode`, `window.reuse`, `reflex.batchBackend`; decide `cdp.profileDir` (keep the env override,
  drop the unused config key) and plumb `cache.gotoTtlMs` into the resolver or delete it (S13.2).
- Add `scripts/gen-config-doc.mjs`; `docs/config.md` becomes generated output with a `--check` mode in
  CI. Same generator lists env overrides.
- Error taxonomy v2: add `E_EMPTY_PAGE`, keep the rest closed, rewrite every hint so it names an
  existing key/command (S9.2). Remove hints that point at `reflex.enabled` for a gate controlled by
  `reflex.pageGate`. Add the code-reachability test (S9.5).
- Audit: replace the substring drift rule with a value-aware check (defaults, enum members, ranges) and
  add the dead-key rule (S13.2).
- Fix `readOnlyHint`/`idempotentHint` on every tool (S9.6).

**Gate:** dead-key audit green; generated `docs/config.md` byte-identical; every documented code has a
test or a `reserved` marker; no hint names a key that does not exist (test over hint strings).
**Deletes:** `src/config.ts` (split), the hand-written config table.

## P3 — Transport: discover, attach, lock, tabs

**Goal:** a reliable, attach-only session layer the rest can build on (hard rules 1–3, S8.4, S12).

**Do**
- Keep the working parts of `src/cdp/` (raw WS, discovery order, `DevToolsActivePort`, attach wait,
  heartbeat lock) and port them behind one session object with an explicit lifecycle.
- Tab model: anchor tab, one work tab per engine, `read#n` slots; idempotent acquisition; release on
  shutdown; never close a foreign tab.
- One writer per tab via a keyed FIFO lock; `page.url()` invalidation and `frameNavigated`+`loaderId`
  commit semantics preserved (they were hard-won).
- `E_CDP_AWAITING_ALLOW` keeps its behaviour (60 s, one notification, retryable) and is documented as a
  human step (S8.4).
- Doctor skeleton with a probe seam so later phases can diagnose without a live browser in tests.

**Gate:** offline suite with the fake CDP covers: connect refused, awaiting allow, disconnect mid-call,
stale lock reclaim, two sessions, tab closed under us, PDF slot release. `node src/cli/doctor.ts --json`
reports `ok` against a running Chrome the owner approved.
**Deletes:** ad-hoc session code that the new lifecycle replaces.

## P4 — Search: adapters, matrix, AI, budget

**Goal:** the core value, honest and inside a deadline (S4, S7, S8).

**Do**
- Port google/duckduckgo/yandex adapters; every selector keeps its canary and gets a sanitized fixture.
- Implement the support matrix literally (S4.2), including `ignored` flags; add the matrix test
  (engine × argument → honoured | flagged).
- AI states end to end: wait, probe, expand (opt-in), extract, re-check at render (S4.3).
- `/goto` resolution: cookie GET, `redirect:manual`, concurrency 3, total deadline (S8.3); unresolved
  links flagged (S7.4).
- A call-level deadline (S8.1) and the worst-case arithmetic test (S8.2), computed from constants.
- Merge/dedupe/per-engine accounting, `E_EMPTY` handling, cache key covering every honoured argument.

**Gate:** every adapter has a fixture and a unit test; matrix test green; worst-case ≤ budget; live
smoke once per engine with the evidence line pasted into the PR.
**Deletes:** v1 compaction quirks that contradict S4.6, and the DDG claims in `docs/engines.md` that the
code does not implement.

## P5 — Read: readiness, SSRF, paging, PDF

**Goal:** reading a page is as trustworthy as searching it (S5).

**Do**
- Readiness per S5.1: marker/text floor with a soft deadline inside the budget, no fixed sleeps.
- Thin document → `E_EMPTY_PAGE` + artifact; `E_PARSE` back to "canary broke" only (S5.2, S9.3).
- SSRF guard: literal ranges, DNS check with injected resolver in tests, re-check on redirect and after
  navigation (S5.3). Keep the credentials-never-echoed property.
- Paging contract exact (`nextOffset`, `totalChars`, `clamped`, `E_OFFSET_RANGE`) and a property test
  that concatenating pages reproduces the document.
- PDF ladder unchanged in shape, bounded by config, slot released (S5.6); scanned PDF is honest.
- Read slots and locks (S5.7), release-on-shutdown test.

**Gate:** offline tests for JS-rendered (no text), redirect-to-private, moved-document, offset edges,
PDF text and PDF scanned; one manual read of a real JS-heavy page recorded in the PR.
**Deletes:** the "immediate extract" path and its misleading `E_PARSE`.

## P6 — Secondary tools

**Goal:** the three deferred tools are as honest as the two direct ones (S6).

**Do**
- `image_search`: fixtures for Google tiles and Yandex tiles first (v1 had none), then the adapter,
  `pageUrlKind`, ad filtering, `attach` blocks with the byte cap, artifact on parse failure.
- `web_research`: budget accounting, claims with citations, coverage floor, `budget` in details; no
  model provider call (D1 default).
- `web_doctor`: `probe`/`fix` over the P3 session, safe fix set only, JSON schema file that actually
  exists and is validated in a test.
- If D1 keeps any classifier: opt-in key, caps, USD guard, `localOnly`, decision log row schema.

**Gate:** `node src/cli/doctor.ts --json | <validator>` green; research budget test (never exceeds);
image fixtures asserted; `web_research` cites every claim in a fixture-driven test.
**Deletes:** `src/reflex/**` when D1 = delete; the fake schema path.

## P7 — Rates, UX, panel

**Goal:** the window behaves like a polite human and never surprises its owner (S10, S12).

**Do**
- Limiter: per-engine pacing with jitter, daily caps, persisted state, `E_RATE_LIMITED` with the wait;
  in-flight serialization across tabs (S10.1, S10.2).
- Window: focus/follow/idle policies, anchor panel content and repaint, notification on the Allow
  prompt; `"never"` dominates; a wall keeps the page (S12).
- Remove the wall retry and `captcha.waitMs` per D5; assert "no navigation after a wall" in a test.

**Gate:** fake-clock tests for pacing (no early fire, jitter within bounds, cap wins), panel never
fails a search, wall test asserts zero automatic re-navigation.
**Deletes:** `captcha.*` keys (per D5), retry code, dead focus branches.

## P8 — Hardening, docs, release

**Goal:** the tree is the product description (A1–A8).

**Do**
- Rewrite `README.md` from SPEC: install, the CDP Allow step, tool table (generated), failure table
  (generated from codes), what is not supported.
- Regenerate `docs/config.md`, `docs/errors.md`, `docs/engines.md` (selectors + fixtures), retire
  `docs/architecture.md` into short ADR-backed notes or delete it.
- Audit sweep: hard rules, prompts budget, dead keys, values, fixtures, doc budgets, packaging.
- Budget/perf report: p50/p95 for search and read, worst-case table, artifact size.
- Release: version single source, `scripts/release.mjs` bump table, OIDC publish before tag, npm trusted
  publisher, provenance. First publish of the v2 major version is manual.
- Final live smoke: three engines, one query each, `n=2`; a wall stops the run and is reported.

**Gate:** A1–A8 demonstrated in the PR; `npm run lint && npm test`; `node src/cli/doctor.ts --json`
against a live session; `npm pack --dry-run` contains no dev docs or fixtures.

---

## Ordering rationale (for the reviewer)

Reachability (P1) and the contract surface (P2) come before transport because they are cheap and remove
the two failure modes that make everything else unverifiable. Transport (P3) precedes adapters: a
correct SERP parsed from the wrong tab is worthless. Search (P4) precedes read (P5) because search is
the product's headline and exercises the transport hardest; read then reuses the same session, budget
and error machinery. Secondary tools (P6) last among features because they depend on everything above.
Rates/UX (P7) can slip a release without breaking the core loop; hardening (P8) is not a phase for new
behaviour, only for proof.

## First ten commits (suggested)

1. `chore(version): read the extension version from package.json`
2. `docs(adr): add the ADR template and record the v2 decisions`
3. `chore(audit): budget SPEC/PLAN and stop treating them as apparatus`
4. `feat(tools): register web_read direct and activate tool discovery`
5. `test(tools): assert reachability for both registration branches`
6. `refactor(config): split the loader into defaults, schema, load and env`
7. `chore(config): delete keys no code reads`
8. `feat(config): generate docs/config.md and fail CI on drift`
9. `feat(errors): add E_EMPTY_PAGE and make every hint executable`
10. `refactor(cdp): one session lifecycle with an explicit tab model`

## Risks and mitigations

| risk | mitigation |
|---|---|
| The owner is absent for the Allow click during a live gate | gate is opt-in, run once, and reported as `E_CDP_AWAITING_ALLOW`; never auto-retry |
| Selectors rot faster than the rewrite | fixtures + `docs/engines.md` line per selector; a rotted selector fails offline, not live |
| Scope creep back into "more engines" | SPEC non-goals; a new engine needs an ADR and a fixture budget |
| Two implementations survive a phase | the phase's "Deletes" line is part of its exit gate |
| Rewrite stalls mid-way with a half-working tree | each phase keeps the product usable: P1–P2 fix what ships, P3 replaces behind the same tool contracts |
