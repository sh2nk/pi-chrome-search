# pi-chrome-search

Free, keyless web search for [pi](https://pi.dev) through **your own, visible Chrome**. The extension attaches
to the browser you already use — same profile, same cookies, same IP — and returns compact Markdown from
Google, DuckDuckGo and Yandex, including each engine's native AI summary (Google AI Overview, DuckDuckGo
Search Assist, Yandex "Быстрый ответ Алисы AI"). It also reads pages and searches images.

The window staying visible is intentional: you can watch the search happen, solve a captcha yourself, and keep
using the same profile afterwards.

## What it is

- A pi extension (not a Chrome extension) that drives Chrome over the DevTools Protocol (CDP).
- Attachment, not automation: raw CDP to the running browser, one dedicated window, one work tab per engine.
- Bounded output: results plus an AI summary in ≤2500 characters, so search does not flood the context.
- Honest about failure: every error carries a code, a stage and a hint; parse/block failures leave artifacts.

## What it explicitly does not do

- **No automation browser.** No Playwright/Puppeteer launch, no `--enable-automation`, no separate automation
  profile in `attach` mode. `mode: "launch"` exists for development only and never touches your profile.
- **No paid search APIs and no search keys.** No SerpApi/Serper/Brave/Tavily/Exa/Kagi.
- **No captcha solving.** A wall is surfaced to you as `E_WALL`; it never clicks "I'm not a robot" and never
  calls a solver.
- **No fingerprint spoofing.** User agent, locale, timezone, screen, WebGL and `navigator.*` are untouched.
- **No headless mode,** and it never launches, restarts or kills Chrome; it never closes tabs it did not open.

## Requirements

Node ≥ 26 (native TypeScript, no build step), Chrome 136+ (tested with 157 on Wayland), pi (the devDependency
pins `^1.5.0`; the package peer is `*` so a newer pi is allowed), and a desktop session — headed Chrome, no
server/headless deployment.

## Install

From a local checkout (development and the supported first-run path):

```bash
npm install                 # ws + typescript (dev); no build step
pi -e ./src/index.ts        # load the extension for one session
pi install .                # …or register the checkout as a package
```

Install the packed tarball with npm, then point pi at the installed **directory** (pi's loader rejects a
`.tgz` path, and Node refuses to strip TypeScript under `node_modules`, so `pi -e` is the supported loader):

```bash
npm pack
npm install --prefix /tmp/pi-web ./pi-chrome-search-0.1.0.tgz
pi install /tmp/pi-web/node_modules/pi-chrome-search
```

With the shipped `peerDependencies` npm may also pull the pi/typebox chain into that prefix; pass
`--legacy-peer-deps` if you only want the extension and `ws`. `pi install` writes the package to
`~/.pi/agent/settings.json`; `pi list` shows it, `pi remove <source>` removes it. Verify the extension loaded
by running `/web-doctor` inside pi.

## Enable CDP in Chrome

Chrome 136+ ignores `--remote-debugging-port` for the default profile. Remote debugging is enabled from
inside the browser and requires an explicit **Allow** click:

1. Open `chrome://inspect/#remote-debugging` in the Chrome window you want the agent to use.
2. Tick **Discover network targets**, then click **Allow** on the debugging prompt.
3. Verify the endpoint file:

   ```bash
   cat ~/.config/google-chrome/DevToolsActivePort
   # line 1: port (e.g. 9222)
   # line 2: /devtools/browser/<uuid>
   ```

4. `curl 127.0.0.1:9222/json/version` may return nothing or 404 in this mode. That is expected, not a
   failure: **`DevToolsActivePort` is authoritative.** The extension builds `ws://127.0.0.1:<port><path>`
   from it (discovery order: `PI_CHROME_CDP_WS` → `PI_CHROME_CDP_PORTS` → `DevToolsActivePort` in the
   well-known profile dirs → port scan of `127.0.0.1`).

The UUID path changes when Chrome restarts, so re-read the file after a restart; if it is missing, repeat the
Allow flow. The extension never launches Chrome for you and never edits the profile.

### The Allow prompt is per connection

Chrome asks for permission for each new debugging connection; there is no "always allow" for the default
profile. For a work session, `research/probes/07-cdp-broker.mjs` connects once and lets sequential clients
reuse that connection over loopback:

```bash
node research/probes/07-cdp-broker.mjs --port 9333 --idle-min 30
PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker node src/cli/doctor.ts --json
```

The broker binds `127.0.0.1` only, accepts one client at a time ("one browser, one writer"), forwards CDP
frames and nothing else, and never reconnects or touches your tabs. It is a development aid in `research/`,
not part of the runtime.

## Tools

`web_search` is the only `direct` tool: it is always declared, and everything else is `deferred` — findable
through pi's tool search and callable from `codemode`, but not paid for in every prompt. All tool
descriptions together stay under 900 characters (enforced by `tests/unit/tool_budget.test.ts`).

| Tool | Exposure | Arguments |
|---|---|---|
| `web_search` | direct | `q`; `n` 1–10 (default 5); `engines` `auto` \| id \| list; `summary` (default true); `freshness` `d\|w\|m\|y`; `page` ≥1; `format` `md\|json` |
| `web_read` | deferred | `url` (http/https only); `offset`; `maxChars` (default 6000, ceiling 20000); `format` `md\|text` |
| `image_search` | deferred | `q`; `n` ≤12 (default 4); `engine` `google\|yandex`; `attach` (≤4 thumbnail URLs, off by default) |
| `web_research` | deferred | `q`; `budget` `quick` (1 search + 2 reads) \| `normal` (2+4) \| `deep` (4+8) |
| `web_doctor` | deferred | `probe` (default true), `fix` (default false: reconnect, close owned tabs, prune artifacts) |

`engines: "auto"` tries enabled engines in canonical order — google → duckduckgo → yandex — and falls back to
the next one on `E_WALL`/`E_EMPTY`/`E_UNSUPPORTED`/`E_CDP_*`/`E_TARGET_LOST`. A list merges results by URL,
keeps the best snippet and tags the engine only when the results are mixed.

A `web_search` result is capped at **2500 characters** in total, with the summary ≤1200 and snippets ≤140;
`n` never exceeds 10. If the AI block is absent the header says `ai:no` and results are unchanged — a normal
A/B outcome, never a fabricated summary.

```text
google · 5 results · ai:yes · 1.4s
AI: <summary, ≤1200 chars> [source domains]
1. <title> — <domain>
   <url>
   <≤140-char snippet>
```

`web_read` runs an in-page readability pass (nav/footer/cookie banners stripped) and refuses private hosts,
`file:` and `data:` URLs. It uses your session, which is the point, but it never sends page content anywhere.
`image_search` with `attach: true` appends thumbnail URLs, not image bytes.

## Configuration

Path: `$PI_CODING_AGENT_DIR/web-search.json`, default `~/.pi/agent/web-search.json`. The file is optional:
missing means defaults. It is **strict JSON** — an unknown key is `E_CONFIG` naming the exact key path — and
a partial file is deep-merged over the defaults.

| Key(s) | Default(s) | Meaning |
|---|---|---|
| `mode` | `"attach"` | `attach` drives your Chrome; `launch` is dev/test only, dedicated profile |
| `cdp.ports`, `cdp.ws`, `cdp.connectTimeoutMs`, `cdp.profileDir` | `[9222]`, `null`, `5000`, `null` | Fallback ports (after the endpoint file), explicit WS URL (env overrides), connect deadline, profile dir for `launch` |
| `window.focus`, `window.reuse` | `"session"`, `true` | `session` \| `always` \| `never` focus policy; reuse one dedicated window |
| `humanize` | `"auto"` | `auto` types the first search per engine; `always` types every search |
| `engines.google` | `{ enabled: true, lang: "auto", gl: "auto", dailyCap: 300 }` | On/off, `hl`/`gl`, daily soft cap |
| `engines.duckduckgo` | `{ enabled: true, kl: "auto", dailyCap: 300 }` | On/off, region-lang, cap |
| `engines.yandex` | `{ enabled: true, lr: "auto", dailyCap: 150 }` | On/off, region, cap; last in `auto` |
| `pacing.google`, `pacing.duckduckgo`, `pacing.yandex` | `[2500,5000]`, `[2000,4000]`, `[5000,9000]` | Min gap + jitter window in ms, per engine |
| `search.n`, `search.nMax` | `5`, `10` | Default and maximum results; above 10 is `E_CONFIG` |
| `search.summaryMaxChars`, `search.snippetMaxChars`, `search.outputMaxChars` | `1200`, `140`, `2500` | AI, snippet and total output budgets (results floor reserved first) |
| `read.defaultMaxChars`, `read.maxCharsCeiling` | `6000`, `20000` | Default `web_read` window and hard ceiling |
| `cache.serpTtlMs`, `cache.gotoTtlMs`, `cache.maxEntries` | `600000`, `86400000`, `200` | SERP TTL (10 min), `/goto` TTL (24 h), LRU size |
| `captcha.waitMs`, `captcha.retryYandexOnce` | `0`, `true` | Extra grace after the one Yandex retry for you to solve a wall (0 = no extra wait); the retry waits ~3 s |
| `artifacts.enabled`, `artifacts.keep`, `artifacts.maxBytes` | `true`, `30`, `52428800` | Save failure artifacts; retention in dirs / bytes (50 MB) |
| `reflex.enabled`, `reflex.backend` | `false`, `"auto"` | Optional System 1 layer; `auto` \| `local` \| `openrouter` \| `rules` |
| `reflex.localOnly` | `false` | `true` forbids all remote classifier calls |
| `reflex.provider`, `reflex.model`, `reflex.prefer` | `"auto"`, `null`, `["llama.cpp", "openrouter"]` | Classifier pinning and `auto` backend order |
| `reflex.openrouter.primary`, `reflex.openrouter.fallback` | `"~typesafe/jev-latest"`; clef-flash, pplx-decider-flash, span-01-lite (full ids in `src/config.ts`) | Remote classifier and its fallback chain |
| `reflex.abstainBelow`, `reflex.maxLatencyMs` | `0.55`, `1200` | Low confidence or over-deadline → rules fallback |
| `reflex.maxCallsPerSearch`, `reflex.maxCallsPerSession`, `reflex.maxUsdPerSession` | `30`, `500`, `0.05` | Classifier budgets and cost guard |
| `reflex.batchBackend`, `reflex.triage.when`, `reflex.triage.keep` | `"classifier"`, `"multi-engine-or-n>10"`, `6` | Batching experiment (off), classifier triage trigger, top-k kept |
| `debug` | `false` | Save artifacts for successful searches too |

Environment variables (override the file, not persisted): `PI_CHROME_CDP_WS` (full CDP URL, e.g.
`ws://127.0.0.1:9222/devtools/browser/<uuid>`), `PI_CHROME_CDP_PORTS` (comma-separated fallback ports),
`PI_CHROME_SEARCH_DEBUG` (`1`/`true`), `PI_CHROME_SEARCH_PROFILE` (launch mode), `PI_CODING_AGENT_DIR`
(agent dir; the config is `$PI_CODING_AGENT_DIR/web-search.json`, default `~/.pi/agent/web-search.json`),
`PI_CHROME_SEARCH_HOST_PLATFORM` (diagnostic only: stub `linux`/`darwin`/`win32` for the offline suite).

Example `~/.pi/agent/web-search.json`:

```json
{
  "mode": "attach",
  "window": { "focus": "session" },
  "engines": { "google": { "dailyCap": 200 }, "yandex": { "enabled": false } },
  "search": { "n": 5 },
  "reflex": { "enabled": false }
}
```

**Why `reflex.enabled` is `false`:** System 1 (routing, result triage, read gating) is implemented but ships
only if the bench shows recall within 2 points and returned tokens down ≥20% or reads down ≥30%. The measured
result did not clear that bar honestly, so the flag stayed off — see [`bench/RESULTS.md`](bench/RESULTS.md)
for the numbers and the reasoning. Turning it on is your call; the deterministic rules fallback always works,
and `reflex.localOnly: true` forbids remote calls.

## Commands

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # node --test tests/unit/**/*.test.ts (offline)
npm run audit                     # hard rules, secrets, fixture data, tool budget
node src/cli/doctor.ts --json     # headless doctor; --no-probe --fix --config <path>
npm run bench                     # offline replay; --reflex rules / --compare are offline too
PI_CHROME_LIVE=1 npm run test:live   # opt-in live suite (tests/live/**), one query per engine
```

Live commands hit search engines, so run them **once**, never in a loop:

```bash
PI_CHROME_LIVE=1 node bench/run.ts --live --limit 1                  # one real query, round-robin
PI_CHROME_LIVE=1 node bench/run.ts --live --limit 1 --engine google  # one engine
```

`tests/live/smoke.test.ts` is the committed suite behind `npm run test:live`: one query per engine, `n=2`, no
retries; it skips without `PI_CHROME_LIVE=1` and passes with a logged wall instead of failing. A wall means
stop and ask — not retry.

## Privacy and ToS

- **Your session, your cookies.** Searches and reads happen in your browser as you. `web_read` can open pages
  you are logged into; it never exfiltrates content and refuses private/local/`file:`/`data:` URLs.
- **Local by default.** No telemetry, no account, no search service; the only traffic is the browser's own.
  Artifacts (HTML, text, screenshot, metadata) and the decision log stay under `~/.pi/agent/web-search/`;
  artifacts are sanitized of form values and session tokens, pruned to 30 directories / 50 MB, and ignored by
  git.
- **CDP is powerful.** Any local process that can reach the debugging port can drive the browser. It binds
  loopback only, and you enable it explicitly with the Allow flow above.
- **Optional classifiers.** With the reflex layer on and a remote backend, the query plus candidate
  titles/URLs/snippets (never full pages) go to the classifier provider through your pi session. Usage and
  cost are logged; `reflex.localOnly: true` keeps everything local. Search traffic never goes through a
  classifier provider.
- **ToS.** Google and Yandex prohibit automated access in their terms. This project does not claim
  compliance, does not bypass logins, paywalls or captchas, and must not be run as a service. Personal use on
  your own profile is your decision and your risk. If an engine shows a captcha, solve it in the visible
  window or stop; the extension will not do it for you.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `E_CDP_UNAVAILABLE` | Repeat the Allow flow; check `cat ~/.config/google-chrome/DevToolsActivePort`; or set `PI_CHROME_CDP_WS`. A failing `/json/version` is not the problem |
| `E_CDP_DISCONNECTED` | Retry once (the client reconnects once). If it repeats, run `/web-doctor`; check you did not close Chrome |
| `E_WALL` | A captcha/consent/`/sorry` page. The window is brought forward: solve it yourself, then retry once. Never automate it |
| `E_PARSE` | A selector canary failed. Open the artifact dir from the error, compare `page.html`/`page.txt` with the adapter, run `/web-doctor` |
| `E_BUSY` | Another pi session holds `~/.pi/agent/web-search.lock`. Close it or wait for the heartbeat (`--fix` reclaims a provably dead lock) |
| `E_RATE_LIMITED` / `E_EMPTY` | Gap or daily cap active — wait or use another engine; no results — rephrase, drop freshness, try another engine |
| `E_CONFIG` / `E_BLOCKED_URL` | A key in `~/.pi/agent/web-search.json` is wrong or unknown (unknown keys are rejected); `web_read` refused a private/local/`file:` URL |
| AI summary missing (`ai:no`) | Normal: AI blocks are A/B and query-dependent. Results are unchanged; nothing is invented |

`/web-doctor` (or `node src/cli/doctor.ts --json`) reports the CDP endpoint, browser version, profile,
`navigator.webdriver`, lock state, owned window, artifact/cache size, per-engine verdicts
(`ok`/`wall`/`layout_changed`/`blocked`/`unavailable`) and classifier availability. `--fix` may reconnect,
close only the tabs this connector owns, prune artifacts and reclaim a dead lock; it never restarts Chrome,
never touches a captcha and never edits the profile. Exit code 0 means ok/degraded, 2 means blocked.

## Development

- **Phase plan and gates:** [`PLAN.md`](PLAN.md) (P0–P7 with V-gates); each finished phase has its command
  output in [`evidence/`](evidence/), and `web_doctor --json` is the canonical state.
- **Measured browser behaviour:** [`research/FINDINGS.md`](research/FINDINGS.md) — CDP navigation semantics,
  engine selectors, AI-summary markers, pacing. Update it when a selector moves.
- **Probes:** one-shot scripts in [`research/probes/`](research/probes/) — `03-dom-dump.mjs` for a page dump,
  `06-capture-fixtures.mjs` for sanitized fixtures, `07-cdp-broker.mjs` for the shared connection,
  `08-live-search.mjs` for a single live search. Never loop them.
- **Fixtures:** `tests/fixtures/*.html.gz` with a `meta.json` for SERPs (`read-*` article captures have no
  meta, and a few discovery/`research-*` `.txt`/`.json` fixtures exist), captured then sanitized (no cookies,
  tokens, account identity, exact IP or personal queries). `npm run audit` fails on a personal-data pattern.
- **Audit:** `scripts/audit.mjs` enforces the hard rules (no Playwright/launch/headless, no fingerprint
  spoofing, no killing Chrome, no captcha solvers, no paid search APIs, no secrets, sanitized fixtures) and
  the approximate tool-description budget; `npm test` holds the authoritative budget/cap tests.
- **Conventions:** strict TypeScript ESM, no build step, no `any`, errors through `src/runtime/errors.ts`, caps in `src/extract/compact.ts`, one writer per file.

## License

MIT — see [`LICENSE`](LICENSE).
