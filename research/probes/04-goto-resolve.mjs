#!/usr/bin/env node
// 04 — resolve Google's opaque /goto links with browser cookies and a manual redirect.
// Proves: 302 + Location is available without opening a tab per result.
// Usage: CDP_URL=http://127.0.0.1:9222 node 04-goto-resolve.mjs [--n 5]

import { chromium } from "playwright-core";

const n = Number(process.argv.includes("--n") ? process.argv[process.argv.indexOf("--n") + 1] : 5);
const browser = await chromium.connectOverCDP(process.env.CDP_URL || "http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0] || (await context.newPage());
page.setDefaultTimeout(25_000);

await page.goto(
  "https://www.google.com/search?q=" + encodeURIComponent("что такое трансформер") + "&hl=ru",
  { waitUntil: "domcontentloaded", timeout: 30_000 },
);
await page.waitForTimeout(4_000);

const links = await page.evaluate(
  (limit) =>
    [...document.querySelectorAll("a h3")]
      .slice(0, limit)
      .map((h) => ({ title: h.innerText, href: h.closest("a")?.getAttribute("href") || "" })),
  n,
);

for (const link of links) {
  if (!link.href.startsWith("/goto")) {
    console.log(`[direct] ${link.title}\n         ${link.href}`);
    continue;
  }
  try {
    const r = await context.request.get("https://www.google.com" + link.href, {
      maxRedirects: 0,
      timeout: 8_000,
    });
    console.log(`[${r.status()}] ${link.title}\n         ${r.headers()["location"] || "(no location)"}`);
  } catch (e) {
    console.log(`[err] ${link.title}\n      ${e.message}`);
  }
}

await browser.close();
