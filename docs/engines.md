# Engines and browser markers

Selector knowledge that cost live probes. Every selector below is asserted against a sanitized fixture
in `tests/unit/<adapter>.test.ts` (`google`, `duckduckgo`, `yandex`, `avito`, `image_search`). A selector
change ships a new fixture and updates this page (S13.4).

## Fixtures
| Fixture | Adapter | What it proves |
|---|---|---|
| `tests/fixtures/google-ai.html.gz` | Google | organics, `/goto` wrappers, AI Overview answer, ads, canaries |
| `tests/fixtures/google-wall.html.gz` | Google | `/sorry` captcha wall classification |
| `tests/fixtures/ddg-assist.html.gz` | DuckDuckGo | organics, Search Assist answer, ads |
| `tests/fixtures/ddg-no-assist.html.gz` | DuckDuckGo | no assist block, toggle-only `lead` |
| `tests/fixtures/yandex-neuro.html.gz` | Yandex | organics, Futuris AI answer, jsredir ads, tracking params |
| `tests/fixtures/yandex-captcha.html.gz` | Yandex | SmartCaptcha wall classification |
| `tests/fixtures/images-google.html.gz` | Google Images | tiles, `data-lpage` page URLs, `encrypted-tbn` thumbs |
| `tests/fixtures/images-yandex.html.gz` | Yandex Images | `.SerpItem` tiles, `img_url` image URLs |
| `tests/fixtures/avito-serp.html.gz` + `tests/fixtures/avito-no-match.html.gz` | Avito | 50 listings: `data-marker` contract, price/location/date facts, tracking stripped, canaries; the no-match fallback (`notice`: quoted title + "Похожие объявления рядом…", trimmed to 4 cards) |

## Discovery

1. `PI_CHROME_CDP_WS` — full `ws://…` URL (escape hatch).
2. `PI_CHROME_CDP_PORTS` — comma list, each probed via `127.0.0.1:<port>/json/version`.
3. `DevToolsActivePort` in the profile dirs (`~/.config/google-chrome`, `-beta`, `-unstable`,
   `chromium`, `chromium-browser`, `BraveSoftware/Brave-Browser`, `microsoft-edge`; Windows/macOS
   paths via `runtime/host.ts`). Line 1 = port, line 2 = browser path.
4. Configured `cdp.ports` (default `[9222]`).
5. Nothing → `E_CDP_UNAVAILABLE` with the browser-brand-aware Allow hint.

Chrome 136+ ignores `--remote-debugging-port` for the default profile. Enable it once per Chrome
session: `chrome://inspect/#remote-debugging` → **Discover network targets** → **Allow**.
`/json/version` may stay disabled then — the `DevToolsActivePort` file is authoritative.

The DevTools handshake completes only after the user clicks Allow. Until then the socket hangs, which
is not a dead browser: the session waits `cdp.attachWaitMs` (60 s), notifies the desktop once, and
reports `E_CDP_AWAITING_ALLOW` (retryable). `ECONNREFUSED`/`ENOTFOUND` fail at once.

## Readiness and interaction

- `settle()` waits for a **DOM marker** with a deadline (Google/DuckDuckGo 8 s, Yandex 10 s) and
  jitter; `Page.loadEventFired` never arrives on a real SERP (consent hops + trackers keep loading).
- Navigation commits on `Page.frameNavigated` with a `loaderId` different from the pre-navigate one,
  then accepts `readyState: interactive` after a 200 ms grace.
- `humanize: "auto"` types the first search of a session per engine and uses the pinned SERP URL
  afterwards; `"always"` types every time; `"typing"` uses each engine's `typeProfile`. Typing keys
  at 20–80 ms/char and never touches the fingerprint.
- Yandex warm-up is `https://ya.ru/`: `yandex.ru` redirects to Dzen. A landing on a host outside
  `homeHosts: ["ya.ru","yandex.ru"]` is reported as `home-redirect` and served from the SERP URL.
- DuckDuckGo's home page has no usable search input, so its typed path starts on the SERP
  (`typeOn: "serp"`): clear the prefilled box with Backspace, retype, Enter.
- The box value is read back after typing. A value that is not the query (a second writer, a lost
  focus) is never submitted: Enter stays un-pressed and the search falls back to the SERP URL as
  `box-mismatch`.

## Selectors

**Google** (`google-ai`, `google-wall`): ready `#rso, #search`; organics `a h3`; container
`[data-hveid]`; snippet `.VwiC3b, [data-sncf]`; AI `section` containing `Обзор от ИИ` / `AI Overview`;
ads `data-text-ad`, badges `Реклама` / `Sponsored`; walls `/sorry`, `#captcha-form`, `#recaptcha`,
`.g-recaptcha`, `form[action*="consent.google.com"]`, `consent.google.com`, `consent.youtube.com`.
Text alone never wins: a wall phrase needs a captcha/consent node or a wall URL.

**DuckDuckGo** (`ddg-assist`, `ddg-no-assist`): ready text `DuckDuckGo` **and** ≥1
`a[data-testid="result-title-a"]`; organics `article[data-testid="result"]`; snippets
`[data-result="snippet"]`; Search Assist `[data-testid="duckassist-answer-content"]`; ads
`duckduckgo.com/y.js`, `[data-result="ad"]`; walls `anomaly` path, `Unfortunately, bots use DuckDuckGo
too`, `Please complete the following challenge` (weak `unusual traffic` only with zero results).

**Images** (`images-google`, `images-yandex`, loaded by `tests/unit/image_search.test.ts`):
Google tiles `[data-attrid="images universal"]` with `data-lpage` (the source page); Yandex tiles
`.SerpItem` with `.SerpItem-Thumb` and `a.ImagesContentImage-Cover` (`img_url` is the source image).
Ads `[data-text-ad]`/`[data-ad]` and the `реклама`/`промо` labels are dropped; a `data:` thumb is a
lazy placeholder, never a reportable URL. Yandex 2026 has no `.serp-item`, so a non-zero
`legacySerpItem` canary means the layout rolled back.

**Avito** (`avito-serp`, `avito-no-match`; *special* engine, D11/D12): ready
`[data-marker="item"], [data-marker="page-title"]` (the home page has neither, so the typed warm-up
cannot settle on it); card `[data-marker="item"]` (50 per page, server-rendered); title
`a[data-marker="item-title"]`; price `item-price-value` (fallback `meta[itemprop="price"]`); snippet
`item-specific-params`; facts `item-location` + `item-date` (leading text only: the seller link follows
it); paging `pagination-button/page(N)` with `?p=N`. `context`, `cd`, `slocation` are ranking state and
are stripped (S7.4). `Продвинуто` is a paid boost of the same listing: neither `isAd` nor a fact.
Walls: `/captcha`, `/blocked`, `Доступ ограничен`, `Подтвердите, что вы не робот`, a captcha
widget/iframe — a phrase alone never wins (needs zero cards). A no-match query returns *similar*
listings and is reported as `note: no exact match: …` (S7.6).

**Yandex** (`yandex-neuro`, `yandex-captcha`): ready `.OrganicTitle, .Misspell, .SmartCaptcha`;
organics `.OrganicTitle`; snippet `.OrganicTextContentSpan`; AI `[class*='Futuris']` (`FuturisSearch`,
`FuturisContentSection`, `FactFold`); titles `h3`, `.Misspell`; ads `yandex.ru/clck/jsredir`, badges
`промо` / `реклама` / `sponsored`; walls `/showcaptcha`, `.SmartCaptcha`, `Я не робот`,
`Подтвердите, что запросы отправляли вы`.

## Paging and links

- Google: `&start=10*(page-1)`. Yandex: `&p=page-1`. Avito: `&p=page` (1-based, verified live).
  DuckDuckGo has no pagination: `page > 1` is served as page 1 and reported as `ignored.page` (S4.2).
- Avito's region is a path segment (`/all`, `/moskva`, `/kaluga`): `engines.avito.location` holds that
  slug (`all` = every region, `rossiya` redirects to it); a non-slug degrades to `all`, not a 404.
- Google organics are `/goto?url=<signed protobuf>` wrappers: a cookie-carrying GET with
  `redirect: "manual"`, three at a time under one 8 s batch deadline (S8.3). An unresolved wrapper
  keeps its URL and is marked `unresolved` (S7.4).
- `image_search` on Yandex returns the source **image** URL; Google tiles disclose the host page.

## Card facts (D13)

Price/availability/rating/location shown outside the snippet (Google's `103 500,00 ₽ · В наличии ·
5,0 ★`, every Avito card) go into `SerpItem.facts`, rendered after the snippet, whole facts dropped
past 120 chars. Only Avito has a fixture for it so far.

## AI states (all engines, except Avito)

`answer` (≥200 chars of real prose) · `lead` (block present, no answer) · `none` (no block).
`compact.ts` re-checks the 200-char floor, so a hand-built `RawSerp` cannot smuggle a short "answer".
No block ends the wait after ~1.4 s instead of burning `search.aiWaitMs`; a visible expand runs only
when `search.aiExpand` is true.

## Walls

`E_WALL` at once: window surfaced, one artifact, no automatic re-navigation, no wait-for-human timer
(SPEC D5). The human solves it and retries.
