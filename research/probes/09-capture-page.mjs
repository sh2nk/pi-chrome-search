#!/usr/bin/env node
/**
 * 09 — capture one ordinary web page (not a SERP) as a sanitized fixture.
 *
 * `web_read` (P4-A) needs real article pages with real boilerplate: nav bars,
 * cookie banners, sidebars, footers, comment threads. A synthetic page cannot
 * prove the readability pass, so this probe loads ONE public URL in the user's
 * Chrome (own window, closed afterwards) and stores the post-render HTML.
 *
 * No meta file: `loadFixture()` describes SERPs, and inventing an engine id for
 * a docs page would be a lie. The fixture is `<name>.html.gz` and the read tests
 * load it directly.
 *
 *   PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker \
 *     node research/probes/09-capture-page.mjs --name read-docs \
 *     --url "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions"
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gzip, isFixtureClean, sanitizeFixture } from "../../tests/helpers/sanitize.ts";

const base = new URL("../../src/cdp/", import.meta.url).pathname;
const { discoverEndpoint } = await import(`file://${base}discovery.ts`);
const { CdpSession, createCdpPage } = await import(`file://${base}session.ts`);

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const name = get("--name");
const url = get("--url");
const outDir = get("--out", "tests/fixtures");
const settleMs = Number(get("--settle-ms", "2500"));

if (!name || !url) {
  console.error("usage: --name <fixture> --url <https url> [--out tests/fixtures] [--settle-ms 2500]");
  process.exit(2);
}
if (!/^https:\/\//i.test(url)) {
  console.error("only https URLs are captured");
  process.exit(2);
}

// Active content is dropped: an article fixture needs its text and layout, not
// scripts, styles or icons (SVG path coordinates also look like IPv4 runs to the
// personal-data audit).
const stripActive = (html) =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "");

const t0 = Date.now();
const endpoint = await discoverEndpoint({});
const session = await CdpSession.connect({ wsUrl: endpoint.wsUrl, connectTimeoutMs: 15_000 });
const targetId = await session.createTarget("about:blank", { newWindow: true });

try {
  await session.attach(targetId);
  const page = createCdpPage(session, targetId);
  await page.navigate(url, { timeoutMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  await page.scroll(600);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const rawHtml = await page.html();
  const title = await page.title();
  const html = sanitizeFixture(stripActive(rawHtml));
  if (!isFixtureClean(html)) {
    console.error("fixture is still dirty after sanitize; refusing to write");
    process.exit(4);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.html.gz`), gzip(html));
  console.log(
    JSON.stringify(
      {
        name,
        urlHost: new URL(url).host,
        htmlChars: html.length,
        gzBytes: gzip(html).length,
        ms: Date.now() - t0,
        title: title.slice(0, 80),
      },
      null,
      2,
    ),
  );
} finally {
  await session.closeTarget(targetId).catch(() => {});
  await session.close().catch(() => {});
}
