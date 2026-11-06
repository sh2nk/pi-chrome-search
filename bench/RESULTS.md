# Bench results — V5.6 verdict

Date: 2026-11-06
Corpus: `bench/queries.jsonl` (30 queries, 15 EN / 15 RU, no personal data), 15 synthetic SERPs.
Command: `npm run bench` (offline replay; live is opt-in with `--limit` and not used for this verdict).

## Numbers

| Run | recall@5 | tokens | spam leaked | results/query | p95 |
|---|---|---|---|---|---|
| baseline (`--reflex off`) | 0.789 (71/90) | 8702 | 16/30 | 5 | 0.43 ms |
| rules triage, `keep 6` (default) | 0.867 (78/90) | 8686 | 12/30 | 5 | 2.12 ms |
| rules triage, `keep 3` | 0.789 (71/90) | 5462 | 4/30 | 3 | 1.84 ms |

Verdicts from `--compare`:

- `off → rules(keep 6)`: **KEEP OFF** — recall +7.78 pts (within the 2-point budget, actually better),
  tokens **−0.2%** (the bar is ≥20%).
- `off → rules(keep 3)`: **SHIP** by the letter of SPEC §9.4 — recall ±0 pts, tokens **−37.2%**.

## Decision: reflex stays off

`bench/RESULTS.md` reports what the numbers mean, not just which threshold tripped.

The `keep 3` "win" is not a token optimisation: with `n=5` the user asked for five results and the run
returns three. Returning fewer results always lowers tokens, so the metric is satisfied by delivering less.
That is not the feature SPEC §9.4 is trying to buy (it is about dropping *irrelevant* results), and shipping
it would silently degrade every search.

The honest configuration — triage that still returns the requested `n` (`keep 6` ≥ n) — keeps recall and
halves spam leakage (16 → 12 of 30) but cuts tokens by 0.2%, so it fails the ≥20% bar.

Therefore:

- `reflex.enabled` stays **false** (default unchanged);
- `reflex.triage.keep` stays **6** (never lowered below `n` to manufacture a win);
- the rules layer still runs for routing/telemetry when the flag is turned on, and `bench/run.ts --reflex
  rules` documents how to re-measure;
- the read-gate half of V5.6 (reads ≥30% down) has no honest offline measurement; it needs a live result
  file and is recorded as unmeasured rather than invented.

Re-run: `npm run bench` (baseline), `node bench/run.ts --reflex rules`, then
`node bench/run.ts --compare bench/results/<baseline>.json bench/results/<rules>.json`.
