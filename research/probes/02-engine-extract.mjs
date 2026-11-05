#!/usr/bin/env node
// 02 — extract AI summary + organics from all three engines through the user's Chrome.
// Proves the extraction contract and reports raw → compact character ratios.
// Usage: CDP_URL=http://127.0.0.1:9222 node 02-engine-extract.mjs
// Runs ONE query per engine. Do not loop it.

import { chromium } from "playwright-core";

const cdp = process.env.CDP_URL || "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
const page = context.pages()[0] || (await context.newPage());
page.setDefaultTimeout(25_000);

const cap = (s, n) => {
  s = String(s ?? "").trim();
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
};
const clean = (s) =>
  String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

function render(label, ai, items, raw) {
  const out = [`${label} | ai:${ai ? "yes" : "no"}`];
  if (ai) out.push("AI: " + cap(clean(ai), 1200));
  out.push("", "RESULTS");
  items.slice(0, 5).forEach((r, i) =>
    out.push(`${i + 1}. ${r.title}\n   ${r.url}\n   ${cap(clean(r.snippet), 160)}`),
  );
  const text = out.join("\n");
  const ratio = text.length ? (raw.length / text.length).toFixed(1) : "n/a";
  console.log(`\n${label}: raw=${raw.length} compact=${text.length} ratio=${ratio} n=${items.length}`);
  console.log(text.slice(0, 1200));
  return text;
}

async function google(q) {
  const t0 = Date.now();
  await page.goto(
    "https://www.google.com/search?q=" + encodeURIComponent(q) + "&hl=ru&gl=ru",
    { waitUntil: "domcontentloaded", timeout: 30_000 },
  );
  await page.waitForTimeout(4_000);
  const raw = await page.evaluate(() => document.body.innerText);
  const data = await page.evaluate(() => {
    const sec = [...document.querySelectorAll("section")].find((s) =>
      /Обзор от ИИ|AI Overview/.test(s.innerText || ""),
    );
    const items = [...document.querySelectorAll("a h3")].map((h) => {
      const a = h.closest("a");
      const box = h.closest("div[data-hveid]") || h.parentElement?.parentElement;
      return {
        title: h.innerText,
        href: a?.getAttribute("href") || "",
        snippet: box?.querySelector(".VwiC3b, [data-sncf]")?.innerText || "",
      };
    });
    return { ai: sec ? sec.innerText : "", items: items.slice(0, 8) };
  });

  for (const it of data.items) {
    let url = it.href;
    if (url.startsWith("/goto")) {
      try {
        const r = await context.request.get("https://www.google.com" + url, {
          maxRedirects: 0,
          timeout: 8_000,
        });
        url = r.headers()["location"] || url;
      } catch {
        /* keep the wrapper */
      }
    } else if (url.startsWith("/url?q=")) {
      url = decodeURIComponent(url.slice(7).split("&")[0]);
    }
    it.url = url;
  }

  const ai = clean(data.ai).replace(/^Обзор от ИИ[:\s]*/, "");
  render(`google (${Date.now() - t0}ms)`, ai, data.items, raw);
}

async function yandex(q) {
  const t0 = Date.now();
  const url = "https://yandex.ru/search/?text=" + encodeURIComponent(q);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(5_500);
  if (/Я не робот/.test(await page.evaluate(() => document.body.innerText))) {
    console.log("  [yandex captcha] retrying once after 3s…");
    await page.waitForTimeout(3_000);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(5_500);
  }
  const raw = await page.evaluate(() => document.body.innerText);

  // Expand a collapsed "Показать полностью" block, if present.
  const more = page.locator('text="Показать полностью"').first();
  if (await more.count()) {
    await more.click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const data = await page.evaluate(() => {
    const h = [...document.querySelectorAll("h3")].find((x) =>
      /Быстрый ответ|Нейро|Алиса AI/.test(x.innerText || ""),
    );
    let ai = "";
    if (h) {
      let p = h;
      for (let i = 0; i < 7 && p.parentElement; i++) {
        p = p.parentElement;
        const t = p.innerText || "";
        if (t.length > 400 && t.length < 9000) {
          ai = t;
          if (/Источник|Показать полностью/i.test(t)) break;
        }
      }
    }
    const items = [...document.querySelectorAll(".OrganicTitle")]
      .map((t) => {
        const a = t.querySelector("a") || t.closest("a");
        const box = t.closest("li, .serp-item, div");
        return {
          title: t.innerText,
          href: a?.href || "",
          snippet: box?.querySelector(".OrganicTextContentSpan")?.innerText || "",
        };
      })
      .filter((x) => x.title && x.href);
    return { ai, items: items.slice(0, 8) };
  });

  render(`yandex (${Date.now() - t0}ms)`, clean(data.ai), data.items, raw);
}

async function ddg(q) {
  const t0 = Date.now();
  await page.goto("https://duckduckgo.com/?q=" + encodeURIComponent(q) + "&kl=ru-ru", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(4_500);
  const raw = await page.evaluate(() => document.body.innerText);
  const data = await page.evaluate(() => {
    let ai = "";
    const items = [...document.querySelectorAll('a[data-testid="result-title-a"]')].map((a) => {
      const art = a.closest("article") || a.parentElement?.parentElement;
      return {
        title: a.innerText,
        url: a.href,
        snippet: art?.querySelector('[data-result="snippet"]')?.innerText || "",
      };
    });
    return { ai, items: items.slice(0, 8) };
  });
  // Assist is extracted from the visible text, not the DOM: it is A/B and its container is unstable.
  const bodyText = raw;
  const i = bodyText.indexOf("Search Assist");
  if (i >= 0) {
    const j = bodyText.indexOf("Ответ составлен автоматически", i);
    if (j > i) data.ai = bodyText.slice(bodyText.indexOf("Search Assist", i + 1) + 13, j);
  }
  render(`ddg (${Date.now() - t0}ms)`, clean(data.ai), data.items, raw);
}

try {
  await google("что такое трансформер в машинном обучении");
  await page.waitForTimeout(4_000);
  await yandex("стоит ли покупать электромобиль в россии");
  await page.waitForTimeout(3_000);
  await ddg("how does a solar panel work");
} finally {
  await browser.close();
}
