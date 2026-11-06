# PLAN v2 — hardening, honesty and observability (P8–P14)

**Status:** draft v1 · 2026-11-06
**Precedence:** `SPEC.md` (what) → `PLAN-v2.md` (this file, order and gates) → `PLAN.md` v1 (process, unchanged)
→ `AGENTS.md` (working rules).
**Relation to v1:** `PLAN.md` P0–P7 are shipped green (`evidence/P0..P7`). This file does **not** re-open
them. It adds phases P8–P14 on top, using the same execution model: orchestrator-owned live Chrome,
disjoint file lanes, worker handoff blocks, gate evidence under `evidence/`.
**Source of the items:** one real end-to-end run of the shipped extension (2026-11-06) plus the user's
observations. Every item below has a code location, so a worker never has to rediscover the cause.

---

## 0. TL;DR

| Phase | Item(s) | One-line deliverable | Lanes | Risk |
|---|---|---|---|---|
| **P15** (runs first) | portability | host layer: OS path tables, portable pid liveness, external-binary capability probes; nothing else in the codebase touches the OS | 4 | low |
| **P8** | 1 | AI summary is *waited for*, and `ai:yes` can never be a header with no answer | 4 | medium (live layout) |
| **P9** | 2, 6, 7 | read pipeline is race-free, every failure leaves an artifact, the small lies are gone | 5 | low |
| **P10** | 8, 9, 10, 12 | managed window is watchable: control panel instead of `about:blank`, follows the working tab, types in every engine, `ya.ru` warm-up | 4 | medium (focus vs. hard rules) |
| **P11** | 11 | the CDP-Allow prompt cannot be missed: blocking wait + XDG notification + optional, absence-tolerant raise | 3 | low (raise is best-effort by design) |
| **P12** | 3, 5b | binary payloads: real PDF reading, and `image_search attach` that actually attaches bytes | 3 | medium (new machinery) |
| **P13** | 4 | `web_research` claims are answers, not the first sentence of an excerpt | 3 | low |
| **P14** | System 1 | reflex reframed from a token saver to a *source-quality and risk gate*, bench-gated on a metric that cannot be gamed | 3 | high (verdict may be "keep off") |
| **P16** (last) | publishing | publishable repo: sources + ≤ 10 test files + CI (lint/test/release with automatic version bump) + 5 short docs; 173 tracked files → ≤ 120 | 5 | medium (irreversible pruning) |

Suggested order: **P15 → P8 → P9 → P10 → P11 → P12 → P13 → P14 → P16.** P15 is a prerequisite for P11
and P12 (the only phases that leave the process), P8 and P9 are contract-level honesty, P14 needs the
labelled corpus that P10/P13 runs generate, and P16 runs last because it can only prune what those phases
finished writing.

---

## 1. Field findings (the plan's input, with code locations)

Measured on the shipped build, one real research session (~20 live searches, google 23/300, ddg 8/300,
yandex 10/150 daily caps).

1. **AI summary never arrives.** Two of two Google runs returned `ai:yes` with `ai.text` equal to the query
   echo `Ответ в режиме ИИ, исходный запрос: "…"` and nothing else. Cause: `settleGoogleSerp`
   (`src/engines/google.ts:738`) waits only for the SERP shell (`READY_SELECTOR`), while the AI block
   streams in afterwards; `aiAnswerText` (`google.ts:502`) then finds no body ≥ `MIN_BODY_CHARS` (80) and
   falls back to `stripAiLead(cutTrailingControls(full))` — which is the lead alone. `compact.ts:249`
   happily renders it because it only checks for non-empty text.
2. **Parallel `web_read` races.** Four concurrent reads returned the same body (the last navigation).
   `web_read` uses one shared tab key (`src/tools/web_read.ts:144`, acquire at `:419`) and
   `acquirePage("read")` is idempotent, not exclusive.
3. **PDF is unreadable.** `https://arxiv.org/pdf/2211.17192` → `E_PARSE / stage=extract`, hint "try a
   different URL". Chrome renders PDF in an out-of-process viewer, so the DOM is empty. The HTML twin
   (`arxiv.org/html/…`) reads fine. On this host `pdftotext` (poppler) and `qpdf` exist while `mutool`
   (mupdf) does not — i.e. the current workable path depends on which distro packages the user happens to
   have, which is exactly the kind of binding PO1 removes.
4. **`web_research` claims are noise.** `budget:normal` returned 1/2 searches, 2/4 reads, `enough:yes`,
   claims = `«Актуально на 14 июля 2026 года.»` and a truncated markdown link with `utm_*` tail.
5. **`image_search` (Yandex) reports `pageUrl` = the image file** (`img_url`), not the containing page —
   documented at `src/engines/images.ts:24-29` but invisible to the caller. `attach:true` only prints
   thumbnail URLs; the model never sees an image.
6. **No artifact on any `web_read` failure.** `artifacts.save()` is wired only in
   `src/tools/web_search.ts:406` and `src/tools/image_search.ts:280`. Artifact root was 0 bytes after a
   session that produced two `E_PARSE` failures.
7. **Small lies.** `offset` past the end returns `""` silently (`decisions.jsonl` records `chars:0`);
   `maxChars:99999` is accepted though the ceiling is 20000; `web_doctor fix` closed 6 owned tabs and then
   reported `reconnect failed: E_CDP_UNAVAILABLE` while the session was demonstrably alive;
   `probe:false` reports every engine `unavailable` instead of `skipped`; with `n=3` and two engines, one
   engine silently wins all slots.
8. **`about:blank` anchor tab.** `BLANK_PAGE` at `src/cdp/browser.ts:70`, bootstrap at `:310`. It is
   deliberate (closing the last tab closes the window) but it is a blank tab in the user's face and tells
   them nothing.
9. **`yandex.ru` warm-up redirects to `dzen.ru`.** `homeUrl: "https://yandex.ru/"` at
   `src/engines/yandex.ts:73`; SERP URL at `:836`. The typed path can land on Dzen, which has no search box
   in the expected place.
10. **Typing exists but almost never runs.** `humanSearch` already types for every engine
    (`src/cdp/humanize.ts:327`); the gate is `typedPath = mode === "always" || firstInSession` (`:334`) with
    `humanize: "auto"` in `DEFAULT_CONFIG`, so only the first search of a session is typed. That is why
    Google (first) looks human and the others do not.
11. **First attach can time out behind an unseen prompt.** Chrome's Allow prompt lives in the browser
    window; a headless-ish session never sees it. There is no waiting UX and no raise attempt.
12. **The work tab is not brought forward.** `shouldFocus` (`humanize.ts:302`) with `focus: "session"`
    raises the window only on the first search; afterwards the user watches the anchor.
13. **System 1 is parked for the wrong reason.** `bench/RESULTS.md` correctly rejects `keep 3`
    (fewer results ≠ fewer tokens) and keeps `reflex.enabled:false`. But the reflex was only ever measured
    as a *result compressor*. Its natural job — "is this page worth reading, and is this source
    trustworthy" — was never built or measured.

Portability audit (2026-11-06, prompted by the `hyprctl` over-fit in the draft of P11). The product is
written as if the host were "this Linux box with this profile":

14. **Profile discovery is Linux-only.** `PROFILE_SUFFIXES` (`src/cdp/discovery.ts:96-103`) lists seven
    `~/.config/…` paths. macOS (`~/Library/Application Support/Google/Chrome`) and Windows
    (`%LOCALAPPDATA%\Google\Chrome\User Data`) are unreachable except through `PI_CHROME_CDP_WS`.
15. **PID liveness is Linux-only.** `isPidAlive` (`src/cdp/browser.ts:192`) returns "alive" on every
    non-Linux platform, so a stale lock can only be retired by the 60 s heartbeat.
16. **`$HOME` is read directly.** `tildify` (`src/runtime/doctor.ts:956`) uses `process.env.HOME` (empty on
    Windows) while the rest of the code correctly uses `homedir()`; `expandHome`
    (`src/runtime/limiter.ts:70`) only understands `~/`, not `~\`.
17. **No external binary exists in the tree today** — P12 would be the first. That is the cheapest moment
    to introduce a capability probe, before shell-outs spread.
18. **CLI hints name one browser.** The recovery hint hardcodes `chrome://inspect/#remote-debugging` even
    when discovery found an Edge/Brave/Chromium profile.

---

## 2. Cross-cutting rules for every v2 lane

- Hard rules from `AGENTS.md` §2 are not negotiable: attach only, never close foreign tabs, never spoof,
  never solve captchas, never auto-launch Chrome, one browser writer.
- **`SPEC.md` and `src/engines/types.ts` are additive-only.** Any new field lands as a `contract:` commit
  by the orchestrator before the lanes that need it start.
- New dependency = one-line justification in the commit. Default answer is "no": prefer a CDP domain, an
existing browser capability, or ~80 lines of our own code — and only then an installed binary, as a
   *fallback* behind `capability()` (PO1), never as the primary path.
- Every phase ends with `npm run typecheck && npm test && npm run audit`, a live smoke that ran **once**,
  and `evidence/P<N>.md` containing the commands and their raw output.
- A metric that can be improved by delivering less is not a metric. This includes token counts and
  "results returned".

### 2.1 Portability doctrine (binding on every v2 lane)

The rule that replaced the `hyprctl` over-fit, generalised. A feature may *use* a platform quirk; it may
never *depend* on one, and the platform quirk may live in exactly one module.

| Rule | Statement | Enforced by |
|---|---|---|
| **PO1** | **No required external binary.** Every shell-out goes through `capability(name)` (a memoised, injected, spawn-free probe). A missing capability yields `E_*` + hint, never a crash, and every capability has a CDP-or-JS fallback or an honest unsupported verdict | R13 + unit tests with an empty resolver |
| **PO2** | **No hardcoded OS paths.** Profile/config/data paths resolve through `src/runtime/host.ts` (`profileCandidates()` per platform, `PI_*` overrides first, `homedir()` — never `$HOME`, never `~/` string surgery) | R13 forbids `"/proc/"`, `"/usr/bin/"`, `"/etc/"`, `"$HOME"`, `".config/"` outside `host.ts` |
| **PO3** | **No desktop-specific code outside the adapter tables.** Compositor/DE raising lives only in `src/cdp/raise.ts`; OS notification delivery only in `src/runtime/notify.ts`. Each entry is optional, probed and logged | R13 (import allowlist) |
| **PO4** | **Portable process facts.** Liveness via `process.kill(pid, 0)` (EPERM ⇒ alive), the heartbeat stays the authority; no `/proc`, no `/proc/*/status` parsing, no signals other than 0 | R13 + unit test |
| **PO5** | **Browser-family agnostic where it is free.** The brand is *detected* (profile dir) and used in hints; no hint hardcodes "chrome" when the endpoint came from Edge/Brave/Chromium | test on the hint builder |
| **PO6** | **The suite runs on three platforms' worth of assumptions.** `tests/unit/host.test.ts` runs the host layer with `platform()` stubbed to `linux`/`darwin`/`win32` and with an empty capability resolver; no test may read the real `$HOME`/`/proc` | gate V15.1 |

Only two modules may touch the host: `src/runtime/host.ts` (paths, capabilities, platform facts) and
`src/extract/pdf.ts` (declares *which* capability it needs, never how to find it). Anything else that
imports `node:child_process`, `node:os.platform` or `node:fs.existsSync` on an absolute system path is a
violation.

---

## 3. Spikes (run before the dependent lanes, orchestrator-only)

| Spike | Question | Done when |
|---|---|---|
| **S1** anchor panel | Can we create a target on a local `file://` document (`~/.pi/agent/web-search/anchor.html`) and update it with `Runtime.evaluate` without disturbing engine tabs? Is a `data:` URL refused by `Target.createTarget`? | one live run, three findings in `evidence/P10-spike.md` |
| **S2** PDF bytes | Which CDP path gives PDF text *without any external binary*? Candidate A: attach to the PDF viewer target and read `Accessibility.getFullAXTree` (PDFium exposes the text layer to a11y). Candidate B: `Network.getResponseBody` / `Fetch.getResponseBody` to get the bytes, then a text extractor. Both must pass the SSRF guard on the **final** URL and the size ceiling. | transcript + byte counts in `evidence/P12-spike.md`, with a verdict on which one is primary |
| **S2b** PDF tool ladder | If a binary extractor is needed as fallback, is `pdftotext` (poppler) present/behaving, and does `mutool draw -F txt` produce better output on the same 3 PDFs? Record a two-column comparison. | comparison table in `evidence/P12-spike.md` |
| **S3** allow-prompt attention | (a) Which attention layers fire here — terminal OSC escapes, `org.freedesktop.Notifications` over D-Bus — and which raise adapters exist? (b) Does `gio launch …/google-chrome.desktop` activate a *running* Chrome without opening a second window? (c) What is the macOS (`osascript`/`open -a`) and Windows (`AppActivate`) equivalent, checked on paper only — no other OS is available here. | degradation matrix (OS × desktop × with/without helpers) in `evidence/P11-spike.md` |
| **S4** AI streaming | Record 3 snapshots of one Google AI Overview: (a) shell only, (b) lead only, (c) prose. What selector/text length distinguishes (c)? Same for DDG assist and Yandex neuro card. | fixtures `google-ai-stream-{a,b,c}` + a note in `research/FINDINGS.md` |

S1–S4 and S2b are cheap but they decide the shape of the lanes that follow. No lane starts on a guess.

---

## 4. Phases

### P15 — M15: host portability layer (prerequisite, wave W8)

**Why:** every later phase that leaves the process (P11 notifications, P12 PDF) would otherwise hardcode
this machine. This phase makes "the host" an interface, then makes the offender list from §1 findings 14–18
conform to it.

| Lane | Scope | Files |
|---|---|---|
| P15-A | `platform()` behind an injectable seam, `profileCandidates()` with Linux/macOS/Windows tables (Chrome, Chrome Beta/Dev, Chromium, Brave, Edge — same precedence, `PI_*` overrides first), `homeDir()`, `expandHome()` accepting `~/` **and** `~\\`, a single `tildify()` used by doctor + CLI | new `src/runtime/host.ts`, `src/cdp/discovery.ts`, `src/runtime/doctor.ts`, `src/runtime/limiter.ts` |
| P15-B | portable liveness in the lock: `process.kill(pid, 0)` → alive; `ESRCH` → dead; `EPERM` → alive (not ours); heartbeat remains the authority; lock format unchanged (no version bump) | `src/cdp/browser.ts` |
| P15-C | `capability(name)` registry: `access(X_OK)` on each `PATH` entry on POSIX, `PATHEXT` resolution on Windows, memoised, injectable, **never spawns**; declared names only (`pdftotext`, `mutool`, `notify-send`, `gdbus`, `dbus-send`, `osascript`, `powershell`, `wmctrl`, `xdotool`, `kdotool`, `hyprctl`, `swaymsg`, `gio`) | new `src/runtime/host.ts` |
| P15-D | audit rule **R13** (forbidden host access outside the two allowed modules) + `tests/unit/host.test.ts` platform matrix + one line in `AGENTS.md` §8 ("host access lives in `src/runtime/host.ts`") + the brand-aware hint from PO5 | `scripts/audit.mjs`, `tests/unit/host.test.ts`, `AGENTS.md`, `src/cli/doctor.ts` |

**Gates — V15.1..V15.6**
1. `profileCandidates()` is correct for all three platforms (unit, stubbed); the Linux list is byte-identical
   to today's `PROFILE_SUFFIXES` (no regression for the current user).
2. Live: `node src/cli/doctor.ts --json` still finds `DevToolsActivePort` and reports the same endpoint.
3. Liveness: live pid → true, dead pid → false, `EPERM` → true, all with an injected `kill`.
4. `capability()` on this host finds `pdftotext`, `notify-send`, `gdbus`, `gio`, `hyprctl` and returns
   `null` for `wmctrl`, `xdotool`, `kdotool` — and never spawns anything.
5. R13 fails on a fixture that hardcodes `/proc/` or spawns outside `host.ts`, and passes on the repo.
6. `npm test` is green with `platform` stubbed to `darwin` and `win32` (Chrome-dependent tests skipped by
   capability, not by a filename check).

---

### P8 — M8: the AI summary is real, or it is absent

**Why:** the current output claims an AI answer it does not have. That is the one failure mode SPEC
forbids outright ("do not fabricate"), and it is visible to the user on the first query.

**Contract change (orchestrator, `contract: ai states`):**
`CompactAi`/`RawSerp.ai` gains `state: "answer" | "lead" | "none"`; `web_search` prints
`ai:yes` only for `answer`, `ai:lead` for a lead with no prose, `ai:no` otherwise. New log fields
`aiWaitMs`, `aiChars`.

| Lane | Scope | Files |
|---|---|---|
| P8-A | generic `waitForAi(page, ai, deadline)`: bounded poll (default 6000 ms, config `search.aiWaitMs`) that returns as soon as prose ≥ `minChars` exists; reuses the `waitForMarker` shape | `src/cdp/humanize.ts` (extend), new `src/cdp/ai-wait.ts` |
| P8-B | Google: distinguish lead from prose structurally (`aiAnswerText` returns `{ text, state }`), one optional expand via the existing `findExpandTarget` machinery, gated by config because it is a visible click | `src/engines/google.ts` |
| P8-C | DDG + Yandex: same two-state result on their own markers (`[data-testid="duckassist-answer-content"]`, `Futuris*` / `data-fast-name="neuro_answer"`) | `src/engines/duckduckgo.ts`, `src/engines/yandex.ts` |
| P8-D | fixtures from S4 (offline), unit tests for all three states × three engines, compact tests (`ai:lead` must never render as `ai:yes`), and a `research/FINDINGS.md` update | `tests/unit/*`, `tests/fixtures/*`, `research/FINDINGS.md` |

**Gates — V8.1..V8.5**
1. Offline: `ai:yes` requires ≥ 200 chars of non-lead prose; lead-only fixtures produce `ai:lead`.
2. Offline: no state transitions can produce `ai:yes` with `text === query`, ever.
3. Live, one query per engine: record `ai:|aiWaitMs|aiChars`; a `lead` outcome is a pass, a `yes` with
   `aiChars < 200` is a failure.
4. Live: total added latency ≤ 1.5 s per search with `aiWaitMs` at default; `summary:false` skips the wait
   entirely and costs nothing.
5. Artifact saved when the AI wait times out on a `summary:true` search.

**DoD:** `evidence/P8.md` with the three live transcripts, the two-state fixtures, and the latency table.

---

### P9 — M9: read integrity and the small lies

**Why:** parallel reads silently return the wrong page; failures leave nothing to debug; a handful of
messages claim things that are not true. All of these are cheap and all of them erode trust in every
other number this project reports.

| Lane | Scope | Files |
|---|---|---|
| P9-A | serialize reads: an exclusive per-`PageKey` queue (mutex + FIFO), optional small pool (`read.pool: 1..3`, default 1) where the pool key is `read#n`; `acquirePage` stays idempotent, the *tool* takes the lock | `src/cdp/browser.ts`, `src/cdp/session.ts`, `src/tools/web_read.ts` |
| P9-B | post-navigate proof: after settle, compare `page.url()` with the requested URL (normalized) and fail `E_NAVIGATION_MISMATCH` (new code, retryable) instead of extracting a stranger's page | `src/tools/web_read.ts`, `src/runtime/error-codes.ts` |
| P9-C | artifacts on every tool failure path (`E_PARSE`, `E_TIMEOUT`, `E_BLOCKED_URL` after redirect, `E_NAVIGATION_MISMATCH`): one save call site shared by both tools | `src/tools/{web_read,web_search,image_search}.ts`, `src/runtime/artifacts.ts` |
| P9-D | truth pass: `offset` past the end → explicit `E_OFFSET_RANGE` hint with the content length; `maxChars` clamped with a `clamped:true` note; `web_doctor fix` reports reconnect only when a reconnect was required and failed (and re-probes after the fix); `probe:false` → `skipped`; multi-engine splits `n` across engines (`ceil(n/k)` each) and prints `google:5 yandex:0(failed? E_WALL)` | `src/tools/{web_read,web_doctor,web_search}.ts`, `src/extract/compact.ts` |
| P9-E | `image_search` honesty: `pageUrl` semantics documented in the tool description (`yandex: source image, not the host page`) and a `pageUrlKind: "page" \| "image"` field; the byte-level `attach` is deferred to P12-C | `src/tools/image_search.ts`, `src/engines/images.ts` |

**Gates — V9.1..V9.6**
1. Two concurrent `web_read` calls on two different domains return two different bodies (deterministic
   test with the fake CDP, plus one live run).
2. Twelve concurrent reads complete without cross-contamination and without leaving a lock behind.
3. Induced `E_PARSE` on `web_read` leaves `page.html`, `page.txt`, `meta.json` in the artifact root.
4. Redirect to a blocked address produces an artifact *and* `E_BLOCKED_URL`.
5. `offset` beyond content and `maxChars` over ceiling behave as specified, with tests.
6. Live: `web_doctor --fix` output contains no false reconnect claim; `--json` verdict stays honest.

---

### P10 — M10: the managed window is watchable

**Why:** the user is *supposed* to see the work. Today they see a blank tab, and the typing magic happens
once per session. This phase converts the managed window from a side effect into an instrument panel.

| Lane | Scope | Files |
|---|---|---|
| P10-A | **anchor control panel** (S1): the bootstrap tab is a local `anchor.html` (no network, no cookies, our own CSS) showing engine, query, stage, pace, daily counters, last error, session id; updated with `Runtime.evaluate` on stage changes, throttled to ≤ 2 updates/s. The URL is built with `pathToFileURL()` (no hardcoded separators), the asset is added to the `package.json` `files` allowlist and to audit R12, and `window.panel:false` falls back to the current `about:blank` behaviour | `src/cdp/browser.ts`, new `src/runtime/panel.ts`, `assets/anchor.html`, `package.json` (orchestrator) |
| P10-B | **follow focus** (S12/spike): config `window.follow: "work" \| "anchor" \| "never"` (default `work`) — the working tab is raised when a stage begins and the anchor is raised again after `idleMs` (default 1500 ms). `never` must be byte-for-byte the old behaviour, because it is the only safe setting when the user is presenting | `src/cdp/humanize.ts`, `src/cdp/browser.ts`, `src/config.ts` |
| P10-C | **typing everywhere** (S10): `humanize: "typing"` types on *every* search of every engine, with a per-engine `typeProfile` (box selector, `maxChars`, key delay); keep `auto` for compatibility. Verified live: DDG and Yandex boxes accept the typed path and the SERP still settles | `src/cdp/humanize.ts`, `src/engines/{duckduckgo,yandex}.ts`, `src/config.ts` |
| P10-D | **`ya.ru` warm-up** (S9): `homeUrl` → `https://ya.ru/`, SERP host unchanged; detect a `dzen.ru` landing and treat it as `fellBackToSerp` (navigate the SERP URL) instead of failing; canary test on the redirect target | `src/engines/yandex.ts`, fixtures |

**Gates — V10.1..V10.5**
1. Live: no `about:blank` tab exists after a session; the anchor shows the current query within 300 ms of
   the search starting (screenshot artifact).
2. Live: with `window.follow:"work"` the engine tab is the active tab during a search and the anchor is
   back within 2 s after it ends; with `"never"` the active tab never changes (two runs, screenshots).
3. Live: one typed search per engine; `typed:true` for all three; per-engine latency delta ≤ 1.2 s vs the
   SERP path.
4. Live: Yandex typed path never lands on `dzen.ru`; if it does, `fellBackToSerp:true` and the SERP still
   parses.
5. Offline: all four lanes covered by fixtures; `window.focus`/`follow`/`humanize` matrix has a test per
   cell.

---

### P11 — M11: the Allow prompt cannot be missed

**Why:** the one-time CDP Allow is the only manual step in the whole product, and it can be missed because
it appears in a window the agent cannot see. Today that surfaces as a generic timeout.

**Design principle: escalate attention, never depend on one desktop.** Raising a foreign window is not a
solved problem on Wayland — no portable API exists, and every compositor exposes its own. So the phase is
built as four independent layers, most portable first. Layers 0 and 1 carry the feature; layer 2 is a
bonus that is *expected* to be unavailable; layer 3 removes the need for any of it. Nothing is bound to
Hyprland, KDE or GNOME, and no layer may fail the phase:

| Layer | Mechanism | Cost | Works on |
|---|---|---|---|
| **L0 — terminal** | blocking progress lines (`waiting for the Allow prompt… 42s`) plus OSC notification escapes `ESC ] 9 ; … BEL` (iTerm2/kitty/WezTerm/Ghostty/Konsole/foot) and `ESC ] 777 ; notify ; … BEL` | zero deps | every terminal that supports it, silently ignored elsewhere |
| **L1 — desktop notification** | the XDG notification spec `org.freedesktop.Notifications` (`urgency=2`, no timeout when the server advertises `persistence`), reached through the first available of `notify-send` → `gdbus call` → `dbus-send`; macOS = `osascript -e 'display notification'`; Windows = a best-effort `powershell` toast. All optional, all non-fatal, all behind `capability()` | zero deps, one call | Linux (all DEs incl. wlroots notifiers), macOS, Windows |
| **L2 — optional raise** (S3) | a probe table in portability order, **one entry per OS**: X11/EWMH (`wmctrl`, `xdotool`) → GLib/xdg-activation (`gio launch google-chrome.desktop`) → compositor-native (`kdotool` on KWin, `hyprctl` on Hyprland, `swaymsg` on sway); macOS `open -a "Google Chrome"`; Windows `powershell` + `WScript.Shell.AppActivate` | 1 s timeout each, 0 or 1 attempt | unknown at runtime; `raise: unavailable` is a normal result |
| **L3 — no raise needed** | keep polling `DevToolsActivePort` (the authoritative file) and the WS endpoint for `cdp.attachWaitMs` (default 60 s), so an Allow that lands late still attaches; `web_doctor --watch` mirrors the same wait in a second terminal | free | everywhere |

**Measured on this host (2026-11-06, Wayland/Hyprland):** `org.freedesktop.Notifications` is owned by
`quickshell` and advertises `actions` + `persistence`; `notify-send`, `gdbus`, `dbus-send`, `busctl` and
`gio` exist; `google-chrome.desktop` exists with `Exec=/usr/bin/google-chrome-stable %U`; there is no
`wmctrl`, `xdotool` or `kdotool`; `hyprctl` exists, `ydotool` exists but its daemon is inactive. So L1
works here, L2 has one usable candidate (`hyprctl`) and one to be proven (`gio launch`), and L0/L3 carry
the feature either way.

| Lane | Scope | Files |
|---|---|---|
| P11-A | L0 + L3: `cdp.attachWaitMs`, the waiting state machine, progress lines, OSC escapes, distinct `E_CDP_AWAITING_ALLOW` with a hint naming `chrome://inspect/#remote-debugging`; also a `--watch` mode for the CLI doctor | `src/cli/doctor.ts`, `src/cdp/browser.ts`, `src/runtime/error-codes.ts`, new `src/runtime/notify.ts` |
| P11-B | L1: one non-fatal notification through the per-OS ladder above, `expire_timeout`/`urgency` chosen from `GetCapabilities` on Linux, exactly one attempt, failure logged and ignored; every binary reached through `capability()` (P15-C) | new `src/runtime/notify.ts` |
| P11-C | L2 + doctor honesty: `window.raiseOnPrompt: "auto" \| "never"`, a static adapter table probed in portability order, exact command logged, never installed, never privileged; doctor reports `awaiting_allow` as its own verdict with wait duration, notification result and raise outcome | new `src/cdp/raise.ts`, `src/runtime/doctor.ts`, `src/commands/doctor.ts` |

**Gates — V11.1..V11.6**
1. Reproduce on a fresh Chrome session with CDP not yet allowed: the CLI waits, prints progress, and exits
   with `E_CDP_AWAITING_ALLOW` and the actionable hint — no Chrome restart, no `--fix` side effects.
2. After Allow, the *same* run continues to a successful search without the user retyping anything (L3).
3. L1 fires exactly once and its failure is not fatal: verified by running with an empty `PATH`, with a
   bogus `DBUS_SESSION_BUS_ADDRESS`, and with the capability resolver stubbed to "nothing installed" — the
   tool still waits and still reports honestly on all three platforms' code paths.
4. L2 is exercised on at least two adapters (one that exists here, one that does not) and its absence
   never changes the verdict; the log names the exact command or `raise: unavailable`.
5. L0 escapes are emitted only when stdout is a TTY (no escape garbage in logs, JSON output or CI).
6. Nothing in the phase reads or writes the browser profile directory, and no CDP call happens before
   Allow. The recovery hint names the *detected* browser family (PO5).

---

### P12 — M12: binary payloads (PDF reading + image bytes)

**Why:** research runs into PDFs constantly (arxiv, госуслуги, отчёты), and "attach" that attaches nothing
is the kind of half-feature that makes an agent look broken.

**Shared machinery:** one `fetchBytes(url)` built on CDP (`Network.enable` + response capture, or
`Fetch`), with the SSRF guard applied to the *final* URL after redirects, a size ceiling
(`read.pdfMaxBytes`, default 20 MB) and an artifact on every failure.

**Extraction ladder (PO1: no required binary).** Primary path is *inside the browser we already have* —
Chrome's PDF viewer is a separate target whose accessibility tree carries the text layer, so
`Accessibility.getFullAXTree` gives us text on any OS with zero installs. Only if that yields nothing do we
fall back to an installed extractor, and only if none is installed do we fail honestly:

1. **CDP-only:** attach to the PDF viewer target → `Accessibility.getFullAXTree` → text, page breaks
   reconstructed from the AX node order/`Page` markers. No bytes leave the browser.
2. **`pdftotext -layout`** (poppler) over the fetched bytes — best table fidelity where it exists.
3. **`mutool draw -F txt`** (mupdf) — same shape, different output quirks.
4. **None available / no text layer:** `E_PDF_UNSUPPORTED` (no extractor) or `E_PDF_SCANNED` (image-only),
   both with an actionable hint and an artifact. Never fabricate text, never OCR silently.

`qpdf` is dropped from the design: it validates and rewrites but does not extract text, and it is one more
Linux/brew-only dependency for no user value.

| Lane | Scope | Files |
|---|---|---|
| P12-A | `fetchBytes` + content-type detection; `web_read` branches on `application/pdf` before touching the viewer; artifacts (`doc.pdf` kept only when `read.keepPdf` is on) | new `src/cdp/bytes.ts`, `src/tools/web_read.ts` |
| P12-B | `src/extract/pdf.ts`: rung 1 (AX tree) implemented in-tree, rungs 2–3 behind a `PdfToText` port that asks `capability()` (P15-C) for a binary, page markers `--- p.N ---`, per-page cap, honest `E_PDF_SCANNED` / `E_PDF_UNSUPPORTED` with hints naming the rung that failed | new `src/extract/pdf.ts`, `src/runtime/error-codes.ts`, `src/runtime/host.ts` (capability names) |
| P12-C | `image_search attach:"bytes"`: download ≤4 thumbnails through Chrome, base64 them, and emit image blocks (the agent then actually sees the picture). Defaults stay `attach:false` because images are expensive in context | `src/tools/image_search.ts`, `src/cdp/bytes.ts` |

**Gates — V12.1..V12.7**
1. Live: three PDFs read successfully (a modern layout PDF, a two-column academic one, a scanned one) with
   the first 600 chars and the page count recorded.
2. **Ladder rung 1 works with the capability resolver stubbed to "nothing installed"** — PDF text arrives
   with no external binary on the machine. This is the gate that keeps PO1 honest.
3. Scanned PDF → `E_PDF_SCANNED` with hint "scan only, no text layer", an artifact, and **no** fake text.
4. SSRF: a PDF URL redirecting to `127.0.0.1` is blocked before any byte is written (`E_BLOCKED_URL`).
5. `read.pdfMaxBytes` is enforced; a 25 MB file fails fast with the size in the message.
6. Live: `image_search attach:"bytes"` yields ≤ 4 image blocks and their thumbnails are byte-identical to
   the ones served to Chrome.
7. Offline: PDF tests run against a 20 KB license-free fixture through both rungs — the AX-tree transcript
   and a fake `pdftotext` seam — with no network and no personal data.

---

### P13 — M13: `web_research` claims that answer the question

**Why:** the current `claims` are whichever sentence happens to be first in an excerpt. That is not a
research tool; it is a quote generator.

| Lane | Scope | Files |
|---|---|---|
| P13-A | claim selection: split excerpts into sentences, score by query-term overlap + numeric/date/named-entity presence + position, drop navigational/boilerplate sentences and lone dates; one claim per source unless two are clearly distinct | `src/tools/web_research.ts`, new `src/extract/claims.ts` |
| P13-B | source hygiene: strip tracking params (`utm_*`, `yclid`, `gclid`, `fbclid`, `from`, `ref`) from URLs *and* from link text; canonicalize; dedupe by registrable domain+path; drop excerpts whose only content is a TOC | `src/extract/urls.ts`, `src/extract/claims.ts` |
| P13-C | `enough` honesty: expand the budget when the top claims do not cover the query terms (`refine`/`read_more`) instead of declaring `enough:yes` after one search; report `searches 2/2 reads 3/4` truthfully | `src/tools/web_research.ts`, `src/reflex/policy.ts` |

**Gates — V13.1..V13.4**
1. Offline: a 10-query fixture set where the correct claim is known; ≥ 8/10 top claims contain the answer
   fact (baseline measured and recorded first — no target without a baseline).
2. No URL in the output contains a tracking parameter; enforced by a test over recorded live output.
3. `enough` is `false` when the claims do not cover ≥ 60% of query terms.
4. Live: 3 queries, claims read as answers; one recorded transcript in evidence.

---

### P14 — M14: System 1 v2 — quality gate, not a compressor

**Why:** `bench/RESULTS.md` is right to keep the current reflex off; measuring it as a token saving at
fixed `n` was never going to work. The valuable, non-gameable question is different: *should this page be
read, and should this source be trusted?* That is where a cheap classifier beats a regex, and where a wrong
answer costs the user real time (SEO slop, machine-translated farms, phishing/yellow pages, "answers" that
are just ads).

**New decision points (additive to `src/reflex/types.ts`, `contract: reflex page gate`):**

```ts
export interface PageVerdict {
  /** Read it? */
  worth: boolean;
  /** 0..1 — the classifier is allowed to abstain (returns null and rules decide). */
  trust: number | null;
  kind: "original" | "aggregator" | "forum" | "slop" | "unsafe" | "unknown";
  reasons: string[];
}
classifyPage(ctx: { query: string; url: string; title: string; snippet: string;
                     excerpt?: string }): Promise<PageVerdict | null>;
```

| Lane | Scope | Files |
|---|---|---|
| P14-A | rules baseline: known farm/aggregator domains, thin-content signals (char/sentence ratio, no dates, no author), translated-slop markers, clickbait titles, unsafe TLD/path patterns. Runs offline, zero cost, always available | `src/reflex/rules.ts` |
| P14-B | classifier backend: one batched call scores up to 10 candidates (`worth`/`trust`/`kind`) into JSON; strict schema validation, abstain on garbage, `maxCallsPerSearch` unchanged, `usage`/`costUsd` logged to `decisions.jsonl`, `localOnly` respected | `src/reflex/classifier.ts`, `src/reflex/policy.ts` |
| P14-C | wiring + bench v2: gate `web_read` (skip with a one-line reason instead of burning a read) and rank `web_research` sources; new corpus `bench/slop.jsonl` (≥ 60 labelled URLs: good / slop / unsafe, built from real SERP output, no personal data) and `bench/run.ts --gate` | `src/tools/{web_read,web_research}.ts`, `bench/**` |

**Gates — V14.1..V14.5 (bench-decided, like V5.6)**
1. Corpus exists with ≥ 60 labelled URLs and a documented labelling rubric.
2. `slop`/`unsafe` exclusion ≥ 70% recall at ≤ 2 false skips per 20 queries.
3. Reads saved ≥ 25% on `web_research` with no loss of the "authoritative source present" check.
4. Cost ≤ $0.001 per search at the observed batching, logged with real `usage`.
5. Latency ≤ 600 ms added per gated read; `reflex.localOnly:true` and `reflex.enabled:false` both leave
   behaviour byte-identical to today.

**Verdict may be "stay off".** If recall or the false-skip bar fails, the phase ships the rules baseline,
the bench and the flag, and documents the negative result — exactly as V5.6 did. Captcha *risk* prediction
is explicitly **out of scope**: we do not guess at walls, we classify them after the fact, and nothing here
may ever click, solve or retry around a captcha.

---

### P16 — M16: publishable repository (last phase, wave W17)

**Why:** the tree carries the whole development apparatus: 173 tracked files, of which 86 are tests, 11
evidence, 11 bench, 11 research, plus ~157 KB of process markdown (`SPEC` 48 KB, `PLAN` 46 KB, `PLAN-v2`
40 KB, `AGENTS` 15 KB, `README` 17 KB). A user who installs an npm package needs none of it, and an agent
working on the repo pays for all of it in context. P16 is the only phase whose job is to remove things.

**Safety before deleting anything:** annotated tag `archive/pre-publication` on the pre-prune commit,
pushed. Every deletion happens in a single commit `release: prune to shippable tree`, so any removed file
stays recoverable with `git show archive/pre-publication:<path>`. No `git filter-branch`, no history
rewrite: the apparatus is history, not garbage.

**Inventory — keep / distill / delete**

| Path | Now | Action |
|---|---|---|
| `src/**`, `index.ts`, `tsconfig.json`, `LICENSE`, `.gitignore` | 43 files / 20 400 lines | keep, unchanged; flip `noUnusedLocals`/`noUnusedParameters` to `true` as part of the lint tightening |
| `package.json` | 1 057 B | keep; add `repository`, `bugs`, `homepage`; `publishConfig: {access: public, provenance: true}`; drop the `bench` script |
| `tests/unit` | 34 files / 23 688 lines / 785 tests | **cut to ≤ 10 files** (criterion below) |
| `tests/fixtures` | 45 files / 520 KB | cut to ≤ 8 files / ≤ 150 KB: one layout per engine, one "no AI", one wall, one compact |
| `research/` | 11 files (FINDINGS + 9 probes) | **distill then delete** — durable selector knowledge moves to `docs/engines.md` first |
| `bench/` | 15 files / 3 843 lines, 3 RESULTS | delete; the surviving verdict ("reflex stays off; a metric that improves by returning less is not a metric") becomes five lines in `docs/architecture.md` — a decision, not a corpus |
| `evidence/` | 11 files / 785 lines | delete |
| `SPEC.md` | 48 KB | delete; surviving contracts live in code and `docs/architecture.md` |
| `PLAN.md`, `PLAN-v2.md` | 86 KB | delete (after P16 closes) |
| `AGENTS.md` | 15 KB | **rewrite to ≤ 100 lines** |
| `README.md` | 17 KB | **rewrite to ≤ 90 lines** |
| `scripts/audit.mjs` | 2 305 lines, 12 rules | **trim to ≤ 400 lines**: keep hard-rules (no playwright/launch/headless/fingerprint), secret scan, packaging allowlist, plus new **R14** (doc budgets) and **R15** (docs↔code drift); drop every rule that reads `PLAN.md`/`evidence/` |

**The only criterion for keeping a test:** it protects a user-visible contract that can silently break.
Keep exactly one file per row: google / duckduckgo / yandex parser (canary + layout) · AI state machine
(post-P8) · compact caps and output budget · error codes and rendering · SSRF and URL guard · config
parsing and env overrides · tool surface and tool-description budget · CDP discovery and lock · read/PDF
extraction (post-P12). Everything else (doctor matrices, session/browser internals, reflex bench, audit
self-tests, evidence shape) is removed, and **the prune commit message must list the behaviours it stopped
covering**, so the decision is reviewable rather than silent. Live smoke (`npm run test:live`) stays as the
opt-in safety net.

**Target tree (~80 tracked files, ≤ 26 MB):**

```
index.ts  package.json  tsconfig.json  LICENSE  .gitignore  README.md  AGENTS.md
src/**                                  43 files, unchanged
scripts/audit.mjs                       ≤ 400 lines
scripts/release.mjs                     bump classification + tag/publish driver
tests/unit/*.test.ts                    ≤ 10 files
tests/helpers/**                        fake CDP + fixture loader only
tests/fixtures/**                       ≤ 8 files, ≤ 150 KB
docs/architecture.md  docs/engines.md  docs/errors.md  docs/config.md
                                        ≤ 120 lines each, ≤ 400 total
.github/workflows/ci.yml  .github/workflows/release.yml
```

| Lane | Scope | Files |
|---|---|---|
| P16-A | **distill before deleting**: `docs/engines.md` from `research/FINDINGS.md` (URL builders, DOM markers + canaries, AI-card markers, wall markers, layout traps per engine) and `docs/architecture.md` from `SPEC` (flow diagram + the non-obvious decisions) plus a short decision log (attach-only, one owned window, no headless, no fingerprint, reflex gate off) | `docs/*.md` (new) |
| P16-B | test and fixture triage with the criterion above; `tests/helpers` reduced to the fake CDP + fixture loader; every removal named in the commit body | `tests/**` |
| P16-C | docs rewrite: `README.md` ≤ 90 lines (what/why, install, the 3-click CDP enablement + `DevToolsActivePort` check, 5-tool table, config path + 6 keys, 5 error codes → action, security model, license) and `AGENTS.md` ≤ 100 lines (8 hard rules, repo map, commands, one-writer rule, conventions, 4-bullet DoD); `docs/errors.md` from `error-codes.ts`; `docs/config.md` from `DEFAULT_CONFIG` | `README.md`, `AGENTS.md`, `docs/*.md` |
| P16-D | CI + release: `ci.yml` (`npm ci` → `typecheck` → `lint` → `test`, `concurrency.cancel-in-progress`, node version from `engines`, 10-min timeout) and `release.yml` (push to main touching `src/**`/`index.ts`/`package.json`; `permissions: contents: write, id-token: write`; `fetch-depth: 0`; `scripts/release.mjs` classifies `git log <lastTag>..HEAD` — `!`/`BREAKING CHANGE` → major, `feat` → minor, `fix`/`perf`/`refactor` → patch, docs/test/chore only → **no release**, `[skip release]` → no release; then `npm version`, annotated tag, `gh release create`, and `npm publish --provenance` **only** when `NPM_TOKEN` exists, otherwise it logs `skipped: no token`) | `.github/workflows/*.yml`, `scripts/release.mjs` |
| P16-E | audit trim (R14 doc budgets, R15 drift, drop PLAN/evidence rules), `noUnusedLocals` flip, `npm run lint` = `tsc --noEmit && node scripts/audit.mjs`, prune commit + archive tag | `scripts/audit.mjs`, `tsconfig.json`, `package.json` |

**Default: no linter dependency.** `lint` means typecheck + the hard-rules audit, which is what this repo
can actually regress on. Adding eslint/biome is a separate decision with a one-line justification, not part
of the publication.

**Gates — V16.1..V16.10**
1. `git ls-files | wc -l` ≤ 120; `du -sh .git` unchanged or smaller; every deleted path present in
   `archive/pre-publication`.
2. No tracked path matches `^(research|evidence|bench)/`, `^(SPEC|PLAN)`; audit fails if one reappears.
3. Doc budgets enforced: README ≤ 90, AGENTS ≤ 100, each `docs/*.md` ≤ 120, total ≤ 400 lines (R14, hard fail).
4. Drift check (R15): every key in `DEFAULT_CONFIG` appears in `docs/config.md`; every code in
   `error-codes.ts` appears in `docs/errors.md`; every registered tool appears in the README table.
5. Tests: ≤ 10 files, suite ≤ 15 s, fixtures ≤ 150 KB, zero imports of deleted modules, and the prune
   commit message lists every dropped behaviour.
6. Fresh-clone gate: `git clone <repo> /tmp/x && cd /tmp/x && npm ci && npm run lint && npm test` is green
   with no network access and no `/proc`, `$HOME` or Chrome.
7. Release logic is offline-testable: `classifyBump()` table test covers feat/fix/refactor/breaking/
   docs-only/`[skip release]`; a dry run prints the expected next version for all six message sets.
8. `npm pack --dry-run --json` → ≤ 50 files, only allowlisted paths, ≤ 200 KB (extends V7.1).
9. Both workflows run green on the first push (run URLs recorded; the YAML is not asserted statically).
10. **Five-minute onboarding:** a fresh subagent that may read *only* `README.md` and `docs/**` must
    (a) enable CDP, (b) run one search, (c) explain three error codes without asking a question. Its
    transcript is the evidence.
    transcript is the evidence.

---

## 5. Waves and dependencies

| Wave | Lanes | Depends on |
|---|---|---|
| W8 | S1–S4 + S2b spikes (serial, live) and **P15-A/P15-C** (offline host layer) | — |
| W9 | P8-A, P9-B, P9-D, P10-D, **P15-B/P15-D** | W8 |
| W10 | P8-B, P9-A, P9-C, P10-A | W9 |
| W11 | P8-C, P9-E, P10-B, P11-A | W10 |
| W12 | P8-D, P10-C, P11-B, P12-A | W11 |
| W13 | P12-B, P13-A, P11-C | W12 |
| W14 | P12-C, P13-B, P14-A | W13 |
| W15 | P13-C, P14-B, P10 live gate | W14 |
| W16 | P14-C + bench verdict (serial) | W15 |
| W17 | P16-A (distill) → P16-B/P16-C/P16-E (parallel, disjoint) → P16-D (CI/release) → prune commit + archive tag (serial) | W16 |

P15 must land before W12: P11-B and P12-B are the only lanes that leave the process, and they reach the
host through `capability()`, never through a literal binary name.

Live gates are orchestrator-only and serial; they run once per phase, not per lane. Workers stay offline.

---

## 6. Non-goals for v2

- No headless, no automation profile, no fingerprint work — unchanged.
- No captcha solving, no third-party solver, no retry loop around a wall.
- No focus stealing when the config says `never`; no desktop-specific helper is *required*, and only an
  already-installed one may be used. No attention mechanism may open a window, a tab or a URL to get the
  user's eye — attention is signalled, never manufactured by side effects.
- No paid search APIs; P14's classifier is the only paid surface and it stays budgeted and optional.
- No new runtime dependency without a stated justification; an installed extractor is a *fallback*, never
  the primary path (see the P12 ladder).
- No feature may assume Linux, a specific desktop, a specific terminal or a specific browser family: a
  missing capability is a hint, never a crash (PO1–PO5).
- No metric that improves by returning less.

P16 adds one more: **no file may exist for the process's sake.** If a document describes how the project
was built rather than how the software works, it does not ship — it goes to the archive tag.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Google/DDG/Yandex change AI markup again | S4 snapshots + canaries per selector; `ai:lead` is a *valid* outcome, never an error |
| Anchor panel becomes a privacy surface | it is local-only, no network, no cookies, no query history beyond the current session; `window.panel:false` disables it |
| Follow-focus annoys the user mid-work | `"never"` is byte-identical to today; `idleMs` returns control quickly |
| Raising Chrome on Wayland has no portable API | P11 does not depend on it: L0 (terminal escape) + L1 (XDG notification) + L3 (long wait) carry the feature on every desktop; L2 is best-effort and `raise: unavailable` is a pass |
| PDF viewer path differs by Chrome version | S2 runs on the installed Chrome (157) and the plan records the version; the AX-tree rung is version-checked, not assumed |
| Reflex v2 gate turns into a research project | fixed corpus, fixed rubric, one bench run, verdict allowed to be negative |
| Platform assumptions silently regress | audit R13 + the three-platform unit matrix (V15.1/V15.6); the Linux behaviour is asserted byte-identical to today's |
| A half-configured host produces a confusing failure | every lane that leaves the process reports *which* capability was missing and which rungs were tried, in the error hint and in the artifact `meta.json` |
| Pruning deletes knowledge that the next maintainer then re-derives | `archive/pre-publication` tag + P16-A distills engine selectors and architecture *before* deletion + the five-minute onboarding gate (V16.10) proves the survivors are enough |
| Cutting 785 tests down loses a real regression net | the keep-criterion is written down, the prune commit lists every dropped behaviour, and the opt-in live smoke remains |
| Automatic version bumps create tag spam or release docs-only churn | `paths` filter on code files, conventional-commit classification, `[skip release]` escape hatch, and an offline table test for the classifier |
| CI-only release goes wrong on the first real push | release runs `npm test` first, publishes only when `NPM_TOKEN` exists, and the first run is a recorded gate (V16.9) |
| Live probes burn the profile | one query per engine per gate, pacing unchanged, caps in `state.json` checked before every live step |

---

## 8. Evidence and commit conventions for v2

- `evidence/P8.md` … `evidence/P16.md`, same shape as v1: gate id, command, raw output, verdict, date.
- Spike notes: `evidence/P<N>-spike.md` (`P10-spike`, `P11-spike`, `P12-spike`).
- Commits: `p15: host layer`, `p8: ai states`, `p9: read mutex`, `p10: anchor panel`, `p11: allow ux`,
  `p12: pdf`, `p13: claims`, `p14: reflex gate`, `release: prune to shippable tree`; contract edits as
  `contract: …` before the dependent lanes.
- P16 deletes `evidence/` itself in its own prune commit — after the gates are recorded and captured in the
  phase's evidence file, which is then archived with the rest of the apparatus.
- Each phase updates `research/FINDINGS.md` if a selector or a browser behaviour was measured.
- `PLAN.md` §5 gets one row per v2 phase once the phase has evidence (orchestrator edit), so the status
  table stays the single index of truth.
