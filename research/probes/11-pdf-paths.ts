#!/usr/bin/env node
/**
 * P12 probe — the production PDF path against the live browser.
 *
 * `node research/probes/11-pdf-paths.ts [url]`
 *
 * Prints the captured response's status/content-type/byte count, then parses
 * the bytes with the in-tree rung **and an empty capability resolver**, so the
 * output proves the no-binary path rather than the optional fallback. One run,
 * one request: this is a gate probe, not a loop.
 *
 * The rejected AX-tree route and the `Network.getResponseBody` failure are
 * recorded in `evidence/P12-spike.md`; this probe keeps the accepted path
 * reproducible.
 */

import { CdpSession } from "../../src/cdp/session.ts";
import { discoverEndpoint } from "../../src/cdp/discovery.ts";
import { captureBytes } from "../../src/cdp/bytes.ts";
import { extractPdfText } from "../../src/extract/pdf.ts";

const url = process.argv[2] ?? "https://arxiv.org/pdf/2211.17192";

const endpoint = await discoverEndpoint();
const session = await CdpSession.connect({ wsUrl: endpoint.wsUrl });
try {
  const started = Date.now();
  const fetched = await captureBytes(session, url, { maxBytes: 20 * 1024 * 1024 });
  const fetchedMs = Date.now() - started;
  console.log(
    `fetch: status=${fetched.status} type=${fetched.contentType} bytes=${fetched.bytes.length} in ${fetchedMs} ms`,
  );

  const parsedStarted = Date.now();
  const result = await extractPdfText(fetched.bytes, { capability: () => null, pageMaxChars: 4000 });
  console.log(
    `in-tree (no capabilities): extractor=${result.extractor} pages=${result.pageCount} ` +
      `chars=${result.chars} in ${Date.now() - parsedStarted} ms; attempted=[${result.attempted.join(",")}]`,
  );
  console.log("first 200 chars:");
  console.log(result.pages[0]?.slice(0, 200) ?? "(empty)");
} finally {
  await session.close();
}
