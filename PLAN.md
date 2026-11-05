# PLAN — phased execution with one orchestrator and parallel subagents

**Status:** v1 · 2026-11-05
**Scope:** how `SPEC.md` gets built, in which order, by which agent, with which gates.
**Precedence:** `SPEC.md` (what) → `PLAN.md` (in what order, by whom, proven how) → `AGENTS.md` (working rules).
If the plan and the spec disagree, the spec wins and the orchestrator files a `spec:` change.

Every phase in this document is owned by **one phase agent**. Within a phase the orchestrator may run
**parallel worker subagents**, but only inside the file-ownership and browser-exclusivity rules of §1.
A phase is done when its **validation gates** (§3) have been executed by the orchestrator — not by the
worker that wrote the code — and the evidence is committed under `evidence/`.

---

## 0. TL;DR

| Phase | Milestone | One-line deliverable | Parallel lanes | Serial lanes |
|---|---|---|---|---|
| P0 | pre-M0 | contracts, scaffold, audit script, test harness | — | all |
| P1 | M0 | CDP discovery/attach, lock, doctor | 3 | browser.ts, doctor wiring |
| P2 | M0.5 | compact/caps, cache, limiter, humanize, `web_search` shell | 4 | registry + tool budget |
| P3 | M1+M2 | Google, DuckDuckGo, Yandex adapters | 3 | integration + live smoke |
| P4 | M3+M4 | `web_read`, `image_search`, artifacts, doctor probes | 3 | tool surface + live smoke |
| P5 | M5 | System 1 reflex behind a flag + bench | 3 | wiring + bench verdict |
| P6 | M6 | `web_research` loop + codemode bench | 2 | budget audit + bench verdict |
| P7 | M7 | packaging, README, final hard-rules audit | 2 | pack/install + final live smoke |

The browser is a single shared resource: **only the orchestrator touches live Chrome, one operation at a
time, once**. Workers are offline-only. This is the rule that keeps the profile out of captcha jail.

---

## 1. Execution model

### 1.1 Roles

| Role | Count | Context | May write code | May run live Chrome | May commit |
|---|---|---|---|---|---|
| **Orchestrator** | 1, persistent | full repo + this plan | integration only (shared files) | **yes, exclusively, serialized** | **yes, only** |
| **Phase agent** | 1 per phase | phase section of this plan + SPEC | yes, inside its lanes | no | no |
| **Worker subagent** | 2–6 per phase | one lane packet | yes, only its owned files | no | no |
| **Reviewer** | 0–1 per phase | diff + gates | no (read-only tools) | no | no |

The orchestrator never delegates verification. It re-runs every gate command itself and records the raw
output in `evidence/P<N>.md`. Worker claims without reproducible commands are treated as unfinished work.

### 1.2 Launch mechanics

Use pi's subagent extension (`examples/extensions/subagent`, user-level agents only) or the equivalent
in the user's installed package:

- **Parallel mode** — `{ tasks: [...] }`: max 8 queued, **4 concurrent**. Use it for independent lanes.
- **Chain mode** — `{ chain: [...] }` with `{previous}`: lane → reviewer → fix. Use it when a lane must be
  reviewed before integration.
- **Single mode** — for a serial integration step.

Worker agents get a restricted tool allowlist (`read,edit,write,bash,grep,find,ls`), **no** `subagent`
(depth 1, no recursive fan-out), and no live flags (`PI_CHROME_LIVE` unset, `PI_CHROME_CDP_WS` unset).
Model choice: strong model for architecture/adapters/reflex; cheap model for fixtures/tests/docs.
Each worker task string must start with the lane id (`P2-A`) and end with the handoff block from §1.4.

Fallback if no subagent extension is installed: the orchestrator runs `pi --print` subprocesses with
`--session-id p2-a`, one bash call each, still one writer per file. Do not run two subprocesses that
touch the same file, and never two that touch Chrome.

### 1.3 One-writer rule and shared files

Parallel work only works because ownership is disjoint. Non-negotiable:

- A worker may create/edit **only** the files listed in its lane. Anything else → report `blocked`.
- **Shared files** are owned by the orchestrator for the whole project:
  `src/index.ts`, `src/config.ts`, `src/engines/types.ts`, `src/engines/index.ts`,
  `src/tools/types.ts`, `package.json`, `tsconfig.json`, `scripts/audit.mjs`, `evidence/**`, `PLAN.md`.
  Workers request changes through the handoff (`REQUEST:`) and the orchestrator applies them.
- `src/engines/types.ts` is **frozen** after P0. Additive fields need an orchestrator edit and a
  `contract:` commit so every lane sees the same interface.
- Adapters are appended to the registry by the orchestrator only (`src/engines/index.ts`), after their
  lane is green. No parallel edit of the registry.
- No worker runs `git commit`, `git checkout`, `git rebase`, or touches another worker's branch.
  The orchestrator commits one wave at a time.
- Tests are per-lane files (`tests/unit/<lane>.test.ts`); shared helpers live in `tests/helpers/` and are
  owned by P0/P1.
- Ownership is **per wave**. A later phase may edit a file whose owning wave is already committed and
  green (for example P4-C extends the P1-E doctor); it may not edit a file owned by a *concurrent* lane.

### 1.4 Handoff block (mandatory worker output)

Every worker ends with exactly this, in Markdown, no prose padding:

```
STATUS: done | blocked | partial
LANE: P2-A
FILES: <paths created/changed>
COMMANDS:
  <cmd> → exit <n>; <key output lines>
EVIDENCE: <fixture names / char counts / timings>
DEVIATIONS: <what the spec did not anticipate, or none>
REQUEST: <shared-file change needed, or none>
NEXT: <what the phase agent should do next>
```

The orchestrator copies `COMMANDS` output into `evidence/P<N>.md` after re-running it.

### 1.5 Waves, gates, repair loop

Work is scheduled in **waves**. A wave may mix lanes from two adjacent phases when the dependency
edges allow it (§2.2); that is the whole point of the orchestrator.

```
wave start
  ├─ orchestrator: freeze shared files, spawn lanes (≤4 concurrent)
  ├─ workers: implement + unit tests, offline only, return handoff
  ├─ orchestrator: review diff, run typecheck + lane tests + npm run audit
  ├─ on failure: repair attempt #1 (same lane), #2 (fresh worker), then escalate to user
  └─ wave green: orchestrator integrates shared files, commits, opens the gate
```

**Gate rule:** a gate item is `PASS` only with a command + observed result. `PARTIAL` needs a reason.
`BLOCKED` needs a user action named. Never mark a gate green because "it should work".

**Stop conditions** (orchestrator halts the wave and writes `evidence/P<N>-blocker.md`):
CDP disabled by the user, a captcha/consent wall the user has not solved, `typecheck` red after two
repairs, a lane touching an unowned file, any live probe that would need a retry loop, or a cost-guard
trip above `reflex.maxUsdPerSession`.

### 1.6 Live-browser policy for a parallel fleet

- Workers never set `PI_CHROME_LIVE=1`. Offline tests are the default and must pass without a browser.
- Live runs are scheduled **after** a wave is integrated and committed, by the orchestrator, one engine
  at a time: google → duckduckgo → yandex, `n=2` smoke first, then one `n=5` acceptance query.
- A wall ends the live session. Surface the window, ask the user, record `E_WALL`, **never** loop.
- At most one live probe per engine per phase gate; if a value is A/B-dependent (`ai:no`), record it as
  an outcome, not a failure.
- The lock file is the arbiter: if `~/.pi/agent/web-search.lock` is held, live work waits.

### 1.7 Cost and context budget

- Worker output ≤6 KB; the handoff block is what the orchestrator reads, not the transcript.
- Total wave context: orchestrator keeps a short wave summary, never pasted tool logs (use the evidence
  file instead).
- Classifier spend during P5/P6 bench: `maxUsdPerSession` applies; the orchestrator checks
  `decisions.jsonl` cost before and after the bench run.
- Tool-description budget (≤900 chars) and output cap (≤2500 chars) are *gates*, not aspirations.

---

## 2. Dependencies and wave schedule

### 2.1 Critical path

```
P0 ──► P1 ──► P2 ──► P3 ──► P4 ──► P5 ──► P6 ──► P7
        │      │      │      │      │
        └──────┴──────┴──────┘      └─ bench harness (P5-A) can start in P4
```

### 2.2 Waves (lane-level, not phase-level)

Lanes may be pulled forward only when every dependency named in `Ready` is green. Concurrency cap: 4
workers. At most **two phase agents** are active at the same time (the earlier phase must be in its
integration/gate step, not editing files the next phase needs), so integration never becomes archaeology.

| Wave | Lanes | Depends on |
|---|---|---|
| W0 | P0-A…P0-D (serial) | — |
| W1 | P1-A discovery, P1-B session, P1-C errors/log, P2-A compact/urls, P2-B cache/limiter, P2-C humanize | P0 contracts |
| W2 | P1-D browser/lock, P1-E doctor+CLI, P2-D `web_search` shell, P2-E registry+tool budget | W1 lanes |
| W3 | P3-Google, P3-DDG, P3-Yandex, P4-A `web_read`/SSRF | P2 contract + fixtures harness |
| W4 | P4-B images, P4-C artifacts/doctor probes, P4-D surface audit, P5-A bench harness | adapters for canaries; P2 for tools |
| W5 | P5-B rules/policy, P5-C classifier, P6-A `web_research` skeleton, P7-A README draft (file only) | P4 |
| W6 | P5-D reflex wiring, P6-B codemode bench | P5-A/B/C, P6-A |
| W7 | P7-B packaging + final audit (serial) | everything |

Live gates are not waves. They are serial steps between W2→W3, W3→W4, W4→W5, W6→W7.

---

## 3. Phases

Legend for gate results: `PASS` / `FAIL` / `PARTIAL` / `BLOCKED`. Evidence file per phase:
`evidence/P<N>.md` (template in `evidence/README.md`). Status column in §5 is maintained by the
orchestrator only.

---

### P0 — Contracts, scaffold, harness (pre-M0)

**Objective.** Freeze enough interface and tooling that 4+ agents can code in parallel without merge
conflicts, and that every later gate is a single command.

**Owner.** Orchestrator (serial; this is the only phase with no parallel lanes).

**Lanes**

| Lane | Deliverable | Files owned |
|---|---|---|
| P0-A | npm scaffold: `type: module`, `pi.extensions`, peer deps `@earendil-works/pi-coding-agent` + `typebox`, dep `ws`, dev `typescript`/`@types/ws`/`@types/node`; scripts `typecheck`, `test`, `test:live`, `bench`, `audit`; strict tsconfig; `.gitignore` | `package.json`, `tsconfig.json`, `.gitignore` |
| P0-B | frozen contracts: engine/tool/CDP types, error-code union + hint table, config type + strict loader (unknown key → `E_CONFIG`), no-op extension registration, `/web-doctor` stub | `src/engines/types.ts`, `src/engines/index.ts` (registry stub), `src/tools/types.ts`, `src/cdp/types.ts`, `src/runtime/types.ts`, `src/runtime/error-codes.ts`, `src/reflex/types.ts`, `src/version.ts`, `src/config.ts`, `src/index.ts`, `src/cli/doctor.ts` (stub) |
| P0-C | test harness: in-memory `CdpPage`, fake CDP ws server, injectable clock, fixture sanitizer rules, `evidence/` template | `tests/helpers/*`, `tests/fixtures/README.md`, `evidence/README.md` |
| P0-D | audit script: forbidden-import/flag greps, description-budget hook, secret scan, personal-data check for fixtures | `scripts/audit.mjs` |

**Ready.** SPEC read; user confirmed the plan.

**Validation gates**

| # | Command / action | PASS criteria |
|---|---|---|
| V0.1 | `npm run typecheck` | exit 0, no `any` in `src/` (`grep -rn ": any\\b" src/` empty) |
| V0.2 | `npm test` | contract tests green: config unknown key → `E_CONFIG`; every `ErrorCode` has a hint; version constants resolve |
| V0.3 | `pi -e ./src/index.ts --print "reply with OK"` | extension loads, no stderr error, model replies; `/web-doctor` dispatch verified in print mode — if it does not dispatch, `src/cli/doctor.ts` exists and `node src/cli/doctor.ts --json` runs |
| V0.4 | `npm run audit` | no `playwright` in `src/`/`tests/`; no `launch(`/`--enable-automation`/`--headless` in `src/`; no fingerprint overrides; no secrets |
| V0.5 | `npx tsc --noEmit` against a stub adapter + stub tool | Appendix A interfaces compile end-to-end |
| V0.6 | commit | `p0: contracts, scaffold, audit` |

**DoD.** Every lane merged; shared files frozen; `evidence/P0.md` complete. No browser involved.

---

### P1 — M0: attach, lock, doctor

**Objective.** Attach to the user's already-running Chrome over raw CDP, own one visible window/tab,
prove it is not an automation browser, and make the state diagnosable.

**Owner.** Phase agent P1 + 3 workers; P1-D/P1-E serial by the phase agent.

**Lanes**

| Lane | Deliverable | Files owned | Ready |
|---|---|---|---|
| P1-A | `discovery.ts`: `PI_CHROME_CDP_WS` → `PI_CHROME_CDP_PORTS` → `DevToolsActivePort` (profile dir order) → `9222`; loopback only; `E_CDP_UNAVAILABLE` with the exact chrome://inspect steps | `src/cdp/discovery.ts`, `tests/unit/discovery.test.ts`, `tests/fixtures/devtools-active-port/*` | P0-B |
| P1-B | `session.ts`: raw `ws` CDP client — connect/timeout, `Browser.getVersion`, `Target.getTargets/attachToTarget(flatten)`, `Page.navigate` + lifecycle settle, `Runtime.evaluate(awaitPromise,returnByValue)`, `Network.getCookies`, `Input.*`, `Page.captureScreenshot`, reconnect once, `E_CDP_DISCONNECTED`/`E_TARGET_LOST` | `src/cdp/session.ts`, `tests/unit/session.test.ts`, `tests/helpers/fake-cdp-server.ts` | P0-C |
| P1-C | `errors.ts` (constructors + text/JSON renderer with code/stage/hint/artifact), `log.ts` (JSONL append, size rotation) | `src/runtime/errors.ts`, `src/runtime/log.ts`, `tests/unit/errors.test.ts`, `tests/unit/log.test.ts` | P0-B |
| P1-D | `browser.ts`: dedicated window, one work tab per engine, reuse, focus policy `session\|always\|never`, lock file with PID+heartbeat (`~/.pi/agent/web-search.lock`), stale-lock reclaim, `E_BUSY`, close-only-owned | `src/cdp/browser.ts`, `tests/unit/browser.test.ts` | P1-A, P1-B |
| P1-E | doctor report assembly + per-engine probe (`n=1`, summary off) + `src/cli/doctor.ts --json` + `/web-doctor`, `/web-focus` | `src/runtime/doctor.ts`, `src/cli/doctor.ts`, `src/commands/doctor.ts`, `tests/unit/doctor.test.ts`, `tests/fixtures/doctor.schema.json` | P1-D |

Before P3 the probe loop has no adapters: each engine verdict is reported honestly as `unavailable`
(`E_UNSUPPORTED`), and the doctor must not crash or invent canaries. The deferred `web_doctor` tool is
delivered in P4-C (D11); P1 ships only the CLI and the command.

**Validation gates**

| # | Command / action | PASS criteria |
|---|---|---|
| V1.1 | `node --test tests/unit/discovery.test.ts tests/unit/session.test.ts tests/unit/errors.test.ts tests/unit/log.test.ts` | valid/missing/malformed `DevToolsActivePort`, env precedence, `/json/version` fallback; reconnect once; target-lost mapping; every error renders code+stage+hint |
| V1.2 | `node --test tests/unit/browser.test.ts` | second lock holder → `E_BUSY`; dead PID stale lock reclaimed; foreign tabs never closed; focus policy observed (spy on `Page.bringToFront`) |
| V1.3 | `node src/cli/doctor.ts --json` (live, once) | valid against schema; endpoint + browser version + profile dir; `navigator.webdriver === false`; lock free; owned tab reported; engine verdicts `unavailable` until P3 (no crash, no invented canaries) |
| V1.4 | `grep -rn "playwright\\|launch(" src/` | empty (attach path has no launcher) |
| V1.5 | `PI_CHROME_CDP_WS=ws://127.0.0.1:1 node src/cli/doctor.ts --json` | `E_CDP_UNAVAILABLE` with actionable hint, exit non-zero, no hang beyond `connectTimeoutMs` |
| V1.6 | `npm test && npm run audit` | green; commit `m0: cdp attach, lock, doctor` |

**User blocker B0.** If `DevToolsActivePort` is absent: ask the user once to open
`chrome://inspect/#remote-debugging`, tick, **Allow**, then re-run V1.3. Do not launch Chrome, do not
copy the profile. Mark P1 `BLOCKED` in §5 and continue only with offline lanes P2.

**DoD.** Attach works on the user's browser, doctor is honest, no automation surface. `evidence/P1.md`
includes the raw doctor JSON (redact the exact IP, keep the structure).

---

### P2 — M0.5: search plumbing (no engines yet)

**Objective.** Everything an adapter should not have to think about: caps, dedup, URL hygiene, cache,
pacing, human typing, and the `web_search` tool shell with a frozen output contract.

**Owner.** Phase agent P2 + 4 workers; P2-D/P2-E serial.

**Lanes**

| Lane | Deliverable | Files owned |
|---|---|---|
| P2-A | `compact.ts`: caps (summary 1200, snippet 140, output 2500), never drop summary before results, dedup by normalized URL, ≤2 per domain unless `n` needs it, tracking-param strip, mixed-engine merge (engine tag only when mixed), `pageCarried`; `urls.ts`: normalize, `/goto` + `/url` parsing, domain extraction | `src/extract/compact.ts`, `src/extract/urls.ts`, `tests/unit/compact.test.ts`, `tests/unit/urls.test.ts` |
| P2-B | `cache.ts` (LRU 200, SERP TTL 10 min, `/goto` TTL 24 h, injectable clock); `limiter.ts` (per-engine gap + jitter, daily soft caps persisted in `~/.pi/agent/web-search/state.json`, `E_RATE_LIMITED`) | `src/runtime/cache.ts`, `src/runtime/limiter.ts`, `tests/unit/cache.test.ts`, `tests/unit/limiter.test.ts` |
| P2-C | `humanize.ts`: click search box, `Input.dispatchKeyEvent` at 30–80 ms/char with jitter, Enter, marker-based settle with deadline, 300–900 px scroll, abort-aware sleeps | `src/cdp/humanize.ts`, `tests/unit/humanize.test.ts` |
| P2-D | `web_search.ts`: typebox input, ≤350-char description, annotations (`readOnlyHint`, `openWorldHint`, `idempotentHint`), `direct` exposure, engine dispatch, compact md/json render, failure rendering with `details` | `src/tools/web_search.ts`, `tests/unit/web_search.test.ts` |
| P2-E | registry finalize (append-only adapter map, `auto` order google→ddg→yandex, yandex last), `src/index.ts` wiring, tool-budget test over all registered descriptions | `src/engines/index.ts`, `tests/unit/tool_budget.test.ts` |

**Validation gates**

| # | Command / action | PASS criteria |
|---|---|---|
| V2.1 | `node --test tests/unit/compact.test.ts` | property test: any `RawSerp`, `n≤10` → output ≤2500 chars, AI ≤1200, snippet ≤140; summary never dropped while results are; dedup keeps best snippet; `utm_*`/`gclid`/`yclid`/`from`/`redircnt`/`si` stripped |
| V2.2 | `node --test tests/unit/cache.test.ts` | cache hit performs 0 navigations (spy); TTL expiry re-fetches; `/goto` cache survives 10 min, dies at 24 h; LRU evicts at 200 |
| V2.3 | `node --test tests/unit/limiter.test.ts` | gap+jitter inside configured windows with seeded RNG; cap throws `E_RATE_LIMITED` with hint; state survives process restart (reload from disk) |
| V2.4 | `node --test tests/unit/humanize.test.ts` | keystroke delays in [30,80] ms; scroll in [300,900] px; settle polls marker and honours deadline/abort |
| V2.5 | `node --test tests/unit/web_search.test.ts` | invalid args rejected without navigation; `format:"json"` matches the documented schema; failure text contains code+stage+hint+artifact |
| V2.6 | `node --test tests/unit/tool_budget.test.ts` | `web_search` description ≤350 chars; all declared+deferred descriptions ≤900 chars |
| V2.7 | `npm test && npm run audit` | green; commit `m0.5: search plumbing` |

**DoD.** A stub engine (fixture-driven) produces a compliant `web_search` result without touching Chrome.
`evidence/P2.md` records the measured char counts for `n=5` and `n=10`.

---

### P3 — M1+M2: Google, DuckDuckGo, Yandex

**Objective.** Three independent adapters against the live DOM, with native AI summaries, wall
detection, `/goto` resolution, and no fabrication.

**Owner.** Phase agent P3 + 3 workers (one per engine). Live work only by the orchestrator.

**Lanes** (disjoint by file; all offline until the live gate)

| Lane | Deliverable | Files owned |
|---|---|---|
| P3-Google | `buildUrl` (`hl/gl`, `start`, `tbs`, optional `udm=14`), settle on `#rso`/`#search` with deadline, `detectWall` (`/sorry`, consent, `unusual traffic`), AI Overview via `section` innerText containing `Обзор от ИИ`/`AI Overview` (strip label, cap), organics `a h3` + `closest('div[data-hveid]')` + `.VwiC3b,[data-sncf]`, ad skip, `/goto` HTTP resolve with browser cookies + `redirect:manual` (302→Location; 200-no-redirect → single nav fallback then keep wrapper, cached), canaries | `src/engines/google.ts`, `tests/unit/google.test.ts`, `tests/fixtures/google-{ai,no-ai,wall,empty}.html.gz` + `meta.json`, `tests/fixtures/goto-{302,200}.json` |
| P3-DDG | `buildUrl` `kl`, settle on `a[data-testid="result-title-a"]`, Search Assist slice between 2nd `Search Assist` and the RU/EN disclaimer, organics + `[data-result="snippet"]` + `closest('article')`, ad skip (`y.js`, `[data-result="ad"]`), canaries | `src/engines/duckduckgo.ts`, `tests/unit/duckduckgo.test.ts`, `tests/fixtures/ddg-{assist,no-assist,empty}.html.gz` + `meta.json` |
| P3-Yandex | `buildUrl` (`text`, `p`, `within` if verified), settle on `.OrganicTitle`/9 `h3`, `detectWall` (`/showcaptcha`, `SmartCaptcha`, `Я не робот`), `retryOnWall: true` flag, AI h3 `/Быстрый ответ\|Нейро\|Алиса AI/` inside `Futuris*`, expand `FactFold` via `Показать полностью` once, strip `Содержимое ответа` + bare domain lines, direct links minus `redircnt`, skip `jsredir`, canaries | `src/engines/yandex.ts`, `tests/unit/yandex.test.ts`, `tests/fixtures/yandex-{neuro,no-neuro,captcha,empty}.html.gz` + `meta.json` |

**Fixture rule.** Fixtures are captured by `research/probes/03-dom-dump.mjs`, then sanitized: no cookies,
no tokens, no account email, no query history, no exact IP, no `sxsrf`/`reqid` values. `meta.json` stores
engine, url path shape, query class (not the literal personal query), and capture date. `npm run audit`
fails on a personal-data pattern.

**Validation gates**

| # | Command / action | PASS criteria |
|---|---|---|
| V3.1 | `node --test tests/unit/{google,duckduckgo,yandex}.test.ts` | each engine: AI-present and AI-absent fixtures produce `ai:yes`/`ai:no`; wall fixture → `Wall` with kind; empty fixture → `E_EMPTY` path; results carry title/url/snippet |
| V3.2 | canary test | each adapter reports expected canary counts on its fixtures; a zero canary raises `E_PARSE` with artifact (no silent empty result) |
| V3.3 | `node --test tests/unit/urls.test.ts` + google `/goto` tests | 302 → real URL; 200-no-redirect → one nav fallback then wrapper URL, marked unresolved; resolution cached 24 h |
| V3.4 | merge test | google+ddg same URL deduped; `n` respected; engine tag only when mixed; total ≤2500 chars |
| V3.5 | **LIVE, serial, orchestrator**: one `web_search` per engine, `n=2` smoke then one `n=5` | google: `ai:yes` with a known AI-Overview query or documented `ai:no`, ≥5 results, ≤2500 chars; ddg: ≥5 results, assist if A/B present; yandex: wall → automatic single retry (~3 s) → record both states; persistent wall → `E_WALL` + hint, stop |
| V3.6 | artifact inspection | `E_PARSE`/`E_WALL` produced `page.html`, `page.txt`, `screenshot.jpg`, `meta.json` in the artifact dir |
| V3.7 | `npm test && npm run audit` | green; commits `m1: google adapter`, `m2: yandex + duckduckgo adapters` |

**DoD.** All three engines pass live smoke once; AI absence is reported as `ai:no`, never invented;
`evidence/P3-live.md` stores engine/query-class/ai/results/chars/latency/wall transitions (no personal
data). `research/FINDINGS.md` updated if a selector moved.

---

### P4 — M3+M4: read, images, artifacts, doctor completeness

**Objective.** Page reading with SSRF protection, best-effort image search, artifact retention, and a
doctor that can actually diagnose every engine.

**Owner.** Phase agent P4 + 3 workers; surface audit serial.

**Lanes**

| Lane | Deliverable | Files owned | Ready |
|---|---|---|---|
| P4-A | `extract/read.ts` (article/main scoring, strip nav/footer/aside/cookie banners, Markdown) + `runtime/ssrf.ts` (block localhost/127/8, 10/8, 172.16/12, 192.168/16, `::1`, `169.254/16`, `file:`, `data:`; re-check on redirect) + `web_read.ts` (offset, `maxChars` 6000/ceiling 20000, `truncated`/`nextOffset`/`title`/`byline`/`publishedAt`, http(s) only, domain audit log) | `src/extract/read.ts`, `src/runtime/ssrf.ts`, `src/tools/web_read.ts`, `tests/unit/{read,ssrf,web_read}.test.ts`, `tests/fixtures/read-*.html.gz` | P2 |
| P4-B | `engines/images.ts` (Google `tbm=isch`, Yandex images) + `image_search.ts` (`n≤12`, default 4, `attach` ≤4 thumbnails off by default, deferred) | `src/engines/images.ts`, `src/tools/image_search.ts`, `tests/unit/images.test.ts`, `tests/fixtures/images-*.html.gz` | P2 + P3 patterns |
| P4-C | `artifacts.ts` (dir `<ts>-<engine>-<hash>`, HTML sanitized of form values, retention 30 dirs / 50 MB); doctor per-engine probes + canary aggregation + safe `--fix` (reconnect, close orphan owned tabs, prune artifacts, clear stale lock only); deferred `web_doctor` tool (D11) | `src/runtime/artifacts.ts`, updates to `src/runtime/doctor.ts`, `src/cli/doctor.ts`, `src/tools/web_doctor.ts`, `tests/unit/artifacts.test.ts`, `tests/unit/doctor_engines.test.ts` | P1-E + P3 |
| P4-D | tool-surface audit: `web_read`/`image_search` exposure `deferred`, total description budget, no prompt-visible deferred tools | `tests/unit/tool_surface.test.ts`, `evidence/P4-surface.md` | P2-E + P4-A/B |

**Validation gates**

| # | Command / action | PASS criteria |
|---|---|---|
| V4.1 | `node --test tests/unit/{read,ssrf,web_read}.test.ts` | docs fixture → clean Markdown ≤6000 chars; continuation via `offset` reaches the end; `truncated`/`nextOffset` consistent; private/file/data URLs and redirect-to-private → `E_BLOCKED_URL`; no HTML returned |
| V4.2 | `node --test tests/unit/images.test.ts` | ≥4 items with `thumbUrl/alt/pageUrl/domain`; `attach` default off; ad/`encrypted-tbn` handling as specified |
| V4.3 | `node --test tests/unit/artifacts.test.ts` | retention prunes to 30 dirs / 50 MB; form values absent from saved HTML; `.gitignore` covers artifacts |
| V4.4 | `node --test tests/unit/doctor_engines.test.ts` + live `doctor --json` | schema-valid; per-engine verdict `ok\|wall\|layout_changed\|blocked\|unavailable`; `--fix` spawns no Chrome process and kills none (assert via spy/fake) |
| V4.5 | `node --test tests/unit/tool_surface.test.ts` | `web_search` direct; others deferred; all descriptions ≤900 chars |
| V4.6 | **LIVE, serial, orchestrator**: one `web_read` of a docs page; one image query | clean Markdown ≤6000 chars; ≥4 image items; timing recorded |
| V4.7 | `npm test && npm run audit` | green; commits `m3: web_read`, `m4: images, artifacts, doctor` |

**DoD.** Read/image/doctor gates green, deferred surface verified, artifacts retention proven.
`evidence/P4.md` includes the doctor JSON after `--fix` (no Chrome restart).

---

### P5 — M5: System 1 behind a flag, bench-gated

**Objective.** Optional reflex layer that triages, gates reads, and judges coverage — always with a
deterministic rules fallback, never on the critical path, enabled only if the bench proves it.

**Owner.** Phase agent P5 + 3 workers; wiring/verdict serial.

**Lanes**

| Lane | Deliverable | Files owned |
|---|---|---|
| P5-A | `bench/queries.jsonl` (~30 RU/EN; factual/technical/commercial/news/ambiguous; 2–4 golden domains each, no personal queries) + `bench/run.ts` (offline replay + `--live` opt-in; metrics recall@5, returned chars/tokens, latency p50/p95, spam caught, abstain rate; writes `bench/results/<ts>.json`) | `bench/queries.jsonl`, `bench/run.ts`, `bench/README.md` |
| P5-B | `reflex/types.ts`, `rules.ts` (BM25-ish overlap + domain prior + URL dedup; read gate keyword/allowlist; coverage "no new domains"; route rules), `policy.ts` (abstain <0.55, latency deadline, per-search/session/USD budgets, 24 h verdict cache, JSONL decision log, always logs rules verdicts) | `src/reflex/types.ts`, `src/reflex/rules.ts`, `src/reflex/policy.ts`, `tests/unit/reflex_rules.test.ts`, `tests/unit/reflex_policy.test.ts` |
| P5-C | `classifier.ts`: `ctx.modelRegistry.getAvailableOfType("classifier", …)`, `classify()` with typed questions, `stopReason`/`errorMessage` handling, `localOnly` guard, duration timeout, batching experiment **off** | `src/reflex/classifier.ts`, `tests/unit/reflex_classifier.test.ts` |
| P5-D | wiring: route in `auto` selection, triage before return when `triage.when` matches, read gate before `web_read`, coverage hook for P6, decision log in all paths | `src/reflex/index.ts`; edits to `src/tools/{web_search,web_read}.ts` (owners already committed, no concurrent lane touches them) |

**Validation gates**

| # | Command / action | PASS criteria |
|---|---|---|
| V5.1 | `node --test tests/unit/reflex_*.test.ts` | with `enabled:false` zero registry calls (spy); rules verdicts deterministic (seeded) |
| V5.2 | budget tests | call #31 in one search / #501 in a session / exceeding `maxUsdPerSession` → fall back to rules, no throw, budget event logged |
| V5.3 | abstain tests | `confidence<0.55`, `stopReason!=="stop"`, `errorMessage`, or over-deadline → rules verdict, latency bounded |
| V5.4 | `localOnly` test | fake remote registry asserts it is never called; with no local model → rules |
| V5.5 | `decisions.jsonl` schema test | every row: decision, verdict, confidence, latencyMs, model, usage, costUsd, fallback; no secrets; rotation works |
| V5.6 | bench: `npm run bench` (offline) then one `--live` run | recall@5 within 2 points of baseline **and** returned tokens ≥20% down (triage) / reads ≥30% down (gate) → flag may be enabled; else keep `reflex.enabled:false` and record the numbers |
| V5.7 | cost check | `decisions.jsonl` costUsd for the session ≤ `maxUsdPerSession`; search traffic never left the browser |
| V5.8 | `npm test && npm run audit` | green; commit `m5: system 1 behind flag` with bench verdict in the message |

**DoD.** Default config still `reflex.enabled:false`; `bench/RESULTS.md` states shipped/not shipped with
numbers; no classifier on the critical path.

---

### P6 — M6: `web_research` + codemode comparison

**Objective.** One-call evidence gathering with hard budgets, and an honest measurement of direct vs
codemode vs `web_research`.

**Owner.** Phase agent P6 + 2 workers; verdict serial.

**Lanes**

| Lane | Deliverable | Files owned |
|---|---|---|
| P6-A | `web_research.ts`: budgets quick 1+2 / normal 2+4 / deep 4+8, loop search→triage→read top-k→coverage (reflex if enabled, fixed budget otherwise), evidence bundle {claims, citations, excerpts}, dedup, hard token cap, abort; deferred | `src/tools/web_research.ts`, `tests/unit/web_research.test.ts`, `tests/fixtures/research-*.json` |
| P6-B | codemode comparison: same query set through direct calls, a codemode script (`Promise.allSettled`), and `web_research`; tokens/latency/calls/recall; winner recorded | `bench/codemode.ts`, `bench/RESULTS.md` |

**Validation gates**

| # | Command / action | PASS criteria |
|---|---|---|
| V6.1 | budget tests | each budget performs exactly its allowance (spy on search/read); abort cancels in-flight; no read beyond budget |
| V6.2 | evidence test | every claim has a `sourceUrl` present in the evidence results; citations resolve; output respects the hard token cap; no fabricated domain |
| V6.3 | reflex-off run | works with `reflex.enabled:false` and `localOnly:true` |
| V6.4 | bench | three paths measured on the same queries; winner + recommendation written; `codemode` remains optional (not required by the extension) |
| V6.5 | `npm test && npm run audit` | green; deferred exposure intact; descriptions ≤900 chars; commit `m6: web_research + codemode bench` |

**DoD.** `web_research` respects budgets and citations; bench decision recorded; no global settings change
required.

---

### P7 — M7: packaging, docs, final audit

**Objective.** A tarball that installs cleanly, docs a new user can follow, and proof that none of the
hard rules were broken along the way.

**Owner.** Orchestrator + 2 workers (packaging lane and docs lane), then a serial final audit.

**Lanes**

| Lane | Deliverable | Files owned |
|---|---|---|
| P7-A | `package.json` metadata/`files`/`pi.extensions`; README (install, CDP enable flow exactly as verified, config, privacy/ToS, doctor, troubleshooting, token budget); LICENSE decision recorded | `README.md`, `package.json` (via orchestrator) |
| P7-B | final audit extension: `playwright`/launch/headless/fingerprint/captcha-solver greps, secret scan, fixture personal-data scan, tool-description budget, cap tests; `docs/` consistency (SPEC↔PLAN↔AGENTS) | `scripts/audit.mjs` (orchestrator applies the diff), `evidence/P7.md` |

**Validation gates**

| # | Command / action | PASS criteria |
|---|---|---|
| V7.1 | `npm pack --dry-run` | only intended files; no `node_modules`, artifacts, `.env`, personal fixtures, screenshots |
| V7.2 | install the tarball into a temp `PI_CODING_AGENT_DIR`, then load it | extension loads; `/web-doctor` runs; `pi install ./pi-chrome-search-<v>.tgz` dry-run documented |
| V7.3 | README review against SPEC §11–§12 | all commands/config/env keys documented; CDP clicks match the verified flow; ToS/privacy honestly stated |
| V7.4 | `npm run audit && npm test && npm run typecheck` | green, zero waivers — or every waiver listed with a reason |
| V7.5 | final live smoke (serial, once per engine) | 3 engines complete: `ai:yes/no`, results ≥5, chars ≤2500, latency, wall transitions |
| V7.6 | evidence completeness | `evidence/P0…P7.md` exist; §5 status table has no unexplained `PARTIAL`; FINDINGS/SPEC/AGENTS consistent |
| V7.7 | commit | `m7: packaging, docs, final audit` |

**DoD.** Installable package, honest docs, audited hard rules, complete live-smoke table.

---

## 4. Cross-phase checklists

### 4.1 Hard rules (run at every wave, enforced by `npm run audit`)

| Rule | Check |
|---|---|
| Attach only, no automation launch | `grep -rn "playwright" src/ tests/` empty; `grep -rn "launchPersistentContext\|--enable-automation\|--headless" src/` empty; dev `mode:"launch"` path guarded and never touches the default profile |
| No fingerprint spoofing | `grep -rn "addScriptToEvaluateOnNewDocument\|Emulation.set\|setUserAgentOverride\|navigator.webdriver *=" src/` empty |
| Never kill/close the user's Chrome | `grep -rn "process.kill\|pkill\|chrome.*--restart" src/` empty; close-only-owned test |
| No captcha solving | `grep -rni "2captcha\|anticaptcha\|solve.*captcha" src/` empty |
| No paid search APIs / keys | no SerpApi/Serper/Brave/Tavily/Exa/Kagi imports; only registry-based classifiers |
| Rate limit | limiter tests + one-query live policy + daily caps persisted |
| Cheap prompt | tool-budget test ≤900 chars total |
| Diagnosable failures | every thrown failure is from `runtime/errors.ts`; `E_*` render code+stage+hint(+artifact) |
| Live discipline | one live run per engine per gate; no retry loops; wall → stop |

### 4.2 Live smoke log (orchestrator fills; no personal queries)

| Phase | Engine | Query class | `ai` | Results | Chars | Latency | Wall | Verdict |
|---|---|---|---|---|---|---|---|---|
| P3 | google | technical RU | | | | | | |
| P3 | duckduckgo | factual EN | | | | | | |
| P3 | yandex | commercial RU | | | | | | |
| P4 | — (read) | docs page | — | — | | | | |
| P5 | — (bench) | 30-query set | — | — | | | | |

### 4.3 Commit and evidence discipline

- One commit per wave or gate closure: `p0:`, `m0:`, `m0.5:`, `m1:`, `m2:`, `m3:`, `m4:`, `m5:`, `m6:`,
  `m7:`, plus `fix(parse):`, `fix(cdp):`, `contract:`, `spec:`, `docs:`.
- Commit body: the gate ids that now pass, the live-smoke line (engine, query class, `ai`, chars, latency),
  and the measured token/output budget.
- `evidence/P<N>.md` holds command → result pairs, doctor JSON (redacted), bench numbers. No screenshots,
  no cookies, no personal queries.
- `PLAN.md` §5 status is edited by the orchestrator only. Workers never mark their own gate green.

---

## 5. Status tracking

| Phase | Status | Gate evidence | Blocker / note |
|---|---|---|---|
| P0 contracts | `[x]` | `evidence/P0.md` | contracts, scaffold, harness, audit green |
| P1 attach/doctor | `[ ]` | `evidence/P1.md` | needs B0 (CDP enable) |
| P2 plumbing | `[ ]` | `evidence/P2.md` | — |
| P3 engines | `[ ]` | `evidence/P3.md`, `evidence/P3-live.md` | live serial |
| P4 read/images/doctor | `[ ]` | `evidence/P4.md` | live serial |
| P5 reflex | `[ ]` | `evidence/P5.md`, `bench/RESULTS.md` | bench gate decides |
| P6 research | `[ ]` | `evidence/P6.md` | — |
| P7 packaging | `[ ]` | `evidence/P7.md` | — |

Status values: `[ ]` not started · `[~]` in progress · `[x]` gates pass · `[!]` blocked (reason
required) · `[-]` waived (orchestrator + user approve, reason required).

---

## Appendix A — frozen contracts (P0; additive changes need a `contract:` commit)

```ts
// src/engines/types.ts
export type EngineId = "google" | "duckduckgo" | "yandex";
export type Freshness = "d" | "w" | "m" | "y";

export interface Query {
  text: string; lang?: string; region?: string;
  n: number; page?: number; freshness?: Freshness; summary: boolean;
}
export interface SerpItem {
  title: string; url: string; snippet: string; isAd?: boolean; sourceQuery?: string;
}
export interface AiSummary { text: string; sources: string[]; }
export interface RawSerp {
  engine: EngineId; query: string; ai?: AiSummary; results: SerpItem[];
  pageCarried: boolean; degraded?: boolean;
  timings: { navigateMs?: number; settleMs?: number; extractMs?: number };
}
export type WallKind = "captcha" | "consent" | "sorry" | "blocked";
export interface Wall { kind: WallKind; url: string; markers: string[]; }

export interface Engine {
  readonly id: EngineId;
  readonly retryOnWall?: boolean;           // yandex only
  buildUrl(q: Query): string;
  settle(page: CdpPage, signal?: AbortSignal): Promise<void>;
  detectWall(page: CdpPage): Promise<Wall | null>;
  extract(page: CdpPage, q: Query): Promise<RawSerp>;
  canaries(page: CdpPage): Promise<Record<string, number>>;
}
```

```ts
// src/cdp/types.ts — the surface adapters may use, nothing more
export interface CdpPage {
  url(): string;
  title(): Promise<string>;
  navigate(url: string, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  evaluate<T>(expression: string, o?: { awaitPromise?: boolean }): Promise<T>;
  innerText(selector?: string): Promise<string>;
  html(): Promise<string>;
  click(selectorOrPoint: string | { x: number; y: number }): Promise<void>;
  typeText(text: string, o?: { minMs?: number; maxMs?: number }): Promise<void>;
  press(key: string): Promise<void>;
  scroll(dy: number): Promise<void>;
  screenshot(): Promise<Buffer>;
  cookiesFor(urls: string[]): Promise<Array<{ name: string; value: string; domain: string }>>;
  bringToFront(): Promise<void>;
}
```

```ts
// src/runtime/error-codes.ts
export type ErrorCode =
  | "E_CONFIG" | "E_CDP_UNAVAILABLE" | "E_CDP_DISCONNECTED" | "E_TARGET_LOST"
  | "E_WALL" | "E_EMPTY" | "E_PARSE" | "E_TIMEOUT" | "E_RATE_LIMITED" | "E_BUSY"
  | "E_BLOCKED_URL" | "E_UNSUPPORTED" | "E_CANCELLED";

export type Stage = "config" | "discover" | "connect" | "navigate" | "settle"
  | "extract" | "resolve" | "render" | "read" | "reflex";
export interface FailureDetails {
  code: ErrorCode; engine?: EngineId; stage: Stage; wall?: WallKind;
  artifact?: string; retryable: boolean; hint: string;
}
```

```ts
// src/tools/types.ts — dependency injection; tools never import Chrome directly
export interface ToolDeps {
  config: Config; engines: EngineRegistry; cdp: CdpConnector;
  cache: Cache; limiter: Limiter; artifacts: Artifacts; log: Logger;
  clock: Clock; reflex?: Reflex;
}
```

```ts
// src/engines/index.ts — append-only registry, orchestrator-owned
export interface EngineRegistry {
  get(id: EngineId): Engine;              // throws E_UNSUPPORTED if absent
  enabled(): EngineId[];                  // config order, yandex last in "auto"
}
```

Non-negotiable contract points: `buildUrl` is pure; adapters never navigate themselves; adapters never
take screenshots or write artifacts (the tool layer does); adapters return raw data only, and all caps are
applied in `extract/compact.ts`; `RetryOnWall` lives in the adapter flag, the retry happens in the tool.

### A.1 P0 deltas (frozen 2026-11-06, `p0:` commit)

These are the interfaces actually committed in P0; later phases must not change them without a
`contract:` commit.

- `EngineSelection = "auto" | EngineId | EngineId[]` (D9) and
  `EngineRegistry.has(id)`, `EngineRegistry.select(requested): EngineId[]` (D10: `auto` → canonical
  order, explicit lists keep caller order, disabled/unknown ids are dropped).
- `Engine.extract(page, q)` — the query is required (page/freshness/summary affect extraction).
- `SerpItem.engine?: EngineId` is set by the merge layer only when results are mixed; `RawSerp.timings`
  is a required object (may be `{}`).
- `CdpConnector` (in `src/cdp/types.ts`): `connect()`, `acquirePage(engine)`, `releaseAll()`,
  `isConnected()`, `endpoint()`. `CdpEndpoint` carries `port`, `wsUrl`, `source`, `profileDir?`.
- `src/runtime/types.ts`: `Clock`, `Cache` (generic key/value), `Limiter`, `Artifacts`, `Logger`,
  `DecisionLogRow`. `src/runtime/error-codes.ts` also owns `WebSearchError`, `ERROR_HINTS`, `RETRYABLE`.
- `src/reflex/types.ts`: `Reflex`, `Candidate`, `Evidence`, `CoverageVerdict`, `Route`.
- Additive config key `cdp.profileDir` (default `null`) backs `PI_CHROME_SEARCH_PROFILE` (launch mode only).
  It is not written back by the extension; window bounds live in state, not config.
- Test harness (P0-C) lives in `tests/helpers/` and is the only shared test surface; lane tests must not
  edit it without an orchestrator handoff.

---

## Appendix B — worker prompt template

```text
You are worker <LANE> of pi-chrome-search. Read AGENTS.md, then PLAN.md §1 and the <PHASE> section.
Own ONLY these files: <list>. Do not edit anything else; do not commit; do not run git.
Offline only: no PI_CHROME_LIVE, no PI_CHROME_CDP_WS, no live search engines, no browser.
Contract: PLAN.md Appendix A (frozen). If a contract change is needed, stop and put it in REQUEST.
Deliverable: <one paragraph>.
Tests: <test files> must pass with `node --test <paths>`.
Definition of done: code + tests + no `any`, no `playwright`, errors via runtime/errors.ts.
End with the handoff block from PLAN.md §1.4. Do not pad with prose.
```

## Appendix C — reviewer checklist (read-only agent)

1. Only owned files changed? (`git status`/`git diff --stat`)
2. Contract respected (Appendix A), no new dependency, no `any`.
3. Failure paths return `FailureDetails` with code+stage+hint; no bare `throw new Error`.
4. Caps applied in `compact.ts` only; adapters return raw data.
5. Selectors have a canary; fixtures sanitized.
6. Tests fail if the feature is removed (spot-check one assertion).
7. Hard-rule greps from §4.1 clean.
8. Handoff block matches reality (commands re-run by the reviewer).
Verdict: `approve` / `approve-with-nits` / `reject(<reason>)`.

## Appendix D — phase → SPEC milestone map

| PLAN phase | SPEC milestone | Notes |
|---|---|---|
| P0 | pre-M0 | not in SPEC §14; adds frozen contracts and `scripts/audit.mjs` |
| P1 | M0 | splits M0 into 3 parallel lanes + 2 serial |
| P2 | M0.5 | plumbing that M1 needs; keeps M1 commit focused on Google |
| P3 | M1 + M2 | Google first, then DDG/Yandex in parallel, single live gate |
| P4 | M3 + M4 | read SSRF gate is a security gate, not a nice-to-have |
| P5 | M5 | bench-first; shipping is conditional |
| P6 | M6 | `web_research` + codemode bench |
| P7 | M7 | packaging + final hard-rules audit |

Effort: P0–P2 ≈ 2–3 days, P3 ≈ 2–3 days, P4 ≈ 1–2 days, P5 ≈ 2–3 days, P6 ≈ 1–2 days, P7 ≈ 1 day.
The parallel wall-clock is bounded by the serial live gates and by P0's contract quality.
