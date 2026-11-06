# Slop gate — V14 verdict (P14)

Date: 2026-11-06
Corpus: `bench/slop.jsonl` — 139 labelled rows, 18 SERP groups (rubric: `bench/SLOP-RUBRIC.md`).
Classifier replay: `bench/slop-verdicts.jsonl` — `~typesafe/jev-latest` (openrouter), 37 batches,
$0.002839 for 139 pages, recorded by `bench/record.ts` in one capped live session.
Commands: `node bench/run.ts --gate` (offline replay), `node bench/gate.ts --self-test`.

## Numbers

| Label | rows | classifier skipped | rules floor skipped |
|---|---:|---:|---:|
| good | 78 | 5 | 0 |
| aggregator | 8 | 2 | 0 |
| slop | 28 | 25 | 0 |
| unsafe | 14 | 14 | 14 |
| offtopic | 11 | 11 | 0 |

- **Classifier**: recall on slop+unsafe **92.9 % (39/42)**, false skips **7/86 = 1.63 per 20**,
  off-topic 11/11 refused, 7 rows fell back to rules because their batch abstained.
- **Rules floor** (safety only): unsafe 14/14 refused, 0/86 false skips, 0/28 slop. It is the offline
  floor, not a quality judge.
- Missed by the classifier: iobit vendor blog, digi-keys vendor blog, ehow — all labelled `slop`, model
  said `slop` but `worth:true` (it saw the fix instructions as useful evidence). A precision/recall
  trade-off, not a parsing bug.

`web_research` read simulation (V14.3 population: the 3 observed live SERPs; aggregate in parentheses):

| reads | saved | saved % | junk in window | junk left | conditional | goldens before → after |
|---:|---:|---:|---:|---:|---|---|
| 2 | 2 | 33.3 % (13.9 %) | 3 | 1 | 2/4 (50 %) | 2 → 2 |
| 4 | 5 | **41.7 % (19.4 %)** | 6 | 1 | 5/8 (62.5 %) | 2 → 2 |
| 8 | 10 | 41.7 % (25 %) | 11 | 2 | 9/16 (56.3 %) | 2 → 2 |

Latency: classifier **p95 491 ms/page** amortized over 37 batches (789 ms for the recorded 1-page
batches; `web_read` is rules-only by design), rules **5 µs/page**. Cost: **$0.000077 per gate decision**
(one batch), $0.000020 per page.

## Gates

| Gate | Verdict |
|---|---|
| V14.1 corpus ≥ 60 labelled rows + rubric | PASS (139 rows, 18 groups) |
| V14.2a rules safety floor: every unsafe URL refused, no good source refused | PASS (14/14, 0/86) |
| V14.2b classifier: slop/unsafe recall ≥ 70 % at ≤ 2 false skips per 20 | PASS (92.9 %, 1.63/20) |
| V14.3 reads saved ≥ 25 % on `web_research`, authoritative source preserved | PASS (41.7 %, goldens 2 → 2) |
| V14.4 cost ≤ $0.001/search, logged with real usage | PASS ($0.000077/decision) |
| V14.5 ≤ 600 ms added per gated read; disabled path identical | PASS (491 ms/page amortized; rules-only `web_read` adds µs) |

## Decision: page gate **on by default**, classifier-first

- `reflex.pageGate` ships **true**: `web_research` drops refused sources and ranks the rest by trust
  (one batched call per round, ≤10 pages), and `web_read` gets the free safety floor before a tab is
  spent. `reflex.enabled` stays `false`, so triage/route/coverage model traffic stays opt-in.
- The hand-maintained trusted/forum/aggregator/farm lists and the `/sonnik/`-style path and title
  heuristics were **removed** after review. They scored 100 % recall against a corpus written from the
  same signals — narrow and partly circular — and they cannot generalise to a farm the author never
  saw. Quality is the classifier's judgement; the rules keep only safety (punycode, abused TLD,
  credentials, adult/pharma/casino/scam, login/cart, ad hosts), which is deterministic, free and works
  on a fresh install.
- **A production bug was found while recording**: `src/reflex/classifier.ts` passed
  `{provider, id}` to `registry.classify()`, stripping `type`/`api`/`cost`; the SDK rejects that with
  *"is not a classifier model"*, so every live classifier call since P5 had failed as
  `provider_error`. The registry entry is now preserved. The numbers above are the first real
  classifier verdicts this project has measured.
- Cost/latency are bounded by the existing `reflex.maxCallsPerSearch` (30), `maxCallsPerSession` (500)
  and `maxUsdPerSession` ($0.05); one research round costs ~$0.0001–0.0002. The classifier is not
  invoked by `web_read`, so a single page read is unchanged in latency.

Re-run: `node bench/record.ts` (live, capped, ~$0.003) to refresh the replay, then
`node bench/run.ts --gate`. The corpus is one model on one day; a second model or a held-out corpus is
the next honest measurement, not a lower bar.
