# AGENTS.md — working on `pi-chrome-search`

The user speaks Russian: reply in Russian. Code, comments, commit messages and docs are English.

A pi extension that searches the web for free through the user's own visible Chrome (Google,
DuckDuckGo, Yandex, each engine's native AI summary), reads pages, searches images, and never launches
an automation browser. The window being visible is **desired**, not a bug. Read
`docs/architecture.md` (decisions) and `docs/engines.md` (selectors) before changing behaviour.

## Hard rules (violating these breaks the premise)

1. **Attach only.** Never `launch()`, `launchPersistentContext()`, `--enable-automation` or a separate
   automation profile in `attach` mode. Raw CDP (`ws`) in production code. `mode:"launch"` is tests-only.
2. **Never restart, kill or close the user's Chrome**, never close tabs we did not open, never touch
   `~/.config/google-chrome/**` (no cookie copying, no `Local State` edits).
3. **No headless and no fingerprint spoofing.** No UA/locale/timezone/screen/WebGL/`navigator.*`
   overrides, no `Page.addScriptToEvaluateOnNewDocument`. One-off `Runtime.evaluate` is fine.
4. **No paid search APIs or keys** (SerpApi/Serper/Brave/Tavily/Exa/Kagi). Classifiers may use the user's
   existing OpenRouter balance or local llama.cpp — capped, logged, `reflex.localOnly:true` disables
   remote calls. Search traffic never goes through a classifier provider.
5. **Never solve captchas.** Surface the window, return `E_WALL`, let the user solve it. No third-party
   solver, no retry loop around a wall.
6. **Rate-limit like a human.** One search at a time per engine, `pacing` and daily caps respected, one
   live probe per engine per gate. Never loop live probes; never auto-launch Chrome in `attach` mode.
7. **Every failure is diagnosable**: `code` + `stage` + `hint` (+ artifact for page states), through
   `src/runtime/errors.ts`. No bare `throw new Error("failed")`.
8. **Keep the prompt cheap and the browser single-writer.** `web_search` is the only `direct` tool; all
   tool descriptions ≤900 chars total, asserted in a test. Live Chrome work is orchestrator-only and
   serialized; one writer per file; workers never commit and never mark their own gate green.

## Repo map

```
index.ts            package entry (lets pi label this package by name)
src/index.ts        runtime: 5 tools, /web-doctor, /web-focus, session shutdown
src/config.ts       strict loader → ~/.pi/agent/web-search.json
src/tools/          web_search (direct), web_read, image_search, web_research, web_doctor
src/engines/        google, duckduckgo, yandex, images — pure buildUrl + DOM extractor
src/cdp/            discovery, session (raw WS), browser (window/tab/lock), humanize, ai-wait,
                    page-lock, raise
src/extract/        compact (caps/dedup/URLs), read, urls, claims, goto, pdf
src/runtime/        cache, limiter, errors, error-codes, artifacts, doctor, log, notify,
                    attention, panel, ssrf, host
src/cli/doctor.ts   headless doctor (--json), used by gates
scripts/audit.mjs   hard rules, secrets, fixture hygiene, doc budgets, docs↔code drift, packaging
scripts/release.mjs conventional-commit bump classification (offline-testable)
tests/unit          contract suite (offline) · tests/live opt-in smoke · tests/fixtures sanitized
docs/               architecture, engines, errors, config
.github/workflows   ci.yml (lint+test) · release.yml (bump/tag/publish)
```

## Commands

```bash
npm run lint                     # tsc --noEmit && node scripts/audit.mjs
npm test                         # node --test tests/unit/**/*.test.ts (offline)
node src/cli/doctor.ts --json    # canonical gate output; --no-probe --fix --watch
PI_CHROME_LIVE=1 npm run test:live   # one query per engine, n=2, no retries; a wall = stop
pi -e ./src/index.ts             # load the extension in a throwaway session
node scripts/release.mjs --dry-run   # print the next version for the current log
```

Live commands hit real engines: run them **once**. A wall means stop and ask, not retry. Artifacts:
`~/.pi/agent/web-search/artifacts/`; decisions: `~/.pi/agent/web-search/decisions.jsonl`.

## Conventions

- TypeScript strict ESM, Node ≥26, no build step, no `any` (use `unknown` + guards).
- Small modules: an adapter is `buildUrl` + a DOM extractor, not a god object; text/structural markers
  with canaries, never obfuscated class names alone.
- All output passes `src/extract/compact.ts`; caps live there only.
- **Host access lives in `src/runtime/host.ts`** (platform, paths, profile tables, `capability()`,
  `isProcessAlive()`). Nothing else imports `node:os`, reads `$HOME`/`PATH`, hardcodes `/proc/` or
  `.config/`, or spawns to probe a binary — audit rule R13 enforces it.
- Every new selector ships a fixture (`tests/fixtures`, sanitized: no cookies, tokens, identity, exact
  IP, personal queries) and a line in `docs/engines.md`.
- New dependency: justify it in the commit message. Tests are offline by default; live tests are opt-in.
- Commit style: `feat: …`, `fix(parse): …`, `docs: …`, `test: …`, `chore: …` — the release workflow
  classifies these (`!`/`BREAKING CHANGE` → major, docs/test/chore only → no release). Commit on your
  own as soon as the gates pass: do not wait for an explicit "commit" request, one logical change per
  commit.

## Definition of done

- `npm run lint && npm test` pass, and `node src/cli/doctor.ts --json` is schema-valid and honest.
- The changed behaviour has an offline test plus (for live paths) one documented smoke run: engine,
  query class, `ai:yes/lead/no`, chars, latency.
- Output ≤2500 chars at `n=5`; tool descriptions ≤900 chars; a new selector is in `docs/engines.md`.
- No hard rule broken: no launch/headless/fingerprint/captcha automation, no paid search API, no secret
  or personal data in a tracked file.
