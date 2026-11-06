# Slop-gate corpus — labelling rubric (V14.1)

`bench/slop.jsonl` is the labelled corpus the P14 page gate is measured on. A label answers one
question: **should `web_read`/`web_research` spend a browser read on this result for this query?**

Every row was labelled from the SERP snapshot alone — URL, title, snippet — never from the page body.
That is the information the gate itself has before it reads, so a body-informed label would measure
something the gate cannot see.

## Labels

| Label | Meaning | Gate expectation |
|---|---|---|
| `good` | primary source, documentation, standards body, established publication, or an original article/review/forum thread that answers the query | **never skipped** |
| `aggregator` | marketplace, meta-search, video hosting, or a page that gathers other people's answers | **never skipped** (low trust, still worth a read) |
| `slop` | the page exists to occupy the query, not to answer it: content farm, machine-translated article, keyword-stuffed portal column, dream-book/horoscope page, shop blog about an unrelated topic, vendor lead-gen page | should be skipped |
| `unsafe` | deceptive or harmful: phishing/credential harvest, fake support, prize scam, malware, adult/pharma/gambling traffic, punycode homograph, credentials in the URL | should be skipped |

## Provenance (`source`)

| `source` | How it got here |
|---|---|
| `serp` | observed in a live Google SERP on 2026-11-06 (three generic queries: commercial EN, technical RU, lifestyle RU slop attractor). The query text is not stored — only a class (`live-laptop-en`, `live-win-update-ru`, `live-dream-ru`) — so no personal query enters git. |
| `fixture` | the real URLs recorded in the P5 `bench/fixtures/**` SERPs (the synthetic `spam-seo.example` sentinel is excluded: it is a benchmark marker, not real data). |
| `curated` | real-world farm/unsafe shapes that do not depend on a query: known content-farm hosts, abused TLDs, punycode, credentials in URL, scam copy. Curated rows are labelled by shape, not by a specific SERP observation. |

The `why` field records the reason for the label in one line. `serp` + `rank` group rows back into the
result set they came from, which is what the read-saving simulation replays.

## Known limits (stated so the numbers are not over-read)

- 139 rows / 18 SERP groups is a small corpus. Recall on `curated` rows is close to tautological for
  the host lists the rules carry by design; the informative numbers are the live-SERP rows, the
  false-skip count on `good`/`aggregator`, and the research simulation.
- Label boundaries are judgement calls: a vendor blog with real instructions could be argued into
  `good`. The rubric resolves that as `slop` when the page's purpose is lead generation, and the `why`
  field exposes the call for review.
- The gate is measured with the **rules** backend here. The classifier backend needs a live pi session
  and a paid classifier; it is exercised by unit tests for batching, schema validation, abstention,
  budget and logging, and its accuracy is explicitly marked **unmeasured** in the gate report.
