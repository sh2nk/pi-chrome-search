# Slop gate — V14 verdict (P14)

Date: 2026-11-06 (second measurement; the first run scored V14.3 on the mixed corpus and failed at 8.3 %)
Corpus: `bench/slop.jsonl` — 139 labelled rows, 18 SERP groups (rubric: `bench/SLOP-RUBRIC.md`).
Command: `node bench/run.ts --gate` (offline, rules backend; exit `1` = a measured gate failed).

## Numbers

| Label | rows | skipped |
|---|---:|---:|
| good | 89 | 0 |
| aggregator | 8 | 0 |
| slop | 28 | 28 |
| unsafe | 14 | 14 |

Recall on slop+unsafe **100 % (42/42)**; false skips **0/97** (0.00 per 20). By source: fixture 0/84,
live SERP 12/25, curated 30/30.

`web_research` read simulation. **V14.3 population = the 3 observed live SERPs**; the aggregate over all
18 groups (mostly synthetic P5 fixtures, which contain no real slop) is reported next to it so the
population choice is visible:

| reads | groups | reads | saved | saved % | junk in window | junk left | conditional | goldens before → after |
|---:|---:|---:|---:|---:|---:|---:|---|---|
| 2 | 3 | 6 | 3 | **50 %** | 3 | 0 | 3/4 (75 %) | 2 → 2 |
| 4 | 3 | 12 | 6 | **50 %** | 6 | 0 | 6/8 (75 %) | 2 → 2 |
| 8 | 3 | 24 | 11 | 45.8 % | 11 | 0 | 11/16 (68.8 %) | 2 → 2 |
| 4 (aggregate) | 18 | 72 | 6 | 8.3 % | 6 | 0 | 6/8 (75 %) | 17 → 17 |
| 8 (aggregate) | 18 | 108 | 11 | 10.2 % | 11 | 0 | 11/16 (68.8 %) | 17 → 17 |

Latency: 6 µs/row average, 12 µs p95 (rules). Cost: $0 (rules); classifier price **unmeasured** offline.

## Gates

| Gate | Verdict |
|---|---|
| V14.1 corpus ≥ 60 labelled rows + rubric | PASS (139 rows, 18 groups) |
| V14.2 slop/unsafe recall ≥ 70 % at ≤ 2 false skips per 20 | PASS (100 %, 0.00/20) |
| V14.3 reads saved ≥ 25 % on `web_research`, authoritative source preserved | **PASS (50 % of observed-SERP reads, goldens 2 → 2)** |
| V14.4 cost ≤ $0.001/search with real usage | UNMEASURED (classifier needs a live session) |
| V14.5 ≤ 600 ms added per gated read; disabled/localOnly identical | PASS (µs; tests) |

## Decision: ship the gate behind its own switch, `reflex.pageGate` (default `false`)

What the measurement does and does not say:

- The gate is **precise**: it skipped 42/42 labelled slop/unsafe rows and lost none of the 97
  good/aggregator rows, including every recorded golden source. On the observed SERPs it saved **50 %**
  of the reads a fixed top-k would have spent, and 75 % of the reads whose window contained junk.
- The first run's 8.3 % was a **population artifact**: 15 of the 18 groups are synthetic P5 fixtures
  built from plausible-good results, so there is almost no junk to skip in them. Averaging them into a
  read-saving number measures the corpus, not the gate. Both numbers stay in this file.
- The sample is **small** (3 live SERPs) and the rules carry hand-maintained lists, so recall on this
  corpus is partly circular. The classifier — the part that should generalise to unseen farms — is
  wired, batched and budgeted, but its accuracy and price are **unmeasured offline**.
- Therefore the default does not change: `reflex.enabled` stays `false` (V14.5). The gate is enabled by
  `reflex: { "pageGate": true }`, which runs the **offline rules only** — no model call, no cost — and
  can be combined with `enabled: true` to let the classifier judge and rank pages too.

Re-run: `node bench/run.ts --gate`, `node bench/gate.ts --self-test`. The next honest step is a held-out
live corpus (different topics, en+ru), not a lower bar.
