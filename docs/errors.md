# Errors

Every failure is a `WebSearchError` (see `src/runtime/error-codes.ts`): `code`, `stage`, `retryable`,
`hint`, and for page states an artifact directory. The hint is the action — shown to the agent and the
user verbatim. `E_*` codes never mean "something failed"; they name what to do next.

| Code | Retry | Action |
|---|---|---|
| `E_CONFIG` | no | Fix the named key in `web-search.json`; unknown keys are rejected. |
| `E_CDP_UNAVAILABLE` | no | Chrome is not reachable: open `chrome://inspect/#remote-debugging`, tick **Discover network targets**, click **Allow**; or set `PI_CHROME_CDP_WS`. |
| `E_CDP_AWAITING_ALLOW` | yes | The Allow prompt is unanswered. Click it — the call resumes by itself (it waited `cdp.attachWaitMs`). |
| `E_CDP_DISCONNECTED` | yes | The socket dropped: retry once; if it repeats run `/web-doctor` and check the lock file. |
| `E_TARGET_LOST` | yes | The owned tab was closed or navigated away; retry reopens it. |
| `E_WALL` | yes | Captcha/consent: solve it in the visible window, then retry. Never automated. |
| `E_EMPTY` | yes | No organic results: rephrase the query or try another engine. |
| `E_PARSE` | no | A selector canary failed: open the artifact dir, compare `page.txt` with the markers in `docs/engines.md`, patch the adapter. |
| `E_EMPTY_PAGE` | no | The document rendered no readable text (client-side page, empty shell): open the artifact, try another URL; `E_PARSE` means a selector canary broke. |
| `E_TIMEOUT` | yes | Deadline exceeded; `stage: budget` means the whole call ran out of time. Retry, or ask for less (a smaller `n`, fewer engines, `summary:false`). |
| `E_BUSY` | yes | Another pi session holds `~/.pi/agent/web-search.lock`; close it or wait for the heartbeat to expire. |
| `E_BLOCKED_URL` | no | Only public `http(s)` is readable; loopback, private ranges, `file:` and `data:` are blocked (re-checked on redirect). |
| `E_UNSUPPORTED` | no | Engine/vertical not implemented; `/web-doctor` shows per-engine status. |
| `E_CANCELLED` | yes | The call was aborted; retry if unintended. |
| `E_NAVIGATION_MISMATCH` | yes | The tab changed document during a read. Retry once; a repeat means the page navigated itself. |
| `E_OFFSET_RANGE` | no | `offset` is past `totalChars`; pass a smaller offset or `0`. |
| `E_PDF_SCANNED` | no | The PDF is images only. OCR is out of scope: open it in the browser or find an HTML/text twin. |
| `E_PDF_UNSUPPORTED` | no | Neither the in-tree parser nor an installed `pdftotext`/`mutool` decoded it (encrypted/odd encoding): try the HTML version. |

`web_doctor` (or `/web-doctor`) is the first stop for CDP, lock, window and per-engine verdicts:
`node src/cli/doctor.ts --json` prints the same report headlessly. Artifacts:
`~/.pi/agent/web-search/artifacts/<ts>-<engine>-<hash>/` (`page.html`, `page.txt`, `screenshot.jpg`,
`meta.json`). Decisions: `~/.pi/agent/web-search/decisions.jsonl`.

Reserved codes (thrown by production code, dedicated offline test lands in the named phase):
`E_EMPTY_PAGE` (P5), `E_NAVIGATION_MISMATCH` (P5), `E_OFFSET_RANGE` (P5). `RESERVED_CODES` in
`src/runtime/error-codes.ts` carries the same list.
