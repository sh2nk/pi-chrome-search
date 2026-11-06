# P3 live gates — one run per engine

Run through the local CDP broker (`research/probes/07-cdp-broker.mjs`), so all of these share one Chrome
connection and cost the user a single Allow for the session. One query, one invocation, no retries; a wall
would be surfaced, never solved.

Harness: `research/probes/08-live-search.mjs` calls the real `web_search` tool with the real runtime
(connector, limiter, cache, artifacts, registry).

## V3.5 (a) — Google live

Two runs of the same query, because the first one found a real bug.

| Run | Field | Value |
|---|---|---|
| 1 (defect) | Command | `… --engine google --query "что такое трансформер в машинном обучении" --n 5` |
| | Result | `ai:yes`, 5 results, 2500 chars, 4.56 s |
| | Defect | `ai.text` began with inline CSS (`.A3ySSe{padding:10px}.Jd31eb{display:contents}…`): the "largest descendant" of the AI section was chosen by raw `textContent`, and the live node carries a `<style>` block, which ate the AI budget. |
| 2 (fixed) | Command | same, after `fix(google): AI summary must not ship inline CSS` |
| | Result | `ai:yes`, 5 results, 2500 chars, 4.16 s |
| | AI text | 1092 chars of prose starting `Трансформер (Transformer) — это архитектура глубоких нейронных сетей…`, `hasCSS=false` |
| | Sources | `ru.wikipedia.org`, `bigdataschool.ru`, `huggingface.co`, `contest.yandex.ru`, `deepmachinelearning.ru` |
| | Results | `ru.wikipedia.org`, `habr.com`, `deepmachinelearning.ru`, `contest.yandex.ru`, `huggingface.co` — direct URLs, `/goto` wrappers resolved by the tool layer |

The second run is the gate: `ai:yes` with a real overview, ≥5 results, ≤2500 chars. The first run is kept
here because "it worked offline" is not the same as "it works on the live DOM", and the fixture could not
reproduce it (the capture strips `<style>` before storing).

## V3.5 (b) — DuckDuckGo live

| Field | Value |
|---|---|
| Command | `… --engine duckduckgo --query "how does a solar panel work" --n 5` |
| Exit | 0 |
| Query class | technical-ai (EN) |
| `ai` | yes — Search Assist block with 2 sources (`nationalgrid.com`, `U.S. Energy Information Administration`) |
| Results | 5 of 10 carried (`page: more results available`) |
| Chars | 1723 (cap 2500) |
| Latency | 6.76 s (typed first search: home → box → Enter → settle) |
| Wall | none |
| URLs | direct (`energysage.com`, `en.wikipedia.org`, `solvoltaics.com`, `energy.gov`, `thegreenwatt.com`) — no wrappers |

First live page after the navigate rewrite: commit-then-readiness resolved without a load-event timeout, and
the settle marker/selector combination from the adapter was found on the real SERP (the risk flagged by the
lane did not materialise).

## V3.5 (c) — Yandex live

| Field | Value |
|---|---|
| Command | `… --engine yandex --query "стоит ли покупать электромобиль в россии" --n 5` |
| Exit | 0 |
| Query class | technical-ai (RU) |
| `ai` | no — the neuro card was robot-gated on the live page, exactly as in the capture; no answer text in the DOM, so nothing was invented |
| Results | 4 (`banki.ru`, `drive2.ru`, `avtocod.ru`, `dzen.ru`), page reported more |
| Chars | 852 (cap 2500) |
| Latency | 7.01 s |
| Wall | none — no captcha, so no retry transition to record |
| Note | 4 of the organics survived the ad/redirect filters (`jsredir`, `/clck/`, promo labels); `pageCarried` stayed honest. The validator confirmed there is no result-host filter, so the earlier 'dropped by host rule' wording was wrong — corrected here. V3.5 sets no yandex result floor |

## V3.6 — artifacts on E_PARSE/E_WALL

The writer is covered offline (25 tests: directory shape, sanitizer token matrix, retention, failure
tolerance) and wired into `web_search` on the `E_PARSE`/`E_WALL` paths. A live snapshot was not forced:
producing a real `E_WALL` means provoking a captcha on the user's profile, which the hard rules forbid, and
inventing an `E_PARSE` would be a fake gate. First natural wall/parse failure will land a snapshot in
`~/.pi/agent/web-search/artifacts/`, and `evidence/P4.md` re-checks the path through `web_doctor`.

## V3.7 — offline gates

```
npx tsc --noEmit          → 0
npm test                  → 529 pass, 0 fail
npm run audit             → 9 checks, 0 violations
pi -e ./src/index.ts --print "reply with exactly OK" → OK
```

## Broker note

All four live runs above share one Chrome connection (`07-cdp-broker.mjs`); Chrome 136+ asks the user to
Allow each new debugging connection and has no permanent grant, so the broker is what keeps the session to
one click. Live work stayed orchestrator-only and serial.
