# `bench/` — System 1 benchmark (SPEC §9.4, PLAN P5-A / V5.6)

Answers one question with numbers, not vibes: **does the optional reflex layer keep search
quality while cutting what the model has to read?** The default path is an offline replay of
recorded SERPs, so it is deterministic, free, and never touches Chrome. Live runs are opt-in,
one query at a time, and stop at the first wall.

```
bench/
  queries.jsonl          30 RU/EN queries, 2–4 golden domains each, no personal queries
  fixtures/<class>.json  15 hand-written synthetic SERPs (3 per class) + one synthetic spam item each
  run.ts                 offline replay, live run, self-test, comparison
  results/               local output only — never commit (see Honesty rules)
  README.md              this file
```

## 1. Offline replay (default)

```bash
npm run bench                 # == node bench/run.ts; writes bench/results/<ts>-offline.json
node bench/run.ts --no-write  # same numbers, nothing written
node bench/run.ts --n 5       # SPEC default; 1–10 allowed
node bench/run.ts --class technical
node bench/run.ts --serp-source ./bench/fixtures   # explicit control corpus
```

What happens per query: the runner picks one recorded SERP (explicit `covers` wins, otherwise
the SERP sharing the most golden domains, ties by fixture id), then compacts it through
`src/extract/compact.ts` with the SPEC defaults (`n=5`, summary ≤1200, snippet ≤140, total
≤2500). No network, no CDP, no config file: two runs of the same corpus produce identical
recall/token/spam numbers. The only non-deterministic field is `latencyMs`.

`--serp-source <dir>` is the control knob: the same query set and the same code against a
different recorded corpus. Use it when you change fixtures or want to prove the pipeline
(not the network) is doing the work. Every `*.json` under the directory is loaded recursively.

Self-check (fixtures, determinism, caps, verdict rules, live guards):

```bash
node bench/run.ts --self-test
```

It exits non-zero if the query set loses a class/language, a fixture loses its spam sentinel,
two replays disagree, output exceeds 2500 chars, the offline run exceeds 2 s, or the SPEC §9.4
verdict rules change behaviour.

## 2. One live query (opt-in)

Live mode calls the real registered `web_search` through the same `createTools` + `Connector`
stack as `research/probes/08-live-search.mjs`; it never reimplements the adapter or bypasses
pacing. Prerequisites: Chrome running with CDP allowed (`chrome://inspect` → Allow), then:

```bash
PI_CHROME_LIVE=1 node bench/run.ts --live --limit 1
PI_CHROME_LIVE=1 node bench/run.ts --live --limit 1 --engine google
```

Rules enforced by the runner:

- `PI_CHROME_LIVE=1` is required; without it the run refuses before opening a socket.
- `--limit N` is required. `N ≤ 5` works directly; `N > 5` additionally needs `--allow-more`.
  There is no "run all 30" default.
- Queries run **sequentially** with a 1.2 s gap, on top of the configured per-engine limiter.
- A wall or infrastructure failure (`E_WALL`, `E_BUSY`, `E_RATE_LIMITED`, `E_CDP_*`,
  `E_TARGET_LOST`) **stops the run**. Nothing is retried. On `E_WALL` the exit code is 3 and the
  visible window is left for the user to solve; rerun later, never in a loop.
- Default selection is round-robin across classes, so `--limit 5` covers five topics rather
  than five trivia questions. `--class` narrows it; `--engine` overrides the query's engine.
- Results go to `bench/results/<ts>-live.json` (override with `--out`). `cached: true` marks a
  cache hit: fast, but not a fresh SERP — do not read cached latency as engine latency.

## 3. Baseline vs reflex

P5-A ships the harness; P5-B/C ship the rules/classifier and P5-D wires them. Until then a
"reflex" result file is produced by that later phase (or by a candidate build) with the same
schema. Comparison is deliberately dumb and honest — it reads two files and applies the SPEC:

```bash
node bench/run.ts --compare bench/results/a.json bench/results/b.json
```

```
recallDelta    = (reflex.recall@5 − baseline.recall@5) × 100        (points)
tokenDeltaPct  = (reflex.tokens − baseline.tokens) / baseline.tokens × 100
readsDeltaPct  = (reflex.reads − baseline.reads) / baseline.reads × 100
ship = recallDelta ≥ −2  AND  (tokenDeltaPct ≤ −20  OR  readsDeltaPct ≤ −30)
```

`ship` is the only gate: recall may not drop more than 2 points, and either returned tokens
drop ≥20 % (triage) or page reads drop ≥30 % (read gate). The comparison prints every reason,
including "unavailable" deltas (e.g. no reads recorded in an offline baseline). `ship` is forced
to `false` when the two files differ in mode (`offline` vs `live`), render (`md` vs `json`) or
query set — a partial live run must never look like a win. A comparison is per-run evidence, not
a promise; re-run it on the same corpus before enabling `reflex.enabled`.

## 4. Metrics

| Field | Meaning |
|---|---|
| `recall@5` | fraction of a query's `goldenDomains` present in the top 5 result domains; aggregate is goldens-hit / goldens-total over successful runs |
| `chars` / `tokens` | summed compact output; `tokens = ceil(chars / 4)` (a cheap estimate, not a tokenizer) |
| `latencyP50Ms` / `latencyP95Ms` | wall time of the measured step (offline: compaction; live: one `web_search` call) |
| `spam` | synthetic spam items checked / leaked / caught; offline only, since live search does not inject spam |
| `abstainRate` | **placeholder 0** until P5-B/C exist; the comparison ignores it |
| `reads` | total page reads recorded by the producer; 0 offline, filled by P5-D result files |
| `cached` | per-query live flag; cached runs are reported, not hidden |

Domain matching is suffix-aware: `wikipedia.org` matches `en.wikipedia.org` and `www.wikipedia.org`
(hostname lowercased, leading `www.` stripped by `domainOf`).

## 5. Result JSON shape

```jsonc
{
  "schema": "pi-chrome-search/bench@1",
  "mode": "offline",                  // "offline" | "live"
  "render": "md",                     // offline md; live json (the tool's JSON view)
  "generatedAt": "2026-11-06T12:00:00.000Z",
  "queriesFile": "queries.jsonl",
  "serpSource": "fixtures",           // fixture dir, or "live-chrome"
  "n": 5,
  "limit": null,                      // live: resolved query count
  "engineOverride": null,
  "queries": [
    {
      "id": "t1", "q": "typescript satisfies operator",
      "class": "technical", "lang": "en", "engines": "auto",
      "fixture": "technical-typescript-css",   // null live
      "ok": true,
      "recallAt5": 0.6667, "goldensHit": 2, "goldensTotal": 3,
      "chars": 812, "tokens": 203, "latencyMs": 0.08,
      "results": 5, "ai": false, "cached": false,
      "topDomains": ["typescriptlang.org", "developer.mozilla.org", "..."],
      "spam": "leaked"                          // "caught" | "leaked" | "absent"
      // "reads": 2, "error": { "code": "E_WALL", "stage": "settle" } when applicable
    }
  ],
  "metrics": {
    "queries": 30, "ok": 30,
    "recallAt5": 0.789, "goldensHit": 71, "goldensTotal": 90,
    "chars": 34768, "tokens": 8702, "avgChars": 1158.9, "avgTokens": 290.1,
    "latencyP50Ms": 0.12, "latencyP95Ms": 0.66,
    "reads": 0, "abstainRate": 0,
    "spam": { "checked": 30, "leaked": 16, "caught": 14, "caughtRate": 0.4667 }
  },
  "stopped": null,                    // live: { "at": "n1", "code": "E_WALL", "stage": "settle" }
  "notes": ["offline replay: ...", "abstainRate is a placeholder ..."]
}
```

`--compare` emits:

```jsonc
{
  "schema": "pi-chrome-search/bench-compare@1",
  "baseline": { "file": "a.json", "mode": "offline", "metrics": { /* … */ } },
  "reflex":   { "file": "b.json", "mode": "offline", "metrics": { /* … */ } },
  "verdict": {
    "recallDelta": 0.0, "tokenDeltaPct": -21.4, "readsDeltaPct": null,
    "ship": true,
    "reasons": ["recall within 2 points (0 pts)", "tokens cut 21.4% (need >=20%)", "..."]
  }
}
```

## 6. Query set and fixtures

`queries.jsonl` is one JSON object per line:

```jsonc
{ "id": "t1", "q": "typescript satisfies operator", "class": "technical",
  "lang": "en", "engines": "auto",
  "goldenDomains": ["typescriptlang.org", "developer.mozilla.org", "github.com"],
  "notes": "optional" }
```

Composition: 30 queries — 6 each of `factual`, `technical`, `commercial`, `news`, `ambiguous`;
15 English, 15 Russian. Golden domains are 2–4 plausible, generic sources per query. There are
**no personal queries**: nothing about the user, their city, health, accounts, email or finances.
Keep it that way — this file is committed.

A fixture file is `{ "class": "<class>", "serps": [ … ] }`; each SERP carries `id`, `engine`,
`covers` (query ids), an optional `ai` summary, and 4+ results. Exactly one result per SERP must
use the reserved domain `spam-seo.example` and the title marker `[synthetic spam]`; the self-test
enforces this, and the baseline deliberately leaks some of them so the metric is exercised.
Fixtures are synthetic: no copied SERP HTML, no cookies, no profile identity fields.

## 7. Honesty rules

1. **No personal queries, ever.** The bench measures retrieval, not the user's life.
2. **A wall stops the run.** No retry loop, no alternate profile, no captcha solving. `E_WALL`
   means "ask the user, rerun later".
3. **Numbers are per-run, not promises.** Offline replay measures the pipeline against a fixed
   corpus; live recall depends on the engine's mood, freshness and personalization. Report the
   file path and query count with every claim.
4. **A reflex ships only if `--compare` says `ship: true`** on the same corpus, recall within
   2 points and the token/read threshold met. Otherwise `reflex.enabled` stays `false`, and the
   numbers are recorded anyway (a negative result is a result).
5. **No invented metrics.** `abstainRate` is 0 because the reflex does not exist yet; `reads`
   is 0 offline because nothing was read. Do not fill gaps with guesses.
6. **Do not commit `bench/results/`.** It is local output; the same run is reproducible from the
   fixtures. (Add `bench/results/` to `.gitignore` if it is not there yet.)
7. **No new dependencies, no browser automation.** `run.ts` imports compaction and, in live
   mode, the existing extension stack — never Playwright and never a launcher.
