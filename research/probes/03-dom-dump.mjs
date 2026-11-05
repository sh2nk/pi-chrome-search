#!/usr/bin/env node
// 03 — dump a post-render SERP (HTML + visible text) for selector archaeology.
// Usage: CDP_URL=http://127.0.0.1:9222 node 03-dom-dump.mjs --url "https://yandex.ru/search/?text=test"
//        [--out /tmp/probe-dump] [--shot]

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = get("--url");
const out = get("--out", "/tmp/probe-dump");
const shot = args.includes("--shot");

if (!url) {
  console.error('usage: node 03-dom-dump.mjs --url "https://…" [--out DIR] [--shot]');
  process.exit(1);
}

const browser = await chromium.connectOverCDP(process.env.CDP_URL || "http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0] || (await context.newPage());
page.setDefaultTimeout(25_000);

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForTimeout(5_000);

mkdirSync(out, { recursive: true });
const html = await page.content();
const text = await page.evaluate(() => document.body.innerText);
const meta = {
  url: page.url(),
  title: await page.title(),
  h3: await page.locator("h3").count(),
  textLength: text.length,
  captcha: /Я не робот|SmartCaptcha|подозрительный трафик|unusual traffic/.test(text),
  ai: /Обзор от ИИ|AI Overview|Быстрый ответ|Search Assist/.test(text),
  at: new Date().toISOString(),
};

writeFileSync(join(out, "page.html"), html);
writeFileSync(join(out, "page.txt"), text);
writeFileSync(join(out, "meta.json"), JSON.stringify(meta, null, 2));
if (shot) {
  await page.screenshot({ path: join(out, "page.png"), fullPage: false }).catch((e) => {
    console.error("screenshot failed:", e.message);
  });
}

console.log(JSON.stringify({ out, ...meta }, null, 2));
await browser.close();
