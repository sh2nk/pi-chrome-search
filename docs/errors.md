# Errors

Generated from `src/runtime/error-codes.ts`; do not hand-edit. `node scripts/gen-errors-doc.mjs
--check` fails when this page drifts from the taxonomy.

Every failure is a `WebSearchError`: `code`, `stage`, `retryable`, `hint`, and, for page states, an
artifact directory. The hint is the action, shown to the agent and the user verbatim.

| Code | Retry | Action |
|---|---|---|
| `E_CONFIG` | no | fix the named key in web-search.json (or $PI_CODING_AGENT_DIR/web-search.json); unknown keys are rejected |
| `E_CDP_UNAVAILABLE` | no | open the browser's remote-debugging page (chrome://inspect/#remote-debugging for Chrome; edge://, brave:// or chromium:// for the other Chromium-family browsers), tick "Discover network targets" and click Allow, then retry; or set PI_CHROME_CDP_WS=ws://127.0.0.1:<port><path> |
| `E_CDP_DISCONNECTED` | yes | the CDP socket dropped; retry once — if it repeats, run /web-doctor and check the lock file |
| `E_TARGET_LOST` | yes | the owned tab was closed or navigated away; retry to reopen it |
| `E_WALL` | yes | solve the captcha/consent in the visible browser window, then retry — never automate it |
| `E_EMPTY` | yes | the engine returned no organic results; rephrase the query or try another engine |
| `E_EMPTY_PAGE` | no | the document rendered no readable text; the page may be client-side, so open the artifact and try another URL (or retry once if the page loads late) |
| `E_PARSE` | no | a selector canary failed; inspect the artifact directory, run /web-doctor, then patch the adapter |
| `E_TIMEOUT` | yes | the deadline was exceeded; retry, or ask for less (a smaller `n` or `maxChars`) |
| `E_BUSY` | yes | another pi session holds ~/.pi/agent/web-search.lock; close it or wait for its heartbeat to expire |
| `E_BLOCKED_URL` | no | use a public http(s) URL; localhost, private ranges, file: and data: are blocked |
| `E_UNSUPPORTED` | no | this engine or vertical is not implemented yet; check /web-doctor for per-engine status |
| `E_CANCELLED` | yes | the call was aborted; retry if it was not intentional |
| `E_NAVIGATION_MISMATCH` | yes | the tab changed document between navigation and extraction; retry once — reads are serialized, so a repeat means the page navigated itself |
| `E_OFFSET_RANGE` | no | offset is past the end of the rendered document; pass an offset below the reported totalChars (or 0 to start over) |
| `E_CDP_AWAITING_ALLOW` | yes | the browser is waiting for the DevTools Allow: open the remote-debugging page (chrome://inspect/#remote-debugging for Chrome; edge://, brave:// or chromium:// for the other Chromium-family browsers), tick "Discover network targets" and click Allow — the call resumes by itself |
| `E_PDF_SCANNED` | no | the PDF is a scan with no text layer; OCR is out of scope and silently inventing text is forbidden — open it in the browser or find an HTML/text version with the same content |
| `E_PDF_UNSUPPORTED` | no | the PDF could not be decoded; the in-tree extractor found no readable text and no installed pdftotext/mutool fallback succeeded — try the HTML version of the document or open the artifact |

`web_doctor` (or `/web-doctor`) is the first stop for CDP, lock, window and per-engine verdicts:
`node src/cli/doctor.ts --json` prints the same report headlessly. Artifacts:
`~/.pi/agent/web-search/artifacts/<ts>-<engine>-<hash>/` (`page.html`, `page.txt`, `screenshot.jpg`,
`meta.json`). Decisions: `~/.pi/agent/web-search/decisions.jsonl`.

Every code here has an offline test; `RESERVED_CODES` is empty and stays that way unless a future code
is deliberately reserved with a phase and a reason.
