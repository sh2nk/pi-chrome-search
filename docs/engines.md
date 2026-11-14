# Engines and browser markers

Selector knowledge that cost live probes: every selector below is asserted against a sanitized fixture in
`tests/unit/<adapter>.test.ts`; a change ships a new fixture and updates this page (S13.4).

## Fixtures
| Fixture | Adapter | What it proves |
|---|---|---|
| `tests/fixtures/google-ai.html.gz` + `tests/fixtures/google-facts.html.gz` + `tests/fixtures/google-wall.html.gz` | Google | organics, `/goto` wrappers, AI Overview answer, ads, canaries; the pricing row (`От 4 057,00 ₽` + rating `aria-label`) as facts, absent on article results; `/sorry` wall classification |
| `tests/fixtures/ddg-assist.html.gz` + `tests/fixtures/ddg-no-assist.html.gz` | DuckDuckGo | organics, Search Assist answer and ads; the no-assist page (toggle-only `lead`) |
| `tests/fixtures/yandex-neuro.html.gz` + `tests/fixtures/yandex-rating.html.gz` + `tests/fixtures/yandex-captcha.html.gz` | Yandex | organics, Futuris AI answer, jsredir ads, tracking params; the 2026 card (`OrganicTextContent` snippet, shop rating label); SmartCaptcha wall |
| `tests/fixtures/images-google.html.gz` + `tests/fixtures/images-yandex.html.gz` | Google/Yandex Images | tiles, `data-lpage` page URLs, `encrypted-tbn` thumbs; `.SerpItem` tiles and `img_url` image URLs |
| `tests/fixtures/avito-serp.html.gz` + `tests/fixtures/avito-no-match.html.gz` | Avito | 50 listings: `data-marker` contract, price/location/date facts, tracking stripped, canaries; the no-match fallback (`notice`: quoted title + "Похожие объявления рядом…", trimmed to 4 cards) |
| `tests/fixtures/avito-wall.html.gz` | Avito | IP firewall markup (supplied out of band: URL is not evidence): `<title>Доступ ограничен`, hCaptcha, zero cards → `E_WALL` |
| `tests/fixtures/ozon-serp.html.gz` + `tests/fixtures/ozon-no-match.html.gz` | Ozon | results area of a 16-tile SERP: `.tile-root`, title/price/score-count facts, `at=` stripped, canaries; the zero-match page (`headline` → `notice`) with 40 recommendation tiles |

## Discovery

1. `PI_CHROME_CDP_WS` → 2. `PI_CHROME_CDP_PORTS` (comma list, each probed via `127.0.0.1:<port>/json/version`)
→ 3. `DevToolsActivePort` in the profile dirs (`runtime/host.ts` holds the platform tables: Chrome and its
channels, Chromium, Brave, Edge; line 1 = port, line 2 = browser path) → 4. configured `cdp.ports` (default
`[9222]`) → 5. nothing, which is `E_CDP_UNAVAILABLE` plus the Allow hint.

Chrome 136+ needs the one-time `chrome://inspect/#remote-debugging` → **Discover network targets** →
**Allow**; `/json/version` may stay disabled and the file above is authoritative. Until the human clicks, a
hung socket waits `cdp.attachWaitMs` (60 s), notifies once and reports `E_CDP_AWAITING_ALLOW` (retryable).

## Readiness and interaction

- `settle()` waits for a **DOM marker** with a deadline (Google/DuckDuckGo 8 s, Yandex 10 s, both marketplaces
  12 s) and jitter — `Page.loadEventFired` never arrives on a real SERP. Navigation commits on `Page.frameNavigated`
  with a new `loaderId`, then accepts `readyState: interactive` after 200 ms.
- `humanize: "auto"` types the first search of a session per engine, then uses the pinned SERP URL;
  `"always"` types every time; `"typing"` uses each `typeProfile` (20–80 ms/char, no fingerprint work).
  Warm-ups: Yandex `https://ya.ru/` (`yandex.ru` redirects to Dzen), Avito the configured `/<location>/`,
  Ozon `https://www.ozon.ru/` with `input[name="text"]` (`maxlength=255`); a landing outside `homeHosts` is
  `home-redirect`, served from the SERP URL.
- DuckDuckGo's home page has no usable input, so its typed path starts on the SERP (`typeOn: "serp"`): clear the
  prefilled box with Backspace, retype, Enter. The box value is read back; a value that is not the query (second
  writer) is never submitted and the search falls back to the SERP URL as `box-mismatch`. A wall is `E_WALL` at
  once (D5): window surfaced, one artifact, no re-navigation.

## Selectors

**Google** (`google-ai`, `google-wall`): ready `#rso, #search`; organics `a h3`; container `[data-hveid]`;
snippet `.VwiC3b, [data-sncf]`; AI `section` containing `Обзор от ИИ` / `AI Overview`; ads `data-text-ad`,
badges `Реклама` / `Sponsored`; walls `/sorry`, `#captcha-form`, `#recaptcha`, `.g-recaptcha`,
`form[action*="consent.google.com"]`, `consent.youtube.com`. A wall phrase needs a captcha/consent node or a
wall URL: text alone never wins.

**DuckDuckGo** (`ddg-assist`, `ddg-no-assist`): ready text `DuckDuckGo` **and** ≥1
`a[data-testid="result-title-a"]`; organics `article[data-testid="result"]`; snippets `[data-result="snippet"]`;
Search Assist `[data-testid="duckassist-answer-content"]`; ads `duckduckgo.com/y.js`, `[data-result="ad"]`; walls
`anomaly`, `Unfortunately, bots use DuckDuckGo too`, `Please complete the following challenge` (`unusual
traffic` only with zero results).

**Images** (`images-google`, `images-yandex`, via `tests/unit/image_search.test.ts`): Google tiles
`[data-attrid="images universal"]` with `data-lpage` (the source page); Yandex tiles `.SerpItem` with
`.SerpItem-Thumb` and `a.ImagesContentImage-Cover` (`img_url` is the source image). Ads `[data-text-ad]`/
`[data-ad]` and the `реклама`/`промо` labels are dropped; a `data:` thumb is a lazy placeholder, never a
reportable URL. Yandex 2026 has no `.serp-item`: a non-zero `legacySerpItem` canary means the layout rolled
back. `image_search` returns Yandex's source **image** URL; Google tiles disclose the host page.


**Avito** (`avito-serp`, `avito-no-match`; *special* engine, D11/D12): ready
`[data-marker="item"], [data-marker="page-title"]` (the home page has neither, so the typed warm-up cannot
settle on it); card `[data-marker="item"]` (50 per page); title `a[data-marker="item-title"]`; price
`item-price-value` (fallback `meta[itemprop="price"]`); snippet `item-specific-params`; paging
`pagination-button/page(N)` with `?p=N`. `context`, `cd`, `slocation` are ranking state and are stripped
(S7.4); `Продвинуто` is a paid boost of the same listing: neither `isAd` nor a fact. Walls (`avito-wall`): the
firewall names itself in `<title>`, not the body; a captcha widget (`#h-captcha`, `.h-captcha`,
`.form-captcha*`) is a wall on its own and sits *in* the gate, so a phrase needs zero cards and the wall
reports at once. `/captcha`/`/blocked` stay defensive: the fixture is pasted markup, so its URL proves
nothing. A no-match query says `note: no exact match: …` (S7.6).

**Ozon** (`ozon-serp`, `ozon-no-match`; *special* engine, D11/D14): ready `[data-widget="searchResultsSort"]` and
`[data-widget="statusWidget"]` (plus `searchResultsV2`, the `/search/` list, anticipated but never observed),
never a bare `.tile-root` — the home page renders 20 cards of its own (measured), so the gate is the results chrome. Card `.tile-root`; title
`span.tsBody500Medium` (the product link is the anchor wrapping it); price `span.tsHeadline500Medium`; score and
review count are the two `span.tsBodyControl300XSmall` leaves, told apart by *shape* (a bare number is the
score, the other leaf is copied whole); no snippet, because a tile has no description. Every query parameter on a `/product/` link (`at`, `avtc`, …) is attribution state and is
stripped (S7.4). `?text=` is answered either by the grid or by a semantic redirect to a predicted
`/category/…` page; the cards are the same, so the landed URL is not a failed search. A zero-match query says
`note: no exact match: …`; its headline is reported and the *words* are never matched in code. **No wall
fixture exists**: reaching Ozon's block page means provoking the firewall, so `detectOzonWall`'s markers
(`/captcha`, `/blocked`, `Доступ ограничен`, a captcha widget) are defensive and are tested on synthetic
markup, never claimed as captured. The widget sits *in* the gate, so a wall reports at once.

**Yandex** (`yandex-neuro`, `yandex-rating`, `yandex-captcha`): ready `.OrganicTitle, .Misspell, .SmartCaptcha`;
organics `.OrganicTitle`; snippet `.OrganicTextContentSpan, .OrganicTextContent` (the second is the 2026
layout: the first alone returned empty snippets on a live SERP); AI `[class*='Futuris']` (`FuturisSearch`,
`FuturisContentSection`, `FactFold`); titles `h3`, `.Misspell`; ads `yandex.ru/clck/jsredir`, badges `промо` /
`реклама` / `sponsored`; walls `/showcaptcha`, `.SmartCaptcha`, `Я не робот`, `Подтвердите, что запросы
отправляли вы`.

## Paging and links

- Google: `&start=10*(page-1)`. Yandex: `&p=page-1`. Avito: `&p=page`, Ozon: `&page=page` (both 1-based and
  verified live: a page-2 navigation returned a different product set). DuckDuckGo has no pagination:
  `page > 1` is served as page 1 and reported as `ignored.page` (S4.2).
- Avito's region is a path segment (`/all`, `/moskva`, `/kaluga`): `engines.avito.location` holds that slug
  (`all` = every region, `rossiya` redirects to it); a non-slug degrades to `all`, not a 404.
- Google organics are `/goto?url=<signed protobuf>` wrappers: a cookie-carrying GET, `redirect: "manual"`, three
  at a time under one 8 s deadline (S8.3); an unresolved wrapper keeps its URL and is marked `unresolved`.

## Card facts (D13)

Price/availability/rating/location shown outside the snippet go into `SerpItem.facts` (rendered after the
snippet; whole facts dropped past 120 chars), copied from the page and never composed, so a fact cannot claim
more than the SERP did. Nodes: Avito `item-price-value`/`-location`/`-date`; Ozon `tsHeadline500Medium` (price)
plus the score leaf and the count leaf, verbatim; Google a leaf that is *only* a price — any recognised
currency, at most a four-letter prefix — plus an `aria-label` shaped `<score> … 5` or `5 … <score>`
(`google-facts`, one case per locale in the test); Yandex `.EReviewsLabel .A11yHidden` + `.EReviewsLabel-Reviews`,
a *shop* rating and its count. Article results carry none, and an unknown currency yields no fact.

## AI states (primary engines only; neither marketplace has an AI block)

`answer` (≥200 chars of real prose) · `lead` (block present, no answer) · `none` (no block). `compact.ts`
re-checks the 200-char floor, so a hand-built `RawSerp` cannot smuggle a short "answer"; no block ends the wait
after ~1.4 s and a visible expand runs only when `search.aiExpand` is true.
