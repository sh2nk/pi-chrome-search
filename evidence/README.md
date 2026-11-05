# evidence/ — proof that a phase gate passed

The orchestrator writes one file per phase (`P0.md` … `P7.md`) and commits it together with the wave.
A gate is not "done" because the code looks right: it is done when the command in `PLAN.md §3` was re-run
by the orchestrator and its output is recorded here.

## Rules

- **Commands, not claims.** Every line is `command → exit code → the lines that matter`. Truncate long
  output, never paste full tool logs.
- **No personal data.** No cookies, tokens, `sxsrf`/`reqid` values, account emails, exact IP, or literal
  personal search queries. Use query classes (`technical RU`, `commercial RU`, `factual EN`).
- **No binaries.** No screenshots, no `page.html`. Reference the artifact directory path instead; the
  artifact itself stays in `~/.pi/agent/web-search/artifacts/` and is git-ignored.
- **Redacted doctor JSON is allowed** and encouraged: it is the honest state of attach/WebDriver/lock.
- **Blockers get their own file**: `P<N>-blocker.md` with what the user must do and what was not run.
- Evidence that was waived is marked `WAIVED (<reason>, approved by user on <date>)`.

## Template

```markdown
# P<N> — <phase name>

Date: YYYY-MM-DD
Owner: orchestrator
Commit: <sha> <subject>
Waves: <lane ids integrated>; max concurrency <n>

## Gates

| # | Command | Exit | Result | Verdict |
|---|---|---|---|---|
| V<N>.1 | `npm run typecheck` | 0 | no errors | PASS |
| V<N>.2 | `node --test tests/unit/<lane>.test.ts` | 0 | 14/14 pass | PASS |
| V<N>.3 | `node src/cli/doctor.ts --json` | 0 | <redacted snippet> | PASS |

## Live smoke

| Engine | Query class | ai | Results | Chars | Latency | Wall | Verdict |
|---|---|---|---|---|---|---|---|
| google | technical RU | yes | 5 | 2 314 | 4.9 s | none | PASS |

## Deviations

- <what the spec did not anticipate and how it was handled>

## Open questions / next phase inputs

- <one or two bullets>
```

## Status legend (mirrors `PLAN.md §5`)

`PASS` · `FAIL` · `PARTIAL` (reason required) · `BLOCKED` (user action named) · `WAIVED` (user approved).
