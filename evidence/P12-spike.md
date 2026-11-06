# P12 spike — where PDF text can come from (S2 / S2b)

**Verdict: PASS** — candidate A (AX tree) rejected by measurement; candidate B
(`Fetch` response capture + in-tree parser) accepted and implemented.

Measured 2026-11-06 on the user's attached Chrome `157.0.8103.38`, Linux/Wayland.
Commands are transcribed from the probe scripts; no browser was launched.

## S2 — candidate A: the PDF viewer's accessibility tree

Opened a fresh owned tab on `https://arxiv.org/pdf/2211.17192` and inspected the
target list plus the AX tree of the viewer:

```
our target 331DB20F…  type=page  url=https://arxiv.org/pdf/2211.17192
our AX nodes: 5 (no text)
iframe DC8A0DDC… chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html
  Accessibility.getFullAXTree → 169 nodes
  roles: RootWebArea 1, none 105, generic 37, button 13, StaticText 5,
         textbox 2, InlineTextBox 5, EmbeddedObject 1
  text: ["Показать или скрыть боковую панель","2211.17192v2.pdf","Номер страницы",
         "/","13","Уменьшить","Масштаб","Увеличить","Выровнять по размеру страницы",
         "Повернуть против часовой стрелки","Добавить заметки к тексту","Нарисовать"]
embedded iframe FECD0223… https://arxiv.org/pdf/2211.17192 → 5 AX nodes, no text
```

**Verdict: rejected.** On this Chrome build the viewer exposes only its toolbar;
the PDFium text layer is not in the accessibility tree reachable over CDP, with
or without `Accessibility.enable`. The plan's rung 1 ("AX tree is the
no-binary path") is false on Chrome 157, so P12 replaced it with an in-tree byte
parser over bytes fetched through the browser. The ladder keeps `pdftotext` /
`mutool` as optional fallbacks (`capability()`).

## S2 — candidate B: response bytes through CDP

Two capture shapes were measured; only the second is usable.

1. `Network.enable` + `Page.navigate` + `Network.getResponseBody` on the read
   tab. The response was observed (`mime=application/pdf`, `status=200`), but
   after Chrome swapped the document into the viewer the same `requestId`
   returned **601 bytes of the viewer's HTML** (`<!doctype …`), not the PDF.
   Rejected: the viewer replaces the document before the body is read.
2. **`Fetch` interception at the response stage on a separate background
   target** (implemented in `src/cdp/bytes.ts`):

```
target: about:blank, background:true (47 ms to create)
Fetch.enable {urlPattern:"*", requestStage:"Response"}
Runtime.evaluate fetch("https://arxiv.org/pdf/2211.17192", {credentials:"include"})
Fetch.requestPaused → status 200, content-type application/pdf
Fetch.getResponseBody → 574 982 bytes, base64, header "%PDF-1.5"
Fetch.failRequest(errorReason:"Aborted") → the viewer never engages
close target
```

Total 830 ms for 575 KB. A redirect hop (3xx) is continued, and the final URL is
returned so the tool can re-run the SSRF guard on it. **Verdict: primary path.**

## S2b — binary ladder

| Tool | Present here | Notes |
|---|---|---|
| `pdftotext` (poppler) | yes, `/usr/bin/pdftotext` | `-layout -enc UTF-8 - -` reads stdin, writes stdout; 76 396 chars on the arxiv paper (in-tree 43 406 with the same page count) |
| `mutool` (mupdf) | **absent** | no comparison possible on this host; the command shape is in the code and covered by the injected runner seam |
| `qpdf` | yes | validates/rewrites, does not extract text — dropped from the design as the plan says |

Two findings that shaped the fallback:

- **Encryption exists in the wild.** `https://www.orimi.com/pdf-test.pdf` is
  RC4-encrypted with an empty user password: Chrome and `pdftotext` read it,
  the in-tree parser cannot (it does not implement decryption) and fails
  honestly with `E_PDF_UNSUPPORTED`. That is the concrete case where the
  optional binary rung is worth keeping.
- **A tiny text PDF is still a text PDF.** A 13 KB W3C dummy contains only
  `Dummy PDF file`; an early `MIN_USEFUL_CHARS = 32` threshold classified it as
  empty. The threshold is now 1: the parser only emits text from real text
  operators, so a short answer is honest.

## Reproducible probe

The accepted path, with an empty capability resolver (so the output cannot come
from `pdftotext`):

```
$ node research/probes/11-pdf-paths.ts
fetch: status=200 type=application/pdf bytes=574982 in 537 ms
in-tree (no capabilities): extractor=in-tree pages=13 chars=43208 in 94 ms; attempted=[]
first 200 chars:
Fast Inference from Transformers via Speculative Decoding
Yaniv Leviathan
…
```

## Resulting design

1. In-tree parser over the fetched bytes (`src/extract/pdf.ts`): classic objects,
   PDF 1.5 object streams, Flate/ASCIIHex/ASCII85, page tree, Type0 + simple
   fonts, ToUnicode CMaps, `/Differences`, `Tj`/`TJ`/`'`/`"` with baseline-aware
   line breaks.
2. `pdftotext -layout` (stdin/stdout) behind `capability()`, then
   `mutool draw -F txt`.
3. No text: `E_PDF_SCANNED` when the pages carry images and no text operators,
   `E_PDF_UNSUPPORTED` otherwise, both with an artifact and no fabricated text.
