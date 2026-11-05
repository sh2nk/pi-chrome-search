# Probes

Throwaway scripts used to produce `../FINDINGS.md`. They are **not** production code and are not
imported by the extension.

## Setup

```bash
mkdir -p /tmp/probe && cd /tmp/probe
npm init -y >/dev/null
npm i playwright-core
node "$REPO/research/probes/01-cdp-smoke.mjs"   # REPO=/path/to/pi-chrome-search
```

The scripts connect to a Chrome that already has CDP enabled:

```bash
# chrome://inspect/#remote-debugging → tick → Allow
cat ~/.config/google-chrome/DevToolsActivePort   # port + path
export CDP_URL=http://127.0.0.1:9222             # or the port from the file
```

## Safety

These scripts hit **real search engines with the user's real profile**. That is the point, and also the
risk: repeated runs get the profile captcha'd or `/sorry`'d.

- Run one script at a time, once.
- Do not loop them, do not parallelize.
- If a wall appears, stop and let the user solve it in the window.
- Never leave a script running unattended.
- `05-http-fallback.mjs` is the only one that does not touch Chrome; it is still rate-limited by the IP.

## What each script proves

| Script | Proves |
|---|---|
| `01-cdp-smoke.mjs` | CDP attach works, `navigator.webdriver === false`, Google serves a SERP to the real browser |
| `02-engine-extract.mjs` | the compact extraction contract for all three engines (AI summary + organics + `/goto` resolution) and the raw→compact ratios |
| `03-dom-dump.mjs` | dumps post-render HTML/text for selector archaeology when an adapter breaks |
| `04-goto-resolve.mjs` | Google `/goto?url=…` resolves to a real URL via `302 Location` with browser cookies |
| `05-http-fallback.mjs` | keyless HTTP tricks (Yandex `search/site` works; Google WML is header/TLS-sensitive) |

## Where these probes sit in `PLAN.md`

| Probe | Feeds | Notes |
|---|---|---|
| `01`, `02` | P1 (attach/doctor) and P3 (adapter contract) | run live **once** at the P1/P3 gate, never in parallel with other live work |
| `03`, `04` | P3 fixtures: `google-{ai,no-ai,wall,empty}`, `ddg-*`, `yandex-*`, `goto-{302,200}` | sanitize before committing (no cookies, tokens, `sxsrf`/`reqid`, emails, exact IP, personal queries) — P3 fixture rule |
| `04` resolution trick | P2-A `extract/urls.ts` + P3-Google | the HTTP 302 → `Location` path is production behaviour, cached 24 h |
| `05` | P3 fallback lane (degraded only) | never the main path; results marked `degraded: true`, `ai:false` |

Probe output is evidence, not code: paste the numbers into `../FINDINGS.md` and the phase gate into
`evidence/P<N>.md`. If a probe contradicts a plan assumption, the orchestrator updates the plan before the
lane starts — not after it fails.

## Historical (do not reuse)

The first probe round used `playwright.launchPersistentContext()`. It worked for ~6 queries, then Google
returned `/sorry` and Yandex returned SmartCaptcha immediately. That failure mode is recorded in
`../FINDINGS.md` §1; there is deliberately no script for it here.
