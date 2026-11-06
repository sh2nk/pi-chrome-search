# Fixtures

Offline SERP captures for adapter tests (P3/P4) and the doctor's canary checks.
Every adapter test must pass against these bytes, with **no browser and no network**.

## Naming

```
<engine>-<variant>.html.gz     sanitized, gzipped post-render HTML
<engine>-<variant>.meta.json   metadata (plain JSON, tiny)
```

| Engine | Required variants |
|---|---|
| `google` | `google-ai`, `google-no-ai`, `google-wall`, `google-empty` |
| `duckduckgo` | `ddg-assist`, `ddg-no-assist`, `ddg-empty` |
| `yandex` | `yandex-neuro`, `yandex-no-neuro`, `yandex-captcha`, `yandex-empty` |

Later waves add `read-*`, `images-*`, `goto-*` and `research-*` fixtures with the
same rules. A fixture is the *page after settle*, not a raw `curl` response:
AI summaries are client-rendered, so the HTML must come from a real headed tab.

`read-*` fixtures are ordinary article pages, not SERPs: they are `<name>.html.gz`
only, with **no** `meta.json` — an `engine` field would have to lie. They are
captured with `research/probes/09-capture-page.mjs`; `read-docs` (MDN),
`read-blog` (Rust blog) and `read-wiki` (Russian Wikipedia) cover docs, code and
Cyrillic prose with real navigation/footer boilerplate.

`ai`/`assist`/`neuro` absence is a valid A/B outcome — record it as `ai: "no"`,
never delete the fixture and never fabricate a summary.

## AI-state fixtures (P8)

The AI block has three states (`answer`/`lead`/`none`). The real captures cover
`answer` (`google-ai`, `ddg-assist`) and `none` (`google-no-ai`, `ddg-empty`,
`yandex-neuro` is robot-gated). Two *derived* fixtures cover `lead` (the block is
present but carries no full answer):

| Fixture | Derived from | Change |
|---|---|---|
| `google-ai-lead` | `google-ai` | the real AI section content replaced by the live lead line (`Ответ в режиме ИИ, исходный запрос: …`), no prose |
| `ddg-assist-lead` | `ddg-assist` | the real assist container kept, body replaced by the `Search Assist` label only |

They are labelled `capturedWith: "derived from … (P8 S4)"` and their `notes` say
so. A derived fixture is never presented as a fresh capture, and no answer text
is invented: the lead string is the one the live bug produced.

## `meta.json` schema

```json
{
  "engine": "google",
  "urlPathShape": "/search?q=<query>&hl=ru&gl=ru",
  "queryClass": "no-ai",
  "capturedAt": "2026-11-05",
  "ai": "no",
  "results": 10,
  "capturedWith": "research/probes/03-dom-dump.mjs",
  "notes": "desktop, ru-RU, summary absent by A/B"
}
```

Required:

- `engine` — `google` | `duckduckgo` | `yandex`.
- `urlPathShape` — URL path with `<query>` (or `{query}`/`*`) instead of the
  literal `q`/`text`/`query`/`word` value. No whitespace, no tokens.
- `queryClass` — short ascii slug (`no-ai`, `technical`, `wall`, `news`, …).
  **Never the query text**, not even transliterated.
- `capturedAt` — `YYYY-MM-DD` or an ISO-8601 timestamp.

Optional: `ai` (`"yes"|"no"`), `results` (non-negative integer), `capturedWith`,
`notes`. Unknown keys are allowed, but they are still sanitizer-checked.

`tests/helpers/load-fixture.ts` validates this shape and rejects a literal query
or an unsanitized capture. `capturedAt` is checked against the calendar, not just
`Date.parse`, so `2026-02-30` and non-leap `02-29` fail. `queryClass` is
deliberately restricted to `^[a-z][a-z0-9_-]{0,31}$` so a pasted Russian query
fails the gate. `fixtureExists()` returns `false` for an invalid name (a probe
may ask about arbitrary strings); `loadFixture()` still rejects it.

## Sanitization rules

Run every capture through `tests/helpers/sanitize.ts` before gzipping. It removes:

| Rule | Examples |
|---|---|
| cookies / auth | `Cookie: SID=…`, `Set-Cookie`, `Authorization: Bearer …`, `document.cookie` (a header is redacted only when a `name=value` pair follows, so prose like “How to set a cookie: a guide” survives) |
| token values | `sxsrf`, `reqid`, `sca_esv`, `ei`, `gs_lcp`, `vet`, `ved`, `usg`, `sa`, `cd`, `uact`, `csrf`, session ids, API keys |
| emails | `someone@gmail.com` → `[redacted-email]` |
| IPv4 | any address → `[redacted-ip]`; `127.0.0.1` and `0.0.0.0` are preserved |
| literal queries | every variant passed in `personalQueries` (raw, percent-encoded, `+` form, HTML-escaped) → `[redacted-query]` |

Personal queries cannot be detected automatically. Pass the explicit list used
for the capture; **never commit that list**.

```bash
mkdir -p /tmp/fixture-google-no-ai
node research/probes/03-dom-dump.mjs \
  --url "https://www.google.com/search?q=<your-query>&hl=ru" \
  --out /tmp/fixture-google-no-ai

# Sanitize + gzip with the harness (Node 26 strips .ts on import).
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { gzip, sanitizeFixture } from "./tests/helpers/sanitize.ts";
  const html = readFileSync("/tmp/fixture-google-no-ai/page.html", "utf8");
  const personalQueries = [process.env.CAPTURE_QUERY ?? ""];
  writeFileSync("tests/fixtures/google-no-ai.html.gz", gzip(sanitizeFixture(html, { personalQueries })));
'
```

Then write `google-no-ai.meta.json` by hand (or reuse the probe's `meta.json`
fields) and add a test that loads it via `loadFixture("google-no-ai")`.

`03-dom-dump.mjs` also writes `page.txt` and (with `--shot`) a screenshot. Neither
is committed: screenshots show the logged-in avatar, `page.txt` keeps the query.

## Hard rules

- **No personal data in git, ever.** A fixture is a public artifact of this repo:
  no cookies, tokens, account email, avatar URL, query history, exact IP,
  geolocation, or screenshots. `npm run audit` fails on the patterns above.
- Keep fixtures small (one SERP, no base64 images/fonts). A few hundred KB
  uncompressed is normal; strip `<style>`/`<script>` blobs only if extraction
  does not depend on them.
- Sanitizing must not change the markers the adapter relies on (`#rso`, `h3`,
  `data-testid`, `Futuris*`, …) — assert canaries after regenerating.
- Never regenerate a fixture from a logged-out or captcha-walled session and
  label it `ai`/`assist`/`neuro`.
- If a live capture needs the user's account, the **orchestrator** captures it
  once; workers only consume sanitized bytes.
