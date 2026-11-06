# Architecture

The extension is a pi plugin that drives the user's own visible Chrome over raw CDP. No bundled
browser, no automation profile, no paid search API.

```
pi process
└── src/index.ts                     registers 5 tools + /web-doctor + /web-focus
    ├── config.ts                    loadConfig() → ~/.pi/agent/web-search.json
    ├── tools/
    │   ├── web_search.ts    direct   SERP → compact Markdown/JSON (≤2500 chars)
    │   ├── web_read.ts      deferred page → Markdown (≤6000 chars, offset)
    │   ├── image_search.ts  deferred tiles; attach:"bytes" returns real image blocks
    │   ├── web_research.ts  deferred search→read→claims loop
    │   └── web_doctor.ts    deferred diagnostics (+ /web-doctor command)
    ├── engines/            google.ts, duckduckgo.ts, yandex.ts, images.ts
    ├── cdp/                discovery, session (raw WS), browser (window/tab/lock),
    │                       humanize (typing/settle), ai-wait, page-lock, raise
    ├── extract/            compact (caps/dedup/URLs), read (readability), urls
    │                       (/goto, tracking params), claims, goto, pdf
    └── runtime/            cache, limiter, errors, error-codes, artifacts, doctor,
                            log, notify, attention, panel, ssrf, host
```

## Request flow (`web_search`)

1. Resolve config, acquire the session lock (`~/.pi/agent/web-search.lock`, PID + heartbeat).
2. Discover the CDP endpoint (see `docs/engines.md` §Discovery), attach over one WebSocket.
3. Ensure the extension's **one owned window**; its anchor tab is `assets/anchor.html` — a local
   control panel painted with one-off `Runtime.evaluate` (engine, query, stage, pace, counters).
4. Per engine: pacing/limiter → typed or direct SERP URL → `settle()` (marker, not a sleep) →
   `detectWall()` → `extract()` → `ai.probe()/wait` for the native AI block.
5. `extract/compact.ts` merges engines, dedups URLs, strips tracking params and applies the two
   budgets (results floor first, AI to the remainder).
6. Every failure is a `WebSearchError` with `code`, `stage`, `retryable`, `hint` and, for page
   states, an artifact directory under `~/.pi/agent/web-search/artifacts/<ts>-<engine>-<hash>/`.

## Decisions that must not be re-litigated

- **Attach only.** `mode:"launch"` exists for tests; production never starts a browser. Launching
  with a fresh profile is exactly what gets the user's account captcha'd.
- **One owned window, one work tab per engine.** Closing the last tab would close the window, so the
  anchor tab exists; tabs we did not open are never closed.
- **No headless, no fingerprint work.** No UA/locale/timezone override, no `navigator.*` patching, no
  `Page.addScriptToEvaluateOnNewDocument`. One-off `Runtime.evaluate` for extraction and the panel.
- **No captcha solving.** A wall is `E_WALL` with the window surfaced; the user solves it.
- **Readiness is a DOM marker, not `loadEventFired`.** A real SERP never fires a correlated load
  event; the client commits on `frameNavigated` with a fresh `loaderId`, then the adapter waits for a
  marker with a deadline.
- **AI states are three-valued.** `answer` (≥200 chars of prose), `lead` (block present, no answer),
  `none`. A query echo is never rendered as an answer.
- **Reflex triage stays off** (`reflex.enabled:false`): the benchmark showed no honest token win. The
  page-quality gate (`reflex.pageGate:true`) ships independently: one batched classifier call in
  `web_research` drops/ranks sources at ~$0.00008 per decision; `web_read` uses the rules floor only.
  A metric that improves by returning less is not a metric.
- **Rates are human.** Per-engine spacing with jitter, daily soft caps, one search at a time per
  engine; caps surface as `E_RATE_LIMITED`, never as silent throttling.

## Read pipeline (`web_read`)

Exclusive FIFO lock per read slot (`read.pool` 1..3) → SSRF guard (checked again on redirect) →
navigate → marker settle → `currentUrl()` before and after extraction (a moved document is
`E_NAVIGATION_MISMATCH`, not a stranger's page) → readability → Markdown with `offset`/`nextOffset`.
`maxChars` above `read.maxCharsCeiling` is clamped and reported; an offset past the end is
`E_OFFSET_RANGE`. Failures of kind parse/timeout/blocked/mismatch always leave an artifact.

## PDF (`src/extract/pdf.ts`)

Ladder: in-tree parser (bytes fetched through `Fetch` on a background target, parsed in process) →
optional installed `pdftotext`/`mutool` via `capability()` → honest `E_PDF_SCANNED` (no text layer) or
`E_PDF_UNSUPPORTED`. The AX tree of Chrome's PDF viewer carries no document text on 157, so it is not
a rung. The read tab is released after a PDF read: the viewer can leave a detached session.

## Privacy and security

The browser profile is the user's; we attach, never copy cookies or read `~/.config/google-chrome/**`.
`web_read` is SSRF-guarded (loopback, private ranges, `file:`, `data:`). Nothing is uploaded: search
traffic goes to the engines the user already uses. Artifacts and `decisions.jsonl` stay local.

## Repo layout

Phase labels in source comments (`PLAN-v2 P8`, `evidence/P2-A`, `research/FINDINGS.md §3`) name the
project's history: that apparatus lives in the annotated tag `archive/pre-publication`
(`git show archive/pre-publication:PLAN-v2.md`), not in the shipped tree.

`index.ts` (package entry) · `src/**` · `scripts/audit.mjs` (hard rules, secrets, budgets) ·
`scripts/release.mjs` (version bump) · `tests/unit` (contract suite) · `tests/live` (opt-in smoke) ·
`tests/fixtures` (sanitized SERP/read captures) · `docs/**`.
