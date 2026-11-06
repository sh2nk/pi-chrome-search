# Configuration

Path: `~/.pi/agent/web-search.json` (or `$PI_CODING_AGENT_DIR/web-search.json`). Optional — the defaults
below are complete. Parsing is strict: unknown keys, wrong types and out-of-range values are
`E_CONFIG` naming the key path. `DEFAULT_CONFIG` in `src/config.ts` is the source of truth; this page
must list every key (the audit fails if it drifts).

## Environment overrides (applied after the file)

| Variable | Effect |
|---|---|
| `PI_CODING_AGENT_DIR` | Directory holding `web-search.json`, the lock, artifacts and logs. |
| `PI_CHROME_CDP_WS` | Full CDP WebSocket URL; skips discovery. Must be `ws://` or `wss://`. |
| `PI_CHROME_CDP_PORTS` | Comma-separated ports to probe (`9223,9224`). |
| `PI_CHROME_SEARCH_PROFILE` | Profile directory to inspect for `DevToolsActivePort` (overrides `cdp.profileDir`). |
| `PI_CHROME_SEARCH_DEBUG` | `1`/`true` turns decision logging on (`debug`). |
| `PI_CHROME_SEARCH_HOST_PLATFORM` | Diagnostic only: force the platform table (`linux`/`darwin`/`win32`). |

## Keys and defaults

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"attach"` | `attach` drives the user's Chrome; `launch` is for tests only. |
| `cdp.ports` | `[9222]` | Ports probed when no `DevToolsActivePort` and no env URL exists. |
| `cdp.ws` | `null` | Explicit WebSocket URL. |
| `cdp.connectTimeoutMs` | `5000` | Per-attempt connect budget. |
| `cdp.profileDir` | `null` | Profile directory override. |
| `cdp.attachWaitMs` | `60000` | How long to wait for the Allow click before `E_CDP_AWAITING_ALLOW`. |
| `window.focus` | `"session"` | `session` raises on the first search, `always`, `never`. |
| `window.reuse` | `true` | Reuse the owned window across calls. |
| `window.raiseOnPrompt` | `"auto"` | Best-effort raise when the Allow prompt is waiting; `never` disables. |
| `window.panel` | `true` | Paint the local anchor control panel (`assets/anchor.html`). |
| `window.follow` | `"work"` | `work` raises the work tab, `anchor` the panel tab, `never` nothing. |
| `window.idleMs` | `1500` | Delay before the anchor returns after a stage ends. |
| `humanize` | `"auto"` | `auto` types the first search per session; `always`; `typing` (per-engine profiles). |
| `engines.google.enabled` | `true` | Use Google. |
| `engines.google.lang` | `"auto"` | `hl`; `auto` omits it. |
| `engines.google.gl` | `"auto"` | `gl`; `auto` omits it. |
| `engines.google.dailyCap` | `300` | Soft daily cap. |
| `engines.duckduckgo.enabled` | `true` | Use DuckDuckGo. |
| `engines.duckduckgo.kl` | `"auto"` | Region/language; `auto` omits it. |
| `engines.duckduckgo.dailyCap` | `300` | Soft daily cap. |
| `engines.yandex.enabled` | `true` | Use Yandex. |
| `engines.yandex.lr` | `"auto"` | `lr`; `auto` omits it. |
| `engines.yandex.dailyCap` | `150` | Soft daily cap. |
| `pacing.google` | `[2500, 5000]` | Min/max gap in ms between Google searches. |
| `pacing.yandex` | `[5000, 9000]` | Min/max gap for Yandex. |
| `pacing.duckduckgo` | `[2000, 4000]` | Min/max gap for DuckDuckGo. |
| `search.n` | `5` | Default result count (1..`nMax`). |
| `search.nMax` | `10` | Hard ceiling for `n`. |
| `search.summaryMaxChars` | `1200` | Cap for the AI answer block. |
| `search.snippetMaxChars` | `140` | Cap for one snippet. |
| `search.outputMaxChars` | `2500` | Cap for the whole Markdown output. |
| `search.aiWaitMs` | `6000` | Deadline for the native AI block. |
| `search.aiExpand` | `false` | Click the engine's "show more" on the AI card once. |
| `read.defaultMaxChars` | `6000` | Default `web_read` budget. |
| `read.maxCharsCeiling` | `20000` | `maxChars` above this is clamped and reported. |
| `read.pool` | `1` | Concurrent read slots (1..3); each holds an exclusive FIFO lock. |
| `read.pdfMaxBytes` | `20971520` | Refuse larger PDFs. |
| `read.keepPdf` | `false` | Keep the downloaded PDF in the artifact directory. |
| `read.pdfPageMaxChars` | `4000` | Per-page cap for PDF text. |
| `image.attachMaxBytes` | `8388608` | Size ceiling for one attached image. |
| `cache.serpTtlMs` | `600000` | SERP cache TTL (10 min). |
| `cache.gotoTtlMs` | `86400000` | Resolved `/goto` links TTL (24 h). |
| `cache.maxEntries` | `200` | LRU size. |
| `captcha.waitMs` | `0` | Extra wait for the user to solve a wall; `0` = do not wait. |
| `captcha.retryYandexOnce` | `true` | One Yandex retry after ~3 s on the same profile. |
| `artifacts.enabled` | `true` | Write `page.html`/`page.txt`/`screenshot.jpg`/`meta.json` on failures. |
| `artifacts.keep` | `30` | Artifact directories to keep. |
| `artifacts.maxBytes` | `52428800` | Artifact root budget. |
| `reflex.enabled` | `false` | System 1 triage/route/coverage. Off: the benchmark showed no honest win. |
| `reflex.pageGate` | `true` | Batched page-quality gate in `web_research` (rules floor in `web_read`). |
| `reflex.backend` | `"auto"` | `auto`, `classifier`, `rules`. |
| `reflex.localOnly` | `false` | Forbid remote classifier calls. |
| `reflex.provider` | `"auto"` | Classifier provider. |
| `reflex.model` | `null` | Classifier model id. |
| `reflex.prefer` | `["llama.cpp","openrouter"]` | Backend order. |
| `reflex.openrouter.primary` | `"~typesafe/jev-latest"` | Primary classifier model. |
| `reflex.openrouter.fallback` | `[…]` | Fallback classifier models. |
| `reflex.abstainBelow` | `0.55` | Confidence under which the model abstains. |
| `reflex.maxLatencyMs` | `1200` | Per-call latency budget. |
| `reflex.maxCallsPerSearch` | `30` | Per-search call cap. |
| `reflex.maxCallsPerSession` | `500` | Per-session call cap. |
| `reflex.maxUsdPerSession` | `0.05` | Per-session spend cap. |
| `reflex.batchBackend` | `"classifier"` | Batch path for page-gate calls. |
| `reflex.triage.when` | `"multi-engine-or-n>10"` | When triage may run. |
| `reflex.triage.keep` | `6` | Items kept by triage. |
| `debug` | `false` | Verbose decision logging. |

Cross-field rules: `search.n ≤ search.nMax ≤ 10`, `read.defaultMaxChars ≤ read.maxCharsCeiling`,
`pacing.*[0] ≤ pacing.*[1]`, at least one engine enabled.
