# pi-chrome-search
Free, keyless web search for [pi](https://pi.dev) through **your own, visible Chrome** — same profile,
same cookies, same IP — returning compact Markdown from Google, DuckDuckGo and Yandex with each engine's
native AI summary (AI Overview, Search Assist, "Быстрый ответ Алисы AI"), plus page reading and image
search. The window staying visible is intentional: you can watch the search and solve a captcha yourself.
It is not an automation browser: raw CDP, one owned window, one work tab per engine, ≤2500 chars of
output, every failure carrying a code, a stage and a hint. No paid search APIs, no keys, no captcha
solving, no fingerprint spoofing, no headless mode.

## Install
Node ≥ 26 (native TypeScript, no build step), Chrome 136+ (tested on 157, Wayland), pi, a headed desktop
session. Then `/web-doctor` inside pi must report a live CDP endpoint and `navigator.webdriver === false`.

```bash
npm install            # ws + typescript (dev); no build step
pi install .           # register this checkout as a pi package
pi -e ./src/index.ts   # …or load it for one throwaway session
```

## Enable CDP (once per Chrome session)
Chrome 136+ ignores `--remote-debugging-port` for the default profile; debugging is enabled from inside
the browser and needs an explicit **Allow** click.

1. Open `chrome://inspect/#remote-debugging` in the Chrome window the agent should use.
2. Tick **Discover network targets**, then click **Allow** on the prompt.
3. Check the endpoint file (line 1 = port, line 2 = `/devtools/browser/<uuid>`):
   `cat ~/.config/google-chrome/DevToolsActivePort`

`curl 127.0.0.1:9222/json/version` may return nothing in this mode — expected; the file is authoritative.
Discovery order: `PI_CHROME_CDP_WS` → `PI_CHROME_CDP_PORTS` → `DevToolsActivePort` → `cdp.ports`. The
extension never launches, restarts or kills Chrome, never edits your profile, never closes foreign tabs.

## Tools
`web_search` is `direct`; everything else is `deferred` (tool search + `codemode`, not paid per prompt).
All descriptions together stay under 900 characters.

| Tool | Exposure | Arguments |
|---|---|---|
| `web_search` | direct | `q`; `n` 1–10 (5); `engines` `auto`\|id\|list; `summary` (true); `freshness` `d\|w\|m\|y`; `page`; `format` `md\|json` |
| `web_read` | deferred | `url` (http/https); `offset`; `maxChars` (6000, ceiling 20000); `format` `md\|text` |
| `image_search` | deferred | `q`; `n` ≤12 (4); `engine` `google\|yandex`; `attach` (≤4 thumbnails) |
| `web_research` | deferred | `q`; `budget` `quick` (1 search + 2 reads) \| `normal` (2+4) \| `deep` (4+8) |
| `web_doctor` | deferred | `probe` (true), `fix` (false: reconnect, close owned tabs, prune artifacts) |

Output is capped at 2500 chars (summary ≤1200, snippets ≤140). The AI block has three states: `ai:yes`
only for ≥200 chars of prose, `ai:lead` (block present, no answer — never rendered as one), `ai:no`.

## Configuration
`~/.pi/agent/web-search.json` (or `$PI_CODING_AGENT_DIR/web-search.json`), optional and strict: an
unknown key is `E_CONFIG`. All keys: [`docs/config.md`](docs/config.md). The six that matter most:
`engines.google.enabled` (`true`, per-engine switch) · `search.n` (`5`, ≤`search.nMax` 10) ·
`search.aiWaitMs` (`6000`, bounded AI-block wait) · `read.maxCharsCeiling` (`20000`) ·
`window.follow` (`"work"`, which tab is raised during a stage) · `reflex.pageGate` (`true`,
source-quality gate in `web_research`, rules floor in `web_read`).

Env overrides: `PI_CHROME_CDP_WS`, `PI_CHROME_CDP_PORTS`, `PI_CHROME_SEARCH_PROFILE`,
`PI_CHROME_SEARCH_DEBUG`, `PI_CODING_AGENT_DIR`. System 1 triage stays off (`reflex.enabled: false`):
the benchmark showed no honest token win.

## When it fails
| Code | Action |
|---|---|
| `E_CDP_UNAVAILABLE` | Open `chrome://inspect/#remote-debugging`, tick **Discover network targets**, click **Allow**; or set `PI_CHROME_CDP_WS` |
| `E_CDP_AWAITING_ALLOW` | The prompt is waiting; click it — the call resumes by itself (`cdp.attachWaitMs`, 60 s) |
| `E_WALL` | A captcha/consent page: solve it in the visible window, then retry. Never automated |
| `E_BUSY` | Another pi session holds `~/.pi/agent/web-search.lock`: close it or wait for the heartbeat |
| `E_PARSE` | A selector canary failed: open the artifact dir, compare `page.txt` with `docs/engines.md` |

All 18 codes with hints: [`docs/errors.md`](docs/errors.md). `/web-doctor` (or
`node src/cli/doctor.ts --json`) is the first stop; `--fix` reconnects, closes only owned tabs and prunes
artifacts under `~/.pi/agent/web-search/`.

## Security and ToS
Your session, your cookies: searches and reads happen in your browser as you. `web_read` can open pages
you are logged into but never exfiltrates content, and it refuses loopback/private/`file:`/`data:` URLs
(re-checked on redirect). No telemetry; artifacts are sanitized and git-ignored. CDP is powerful — any
local process that reaches the debugging port can drive the browser; it binds loopback only and you
enable it explicitly. The optional page gate sends only URL/title/snippet of ≤10 sources (never page
text) to your configured classifier; `reflex.localOnly: true` keeps it local.

Google and Yandex prohibit automated access in their terms: this project does not claim compliance and
must not be run as a service. If an engine shows a captcha, solve it in the window or stop.

## Development
`npm run lint` (typecheck + audit) · `npm test` (offline contract suite) · `npm run test:live` (opt-in,
one query per engine, no retries, `PI_CHROME_LIVE=1`). Decisions: [`docs/architecture.md`](docs/architecture.md)
· selectors: [`docs/engines.md`](docs/engines.md). Never launch a browser from tests; never loop probes.

## License
MIT — see [`LICENSE`](LICENSE).
