# `bench/codemode.ts` — direct vs codemode vs `web_research` (PLAN P6-B, gate V6.4)

Three paths, one query set, one number each: **how many characters does the model have to read**
after the path did the job. Offline, deterministic, no model, no network, no Chrome.

PLAN P6-B names `bench/RESULTS.md` as the deliverable; that file is orchestrator-owned, so the
measurement lives here and `RESULTS.md` can link to it.

```bash
node bench/codemode.ts              # markdown report (aggregates + per-query rows)
node bench/codemode.ts --json       # the same numbers, machine-readable
node bench/codemode.ts --self-test  # corpus, caps, determinism, honesty checks
```

## 1. What this measures — and what it does not

A real codemode run needs an agent loop, and an agent loop needs a model. This repo has no model in
the bench, and faking one would make the comparison worthless. So the harness measures the only thing
that is deterministic without a model: **the characters a path puts in front of the model**, plus the
number of calls the agent has to make and the golden domains that survive into the payload.

Measured: output characters, tokens (`chars/4`), agent-visible calls, nested tool calls, recall@5 of
`goldenDomains` in the payload, harness wall time.

**Not measured** — and not claimed anywhere in this file: model/agent thinking time, network or
browser latency, answer quality, and whether a filtered payload still contains the sentence the
answer needed. That last one is the real risk of codemode and a character count cannot price it.

## 2. Method

| Path | Agent calls | Nested calls | What the model reads |
|---|---:|---:|---|
| `direct` | 3 | 0 | `web_search(q, n=5)` markdown + `web_read` on the top 2 results, 6000 chars each |
| `codemode` | 1 | 3 | the script's returned JSON + the script text (charged per query) |
| `research` | 1 | 1 search + up to 4 reads | the `web_research` bundle, hard cap 2500 chars |

Every path reuses production code:

- `direct` — `src/extract/compact.ts` (`compactSerps`, SPEC defaults `n=5`, summary ≤1200,
  snippet ≤140, total ≤2500) and `src/extract/read.ts` (`renderReadableDocument` at the 6000-char
  `web_read` default). Same code `bench/run.ts` measures, so the direct numbers agree with it:
  recall 0.789 (71/90), search payload 34 768 chars over 30 queries, spam leak 16/30.
- `codemode` — `CODEMODE_SCRIPT` in `bench/codemode.ts` is the script an agent writes; its
  in-process equivalent (`codemodeScript`) performs the same operations: one `web_search`
  (`format:"json"`), `Promise.allSettled` over the top-2 `web_read` calls, then a client-side filter
  (dedupe by URL via the JSON view, keep ≤2 per domain, snippets to 140) and a JSON return with a
  **600-char head per read**. `--self-test` asserts the script text and the code agree on all six
  parameters, so they cannot drift.
- `research` — the real `createWebResearchTool` with injected seams, `reflex.enabled:false`
  (V6.3: no classifier is built, no model is consulted).

**Read payload proxy.** The SERP fixtures are synthetic and no page bodies were recorded for their
URLs, so each read is served one of three committed captures — `tests/fixtures/read-docs.html.gz`
(MDN), `read-blog.html.gz` (Rust blog), `read-wiki.html.gz` (RU Wikipedia) — through the real
readability pass at the requested cap. Mapping is by domain: `*.wikipedia.org` → wiki, a fixed
docs-host list (`developer.mozilla.org`, `typescriptlang.org`, `nodejs.org`, `docs.docker.com`,
`postgresql.org`, `man7.org`, …) → docs, everything else → blog. Rendered lengths: 18.5k / 8.8k /
10.7k chars, so a 6000-char window really is a truncation. This measures the **cost shape** of a real
page read, not the content of that exact URL.

## 3. Assumptions (all explicit, all in the output)

1. `tokens = ceil(chars / 4)` per query, summed; a cheap estimate, not a tokenizer. Aggregate tokens
   can therefore exceed `ceil(totalChars / 4)` by up to one token per query.
2. The codemode script is **796 chars** and is charged **per query**. A tool-call argument stays in
   the transcript and is re-read on later turns; the `script-once` row shows the optimistic reading
   (one script for the whole session, 29 copies removed).
3. Codemode keeps a **600-char head per read**. This is an assumption, not a measurement of what a
   page needs — §5 shows what happens when it changes.
4. `web_research` ran with budget `normal` (2 searches + 4 reads); `quick`/`deep` are reported too.
5. Latency is harness wall time for the measured step only.

## 4. Results

Corpus: `bench/queries.jsonl` (30 queries, 15 EN / 15 RU, 5 classes), `bench/fixtures/*`
(15 SERPs), read proxy as above. One run, 2026-11-06:

| path | chars | tokens | agent calls | nested calls | recall@5 | wall ms |
|---|---:|---:|---:|---:|---:|---:|
| `direct` | 391 660 | 97 926 | 90 | 0 | 0.789 (71/90) | 120 |
| `codemode` | 98 971 | 24 752 | 30 | 90 | 0.789 (71/90) | 13 |
| `research` | 60 793 | 15 211 | 30 | 174 | 0.644 (58/90) | 29 |

Δ vs direct: codemode **−74.7 %**, research **−84.5 %**. Per query that is ≈13 055 chars for direct,
≈3 299 for codemode, ≈2 026 for one research call.

`web_research` by budget (same corpus, reflex off):

| budget | chars | tokens | searches+reads | recall@5 | wall ms |
|---|---:|---:|---:|---:|---:|
| quick (1+2) | 54 126 | 13 539 | 90 | 0.389 (35/90) | 21 |
| normal (2+4) | 60 793 | 15 211 | 174 | 0.644 (58/90) | 29 |
| deep (4+8) | 43 227 | 10 817 | 177 | 0.656 (59/90) | 27 |

Codemode sensitivity — the read-head size is the only free parameter:

| variant | chars | tokens | note |
|---|---:|---:|---|
| `head-600` (default) | 98 971 | 24 743 | ~one lead paragraph per read |
| `head-1200` | 135 403 | 33 851 | twice the head |
| `head-6000` | 424 405 | 106 102 | no body filtering: the same text direct sees |
| `script-once` | 75 887 | 18 972 | head-600, one script for all 30 queries |

## 5. Reading the numbers

1. **Direct is dominated by page reads.** ≈11 900 of ≈13 055 chars per query (≈91 %) are the two
   6000-char `web_read` results; the search payload alone is ≈1 159 chars (34 768 over 30 queries,
   matching `bench/run.ts`).
2. **Codemode's −74.7 % is bought, not found.** The script keeps 600 of 6 000 characters per page
   *before any model sees them*. At `head-6000` the same path costs **+8.4 %** more than direct,
   because the identical text is re-serialised as JSON with per-result keys. The whole saving is the
   blind 90 % truncation of two pages — and the script cannot know which 600 chars matter.
3. **`web_research`'s −84.5 % comes from its 2 500-char hard cap**, not from the corpus being lucky;
   it is the same cap the extension enforces in production.
4. **Recall@5 is identical for direct and codemode (0.789).** Both keep the five compacted results;
   on this corpus the script's 2-per-domain filter removed nothing (the fixtures already respect that
   cap). A dedupe filter preserves domains — it does not improve or degrade them.
5. **Research recall (0.644) is lower by construction, not by failure.** Its bundle cites the pages
   it read (2–4 URLs), not the five results it saw, so a golden domain that was in the SERP but not
   read cannot appear in the payload. Read the number as "how many golden domains survive into the
   bundle", not "how well did retrieval do".
6. **The dedupe filter is not a spam filter.** The synthetic `spam-seo.example` result survives into
   16/30 direct payloads and 16/30 codemode payloads; the research bundle cites it 8/30 times
   (it actually read the page). Removing it is triage's job, which is what P5 measures.
7. **`deep` returns *less* than `normal` here (43 227 vs 60 793 chars).** The 2 500-char cap is
   divided across the read allowance before the loop runs, so `deep` sizes every excerpt for 8 reads
   (156 chars) even when the loop stops after 4; `normal` sizes them for 4 (312). The no-new-domains
   rule usually stops both at 2 searches / 4 reads on a corpus with one SERP per group (measured: 3/90
   runs stop earlier), so `deep` pays the smaller window without gaining evidence. See §7 — this is a
   P6-A follow-up, not a bench bug.

## 6. Recommendation (V6.4)

- **Direct `web_search` calls stay the default.** They are the honest path: 3 calls, the real SERP,
  and whole pages when a page is read. `codemode` is not required by the extension and must not
  become a default setting.
- **Codemode helps only when the agent can state, in the script, what it needs** — a shortlist of
  candidates, a domain-deduped table, a field extracted by a pattern — or when it wants a filtered
  bundle without spending a turn. It does **not** help as a generic "read the web for me" path: the
  −74.7 % would come from truncating pages the model never chose. If codemode is enabled, keep
  `mode:"on"` (declared tools stay declared) and a small `inlineBudget`, per AGENTS §10.
- **`web_research` wins when the question needs cited claims and the agent would otherwise read two
  or more pages**: one call, ≤2 500 chars, ≈1.6× cheaper than codemode and ≈6.4× cheaper than
  direct, with 0.64 recall@5 of SERP domains. That is the right tool for "what do sources say about
  X"; it is the wrong tool when the answer needs a full page (README tables, code listings) or a
  complete SERP listing.
- **Order of preference, from these numbers:** `web_research` for evidence-shaped questions →
  direct `web_search` (+ selective `web_read`) for everything else → codemode only for an ad-hoc,
  script-shaped job. Never enable codemode globally on the strength of a 600-char head.

## 7. Limits of this measurement

- No model, so the script's "what to keep" decision is a constant, not intelligence. A real agent
  could write a *better* 600 chars (or a worse one) — unmeasurable here.
- The read proxy is topically unrelated to the query, so `web_research`'s coverage judge usually
  spends its budget instead of stopping early (measured: 2/30 runs stopped early): its cost is an
  **upper bound** on this corpus, not a central estimate.
- One SERP per fixture group means refinement queries return the same URLs; `deep` cannot find more
  evidence than `normal`. A live corpus would let `deep` use its allowance.
- P6-A follow-up worth taking: size `excerptChars` from the reads **actually performed**, not from
  the allowance, so an early stop does not shrink every excerpt (item 7 in §5).
- The numbers are per-run evidence for a fixed corpus (bench honesty rule 3). Re-run the command
  before quoting them; `bench/results/` is not committed.
