# pi-chrome-search

[![npm](https://img.shields.io/npm/v/pi-chrome-search)](https://www.npmjs.com/package/pi-chrome-search)
[![downloads](https://img.shields.io/npm/dm/pi-chrome-search)](https://www.npmjs.com/package/pi-chrome-search)
[![ci](https://github.com/sh2nk/pi-chrome-search/actions/workflows/ci.yml/badge.svg)](https://github.com/sh2nk/pi-chrome-search/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-chrome-search)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D26-brightgreen)](package.json)

Free web search for [pi](https://pi.dev) through your own visible Chrome: same profile, same cookies,
same IP. Compact Markdown from Google, DuckDuckGo and Yandex, with each engine's native AI summary
(AI Overview, Search Assist, Alice). The window stays visible on purpose, so you can watch the search
and solve a captcha yourself. No keys, no paid APIs, no headless mode, no spoofing, no captcha solving.
Needs Node ≥26 and Chrome 136+ on a headed desktop.

## Install

```bash
npm install
pi install .          # register this checkout as a pi package
pi -e ./src/index.ts  # or load it for one throwaway session
```

## Enable CDP (once per Chrome session)

Chrome 136+ ignores `--remote-debugging-port` for the default profile: debugging is enabled from
inside the browser, with an explicit **Allow** click.

1. Open `chrome://inspect/#remote-debugging` in the Chrome window the agent should use.
2. Tick **Discover network targets**, then click **Allow**.
3. Check the endpoint file (port, then `ws` path): `cat ~/.config/google-chrome/DevToolsActivePort`.

Discovery order: `PI_CHROME_CDP_WS` → `PI_CHROME_CDP_PORTS` → `DevToolsActivePort` → `cdp.ports`.
`curl 127.0.0.1:9222/json/version` may stay empty here; the file is authoritative.

## Tools

`web_search` is `direct`; the rest are `deferred` (via tool search or `codemode`, no per-prompt cost).

| Tool | Arguments |
|---|---|
| `web_search` | `q`; `n` 1-10 (5); `engines` `auto`\|id\|list; `summary`; `freshness` `d\|w\|m\|y`; `page`; `format` `md\|json` |
| `web_read` | `url` (public http/https); `offset`; `maxChars` (6000, ceiling 20000); `format` `md\|text` |
| `image_search` | `q`; `n` ≤12 (4); `engine` `google\|yandex`; `attach` (≤4 image blocks) |
| `web_research` | `q`; `budget` `quick` (1 search + 2 reads), `normal` (2+4), `deep` (4+8) |
| `web_doctor` | `probe` (true); `fix` (false: reconnect, close owned tabs, prune artifacts) |

Output is capped at 2500 chars (summary ≤1200, snippet ≤140). The AI block reports `ai:yes` only for
≥200 chars of prose, `ai:lead` when the block exists without an answer, `ai:no` when absent.

## Configuration

`~/.pi/agent/web-search.json` (or `$PI_CODING_AGENT_DIR/web-search.json`), optional and strict: an
unknown key fails as `E_CONFIG`. Every key and env override: [`docs/config.md`](docs/config.md).

## When it fails

| Code | Action |
|---|---|
| `E_CDP_UNAVAILABLE` | Open `chrome://inspect/#remote-debugging`, tick **Discover network targets**, click **Allow**, or set `PI_CHROME_CDP_WS` |
| `E_CDP_AWAITING_ALLOW` | The prompt is waiting; click it, the call resumes on its own (60 s) |
| `E_WALL` | Captcha or consent page: solve it in the visible window, then retry |
| `E_BUSY` | Another pi session holds the lock in `~/.pi/agent/`: close it or wait |
| `E_PARSE` | A selector canary broke: compare the artifact `page.txt` with [`docs/engines.md`](docs/engines.md) |

All 19 codes: [`docs/errors.md`](docs/errors.md). Start with `/web-doctor` or
`node src/cli/doctor.ts --json`; `--fix` reconnects, closes only owned tabs and prunes artifacts.

## Security and ToS

Searches run in your browser, as you. `web_read` refuses loopback, private, `file:` and `data:` URLs,
re-checked on redirect. No telemetry; artifacts are sanitized and git-ignored. The optional page gate
sends URL, title and snippet of at most 10 sources (never page text), `reflex.localOnly` keeps it local.

Google and Yandex forbid automated access in their terms. This project does not claim compliance and
must not be run as a service. A captcha means solve it in the window or stop.

## Development

```bash
npm run lint                         # typecheck + audit
npm test                             # offline contract suite
PI_CHROME_LIVE=1 npm run test:live   # one query per engine, no retries
node src/cli/doctor.ts --json        # canonical gate report
```

Decisions: [`docs/architecture.md`](docs/architecture.md). Selectors: [`docs/engines.md`](docs/engines.md).

## License

MIT, see [`LICENSE`](LICENSE).
