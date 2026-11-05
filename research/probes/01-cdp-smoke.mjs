#!/usr/bin/env node
// 01 — smoke-test CDP attach to the user's real Chrome.
// Proves: the connection works, navigator.webdriver is false, Google serves a SERP.
// Usage: CDP_URL=http://127.0.0.1:9222 node 01-cdp-smoke.mjs

import { chromium } from "playwright-core";

const cdp = process.env.CDP_URL || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(cdp).catch((e) => {
  console.error(`cannot attach to ${cdp}: ${e.message}`);
  console.error("enable it in chrome://inspect/#remote-debugging (tick + Allow), or set CDP_URL");
  process.exit(1);
});

console.log("browser:", browser.version());
const context = browser.contexts()[0];
if (!context) {
  console.error("no browser context (is Chrome running with a profile?)");
  process.exit(1);
}
const page = context.pages()[0] || (await context.newPage());
page.setDefaultTimeout(20_000);

console.log("webdriver:", await page.evaluate(() => navigator.webdriver));
console.log("language :", await page.evaluate(() => navigator.language));
console.log("ua       :", (await page.evaluate(() => navigator.userAgent)).slice(0, 100));

await page.goto("https://www.google.com/search?q=test&hl=ru", {
  waitUntil: "domcontentloaded",
  timeout: 30_000,
});
await page.waitForTimeout(3_500);

const body = await page.evaluate(() => document.body.innerText);
console.log("url      :", page.url().slice(0, 90));
console.log("title    :", await page.title());
console.log("h3       :", await page.locator("h3").count());
console.log("ai block :", /Обзор от ИИ|AI Overview/.test(body));
console.log("wall     :", /подозрительный трафик|unusual traffic|Я не робот/.test(body));

await browser.close();
