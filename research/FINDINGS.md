# FINDINGS — live probes, 2026-11-05

**Plan of record:** `../PLAN.md`. These findings are inputs to P3 (adapters) and P4 (read/images): the
selectors and sizes below are the contract that the offline fixtures encode, and every live gate
re-verifies them once. If a gate sees drift, patch the adapter **and** update this file — the phase is not
accepted until `evidence/P<N>.md` and this document agree. Probe scripts stay one-shot: no loops.

Everything below was measured on the user's machine, not inferred from docs. Numbers are from a small
number of runs on one IP; treat them as orders of magnitude, not constants. Re-measure in `bench/`.

## Environment

| Item | Value |
|---|---|
| Date | 2026-11-05, ~16:00–16:30 UTC |
| Chrome | 157.0.8103.38, headed, Wayland |
| Profile | `~/.config/google-chrome` (running), Google account logged in, 423 `.yandex.ru` cookies |
| IP | RU residential, Kaluga, Rostelecom (exact address intentionally omitted) |
| Node / pi | 26.13.0 / 1.5.0 |
| CDP | not enabled at rest; probes launched a **copy** of the profile or a throwaway profile |

---

## 1. Playwright launch vs CDP attach (the most important finding)

**Playwright `launchPersistentContext({ channel: "chrome", headless: false })`:**

- Fresh throwaway profile (`/tmp/wtest/profile`), desktop UA, `--disable-blink-features=AutomationControlled`.
- Google worked for the first ~6 queries (AI Overview present), then returned
  `https://www.google.com/sorry/index?continue=…` — "Мы зарегистрировали подозрительный трафик,
  исходящий из вашей сети" with the IP printed.
- Yandex returned `/showcaptcha` (SmartCaptcha) on the first direct SERP navigation.

**Manual Chrome + `connectOverCDP` (no Playwright launch flags):**

- `navigator.webdriver === false`.
- Google served normal SERPs with AI Overview again.
- Yandex still captcha'd the first navigation of a session, but a **retry ~3 s later on the same profile
  returned a normal SERP** (9 `h3`, no captcha). This happened twice (two separate sessions).

**Conclusion:** attach, never launch. A visible, long-lived, real-profile Chrome is the asset.

### Profile copy experiment

- Copied `~/.config/google-chrome/{Local State,Default/Cookies,Default/Preferences}` to `/tmp/tp` and
  launched Chrome against it.
- Google rendered "Войти" (not logged in) → cookies were not usable after the copy.
- After that run, the copied cookie DB had **26 rows / 20 yandex / 6 google** instead of 423 yandex —
  Chrome discarded cookies it could not decrypt.
- `secret-tool` is present and the keyring is reachable (`Chrome Safe Storage` lookup exits 0), so
  programmatic decryption is possible, but **copying the profile is not a reliable way to inherit a
  session**. Use the live browser (or a dedicated, warmed profile).

---

## 2. Google

Query: `что такое трансформер в машинном обучении`, `&hl=ru`.

- **AI Overview:** present. Found via a `section` whose `innerText` contains `Обзор от ИИ`; raw text
  ~2 608 chars. The block includes sub-headings, inline source names (`Википедия`, `+1`,
  `BigDataSchool`, `Hugging Face`), and a "show more" control.
- **Organics:** 9–10 `a h3` items. Container `closest('div[data-hveid]')`; snippet
  `.VwiC3b, [data-sncf]` worked.
- **Links are opaque:** every organic href is `/goto?url=CAES…` (signed protobuf). Real URLs are also
  embedded in page JS data, but parsing that is brittle.
- **Resolution:** `GET https://www.google.com/goto?url=…` through the browser context with
  `maxRedirects: 0` returned `302` + `Location: <real url>` for 3 of 4 tested links; one returned `200`
  with no redirect (handle as unresolved).
- **AI Mode ("Режим ИИ"):** the tab href is
  `/search?q=…&sca_esv=…&hl=ru&sxsrf=…`. Clicking it produced a chat-style answer
  (`Ответ в режиме ИИ`, ~4 841 chars) with the same source domains. Slower and longer than AI Overview;
  not needed for MVP.
- **Sizes:** raw visible text 5 780 chars → compact (8 results + AI capped 1 200) 3 024 chars (1.9×).
  With `n=5` the output is ~2.2–2.4k chars.
- **Timing:** ~5.5 s for navigation + 3.8 s settle + extraction + 4 `/goto` resolutions.

Failure mode seen: `/sorry` (reCAPTCHA) after a burst from a Playwright-launched browser.

---

## 3. Yandex

Query: `стоит ли покупать электромобиль в россии`, `yandex.ru/search/?text=…`.

- **SmartCaptcha** on first navigation in a fresh session (`/showcaptcha`, body "Я не робот",
  "Нам очень жаль, но запросы с вашего устройства похожи на автоматические"). The page advertises
  **Yandex Search API v2** as the sanctioned path.
- Retry after ~3 s on the same profile → normal SERP. Confirmed twice.
- **Layout (2026-11):** no `li.serp-item`; `serp-item` count = 0. Use:
  - `.OrganicTitle` (anchor inside or nearest anchor) → title + href;
  - `.OrganicTextContentSpan` → snippet;
  - 9 `h3` on a normal page.
- **AI summary:** `h3` text `Быстрый ответ Алисы AI`, inside `Futuris*` classes
  (`FuturisGPTMessage`, `FuturisContentSection`, `FactFold`). The `FactFold` container was
  `height: 205px` (collapsed) with a "Показать полностью" control. Content included headings, bullets
  and source domains (`banki.ru`, `dzen.ru`, `sbersova.ru`, …), ~3 876 chars raw.
- `data-fast-name="neuro_answer"` appeared in one capture, **not** in another for the same query type.
  It is a bonus signal, not a contract.
- **"Алиса AI" tab** exists in the header; href `//yandex.ru/alice?reqid=…&alice_dee…`. Not explored.
- **Sizes:** raw visible text 11 674 chars → compact (8 results + AI capped 1 200) 1 590 chars (7.3×).
- **Timing:** ~5.8 s including the captcha retry path (successful retry was ~3 s + 5.5 s settle).

---

## 4. DuckDuckGo

Query: `how does a solar panel work`, `duckduckgo.com/?q=…`.

- **Search Assist:** present for this English query. The answer text sits between the second `Search
  Assist` occurrence and `Ответ составлен автоматически` (RU UI) / `Answer generated automatically`
  (EN). Sources appear as domain names before the disclaimer.
- The assist block is **A/B**: a later load of the same query family showed only the "Search Assist"
  header and no answer. Treat `ai:no` as normal.
- **Results:** `a[data-testid="result-title-a"]` (real anchor with `href`), snippet
  `[data-result="snippet"]`, container `closest('article')`. 10 results, 19 `h3` including sub-links.
- **Sizes:** raw visible text ~7 201 chars → compact ~1 700 chars (4.2×).
- **HTTP endpoint is flaky:** `POST https://html.duckduckgo.com/html/` with browser-ish headers once
  returned 10 `result__a` links, later `ddgs` reported "No results found". Browser path is reliable;
  HTTP is not.
- **Timing:** ~4–6 s cold.

---

## 5. Keyless HTTP tricks (results only, no AI summary)

From `ddgs` 9.16.1 source (MIT), tested via `uv run --with ddgs`:

```python
DDGS().text("что такое трансформер", backend="yandex", max_results=3)   # 3 results
DDGS().text("что такое трансформер", backend="google", max_results=3)   # 3 results
DDGS().text("…", backend="duckduckgo", max_results=3)                   # ERR: No results
```

How they work:
- **Google:** `GET https://www.google.com/wml/search` with a 2007-era Nokia UA
  (`NokiaN72/<fw> Series60/2.8 Profile/MIDP-2.0 Configuration/CLDC-1.1`, optionally
  `/UC Browser7.9.1.12x/27/351/UCWEB`), cookie `CONSENT=YES+`, params
  `q, sca_esv=1, filter, start, hl, lr, cr`; parse the WML/mobile HTML, links `/url?q=`.
- **Yandex:** `GET https://yandex.com/search/site/?text=…&web=1&searchid=<random 7 digits>&p=<n-1>`;
  parse `//li[contains(@class,'serp-item')]` + `h3 a` + `.text`.
- **DDG:** `POST https://html.duckduckgo.com/html/` — unreliable from this IP.

A direct Node `fetch` with the same Nokia UA/cookie returned **403** for the Google WML endpoint, while
`ddgs` (Python/TLS stack) got results. So the Google trick is TLS/header-fingerprint-sensitive; do not
count on it from Node. Yandex `search/site` worked from plain Node `fetch` (200, ~39–42 KB, 5 items).

Use only as a degraded fallback when the browser is unavailable. No AI summary, no `/goto` resolution.

---

## 6. Token and tool-surface measurements

| Package | Tools | Description chars (approx.) | Notes |
|---|---|---|---|
| `pi-browser-harness` | 44 | 12 832 (≈3.2k tokens) | browser control, not search |
| `pi-camoufox-gateway` | 2 | 1 976 (≈500 tokens) | closest search infrastructure |
| `pi-web-access` | 4–6 | 2 157 + long guidance | provider sprawl |
| `pi-web-search` (provider-native) | 2 | 520 | tiny surface |
| **target for this project** | **1 direct + deferred** | **≤900** | ≈230 tokens |

Raw-vs-compact character counts are in §2–§4. Token estimate for Russian: ~2.5 chars/token.

---

## 7. Prior-art facts worth remembering

- `pi-web-access` has a keyless DuckDuckGo parser (`duckduckgo.ts`) and a `degoog.ts`, but **no Yandex**
  and no engine-native AI summaries (`grep -ri yandex` → nothing).
- `pi-camoufox-gateway` already documents the Google `/goto` problem and resolves it by opening a tab per
  URL (expensive). Our HTTP `302` trick is cheaper.
- `omkarcloud/google-scraper` (MIT, Python/Camoufox) returns `ai_overview: { is_available, text, sources }`
  — a good schema reference. It requires a local Python API and Camoufox.
- `ddgs` (MIT) is the source of the Google WML / Yandex site-search tricks.
- `pi-browser-harness` reads `DevToolsActivePort` from profile dirs and probes `/json/version`; it notes
  that `/json/version` may be disabled when debugging is enabled via `chrome://inspect`.

---

## 8. Classifier backends (OpenRouter / local)

Pi ships classifier models as a separate model type. The ones visible through `openrouter` (from
`pi/packages/ai/dist/providers/data/openrouter.json`; prices = USD per 1M input tokens, no output):

| Model ID under `openrouter` | $/1M in | Ctx | Input |
|---|---|---|---|
| `~typesafe/jev-latest` | 0.042 | 262k | text+image |
| `typesafe/jev-1.14` | 0.042 | 262k | text+image |
| `cloudflare/clef-flash` | 0.038 | 24k | text+image |
| `~perplexity/pplx-decider-flash-latest` | 0.010 | 262k | text+image |
| `respan/span-01-lite:free` | 0 | 4k | text |
| `openai/gpt-6-luna-decisions` | 0.10 | 1.05M | text+image |

Local llama.cpp decision models (`/v1/systemone`) are free and appear as classifiers when the router
reports `architecture.output_modalities` containing `decisions`:

```bash
curl -s http://127.0.0.1:8080/models | \
  jq '.data[] | select(.architecture.output_modalities[]? == "decisions") | .id'
```

Cost of triage, realistically: 20 candidates × ~350 input tokens = 7k tokens.
Jev ≈ $0.0003 per search; PPLX Decider Flash ≈ $0.00007; Respan/local = $0. 1 000 searches with Jev
≈ $0.30. This is why "use OpenRouter for System 1" is compatible with the "free search" requirement —
it is not free, but it is noise, and it is optional (`reflex.localOnly: true`).

Caveats: remote classifiers add 100–600 ms per call; one call per candidate means 20 calls per triage.
Run with concurrency 4, set a deadline, and skip triage for plain `n=5` single-engine searches. If the
bench shows the latency is too high, either batch 10–20 candidates into one cheap chat call
(`ctx.modelRegistry.complete()` with strict JSON) or stay on rules.

## 9. How pi itself uses classifiers (why they look "off by default")

Nothing in pi's normal chat loop calls a classifier. The capability is built in, but only two surfaces
reach it:

1. **`codemode`** — scripts call `models.classify(model, { state, questions })`. Codemode is off by
   default (`defaultTools` does not include it); enable with `"defaultTools": ["+codemode"]` or
   `--tools +codemode`. This is the intended home for "filter/rank/judge inside a script" (exactly our
   triage use case). With `codemode.mode: "on"` (default) declared tools stay declared and only
   undeclared tools are listed, within a 3000-token `inlineBudget`; `"only"` hides all direct tools and
   forces every call through a script. Nested calls still go through `tool_call`/`tool_result`.
2. **Virtual models** — an extension registers `pi.registerVirtualModel({ route })`, and `route()` may
   call `ctx.modelRegistry.classify()` to pick the physical chat model per request. The shipped example
   is `examples/extensions/jev-router.ts`: Jev rates the first user message, planning goes to a strong
   model, implementation switches to a cheap one after the first successful edit. It only works if the
   extension is loaded and the virtual model is selected (`/model jev/auto`).

llama.cpp decision models are listed as classifiers and can be used by either surface. Image-capable
classifiers (Jev, Clef, Luna) can also judge screenshots — relevant for "is this page a captcha / a
layout change / the right answer".

Classifier usage is reported with token counts and cost; `classify()` returns `usage`, and codemode adds
it to the tool result/session cost. Direct extension calls through `ctx.modelRegistry.classify()` get the
same `usage` field.

## 10. Caveats

- Findings are snapshots, not guarantees: P3/P4/P7 gates re-check them on the live browser, and
  `PLAN.md` V3.1/V3.2 turn them into offline fixtures with canaries.
- One IP, one day, few runs. Google/Yandex behaviour is A/B and reputation-dependent.
- The AI Overview/Neuro/Search Assist presence is query- and experiment-dependent; `ai:no` is normal.
- Selectors are obfuscated and will drift; the text markers are more stable than class names.
- The user's profile was copied for some probes; cookies did not survive. Do not build on profile copies.

## 11. CDP navigation semantics (measured 2026-11-06, Chrome 157)

`Page.navigate` + `Page.loadEventFired` + loaderId correlation is **not** a usable readiness gate on a
real profile. Navigating to `https://www.google.com/search?q=…&hl=ru` in the user's logged-in Chrome
produced no matching `loadEventFired` within 30 s: the SERP redirects through consent/`/search` hops and
keeps loading ads/trackers, so the correlated event never arrives and the client reports `E_TIMEOUT` on a
page that is visibly rendered and searchable.

What works (implemented in `cdp/session.ts`):

1. `Page.getFrameTree` **before** navigating → the current main-frame `loaderId` is the stale-event
   discriminator. Without it, a replayed `frameNavigated` from the previous document silently satisfies
   the wait.
2. Subscribe to `Page.frameNavigated` (one event per redirect hop, each with a fresh `loaderId`) and
   `Page.navigatedWithinDocument` (fragment/history navs keep the `loaderId`) **before** `Page.navigate`.
3. Resolve on the first commit with `loaderId !== preLoaderId`; a 250 ms single URL check covers the rare
   navigation that returns without an event and with the target URL already updated.
4. Then poll `document.readyState` (120 ms) and accept `interactive` + 200 ms grace — waiting for
   `complete` reproduces the timeout. Content readiness is the adapter's marker settle, not the client's.
5. `attach` does not return a URL: seed `page.url()` from `createTarget` and one best-effort
   `Target.getTargetInfo` on attach, otherwise a freshly opened tab reports `""`.

Measured: redirect chain resolves in ~3 ms; an `interactive`-only page in ~245 ms (grace path); a stalled
`loading` page still fails at the deadline; a stale replay fails instead of falsely succeeding.

## 12. AI-summary states and streaming (measured 2026-11-06, P8)

The AI block was previously treated as "present or absent", and a present-but-empty block was reported as
`ai:yes` with the lead line (`Ответ в режиме ИИ, исходный запрос: "…"`) as its text. Measured live with
`research/probes/10-ai-stream.mjs` (one navigation, one query, adapter `ai.probe()` polled every 250 ms):

| Engine | Query class | First probe after `page.navigate()` | Final | Width |
|---|---|---|---|---|
| Google | technical | `answer` at 1 188 ms (no lead/shell phase observed) | answer | 2 304 chars |
| Yandex (via `web_search`, typed path) | technical | — | answer | 351 chars |
| DuckDuckGo (via `web_search`, typed path) | technical | — | answer | 525 chars |

Findings:

1. **On this profile the Overview was already complete when the SERP navigation resolved.** No
   `none → lead → answer` transition was observable on a fresh navigation, so the live stream is not a
   reliable way to stage the three states. The fixtures model them instead:
   - `google-no-ai` (no AI section) = the shell/absent state,
   - `google-ai-lead` (derived from `google-ai`: real section, prose replaced by the live lead line),
   - `google-ai` (the real capture) = the answer state.
   `ddg-assist-lead` is derived from `ddg-assist` the same way (container kept, body removed).
2. **`ai:yes` must be width-gated.** A 351-char Yandex answer and a 525-char DDG answer are answers; a
   47-char fragment or the query echo is not. The threshold is 200 chars of non-lead prose
   (`AI_ANSWER_MIN_CHARS`), enforced twice: by the adapters and again by `extract/compact.ts`, so a
   hand-built or third-party `RawSerp` cannot smuggle a short "answer" through.
3. **A page with no AI block must not cost the full `aiWaitMs`.** Observed: the wait on a Google SERP
   without an Overview ends at ~1 400 ms (grace) with `state=none`, and the artifact records
   `AI_TIMEOUT` with `polls: 10`. A block that *is* present keeps the wait alive to the deadline; Yandex
   took 2.24 s to render its answer, which is the engine's render time, not our polling overhead (the wait
   returns on the first probe that sees ≥200 chars).
4. **Derived fixtures are labelled.** Their `meta.json` `capturedWith`/`notes` say `derived from … (P8 S4)`
   and never claim a fresh capture. No prose was invented: the lead line is the string the live bug
   produced, and the answer fixture is the untouched real capture.
5. **`page.url()` is stale after a typed search (P9 input).** The human path presses Enter inside the page;
   the navigate-commit tracking in `cdp/session.ts` only runs during `page.navigate()`, so an artifact saved
   after a typed search records the *home* URL while `page.txt`/`page.html` are the SERP. `detectWall`'s URL
   evidence has the same blind spot. Recorded here for P9-B (post-navigate proof), not fixed in P8.

## 13. P9 measurements — read integrity, the small lies, and the attach budget (2026-11-06)

1. **Parallel reads really do share one tab.** `acquirePage("read")` is idempotent by design, so four
   concurrent `web_read` calls navigated the same tab and every extraction saw the last body. Fixed by an
   exclusive FIFO lock per slot (`cdp/page-lock.ts`, `config.read.pool` 1..3). Live: two concurrent reads
   (example.com + iana.org) returned `Example Domain` (923 chars) and `Example Domains` (854 chars) in
   2.37 s total, and the lock reported `pending() === 0` afterwards.
2. **`page.url()` is a cache, not a fact.** After a typed search (or a JS redirect) the target-event cache
   still holds the previous document's URL. `CdpPage.currentUrl()` asks the document for `location.href`
   and refreshes the cache; `web_read` compares it before and after extraction and raises
   `E_NAVIGATION_MISMATCH` instead of extracting a stranger's page. Comparing it to the *requested* URL
   would reject every legitimate redirect, so the proof is "the document did not move during the read".
3. **A failed `E_PARSE`/`E_TIMEOUT`/redirect left no artifact.** `web_read` never called
   `artifacts.save()`. Now `E_PARSE`, `E_TIMEOUT`, `E_BLOCKED_URL` (after a redirect) and
   `E_NAVIGATION_MISMATCH` snapshot `page.html`/`page.txt`/`meta.json` through one shared
   `saveFailureArtifact()` call site (also used by `web_search`/`image_search`).
4. **The doctor's connect budget was shorter than Chrome's Allow prompt.** Observed on the installed
   Chrome (157): the first attach after the last owned window was closed — and any attach that has to wait
   for the user to click Allow in `chrome://inspect` — can outlive the doctor's 7 s connect budget
   (`connectTimeoutMs` 5 s + 2 s discovery). The fix then logged
   `connect failed: E_CDP_UNAVAILABLE` + `reconnect failed: E_CDP_UNAVAILABLE` while the very next report
   (same process) connected and printed `cdp: ok`. Two changes: a timed-out connect is now given a late
   grace on the *same* promise and reported as `connected to CDP (after the deadline)`; and a post-release
   reconnect is attempted only when the session is actually gone (`session still open; reconnect not
   required` otherwise). Measured after the fix: `--fix --no-probe` finished in 3.0 s with
   `connected to CDP` / `closed 1 owned tab(s)` / `reconnected after release`, exit 0.
   **The real fix for the missed prompt is P11** (blocking wait + desktop notification + best-effort
   raise); P9 only removes the false claim.
5. **`probe:false` is not `unavailable`.** A skipped probe means "not exercised"; the doctor now says
   `skipped` and keeps the report `degraded`, so "no evidence" is never mistaken for "engine works" or
   "engine tried and failed". A `fix` re-probes even when the caller passed `probe:false`.
6. **A merged search split nothing.** `n=3` across two engines asked each engine for 3 and the first
   engine filled every slot; a failed second engine was invisible. Now each engine gets `ceil(n/k)` and the
   header carries `google:2 yandex:0(E_WALL)` (also in `details.perEngine`/`details.failedEngines` and the
   JSON view, recomputed after the JSON fit).
7. **Yandex `pageUrl` is an image file.** The 2026 tile markup discloses only `img_url` (the source image),
   not its host page. `ImageItem.pageUrlKind` is `"page"` for Google and `"image"` for Yandex; the tool
   description says so, and the payload validator infers the kind from the URL when a payload omits it.

## 14. P11 measurements — the Allow prompt (2026-11-06)

1. **The prompt looks like a dead socket.** Chrome 136+ completes the DevTools WebSocket handshake only
   after the user clicks Allow; until then the client sits in the handshake and the old 5 s connect budget
   (7 s with discovery) expired first. The user's report matches the data: "I don't always see the prompt
   and don't always manage to click Allow." The doctor used to call that `E_CDP_UNAVAILABLE`; two P9 runs
   logged a failed connect and then reported `cdp: ok` from the same process.
2. **A refusal is not a prompt.** `ECONNREFUSED`/`ENOTFOUND` means nothing listens, so waiting 60 s would
   be a lie; the connector fails immediately for those and waits only for a handshake that hangs or is
   rejected.
3. **Measurement of the wait (black-hole endpoint, not Chrome):** a TCP server that accepts and never
   answers, `attachWaitMs: 7000`, `connectTimeoutMs: 5000` → 2 attempts, progress at 3 s,
   `E_CDP_AWAITING_ALLOW` at 8 015 ms, report `status: awaiting_allow`, exit 2. Notification and raise each
   fired exactly once.
4. **L1 works on this host:** `notifyDesktop()` → `{"delivered":true,"via":"notify-send","tried":["notify-send"]}`
   (urgency critical, `-t 0`, so the popup stays until dismissed).
5. **L2 works, but Hyprland 0.57 changed its IPC.** The legacy dispatcher
   `hyprctl dispatch focuswindow class:google-chrome` now fails with a Lua error; the working call is
   `hyprctl eval 'hl.dsp.focus({window="class:google-chrome"})'`. The adapter tries the modern form first
   and falls back to the legacy one, so older builds keep working. Window class measured with
   `hyprctl clients -j`: `google-chrome` (title `… - Google Chrome`), no `wmctrl`/`xdotool`/`kdotool`.
6. **Attention is signalled, never manufactured.** Nothing in the path opens a window, a tab or a URL,
   launches the browser or installs a helper; `gio launch chrome.desktop` was deliberately left out of the
   raise ladder because activating a stopped browser is a side effect, not attention.
7. **A fresh-Chrome re-reproduction is out of scope by rule.** Forcing the prompt again would require
   restarting Chrome or revoking the Allow in `chrome://inspect`; the first is forbidden (AGENTS §2), the
   second would leave the user's session unusable mid-run. The waiting state machine is therefore proven
   offline (FakeSession) and against a live silent endpoint; the real-prompt case is the one P9 already
   observed twice.
