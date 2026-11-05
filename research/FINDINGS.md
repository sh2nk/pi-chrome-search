# FINDINGS — live probes, 2026-11-05

Everything below was measured on the user's machine, not inferred from docs. Numbers are from a small
number of runs on one IP; treat them as orders of magnitude, not constants. Re-measure in `bench/`.

## Environment

| Item | Value |
|---|---|
| Date | 2026-11-05, ~16:00–16:30 UTC |
| Chrome | 157.0.8103.38, headed, Wayland |
| Profile | `~/.config/google-chrome` (running), Google account logged in, 423 `.yandex.ru` cookies |
| IP | RU residential, Kaluga, Rostelecom (exact address intentionally omitted) |
| Node / pi | 26.13.0 / 1.5.0 |
| CDP | not enabled at rest; probes launched a **copy** of the profile or a throwaway profile |

---

## 1. Playwright launch vs CDP attach (the most important finding)

**Playwright `launchPersistentContext({ channel: "chrome", headless: false })`:**

- Fresh throwaway profile (`/tmp/wtest/profile`), desktop UA, `--disable-blink-features=AutomationControlled`.
- Google worked for the first ~6 queries (AI Overview present), then returned
  `https://www.google.com/sorry/index?continue=…` — "Мы зарегистрировали подозрительный трафик,
  исходящий из вашей сети" with the IP printed.
- Yandex returned `/showcaptcha` (SmartCaptcha) on the first direct SERP navigation.

**Manual Chrome + `connectOverCDP` (no Playwright launch flags):**

- `navigator.webdriver === false`.
- Google served normal SERPs with AI Overview again.
- Yandex still captcha'd the first navigation of a session, but a **retry ~3 s later on the same profile
  returned a normal SERP** (9 `h3`, no captcha). This happened twice (two separate sessions).

**Conclusion:** attach, never launch. A visible, long-lived, real-profile Chrome is the asset.

### Profile copy experiment

- Copied `~/.config/google-chrome/{Local State,Default/Cookies,Default/Preferences}` to `/tmp/tp` and
  launched Chrome against it.
- Google rendered "Войти" (not logged in) → cookies were not usable after the copy.
- After that run, the copied cookie DB had **26 rows / 20 yandex / 6 google** instead of 423 yandex —
  Chrome discarded cookies it could not decrypt.
- `secret-tool` is present and the keyring is reachable (`Chrome Safe Storage` lookup exits 0), so
  programmatic decryption is possible, but **copying the profile is not a reliable way to inherit a
  session**. Use the live browser (or a dedicated, warmed profile).

---

## 2. Google

Query: `что такое трансформер в машинном обучении`, `&hl=ru`.

- **AI Overview:** present. Found via a `section` whose `innerText` contains `Обзор от ИИ`; raw text
  ~2 608 chars. The block includes sub-headings, inline source names (`Википедия`, `+1`,
  `BigDataSchool`, `Hugging Face`), and a "show more" control.
- **Organics:** 9–10 `a h3` items. Container `closest('div[data-hveid]')`; snippet
  `.VwiC3b, [data-sncf]` worked.
- **Links are opaque:** every organic href is `/goto?url=CAES…` (signed protobuf). Real URLs are also
  embedded in page JS data, but parsing that is brittle.
- **Resolution:** `GET https://www.google.com/goto?url=…` through the browser context with
  `maxRedirects: 0` returned `302` + `Location: <real url>` for 3 of 4 tested links; one returned `200`
  with no redirect (handle as unresolved).
- **AI Mode ("Режим ИИ"):** the tab href is
  `/search?q=…&sca_esv=…&hl=ru&sxsrf=…`. Clicking it produced a chat-style answer
  (`Ответ в режиме ИИ`, ~4 841 chars) with the same source domains. Slower and longer than AI Overview;
  not needed for MVP.
- **Sizes:** raw visible text 5 780 chars → compact (8 results + AI capped 1 200) 3 024 chars (1.9×).
  With `n=5` the output is ~2.2–2.4k chars.
- **Timing:** ~5.5 s for navigation + 3.8 s settle + extraction + 4 `/goto` resolutions.

Failure mode seen: `/sorry` (reCAPTCHA) after a burst from a Playwright-launched browser.

---

## 3. Yandex

Query: `стоит ли покупать электромобиль в россии`, `yandex.ru/search/?text=…`.

- **SmartCaptcha** on first navigation in a fresh session (`/showcaptcha`, body "Я не робот",
  "Нам очень жаль, но запросы с вашего устройства похожи на автоматические"). The page advertises
  **Yandex Search API v2** as the sanctioned path.
- Retry after ~3 s on the same profile → normal SERP. Confirmed twice.
- **Layout (2026-11):** no `li.serp-item`; `serp-item` count = 0. Use:
  - `.OrganicTitle` (anchor inside or nearest anchor) → title + href;
  - `.OrganicTextContentSpan` → snippet;
  - 9 `h3` on a normal page.
- **AI summary:** `h3` text `Быстрый ответ Алисы AI`, inside `Futuris*` classes
  (`FuturisGPTMessage`, `FuturisContentSection`, `FactFold`). The `FactFold` container was
  `height: 205px` (collapsed) with a "Показать полностью" control. Content included headings, bullets
  and source domains (`banki.ru`, `dzen.ru`, `sbersova.ru`, …), ~3 876 chars raw.
- `data-fast-name="neuro_answer"` appeared in one capture, **not** in another for the same query type.
  It is a bonus signal, not a contract.
- **"Алиса AI" tab** exists in the header; href `//yandex.ru/alice?reqid=…&alice_dee…`. Not explored.
- **Sizes:** raw visible text 11 674 chars → compact (8 results + AI capped 1 200) 1 590 chars (7.3×).
- **Timing:** ~5.8 s including the captcha retry path (successful retry was ~3 s + 5.5 s settle).

---

## 4. DuckDuckGo

Query: `how does a solar panel work`, `duckduckgo.com/?q=…`.

- **Search Assist:** present for this English query. The answer text sits between the second `Search
  Assist` occurrence and `Ответ составлен автоматически` (RU UI) / `Answer generated automatically`
  (EN). Sources appear as domain names before the disclaimer.
- The assist block is **A/B**: a later load of the same query family showed only the "Search Assist"
  header and no answer. Treat `ai:no` as normal.
- **Results:** `a[data-testid="result-title-a"]` (real anchor with `href`), snippet
  `[data-result="snippet"]`, container `closest('article')`. 10 results, 19 `h3` including sub-links.
- **Sizes:** raw visible text ~7 201 chars → compact ~1 700 chars (4.2×).
- **HTTP endpoint is flaky:** `POST https://html.duckduckgo.com/html/` with browser-ish headers once
  returned 10 `result__a` links, later `ddgs` reported "No results found". Browser path is reliable;
  HTTP is not.
- **Timing:** ~4–6 s cold.

---

## 5. Keyless HTTP tricks (results only, no AI summary)

From `ddgs` 9.16.1 source (MIT), tested via `uv run --with ddgs`:

```python
DDGS().text("что такое трансформер", backend="yandex", max_results=3)   # 3 results
DDGS().text("что такое трансформер", backend="google", max_results=3)   # 3 results
DDGS().text("…", backend="duckduckgo", max_results=3)                   # ERR: No results
```

How they work:
- **Google:** `GET https://www.google.com/wml/search` with a 2007-era Nokia UA
  (`NokiaN72/<fw> Series60/2.8 Profile/MIDP-2.0 Configuration/CLDC-1.1`, optionally
  `/UC Browser7.9.1.12x/27/351/UCWEB`), cookie `CONSENT=YES+`, params
  `q, sca_esv=1, filter, start, hl, lr, cr`; parse the WML/mobile HTML, links `/url?q=`.
- **Yandex:** `GET https://yandex.com/search/site/?text=…&web=1&searchid=<random 7 digits>&p=<n-1>`;
  parse `//li[contains(@class,'serp-item')]` + `h3 a` + `.text`.
- **DDG:** `POST https://html.duckduckgo.com/html/` — unreliable from this IP.

A direct Node `fetch` with the same Nokia UA/cookie returned **403** for the Google WML endpoint, while
`ddgs` (Python/TLS stack) got results. So the Google trick is TLS/header-fingerprint-sensitive; do not
count on it from Node. Yandex `search/site` worked from plain Node `fetch` (200, ~39–42 KB, 5 items).

Use only as a degraded fallback when the browser is unavailable. No AI summary, no `/goto` resolution.

---

## 6. Token and tool-surface measurements

| Package | Tools | Description chars (approx.) | Notes |
|---|---|---|---|
| `pi-browser-harness` | 44 | 12 832 (≈3.2k tokens) | browser control, not search |
| `pi-camoufox-gateway` | 2 | 1 976 (≈500 tokens) | closest search infrastructure |
| `pi-web-access` | 4–6 | 2 157 + long guidance | provider sprawl |
| `pi-web-search` (provider-native) | 2 | 520 | tiny surface |
| **target for this project** | **1 direct + deferred** | **≤900** | ≈230 tokens |

Raw-vs-compact character counts are in §2–§4. Token estimate for Russian: ~2.5 chars/token.

---

## 7. Prior-art facts worth remembering

- `pi-web-access` has a keyless DuckDuckGo parser (`duckduckgo.ts`) and a `degoog.ts`, but **no Yandex**
  and no engine-native AI summaries (`grep -ri yandex` → nothing).
- `pi-camoufox-gateway` already documents the Google `/goto` problem and resolves it by opening a tab per
  URL (expensive). Our HTTP `302` trick is cheaper.
- `omkarcloud/google-scraper` (MIT, Python/Camoufox) returns `ai_overview: { is_available, text, sources }`
  — a good schema reference. It requires a local Python API and Camoufox.
- `ddgs` (MIT) is the source of the Google WML / Yandex site-search tricks.
- `pi-browser-harness` reads `DevToolsActivePort` from profile dirs and probes `/json/version`; it notes
  that `/json/version` may be disabled when debugging is enabled via `chrome://inspect`.

---

## 8. Caveats

- One IP, one day, few runs. Google/Yandex behaviour is A/B and reputation-dependent.
- The AI Overview/Neuro/Search Assist presence is query- and experiment-dependent; `ai:no` is normal.
- Selectors are obfuscated and will drift; the text markers are more stable than class names.
- The user's profile was copied for some probes; cookies did not survive. Do not build on profile copies.
