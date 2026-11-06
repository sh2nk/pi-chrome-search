# P10-spike — S1: can the anchor be a local control panel?

Date: 2026-11-06
Owner: orchestrator
Verdict: **PASS** — `file://` target creation, painting and `data:` behaviour measured on the installed
Chrome 157 through the single CDP connection (`research/probes/07-cdp-broker.mjs`).

Plan: `PLAN-v2.md` §3 (S1) and §4 P10-A. The question was whether the bootstrap tab can stop being
`about:blank` and carry a local panel without disturbing engine tabs, and whether a `data:` URL is a
usable fallback.

## Method

One throwaway script (`/tmp/p10-spike.ts`, not committed — probes are evidence, not code) that creates
three targets in the owned window, paints/reads each, and closes exactly the targets it created. It ran
against `PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker`, i.e. through the broker, so no
second Allow prompt was needed.

```bash
node research/probes/07-cdp-broker.mjs --idle-min 120
PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker node /tmp/p10-spike.ts
```

## Findings (raw, one line per case)

```
{"case":"file-createTarget","titleA":"p10-anchor","hrefA":"file:///tmp/p10-spike-MVswdA/anchor.html","readyA":true,"paintA":"painted","textA":"hello-file"}
{"case":"blank-then-navigate","titleB":"p10-anchor","paintB":"painted","textB":"hello-nav"}
{"case":"data-url","created":true,"title":"d","text":"hi"}
```

1. **`Target.createTarget` accepts a `file://` URL directly.** The document was already
   `document.readyState === "complete"` and its inline script had run when the first `Runtime.evaluate`
   arrived, so an immediate paint is possible. This is the primary anchor path.
2. **`about:blank` + `navigate(file://…)` also works** and waits for the load. Kept as a fallback shape,
   but not used: `createTarget(url)` is one call instead of two.
3. **A `data:` URL is *not* refused** by `Target.createTarget` on Chrome 157 (the draft assumed it was).
   It is still not used: a `data:` document has no stable, inspectable URL for the doctor, and CSP
   semantics differ between navigations. The shipped panel is a file asset, so the question is moot.
4. **A document created this way survives engine-tab creation and focus changes** — the second and third
   targets did not replace the first one's DOM, and painting after creation worked. That is what
   `window.follow` needs (raise the anchor again later).
5. **No profile file is touched**: the asset path is `pathToFileURL(new URL("../../assets/anchor.html",
   import.meta.url))`, loaded read-only. Chrome's own network stack is the only reader.

## Decision

- Anchor URL: `assets/anchor.html` in the package (shipped via the `files` allowlist, guarded by audit
  R12), **not** a generated file under `~/.pi/agent/web-search/`. Nothing is written at runtime.
- Update mechanism: one `Runtime.evaluate` per paint calling `window.__wcsPanel.render(state)`; the page
  assigns `textContent` only (no `innerHTML`), and the JSON payload is escaped for `<`, U+2028, U+2029.
- Fallback: `window.panel:false` → `about:blank` exactly as before; a browser that refuses the `file://`
  target logs `panel_unavailable` and uses `about:blank` rather than failing the search.
