# Engines and browser markers

Selector knowledge that cost live probes. Every marker below is asserted against a sanitized fixture
in `tests/unit/engines.test.ts`; a selector change must ship a new fixture and update this page.

## Discovery (in order)

1. `PI_CHROME_CDP_WS` — full `ws://…` URL (escape hatch).
2. `PI_CHROME_CDP_PORTS` — comma list, each probed via `127.0.0.1:<port>/json/version`.
3. `DevToolsActivePort` in the profile dirs (`~/.config/google-chrome`, `-beta`, `-unstable`,
   `chromium`, `chromium-browser`, `BraveSoftware/Brave-Browser`, `microsoft-edge`; Windows/macOS
   paths via `runtime/host.ts`). Line 1 = port, line 2 = browser path.
4. Configured `cdp.ports` (default `[9222]`).
5. Nothing → `E_CDP_UNAVAILABLE` with the browser-brand-aware Allow hint.

Chrome 136+ ignores `--remote-debugging-port` for the default profile. Enable it once per Chrome
session: open `chrome://inspect/#remote-debugging`, tick **Discover network targets**, click **Allow**.
`/json/version` may stay disabled in that mode — the `DevToolsActivePort` file is authoritative.

The DevTools WebSocket handshake completes only after the user clicks Allow. Until then the socket
hangs, which is not a dead browser: the connector waits `cdp.attachWaitMs` (60 s), notifies the
desktop once, and reports `E_CDP_AWAITING_ALLOW` (retryable) when the wait expires. `ECONNREFUSED` /
`ENOTFOUND` fail immediately — nothing is listening, so waiting would be a lie.

## Readiness and interaction

- `settle()` waits for a **DOM marker** with a deadline (8 s) and jitter; `Page.loadEventFired` never
  arrives on a real SERP (consent hops + trackers keep loading).
- Navigation commits on `Page.frameNavigated` with a `loaderId` different from the pre-navigate one,
  then accepts `readyState: interactive` after a 200 ms grace.
- `humanize: "auto"` types the first search of a session per engine and uses the pinned SERP URL
  afterwards; `"always"` types every time; `"typing"` uses each engine's `typeProfile`. Typing keys
  at 20–80 ms/char and never touches the fingerprint.
- Yandex warm-up is `https://ya.ru/`: `yandex.ru` redirects to Dzen. A landing on a host outside
  `homeHosts: ["ya.ru","yandex.ru"]` is reported as `home-redirect` and served from the SERP URL.

## Google

- URL: `https://www.google.com/search?q=<enc>[&hl=][&gl=][&start=10*(page-1)][&tbs=qdr:d|w|m|y]`.
- Ready marker: `#rso, #search` (language-neutral, present on a zero-result SERP, absent on the home
  page) or a wall container. No text marker: `body.innerText` on a SERP does not contain "Google".
- Canaries: `a h3` (organics), `[data-hveid]` container, `.VwiC3b, [data-sncf]` snippet, the AI label.
- AI Overview: a `section` whose visible text contains `Обзор от ИИ` / `AI Overview`; strip the label
  and any `Ответ в режиме ИИ, исходный запрос: "…"` lead; prose `< 200` chars (`AI_ANSWER_MIN_CHARS`)
  is `lead`, not `answer`.
- Ads: `data-text-ad`, badges `Реклама` / `Sponsored`.
- **Links are opaque**: organic hrefs are `/goto?url=<signed protobuf>`. `extract/goto.ts` resolves
  them with a cookie-carrying `GET` and `redirect: "manual"`, reads `Location`; a `200` with no
  redirect is "unresolved" and the wrapper is kept rather than a fabricated destination.
- Walls: `/sorry`, `#captcha-form`, `#recaptcha`, `.g-recaptcha`, `form[action*="consent.google.com"]`,
  hosts `consent.google.com` / `consent.youtube.com`, phrases `unusual traffic` /
  `подозрительный трафик`, `Я не робот` / `I'm not a robot`. Text alone never wins: it needs a
  captcha/consent node or a wall URL, else a snippet *about* robots becomes a false `E_WALL`.

## DuckDuckGo

- URL: `https://duckduckgo.com/?q=<enc>[&kl=<region-lang>][&s=<offset>][&df=d|w|m|y]`.
- Ready marker: text `DuckDuckGo` **and** ≥1 `a[data-testid="result-title-a"]`; brand word alone also
  exists on the home page, so the pair is the gate.
- Canaries: `resultTitles`, `snippets` (`[data-result="snippet"]`), `articles`
  (`article[data-testid="result"]`), `assistBlocks` (`[data-testid="duckassist-answer-content"]`).
- Search Assist: answer text after the second `Search Assist` occurrence and before
  `Ответ составлен автоматически` / `Answer generated automatically`; sources are the domains just
  before the disclaimer. The block is A/B — `ai:no` is a normal outcome.
- Ads: `duckduckgo.com/y.js`, `[data-result="ad"]`.
- Home page has **no usable search input** (an `aria-hidden` AI-drawer trap plus hidden metadata),
  so the typed path starts on the SERP (`typeOn: "serp"`): clear the prefilled box with Backspace,
  retype, Enter.
- Walls: `anomaly` path, `Unfortunately, bots use DuckDuckGo too`,
  `Please complete the following challenge`; the weak `unusual traffic` only counts with zero result
  anchors.

## Yandex

- URL: `https://yandex.ru/search/?text=<enc>[&p=page-1][&lr=<region>]`; warm-up `https://ya.ru/`.
- Ready marker: `.OrganicTitle, .Misspell, .SmartCaptcha` — the layout changed in 2026: no
  `li.serp-item`, nine `h3` on a normal page.
- Canaries: `.OrganicTitle`, `.OrganicTextContentSpan`, `[class*='Futuris']`, `.FuturisSearch`, `h3`,
  `.Misspell`.
- AI summary: `h3` matching `/Быстрый ответ|Нейро|Алиса AI/` inside `Futuris*`
  (`FuturisGPTMessage`, `FuturisContentSection`, `FactFold`). `FactFold` is height-clamped
  (205 px): click `Показать полностью` once (only with `search.aiExpand`) and read `innerText`; strip
  `Содержимое ответа` and standalone source-domain lines. `data-fast-name="neuro_answer"` is a bonus
  signal, never the contract.
- Ads: `yandex.ru/clck/jsredir`, badges `промо` / `реклама` / `sponsored`.
- Walls: `/showcaptcha`, `.SmartCaptcha`, `Я не робот`, `Нам очень жаль, но запросы…`. Expect it;
  the tool may retry **once** after ~3 s on the same profile (`retryOnWall`), the user solves the
  rest. `E_WALL` surfaces the window and does not hand focus back.
- `image_search` on Yandex returns the source **image** URL (`pageUrlKind: "image"`), not the host
  page; Google tiles disclose the page (`"page"`).

## AI states (all engines)

`answer` (≥200 chars of real prose) · `lead` (block present, no answer: affordance, prompt, query
echo, or a fragment) · `none` (no block). `extract/compact.ts` re-checks the 200-char floor, so a
hand-built `RawSerp` cannot smuggle a short "answer". A wait that sees no block ends after a ~1.4 s
grace instead of burning `search.aiWaitMs`; an AI timeout leaves an artifact.
