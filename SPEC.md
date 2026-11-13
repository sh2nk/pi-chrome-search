# SPEC — pi-chrome-search v2

**Status:** normative. This file, not the code, defines the product. `AGENTS.md` says how to work,
`PLAN.md` says in what order. `docs/*.md` describe **v1 as shipped** and are historical until a plan
phase regenerates or replaces them. On conflict: SPEC wins, and the losing file is fixed in the same PR.

Requirement ids (`S#.#`) exist so tests, commits and reviews can name what they prove. `MUST` /
`MUST NOT` are normative; `SHOULD` is waivable only by an ADR that the owner approves.

---

## 1. Product

Free web search and page reading for pi, performed in the user's **own visible Chrome**: same profile,
same cookies, same IP, no keys, no paid search API, no bundled or headless browser, no automation
profile, no fingerprint spoofing, no captcha solving.

The whole value is the loop **search → read → cite**. v1 shipped the first half only.

**Non-goals** (do not implement, do not add a config key for): headless/CI browsing, scraping at
scale, proxy or VPN rotation, captcha services, cookie export/import, telemetry, hosted/remote
execution, "search API" wrappers of any kind.

## 2. Who the user is

An interactive pi session acting for a human who is present at the machine and can click once
(CDP Allow) or solve a captcha. Every design choice assumes **a human is watching the window**.
An unattended long-running job is out of scope; if the human is absent, the product must say so
through `E_WALL` / `E_CDP_AWAITING_ALLOW`, never by working around them.

## 3. Tools and reachability

Five tools, one contract:

| tool | exposure (target) | purpose |
|---|---|---|
| `web_search` | `direct` | SERP results + native AI summary |
| `web_read` | `direct` | one page as compact Markdown, paged |
| `image_search` | `deferred` | image tiles; optional real image blocks |
| `web_research` | `deferred` | search → read → claims with citations |
| `web_doctor` | `deferred` | diagnose CDP/lock/window/engines; safe fix |

- **S3.1 Reachability is invariant.** Every registered tool MUST be callable by the model in a stock
  install (`pi install npm:pi-chrome-search`, no settings edits, no `--tools`). `deferred` exposure is
  allowed only when the extension itself guarantees that the discovery tool (`tool_search`) is active;
  if that cannot be guaranteed on the running pi, the tool MUST be registered `direct` instead. This is
  v1's central defect and the reason this spec exists: four of five tools were unreachable.
- **S3.2 Tested, not assumed.** A unit test enumerates the registered tools through the same path the
  session uses and asserts reachability for both branches (discovery tool present / absent). "Exposure
  looks right" is not evidence.
- **S3.3 Prompt budget.** Descriptions sum to ≤1200 characters and each is ≤350. The number is
  enforced by a test, because reachability plus a cheap prompt is exactly the trade this product makes.
  Until P1 moves both together, the v1 test and audit still enforce the tighter 900 — do not chase that
  as a bug.
- **S3.4 Discoverability.** `web_search`'s description names the two direct tools and what they return;
  an agent that only reads declared tool descriptions must still be able to do search → read.
- **S3.5 Results are readable.** Every emitted result URL is either resolved to a real destination or
  explicitly marked `unresolved` (S7.4), so a result can always be handed to `web_read`.
- **S3.6 Search operators.** `web_search` passes `q` verbatim and declares `promptGuidelines` teaching
  the operators that actually narrow results: quoted phrases, `-term`, `OR`, `site:`, `filetype:`, and
  date narrowing where the engine supports it (Google `after:`/`before:`, Yandex `date:`). Guideline text
  ≤400 chars. There is no tool-level date filter (ADR-0001 D2), so the model narrows in the query.

## 4. `web_search` contract

Arguments: `q` (required, non-empty after trim, ≤500 chars), `n` 1..10 (default `search.n`), `engines`
`auto | id | id[]` (max 3, `auto` = first enabled engine that works), `summary` boolean (default true),
`page` ≥1, `format` `md|json`.

- **S4.1 Merge semantics.** `auto` and a single id mean "first engine that works, stop at the first
  success"; an explicit list means "coverage set": merge, dedupe, and report per-engine counts. A
  failed engine inside a coverage set MUST appear as `perEngine[id]=0` plus its code in `failedEngines`.
- **S4.2 Support matrix.** Each argument × engine is honoured or reported (S7.1). Target matrix:

  | argument | google | duckduckgo | yandex |
  |---|---|---|---|
  | `n` | yes | yes | yes |
  | `page` | yes | **flag** (no pagination) | yes |
  | `summary` | AI Overview | Search Assist | Alice/Neuro |
  | `site:`/`filetype:`/quotes | passthrough | passthrough | passthrough |

  `flag` means the result carries `ignored: {"page": "duckduckgo"}` and the README documents it. A
  silently ignored argument is a defect, not a shortcut. Date narrowing is a query operator (S3.6), not
  an argument: `&tbs=qdr=` and `&df=` are not part of the surface.
- **S4.3 AI states.** `answer` (≥200 chars of prose, label/echo stripped), `lead` (block present, no
  answer), `none` (no block). Re-checked at render, so an adapter cannot smuggle a short "answer".
  `details.ai` is true only for `answer`.
- **S4.4 Empty is failure.** A SERP with zero organic results is `E_EMPTY` and is neither cached nor
  returned as success; a coverage set continues to its next engine.
- **S4.5 Cache.** Key covers `engine,query,n,page,lang,region,summary`; hits are labelled
  `cached:true`, cost no live request, and never change semantics. A cache hit is not a lie: TTL is
  reported in `details` when it is material.
- **S4.6 Output caps.** Markdown ≤`search.outputMaxChars` (default 2500) exactly; summary
  ≤`search.summaryMaxChars` (1200); snippet ≤`search.snippetMaxChars` (140). JSON is capped too, with
  a documented minimum envelope; counts in `details` describe the emitted text, never the plan.

## 5. `web_read` contract

Arguments: `url` (public http/https), `offset` ≥0 (default 0), `maxChars` ≥1 (default
`read.defaultMaxChars` 6000, ceiling `read.maxCharsCeiling` 20000, clamped and reported), `format`
`md|text`.

- **S5.1 Readiness.** A page is ready when `readyState ≥ interactive` **and** the document yields a
  text floor (≥200 chars) or `readyState = complete`, with a soft deadline (2.5 s) inside the call
  budget. No fixed sleeps; no `loadEventFired` dependency.
- **S5.2 Thin is its own failure.** A document with no extractable text is `E_EMPTY_PAGE` with an
  artifact and a hint that the page may render client-side. `E_PARSE` is reserved for adapter canary
  failures (S9.3).
- **S5.3 SSRF.** Only public `http(s)`; reject credentials, loopback/private/link-local/CGNAT/multicast
  literals, and hostnames that resolve to them. Re-check the landed URL after navigation and on
  redirect. Failure is `E_BLOCKED_URL` at stage `read`, hint names the reason, never echoes credentials.
- **S5.4 Stability.** The document URL is captured before and after extraction; a change is
  `E_NAVIGATION_MISMATCH`, not a stranger's page.
- **S5.5 Paging.** `nextOffset`, `totalChars`, `truncated`, `clamped` are exact for the emitted text; an
  offset past the end is `E_OFFSET_RANGE` naming the range.
- **S5.6 PDF ladder.** In-tree parser over bytes fetched through Chrome → optional installed
  `pdftotext`/`mutool` behind `capability()` → `E_PDF_SCANNED` (no text layer) or `E_PDF_UNSUPPORTED`.
  Bounded by `read.pdfMaxBytes`; the slot is released after a PDF read.
- **S5.7 Read slots.** `read.pool` 1..3; each slot owns one tab and one exclusive lock. A read never
  navigates an engine tab.

## 6. `image_search`, `web_research`, `web_doctor`

- **S6.1 `image_search`**: `q`, `n` ≤12 (default 4), `engine` `google|yandex`, `attach` boolean or
  `"bytes"` (≤4 real image blocks, ≤`image.attachMaxBytes` each). Reports `pageUrlKind` (`page` for
  Google tiles, `image` for Yandex) so a caller knows what the URL points to. Every selector has a
  fixture (v1 had none).
- **S6.2 `web_research`**: `q`, `budget` `quick|normal|deep` = 1 search + 2 reads / 2 + 4 / 4 + 8. It
  MUST NOT exceed its budget, MUST cite a URL for every claim, MUST NOT invent or paraphrase-inside-quotes,
  and MUST report the budget it spent. Page selection is deterministic (merge order, dedupe, top-N): no
  quality gate decides what to read (ADR-0001 D1), and no model provider is called at all (S11.5).
- **S6.3 `web_doctor`**: `probe` (default true), `fix` (default false). Safe fix set: reconnect,
  release owned tabs, prune artifacts, reclaim a stale lock. It MUST NOT kill, restart or close
  anything the extension did not open. `readOnlyHint:false` (S9.6).

## 7. Honesty

- **S7.1 Honour-or-flag.** Every accepted argument is honoured, or the result says
  `ignored: {<arg>: <engine|reason>}`. No silent narrowing: a "weekly" search that was not filtered is
  a lie with a straight face.
- **S7.2 Details describe output.** `results`, `ai`, `aiChars`, `perEngine`, `chars`, `truncated`,
  `cached` are computed from the emitted text (post-fit), never from the plan.
- **S7.3 Labels are state.** `ai:lead`/`ai:no`/`ai:yes` are three distinct outputs; a gated or withheld
  block is `lead`/`none`, never an empty "answer".
- **S7.4 No fabricated links.** An unresolved wrapper stays the wrapper and is marked; a tracking
  parameter stripped from a URL is stripped from the link the user will click, not just from display.
- **S7.5 No phantom features.** A documented key, argument, flag or command either works or does not
  exist. v1 shipped five config keys and a `launch` mode that no code read; that is a defect class.
- **S7.6 Honest degradation.** A fallback path (e.g. keyless HTTP) is labelled `degraded:true`; the
  caller can tell a real SERP from a substitute.

## 8. Time

- **S8.1 One deadline per call.** `search.budgetMs` (default 60000), `read.budgetMs` (default 30000),
  research = sum of its searches and reads, capped by `research.budgetMs` (default 300000). Every stage
  derives its deadline from the remaining budget; exhaustion is `E_TIMEOUT` with `stage:"budget"` and an
  artifact.
- **S8.2 Arithmetic is a test.** For every shipped default (n, engines, summary, page) the documented
  worst case MUST be ≤ the budget: `pacing + settle + aiWait + link resolution + extraction`. The test
  computes it from the constants, so a later default change cannot silently break the promise.
- **S8.3 Link resolution is bounded.** `/goto` resolution runs with concurrency (default 3) and a total
  deadline, not 10 sequential 5 s requests (v1: up to 50 s on one SERP).
- **S8.4 A user interaction is not a hang.** Waiting for the CDP Allow click is `E_CDP_AWAITING_ALLOW`
  (retryable, 60 s, one desktop notification), reported, not silently absorbed. The call budget starts
  once the session is up.
- **S8.5 Bounded walls.** A wall is reported at once. No automatic re-navigation, no wait-for-human
  loop: the user solves it and retries (see D5).

## 9. Errors

- **S9.1 Shape.** Every failure is `code`, `stage`, `retryable`, `hint`, optional `engine`/`wall`/
  `artifact`. No bare `Error("failed")` reaches the agent.
- **S9.2 Hints are executable.** Anything a hint tells the user to do must exist: a real key, a real
  command, a real file. v1 told users to raise a timeout that had no knob, and to flip a flag that was
  already off.
- **S9.3 Taxonomy is disjoint.** `E_PARSE` = our extractor's canary failed; `E_EMPTY_PAGE` = the
  document rendered nothing readable; `E_WALL` = captcha/consent/blocked; `E_BLOCKED_URL` = the SSRF
  guard refused. One situation, one code.
- **S9.4 Artifacts.** Every page-state failure (parse, empty, wall, blocked-after-navigate, mismatch)
  leaves `page.html`, `page.txt`, `meta.json`; retention by count and bytes; nothing personal in
  fixtures.
- **S9.5 Code set is closed and proven.** A test asserts: every code thrown in `src/` is documented and
  every documented code is either exercised by a test or marked `reserved` with a reason.
- **S9.6 Annotations are true.** `readOnlyHint` is false for anything that navigates the user's
  browser, types, spends a quota or writes a file. `idempotentHint` only where a repeat is observably
  free (cache hit) — which `web_search` is not.

## 10. Rates and politeness

- **S10.1** Per-engine pacing with jitter (defaults: google 2.5–5 s, ddg 2–4 s, yandex 5–9 s). No daily
  caps and no `E_RATE_LIMITED`: the engines are free, a quota was an unmeasured guess, and politeness is
  pacing, not a counter (ADR-0001 D8).
- **S10.2** One in-flight live search per engine across the whole session, one writer per tab. Parallel
  pi tool calls queue on a per-tab lock; they never type into one box concurrently.
- **S10.3** No loops around a wall, no retry storms, no probe loops. Doctor probes at most once per
  engine per gate.
- **S10.4** Live smoke: one query per engine, `n=2`, one run, no retries; a wall is a stop-and-ask, not
  a failure to work around.

## 11. Security and privacy

- **S11.1** Attach only; never write `~/.config/google-chrome/**`; never copy or decrypt cookies; never
  export a profile.
- **S11.2** Nothing leaves the machine except the search/read traffic the user already makes. No
  telemetry, no crash reporting, no "usage" endpoint.
- **S11.3** Artifacts and `decisions.jsonl` stay local, are directory-mode private, contain no cookies
  and no auth headers.
- **S11.4** Fixtures are sanitized (no identity, tokens, IPs, personal queries) and reviewed as data.
- **S11.5** No classifier, no rules gate, no page-quality score: the quality layer is deleted, not
  disabled (ADR-0001 D1). Search and read traffic never goes through any third-party provider. The SSRF
  guard is a security boundary, not a quality gate, and stays.

## 12. UX of the visible window

- **S12.1** One owned window, one work tab per engine and per read slot, plus an anchor tab that hosts
  the local control panel (`assets/anchor.html`, painted by one-off `Runtime.evaluate`).
- **S12.2** The window is raised per `window.focus` (`session|always|never`) and handed back per
  `window.follow`/`window.idleMs`; `"never"` dominates everything.
- **S12.3** Tabs we did not open are never closed; the last tab closes the window, so the anchor exists.
- **S12.4** A wall surfaces the window and leaves the page for the human; the extension does not steal
  focus back mid-solve.
- **S12.5** The panel shows engine, query, stage, pace and daily counters; a dead panel never fails a
  search.

## 13. Config, docs and tests

- **S13.1** One schema, strict: unknown key, wrong type or out-of-range value is `E_CONFIG` naming the
  path. Env overrides are listed and applied after the file. `web-search.json` stays optional.
- **S13.2** No dead keys: every leaf of the default config is read by production code. Enforced by an
  audit rule (dotted path resolves to an access outside the config module) and by tests that change the
  key and observe the behaviour. The `reflex.*`, `captcha.*` and `engines.*.dailyCap` blocks are deleted
  (ADR-0001) and do not come back as configuration.
- **S13.3** `docs/config.md` is generated from the schema (defaults, ranges, env) and CI fails when it
  differs from generator output. Hand-written tables drift; v1's did.
- **S13.4** `docs/engines.md` lists every selector and its fixture; a selector without a fixture fails
  the audit. Images included (v1 gap).
- **S13.5** Tests are offline by default, deterministic, and must not touch Chrome, DNS outside the
  injected resolver, or the user's home. Live tests are opt-in and run once.
- **S13.6** `docs/adr/NNNN-*.md` records decisions that change a public contract (tool surface, error
  codes, config keys, defaults, budgets). An ADR without an owner "approved" line is a draft.
- **S13.7** No evidence/apparatus directories in the tree; live-run evidence goes into the PR body.

## 14. Acceptance (product level)

- **A1** Fresh install, untouched settings: the model sees `web_search` and `web_read`, searches, reads
  the top result, and gets an AI answer or an honest `lead`/`none`.
- **A2** `web_search` with `engines:["google","duckduckgo","yandex"], n:5` returns merged, deduped
  results within `search.budgetMs`, with per-engine counts and an `ignored.page` flag for DuckDuckGo.
- **A3** A captcha page yields `E_WALL`, an artifact, the window surfaced, and no automatic retry.
- **A4** `web_read` on a JS-rendered page either returns text or `E_EMPTY_PAGE` with an artifact — never
  a misleading empty success and never `E_PARSE`.
- **A5** `npm run lint && npm test` green; `node src/cli/doctor.ts --json` validates against a schema
  file that exists in the tree, and reports the version in `package.json` (single source).
- **A6** Every config leaf is used; generated docs/config.md matches; no `mode`, no dead key.
- **A7** No hard-rule violation in the audit, and the audit checks values (not just substrings).
- **A8** Live smoke recorded for three engines (engine, query class, `ai:yes/lead/no`, chars, latency)
  in the PR that touches an adapter.

## 15. Decisions (settled)

Owner decisions, 2026-11-13; full rationale and consequences in `docs/adr/0001-v2-decisions.md`.
Changing one requires a new ADR.

- **D1** Classifier and all built-in quality gates deleted; no rules layer either (ADR D1).
- **D2** No `freshness` argument; the agent narrows with query operators, taught by `promptGuidelines`.
- **D3** `web_search` + `web_read` direct; the rest deferred with guaranteed discovery, `direct` fallback.
- **D4** In-place rewrite on `feature/v2-rewrite`, one phase per PR.
- **D5** Wall is immediate: no retry, no wait; the human solves and retries.
- **D6** Yandex last in `auto`; an explicit list is honoured as given.
- **D7** Budgets 60000 / 30000 / 300000 ms; descriptions ≤1200; operator guideline ≤400.
- **D8** No daily caps, no persisted rate state, no `E_RATE_LIMITED`; pacing + one in-flight per engine.
- **D9** v2.0.0 (breaking surface, config and error taxonomy).

## Appendix — v1 defect ledger (why each requirement exists)

| v1 defect (verified on the branch point) | Requirement |
|---|---|
| 4 of 5 tools unreachable in a stock session (`tool_search` inactive) | S3.1, S3.2 |
| five config keys with no reader (`mode`, `cdp.profileDir`, `window.reuse`, `reflex.batchBackend`, `cache.gotoTtlMs`) | S7.5, S13.2 |
| DDG `freshness` silently ignored; argument deleted in v2 (ADR-0001 D2) | S3.6, S4.2 |
| no total deadline; `/goto` up to 10×5 s | S8.1, S8.2, S8.3 |
| `E_PARSE` used for "page rendered nothing" | S9.3 |
| hints naming a non-existent knob / an already-off flag | S9.2 |
| `readOnlyHint:true` on a tool that types in the user's browser | S9.6 |
| docs claimed DDG `&s=`/`&df=`, 8 s settle on a 10 s adapter, "19 codes" for 18, a schema file that does not exist | S7.5, S13.3, S13.4 |
| `src/version.ts` stuck at 0.1.0 while the package is 0.1.1 | A5 |
| images adapter: 756 lines, zero fixtures, zero tests, zero docs | S6.1, S13.4 |
| page gate on by default and spending money in an "optional" feature | S11.5, ADR-0001 D1 |
| daily caps on free engines, persisted state, `E_RATE_LIMITED` | S10.1, ADR-0001 D8 |
| `web_read` documented as "marker settle" but extracted immediately | S5.1 |
