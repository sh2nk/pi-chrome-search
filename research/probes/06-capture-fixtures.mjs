#!/usr/bin/env node
// 06 — capture ONE sanitized SERP fixture through the user's real Chrome.
//
// Live work is orchestrator-only and serialized: one URL per invocation, no
// retry loop. The tab is created in a dedicated window and closed afterwards;
// the user's own tabs are never touched.
//
// Usage:
//   node research/probes/06-capture-fixtures.mjs \
//     --name google-ai --engine google --class technical \
//     --url "https://www.google.com/search?q=<query>&hl=ru" --query "…"
//
// Synthetic wall/empty fixtures are written by hand under tests/fixtures/;
// this script only captures live pages.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzip, isFixtureClean, sanitizeFixture } from "../../tests/helpers/sanitize.ts";

const base = new URL("../../src/cdp/", import.meta.url).pathname;
const { discoverEndpoint } = await import(`file://${base}discovery.ts`);
const { CdpSession, createCdpPage } = await import(`file://${base}session.ts`);

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const name = get("--name");
const engine = get("--engine");
const queryClass = get("--class", "captured");
const url = get("--url");
const query = get("--query", "");
const outDir = get("--out", "tests/fixtures");
const settleMs = Number(get("--settle-ms", "4500"));
const allowWall = args.includes("--allow-wall");

if (!name || !engine || !url) {
  console.error("usage: --name <fixture> --engine <google|duckduckgo|yandex> --class <slug> --url <url> [--query <q>] [--allow-wall]");
  process.exit(2);
}

// Scripts, styles and inline SVG are dropped before a fixture is stored:
// they carry session config and, in SVG path data, coordinate runs that look
// exactly like IPv4 addresses to the personal-data audit (136 false positives
// on the first live Google/DDG captures). Adapters extract text, never icons.
const stripActive = (html) =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, "");

const shapeOf = (raw) => {
  const parsed = new URL(raw);
  for (const key of ["q", "text", "query", "word"]) {
    if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "<query>");
  }
  for (const key of ["sxsrf", "sca_esv", "ei", "ved", "reqid", "usg", "sa", "cd", "gs_lcp", "vet", "redircnt"]) {
    parsed.searchParams.delete(key);
  }
  return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`;
};

const t0 = Date.now();
const endpoint = await discoverEndpoint({});
// Chrome's grant-check can take seconds (observed 1.3 s and one 5 s+ stall on
// the same session), so keep the connect bounded but not tight.
const session = await CdpSession.connect({ wsUrl: endpoint.wsUrl, connectTimeoutMs: 15_000 });
const targetId = await session.createTarget("about:blank", { newWindow: true });

try {
  await session.attach(targetId);
  const page = createCdpPage(session, targetId);
  await page.navigate(url, { timeoutMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  await page.scroll(300 + Math.floor(Math.random() * 600));
  await new Promise((resolve) => setTimeout(resolve, 600));

  const rawHtml = await page.html();
  const rawText = await page.innerText();
  const title = await page.title();

  const wall = /Я не робот|SmartCaptcha|подозрительный трафик|unusual traffic|Подтвердите, что запросы отправляли вы/i.test(
    rawText,
  );
  if (wall && !allowWall) {
    console.error("WALL detected; not capturing. Solve it in the visible window and rerun once.");
    process.exit(3);
  }

  const personalQueries = query ? [query] : [];
  const html = sanitizeFixture(stripActive(rawHtml), { personalQueries });
  const text = sanitizeFixture(rawText, { personalQueries });
  if (!isFixtureClean(html, { personalQueries }) || !isFixtureClean(text, { personalQueries })) {
    console.error("fixture is still dirty after sanitize; refusing to write");
    process.exit(4);
  }

  const ai = /Обзор от ИИ|AI Overview|Быстрый ответ|Search Assist|Нейро/i.test(text);
  // Count result markers in the HTML, not `h3` in innerText: text has no tags, so
  // the earlier counter always wrote 0 and the meta contradicted the capture.
  // This is a marker census, not the adapter's result count (ads are still in).
  const results =
    engine === "duckduckgo"
      ? (html.match(/data-testid="result-title-a"/g) ?? []).length
      : engine === "yandex"
        ? (html.match(/OrganicTitle/g) ?? []).length
        : (html.match(/<h3\b/gi) ?? []).length;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.html.gz`), gzip(html));
  writeFileSync(
    join(outDir, `${name}.meta.json`),
    JSON.stringify(
      {
        engine,
        urlPathShape: shapeOf(url),
        queryClass: wall ? "wall" : queryClass,
        capturedAt: new Date().toISOString(),
        ai: ai ? "yes" : "no",
        results,
        notes: wall
          ? "wall captured"
          : "results = marker census in the HTML; ai = text heuristic (adapter detection is authoritative)",
        capturedWith: "research/probes/06-capture-fixtures.mjs",
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        name,
        engine,
        wall,
        ai,
        htmlChars: html.length,
        textChars: text.length,
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
