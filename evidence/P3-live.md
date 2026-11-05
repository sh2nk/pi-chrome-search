# P3 live gates — one run per engine

Run through the local CDP broker (`research/probes/07-cdp-broker.mjs`), so all of these share one Chrome
connection and cost the user a single Allow for the session. One query, one invocation, no retries; a wall
would be surfaced, never solved.

Harness: `research/probes/08-live-search.mjs` calls the real `web_search` tool with the real runtime
(connector, limiter, cache, artifacts, registry).

## V3.7 — DuckDuckGo

| Field | Value |
|---|---|
| Command | `PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker node research/probes/08-live-search.mjs --engine duckduckgo --query "how does a solar panel work" --n 5` |
| Exit | 0 |
| Query class | technical-ai (EN) |
| `ai` | yes — Search Assist block with 2 sources (`nationalgrid.com`, `U.S. Energy Information Administration`) |
| Results | 5 of 10 carried (`page: more results available`) |
| Chars | 1723 (cap 2500) |
| Latency | 6.76 s (typed first search: home → box → Enter → settle) |
| Wall | none |
| URLs | direct (`energysage.com`, `en.wikipedia.org`, `solvoltaics.com`, `energy.gov`, `thegreenwatt.com`) — no wrappers |

First live page since the navigate rewrite: commit-then-readiness resolved without a load-event timeout, and
the settle marker/selector combination from the adapter was found on the real SERP (the risk flagged by the
lane did not materialise).

## V3.7 — Yandex

| Field | Value |
|---|---|
| Command | `PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker node research/probes/08-live-search.mjs --engine yandex --query "стоит ли покупать электромобиль в россии" --n 5` |
| Exit | 0 |
| Query class | technical-ai (RU) |
| `ai` | no — the neuro card was robot-gated on the live page, exactly as in the capture; no answer text in the DOM, so nothing was invented |
| Results | 4 (`banki.ru`, `drive2.ru`, `avtocod.ru`, `dzen.ru`), page reported more |
| Chars | 852 (cap 2500) |
| Latency | 7.01 s |
| Wall | none — no captcha, so no retry transition to record |
| Note | the 5th organic was a `yandex.*`-hosted link and was dropped by the adapter's host rule (ads/redirects share that host); pageCarried stayed honest. V3.5 does not set a yandex result floor |

## V3.5 — Google

pending (adapter in progress).

## V3.6 — artifacts on E_PARSE/E_WALL

pending (needs a live failure path; the fixtures cover the writer offline).

## Remaining

- Google: AI Overview query, ≥5 results, ≤2500 chars.
- Yandex: neuro query, one run; captcha path is never exercised on purpose.
