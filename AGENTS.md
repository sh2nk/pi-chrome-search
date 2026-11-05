# AGENTS.md — how to work on `pi-chrome-search`

This is the operating manual for the coding agent. Read **`SPEC.md`** first (it is the source of truth),
then `research/FINDINGS.md`. The repo is a scaffold: no `package.json`/`src` yet — **M0 is the first task**.

The user speaks Russian; reply in Russian. Code, comments, commit messages and docs are English.

---

## 1. What we are building (30 seconds)

A pi extension that lets the agent search the web **for free through the user's real, visible Chrome**:
Google, DuckDuckGo, Yandex, with each engine's native AI summary (AI Overview / Search Assist /
"Быстрый ответ Алисы AI"), compact output, page reading, image search, and an optional local
**System 1** reflex layer. It attaches over CDP; it never launches an automation browser, never uses a
paid API, never solves captchas, and never spoofs a fingerprint.

The user's words: *"я хочу посадить агента за меня бесплатно сидеть гуглить в моём браузере"*.
The window being visible is **desired**, not a bug.

---

## 2. Hard rules (violating these breaks the premise)

1. **Attach to the user's running Chrome.** Never `playwright.launch()`, never
   `chromium.launchPersistentContext()`, never `--enable-automation`, never a separate automation profile
   in `attach` mode. Raw CDP only in production code.
2. **Never restart, kill, or close the user's Chrome.** Never close tabs the extension did not open.
   Never touch `~/.config/google-chrome/**` (no cookie copying, no deleting, no editing `Local State`).
3. **No paid search APIs and no search keys.** No SerpApi/Serper/Brave/Tavily/Exa/Kagi. Keyless HTTP
   tricks only as a degraded fallback, clearly marked `degraded: true`.
   **Exception (D8):** System 1 classifiers may use the user's existing OpenRouter balance (very cheap)
   or local llama.cpp. Search traffic never goes through OpenRouter; classifier calls are capped, logged
   and can be disabled with `reflex.localOnly: true`.
4. **No headless.** The whole point is a real headed browser on a real profile.
5. **No fingerprint spoofing.** Do not override UA, locale, timezone, screen, WebGL, `navigator.*`.
   No `Page.addScriptToEvaluateOnNewDocument`. One-off `Runtime.evaluate` for extraction is fine.
6. **Never solve captchas** (no clicks on "Я не робот", no third-party solvers). Surface the window and
   return `E_WALL` with a hint; the user solves it.
7. **Rate-limit like a human.** One search at a time per engine; respect `pacing`; respect daily caps.
   Do not run live probes in a loop — that is exactly what gets the profile captcha'd.
8. **Do not auto-launch Chrome** in `attach` mode if it is not running. Ask the user.
9. **Every failure must be diagnosable**: error code + stage + hint + artifact where useful. No bare
   `throw new Error("failed")`.
10. **Keep the prompt cheap.** `web_search` is the only `direct` tool. Everything else is `deferred`.
    Measure the total tool description size (≤900 chars) in a test.

---

## 3. Environment (verified 2026-11-05)

- Chrome `157.0.8103.38` at `/usr/bin/google-chrome-stable`; Wayland, `DISPLAY=:0`; headed works.
- Profile: `~/.config/google-chrome` (currently running), logged into Google, 423 `.yandex.ru` cookies.
- IP: RU residential (Kaluga, Rostelecom) — good for Yandex/Google; exact address intentionally omitted.
- Node `26.13.0` (native TS type-stripping: `node --test tests/*.test.ts` works), pi `1.5.0`.
- OpenRouter is authenticated in pi (`~/.pi/agent/auth.json`, provider `openrouter`) — classifiers only.
- Local llama.cpp is configured as provider `ik-llama` (`http://127.0.0.1:8080/v1`), may be down.
- CDP is **not enabled yet**: no `DevToolsActivePort`, `127.0.0.1:9222` closed.

### Enable CDP (one-time, user action)
Because Chrome 136+ ignores `--remote-debugging-port` for the default profile:
1. Open `chrome://inspect/#remote-debugging` in the user's Chrome.
2. Tick **Discover network targets** / the remote-debugging toggle, click **Allow**.
3. Verify: `cat ~/.config/google-chrome/DevToolsActivePort` (port + path) or
   `curl -s http://127.0.0.1:9222/json/version`.
4. In our code: read `DevToolsActivePort`, build `ws://127.0.0.1:<port><path>`; if `/json/version` is
   disabled in this mode, the file is authoritative. Escape hatch: `PI_CHROME_CDP_WS=ws://…`.

If the flow differs on this Chrome build, **document the exact clicks here** after verifying.

---

## 4. Start here (M0 checklist)

1. Read `SPEC.md` fully; skim `research/FINDINGS.md` and `research/probes/`.
2. Create the scaffold exactly as SPEC §4 describes:
   - `package.json` (`"type": "module"`, `"pi": { "extensions": ["./src/index.ts"] }`, peer deps
     `@earendil-works/pi-coding-agent` and `typebox`, deps `ws`; dev deps `typescript`, `@types/ws`,
     `@types/node`), `tsconfig.json` (strict), `.gitignore`.
   - `src/index.ts` registering a no-op `web_doctor`-less extension (so `pi -e` loads) + config loader.
   - `src/cdp/{discovery,session}.ts`, `src/runtime/{errors,doctor,log}.ts`, `src/config.ts`.
   - `/web-doctor` command printing CDP/browser/profile/`navigator.webdriver`/lock state.
3. Ask the user to enable CDP (§3) if it is not enabled; verify `web_doctor` sees the browser.
4. Commit. Then proceed to M1 (Google) per SPEC §14.

**Acceptance for M0:** `pi -e ./src/index.ts` loads with no errors; `/web-doctor` reports a live CDP
endpoint and `navigator.webdriver === false`; `npm test` and `npm run typecheck` pass (empty tests OK);
no `playwright` import in `src/`.

---

## 5. Repo layout (target)

```
AGENTS.md  SPEC.md  README.md (M7)
research/FINDINGS.md  research/probes/
src/index.ts  src/config.ts
src/tools/{web_search,web_read,image_search,web_research}.ts
src/engines/{types,google,duckduckgo,yandex,images}.ts
src/cdp/{discovery,session,browser,humanize}.ts
src/extract/{compact,read,urls}.ts
src/runtime/{cache,limiter,errors,artifacts,doctor,log}.ts
src/reflex/{types,rules,classifier,policy}.ts
tests/{unit,fixtures,live}  bench/
```

No `node_modules`, artifacts, or fixtures with personal data in git.

---

## 6. Commands

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # node --test tests/**/*.test.ts (offline)
PI_CHROME_LIVE=1 npm run test:live   # one query per engine, n=2; SKIP on wall, never loop
pi -e ./src/index.ts              # load the extension in a throwaway session
pi -e ./src/index.ts --model …    # if the current model misbehaves
```

Live commands that hit search engines must be run **once**, not in a retry loop. If a test is flaky
because of a wall, fix the test to skip, not to hammer.

---

## 7. Debugging playbook

| Symptom | Action |
|---|---|
| `E_CDP_UNAVAILABLE` | `cat ~/.config/google-chrome/DevToolsActivePort`; check `curl :9222/json/version`; ask user to Allow in `chrome://inspect`; or set `PI_CHROME_CDP_WS` |
| `E_CDP_DISCONNECTED` | reconnect once; check the user did not close Chrome; check lock file |
| `E_WALL` (yandex) | surface window, ask user to solve; after solve retry once; never automate |
| `E_WALL` (google `/sorry`) | stop searching for a while; check whether a Playwright launch was used (it must not be); verify `navigator.webdriver === false` |
| `E_PARSE` | open the artifact dir from the error; compare `page.txt`/`page.html` with the adapter's markers; patch; add a fixture; bump `research/FINDINGS.md` |
| AI summary missing | check `ai:no` is a normal A/B outcome; verify text markers on the live page; do not fabricate |
| Tool name collision | another extension already registers `web_search`; fail early with `E_CONFIG` naming the conflict (do not silently rename) |
| Slow searches | cache hit? pacing sleeps? classifier latency? `web_doctor --json` has timings |

Artifacts: `~/.pi/agent/web-search/artifacts/<ts>-<engine>-<hash>/` (`page.html`, `page.txt`,
`screenshot.jpg`, `meta.json`). Decision log: `~/.pi/agent/web-search/decisions.jsonl` (M5).

---

## 8. Engineering conventions

- TypeScript strict, ESM, Node 26, no build step (pi loads `.ts` directly). No `any`; use `unknown` + guards.
- Small modules; an adapter is a pure `buildUrl` + DOM extractor, not a god object.
- Prefer text markers and structural heuristics over obfuscated class names. Every selector gets a canary.
- All output passes through `extract/compact.ts`: caps live in one place.
- All errors go through `runtime/errors.ts`: one taxonomy, one renderer.
- Comments explain **why** (the non-obvious browser behaviour), not what.
- New dependency: justify in the commit/PR. Prefer `ws` + hand-rolled CDP over Playwright.
- Tests are offline by default; live tests are opt-in and rate-limited.
- Commit style: `m0: scaffold`, `m1: google adapter`, `fix(parse): yandex neuro selector`, etc.
- Never commit: `node_modules/`, `artifacts/`, `.env`, screenshots, HTML fixtures containing personal data.

---

## 9. Prior art (read before reinventing)

- `pi-browser-harness` (MIT): CDP discovery, `DevToolsActivePort`, lock/daemon ideas, real-Chrome model.
- `pi-camoufox-gateway` (MIT): engine chain, cache, char budgets, honest errors, `/goto` problem.
- `pi-web-access` (MIT): token-saving patterns, DuckDuckGo keyless parser, fallback chains.
- `omkarcloud/google-scraper` (MIT): Google `ai_overview` schema and selectors.
- `ddgs` (MIT): Google WML and Yandex `search/site` HTTP tricks (fallback only).

To inspect one: `npm pack <name> && tar xzf <name>-*.tgz` (do not add them as deps).

---

## 10. System 1 (only after M4)

The user asked whether a fast decision model can make search/navigation more effective. Yes — but it is
**M5, behind `reflex.enabled: false`**, and only after `bench/` proves a win.

Backends, in order: local llama.cpp decision model (`/v1/systemone`, free) → OpenRouter classifier
(user's balance; e.g. `openrouter` + `~typesafe/jev-latest`, $0.042/1M input tokens) → `rules.ts`.
Use `ctx.modelRegistry.getAvailableOfType("classifier", "openrouter")`; never read `auth.json` or
`OPENROUTER_API_KEY` yourself. Check `stopReason` — `classify()` does not throw on provider errors.
Respect `maxCallsPerSearch`, `maxCallsPerSession`, `maxUsdPerSession`; log `usage`/`costUsd` to
`decisions.jsonl`. Set `reflex.localOnly: true` to forbid remote calls entirely.

The decision points (triage, read gate, coverage, routing), fallbacks, abstain thresholds, batching
experiment and benchmark gate are in SPEC §9. Do not put a classifier on the critical path before that.

---

## 11. Definition of done (per milestone)

- `npm run typecheck` and `npm test` pass.
- Offline fixture tests cover the new parser and the error path.
- One live smoke run documented in the commit message (engine, query, `ai:yes/no`, chars, latency).
- Token budget measured (output ≤2500 chars at `n=5`; tool descriptions ≤900 chars total).
- `web_doctor --json` still schema-valid and honest.
- `research/FINDINGS.md` updated if a selector/behaviour changed.
- No new dependency without a one-line justification.
