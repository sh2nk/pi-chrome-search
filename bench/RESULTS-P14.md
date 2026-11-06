# Slop gate — V14 verdict (P14)

Date: 2026-11-06
Corpus: `bench/slop.jsonl` — 139 labelled rows, 18 SERP groups (rubric: `bench/SLOP-RUBRIC.md`).
Command: `node bench/run.ts --gate` (offline, rules backend; exit `1` = a measured gate failed).

## Numbers

| Label | rows | skipped |
|---|---:|---:|
| good | 89 | 0 |
| aggregator | 8 | 0 |
| slop | 28 | 28 |
| unsafe | 14 | 14 |

Recall on slop+unsafe **100 % (42/42)**; false skips **0/97** (0.00 per 20). Broken down by source:
fixture 0/84 skipped (no recorded good URL lost), live SERP 12/25, curated 30/30.

`web_research` read simulation (`quick` 2 / `normal` 4 / `deep` 8 reads, SERP order as baseline):

| reads | saved | saved % | junk in window | junk left | conditional | goldens before → after |
|---:|---:|---:|---:|---:|---|---|
| 2 | 3 | 8.3 % | 3 | 0 | 3/4 (75 %) | 17 → 17 |
| 4 | 6 | 8.3 % | 6 | 0 | 6/8 (75 %) | 17 → 17 |
| 8 | 11 | 10.2 % | 11 | 0 | 11/16 (68.8 %) | 17 → 17 |

Latency: 6 µs/row average, 12 µs p95 (rules). Cost: $0 (rules); classifier price **unmeasured** offline.

## Gates

| Gate | Verdict |
|---|---|
| V14.1 corpus ≥ 60 labelled rows + rubric | PASS (139 rows, 18 groups) |
| V14.2 slop/unsafe recall ≥ 70 % at ≤ 2 false skips per 20 | PASS (100 %, 0.00/20) |
| V14.3 reads saved ≥ 25 % on `web_research`, authoritative source preserved | **FAIL (8.3 %)** |
| V14.4 cost ≤ $0.001/search with real usage | UNMEASURED (classifier needs a live session) |
| V14.5 ≤ 600 ms added per gated read; disabled/localOnly identical | PASS (µs; tests) |

## Decision: the gate stays behind `reflex.enabled: false`

Same shape as V5.6, and the same refusal to game the number. What the measurement says:

- The gate is **precise**: it skipped 42/42 labelled slop/unsafe rows and lost none of the 97
  good/aggregator rows, including every recorded golden source. When junk is inside the read window it
  removes 69–75 % of those reads.
- The gate is **not a volume reducer**: on clean SERPs the top-k window contains no junk, so the
  unconditional "25 % fewer reads" bar cannot be met (8.3 % across this corpus). That bar was written
  for a compressor; a quality gate saves reads only where there is junk to skip.
- The rules layer carries a hand-maintained farm/aggregator/trusted list. It generalises badly to
  unseen farms (a shop blog, a vendor lead-gen page on a new domain). That long tail is exactly what the
  classifier is for, and its accuracy is **not** measured here: with rules alone the corpus recall is
  partly circular, because both the rubric and the lists encode the same visible signals.

Therefore:

- `reflex.enabled` stays **false** (default unchanged); the page gate runs only when the user turns the
  reflex on, and a disabled reflex never sees a URL;
- the rules page gate is the offline floor: it can *add* skips, the classifier can only add more, and
  neither can rescue an `unsafe` rules verdict;
- the classifier backend ships wired but unproven: batch size, schema validation, abstention, budget,
  cache and `decisions.jsonl` usage/cost are covered by unit tests, not by a live measurement.

Re-run: `node bench/run.ts --gate`, `node bench/gate.ts --self-test`, and (after a live session)
compare the classifier's `page_gate` rows in `~/.pi/agent/web-search/decisions.jsonl` against this
corpus. The next honest step is a held-out live corpus, not a lower bar.
