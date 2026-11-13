# ADR 0001 — v2 product decisions

- **Status:** accepted
- **Owner approval:** 2026-11-13, sh2nk (answers to `SPEC.md` §15)
- **Phase:** P0 (unblocks P1–P8)
- **Requirements:** S3, S4, S5, S8, S10, S11, S13

## Context

The v1 audit (see `SPEC.md` appendix) found a product whose core loop was unreachable, whose config
contained five keys nobody read, and whose "quality" layer was a paid, default-on classifier plus
deterministic heuristics that rejected pages before the agent could look at them. The owner reviewed
each decision below and chose the simpler product in every case. These answers are binding for the
rewrite; changing one requires a new ADR.

## Decisions

### D1 — Delete the classifier and every built-in quality gate

`src/reflex/**` (classifier, policy, rules, types) is deleted. Nothing replaces it: no model call, no
local heuristic, no page-quality score, no "read gate", no coverage gate. `web_read` reads the URL it is
given (the SSRF guard still applies — it is a security boundary, not a quality opinion). `web_research`
selects pages deterministically: merge order, dedupe, top-N.

Rationale: the v1 benchmark showed no honest token win; the page gate was on by default, spent the
user's OpenRouter balance, and its only visible effect was refusing pages the agent had already chosen.
A gate whose success is "returned less" is not a product feature.

Consequences: `config.reflex.*` disappears, `E_UNSUPPORTED` loses its "declined by gate" meaning,
research becomes deterministic and testable offline, and ~4k LOC plus the OpenRouter coupling leave the
tree. The agent is responsible for its own choices; the tools stay honest about what they returned.

### D2 — No `freshness` argument; date narrowing is the agent's job

`freshness` is removed from `web_search` (v1 silently ignored it on DuckDuckGo). Google's `&tbs=qdr=`
and Yandex's date parameter are not exposed either. Instead `web_search` declares `promptGuidelines`
teaching the operators that narrow a query: quoted phrases, `-term`, `OR`, `site:`, `filetype:`, and
engine date operators (`after:`/`before:` on Google, `date:` on Yandex). `q` stays verbatim.

Consequences: one less argument, one less silent lie, no selector for a parameter nobody verified. The
guideline is prompt text (budgeted, ≤400 chars), so a fresh session learns the operators without a
config knob. `page` remains an argument, and DuckDuckGo still reports `ignored.page`.

### D3 — Tool surface: two direct tools, the rest deferred with guaranteed discovery

`web_search` and `web_read` are `direct`. `image_search`, `web_research`, `web_doctor` stay `deferred`,
but the extension activates the discovery tool itself and falls back to registering them `direct` when
that tool is absent. Reachability never depends on the user editing settings (v1's central defect).

### D4 — In-place rewrite

The rewrite replaces modules in place on `feature/v2-rewrite`, one phase per PR, deleting the legacy
module in the PR that replaces it. No parallel `v2/` tree, no long-lived feature flag.

### D5 — A wall is immediate

No `captcha.retryYandexOnce`, no `captcha.waitMs`, no automatic re-navigation after a wall. A wall is
`E_WALL` with an artifact and the window surfaced, at once. The human wants to know about the captcha
immediately so they can click it; the tool waits for them to retry, not for a timer to expire.

Consequences: the `captcha.*` config block disappears, and a test asserts zero navigations after a wall.

### D6 — Engine order

`auto` keeps Yandex last (a wall costs a human solve). An explicit list is honoured in the caller's
order. A merged coverage set reports per-engine counts and failures.

### D7 — Budgets are generous, deadlines are real

`search.budgetMs` 60000, `read.budgetMs` 30000, `research.budgetMs` 300000, tool descriptions ≤1200
total, search-operator guideline ≤400. A call still has exactly one deadline (S8); the number is
looser, the mechanism unchanged.

### D8 — No daily caps, no rate-limit state file

The search engines are free and a daily quota was an unmeasured guess that turned a policy question
into a runtime error. `engines.*.dailyCap`, the persisted `state.json`, and `E_RATE_LIMITED` are
deleted. Politeness remains as **pacing** (per-engine minimum gap with jitter) and **one in-flight
search per engine**, which is what actually prevents simultaneous typing and suspicious bursts.

Consequences: no state file to go stale, no midnight rollover code, no `E_RATE_LIMITED`. If the engines
ever complain, the answer is `E_WALL` and a human, not a hidden counter.

### D9 — Version 2.0.0

The tool surface, config schema and error taxonomy change, so the release is a major. `package.json`
stays the single source of the version (S/A5).

## Alternatives considered

- **Keep reflex opt-in, local-only.** Rejected: it is the same code with a worse default and a second
  configuration surface to explain; the owner wants it gone.
- **One multiplexed `web` tool with `op`.** Rejected for ergonomics: the model must guess an enum
  before it can search, and every failure message has to explain which op was meant.
- **Keep daily caps.** Rejected: arbitrary, unmeasured, and it converts a free action into a failure.

## Verification

- `rg "reflex|pageGate|judgePages|gateRead" src/` returns nothing after P2.
- `rg "freshness|dailyCap|E_RATE_LIMITED|captcha\\." src/` returns nothing after P2.
- A reachability test proves `web_read` is model-visible in a stock session (P1).
- A test proves zero navigations after `E_WALL` (P7).
- `SPEC.md` §15 and the appendix link every deleted surface to this ADR.
