# pi-chrome-search

[![npm](https://img.shields.io/npm/v/pi-chrome-search)](https://www.npmjs.com/package/pi-chrome-search)
[![pi](https://img.shields.io/badge/pi-package-6f42c1)](https://pi.dev/packages)
[![ci](https://github.com/sh2nk/pi-chrome-search/actions/workflows/ci.yml/badge.svg)](https://github.com/sh2nk/pi-chrome-search/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-chrome-search)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D26-brightgreen)](package.json)

Web search and page reading for [pi](https://pi.dev), through your own visible Chrome. Same profile,
cookies and IP. Google, DuckDuckGo and Yandex return compact Markdown and their native AI summary when
there is one. No keys, no paid APIs, no headless mode, no fingerprint spoofing. Node 26+, Chrome 136+.

## Install

```bash
pi install npm:pi-chrome-search
```

Chrome 136+ enables debugging only after an explicit click:

1. Open `chrome://inspect/#remote-debugging`.
2. Tick **Discover network targets**, then click **Allow**.

The window stays visible. The extension attaches to it and never launches, restarts or closes Chrome.

## Tools

`web_search` and `web_read` are direct. The other three sit behind `tool_search`.

<!-- tools:start -->
| Tool | Exposure | Arguments |
|---|---|---|
| `web_search` | direct | `q` string; `n?` integer 1..10; `engines?` "auto" or ("google" or "duckduckgo" or "yandex") or list of ("google" or "duckduckgo" or "yandex") 1..3; `summary?` boolean; `page?` integer >=1; `format?` "md" or "json" |
| `web_read` | direct | `url` string; `offset?` integer >=0; `maxChars?` integer >=1; `format?` "md" or "text" |
| `image_search` | deferred | `q` string; `n?` integer 1..12; `engine?` "google" or "yandex"; `attach?` boolean or "bytes" |
| `web_research` | deferred | `q` string; `budget?` "quick" or "normal" or "deep" |
| `web_doctor` | deferred | `probe?` boolean; `fix?` boolean |
<!-- tools:end -->

A call has one 60 second deadline. DuckDuckGo has no pagination: `page > 1` is reported as
`ignored.page`. Every unresolved link stays marked `unresolved`.

## Limits

No headless browsing, automation profile, captcha solving, proxy rotation, cookie export, telemetry or
paid search API. Google and Yandex forbid automated access in their terms. If a captcha appears, solve it
in the window or stop.

## Failures

Every failure is an `E_*` code with a stage, a retry flag and a hint you can act on. The full table is in
[errors.md](https://github.com/sh2nk/pi-chrome-search/blob/main/docs/errors.md). Start with
`/web-doctor` or `node src/cli/doctor.ts --json`.

Config reference: [config.md](https://github.com/sh2nk/pi-chrome-search/blob/main/docs/config.md).

MIT.
