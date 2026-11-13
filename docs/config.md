# Configuration

Generated from `src/config/{defaults,schema,env}.ts`; do not hand-edit. `node scripts/gen-config-doc.mjs
--check` fails when this page drifts from the schema.

Path: `~/.pi/agent/web-search.json` (or `$PI_CODING_AGENT_DIR/web-search.json`). Optional: the defaults
below are complete. Parsing is strict: an unknown key, wrong type or out-of-range value is `E_CONFIG`
naming the dotted path.

## Environment overrides (applied after the file)

| Variable | Effect |
|---|---|
| `PI_CODING_AGENT_DIR` | Directory holding `web-search.json`, artifacts and logs. |
| `PI_CHROME_CDP_WS` | Full CDP WebSocket URL; skips discovery. Must be `ws://` or `wss://`. |
| `PI_CHROME_CDP_PORTS` | Comma-separated ports to probe (`9223,9224`). |
| `PI_CHROME_SEARCH_PROFILE` | Profile directory inspected first for `DevToolsActivePort`. |
| `PI_CHROME_SEARCH_DEBUG` | `1`/`true` turns decision logging on (`debug`). |
| `PI_CHROME_SEARCH_HOST_PLATFORM` | Diagnostic only: force the platform (`linux`/`darwin`/`win32`). |

## Keys and defaults

| Key | Default | Constraint | Meaning |
|---|---|---|---|
| `cdp.ports` | `[9222]` | array of integer 1..65535 (≥1 items) | Ports probed when no `DevToolsActivePort` and no env URL exists. |
| `cdp.ws` | `null` | null or non-empty string | Explicit WebSocket URL; `null` means discover. |
| `cdp.connectTimeoutMs` | `5000` | integer ≥ 1 | Per-attempt connect budget. |
| `cdp.attachWaitMs` | `60000` | integer 0..600000 | How long to wait for the CDP Allow click before `E_CDP_AWAITING_ALLOW`; `0` disables the wait. |
| `window.focus` | `"session"` | one of `session`, `always`, `never` | `session` raises on the first search, `always` on every stage, `never` never. |
| `window.raiseOnPrompt` | `"auto"` | one of `auto`, `never` | Best-effort raise while the Allow prompt waits; `never` keeps the session passive. |
| `window.panel` | `true` | boolean | Host the local anchor control panel (`assets/anchor.html`). |
| `window.follow` | `"work"` | one of `work`, `anchor`, `never` | `work` raises the work tab, `anchor` the panel tab, `never` nothing. |
| `window.idleMs` | `1500` | integer 0..60000 | Delay before the anchor returns after a stage ends. |
| `humanize` | `"auto"` | one of `auto`, `always`, `typing` | `auto` types the first search per session, `always` every search, `typing` uses per-engine profiles. |
| `engines.google.enabled` | `true` | boolean | Use Google. |
| `engines.google.lang` | `"auto"` | non-empty string | `hl`; `auto` omits it. |
| `engines.google.gl` | `"auto"` | non-empty string | `gl`; `auto` omits it. |
| `engines.duckduckgo.enabled` | `true` | boolean | Use DuckDuckGo. |
| `engines.duckduckgo.kl` | `"auto"` | non-empty string | Region/language; `auto` omits it. |
| `engines.yandex.enabled` | `true` | boolean | Use Yandex. |
| `engines.yandex.lr` | `"auto"` | non-empty string | `lr`; `auto` omits it. |
| `pacing.google` | `[2500,5000]` | [integer ≥ 0, integer ≥ 0] | Min/max gap in ms between Google searches. |
| `pacing.duckduckgo` | `[2000,4000]` | [integer ≥ 0, integer ≥ 0] | Min/max gap in ms between DuckDuckGo searches. |
| `pacing.yandex` | `[5000,9000]` | [integer ≥ 0, integer ≥ 0] | Min/max gap in ms between Yandex searches. |
| `search.n` | `5` | integer ≥ 1 | Default result count. |
| `search.nMax` | `10` | integer ≥ 1 | Hard ceiling for `n`; never above 10. |
| `search.summaryMaxChars` | `1200` | integer ≥ 1 | Cap for the AI answer block. |
| `search.snippetMaxChars` | `140` | integer ≥ 1 | Cap for one snippet. |
| `search.outputMaxChars` | `2500` | integer ≥ 1 | Cap for the whole Markdown output. |
| `search.aiWaitMs` | `6000` | integer 0..60000 | Deadline for the native AI block; `0` disables waiting. |
| `search.aiExpand` | `false` | boolean | Click the engine's "show more" on the AI card once. |
| `read.defaultMaxChars` | `6000` | integer ≥ 1 | Default `web_read` budget. |
| `read.maxCharsCeiling` | `20000` | integer ≥ 1 | `maxChars` above this is clamped and reported. |
| `read.pool` | `1` | integer 1..3 | Concurrent read slots; each holds its own tab and exclusive lock. |
| `read.pdfMaxBytes` | `20971520` | integer ≥ 1 | Refuse larger PDFs. |
| `read.keepPdf` | `false` | boolean | Keep the downloaded PDF in the artifact directory. |
| `read.pdfPageMaxChars` | `4000` | integer ≥ 1 | Per-page cap for PDF text. |
| `image.attachMaxBytes` | `8388608` | integer ≥ 1 | Size ceiling for one attached image. |
| `cache.serpTtlMs` | `600000` | integer ≥ 0 | SERP cache TTL (10 min). |
| `cache.gotoTtlMs` | `86400000` | integer ≥ 0 | Resolved `/goto` links TTL (24 h). |
| `cache.maxEntries` | `200` | integer ≥ 1 | LRU size. |
| `artifacts.enabled` | `true` | boolean | Write `page.html`/`page.txt`/`screenshot.jpg`/`meta.json` on failures. |
| `artifacts.keep` | `30` | integer ≥ 1 | Artifact directories to keep. |
| `artifacts.maxBytes` | `52428800` | integer ≥ 1 | Artifact root budget. |
| `debug` | `false` | boolean | Verbose decision logging. |

Cross-field rules: `search.n ≤ search.nMax ≤ 10`, `read.defaultMaxChars ≤ read.maxCharsCeiling`,
`pacing.*[0] ≤ pacing.*[1]`, and at least one engine enabled.
