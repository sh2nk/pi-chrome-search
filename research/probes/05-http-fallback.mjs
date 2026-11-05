#!/usr/bin/env node
// 05 — keyless HTTP fallbacks (no browser). Degraded mode only: results, no AI summary.
// Google WML is header/TLS-sensitive and may return 403; Yandex /search/site/ usually works.
// Usage: node 05-http-fallback.mjs [--q "…"]

const q = process.argv.includes("--q") ? process.argv[process.argv.indexOf("--q") + 1] : "что такое трансформер";
const decode = (s) =>
  s.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

async function googleWml() {
  const url = new URL("https://www.google.com/wml/search");
  for (const [k, v] of Object.entries({
    q, sca_esv: "1", filter: "1", start: "0", hl: "ru-RU", lr: "lang_ru", cr: "countryRU",
  })) url.searchParams.set(k, v);
  const ua =
    "NokiaN72/2.0625.2.0.2 Series60/2.8 Profile/MIDP-2.0 Configuration/CLDC-1.1/UC Browser7.9.1.121/27/351/UCWEB";
  const r = await fetch(url, {
    headers: { "User-Agent": ua, Cookie: "CONSENT=YES+", "Accept-Language": "ru-RU,ru;q=0.9" },
  });
  const html = await r.text();
  const links = [...html.matchAll(/<a[^>]+href="\/url\?q=([^"&]+)[^"]*"[^>]*>(.*?)<\/a>/gs)].slice(0, 5);
  console.log(`google wml: ${r.status} ${html.length}b links=${links.length}`);
  for (const [, href, title] of links) {
    console.log(`  - ${decode(title).slice(0, 80)} :: ${decodeURIComponent(href).slice(0, 90)}`);
  }
  if (r.status !== 200) console.log("  (expected sometimes: 403 = header/TLS fingerprint, not a bug in our code)");
}

async function yandexSite() {
  const url = new URL("https://yandex.com/search/site/");
  url.searchParams.set("text", q);
  url.searchParams.set("web", "1");
  url.searchParams.set("searchid", String(Math.floor(1_000_000 + Math.random() * 8_999_999)));
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9",
    },
  });
  const html = await r.text();
  const captcha = /showcaptcha|Я не робот/.test(html);
  // Split by result blocks first, otherwise a lazy regex pairs one item's title with another's link.
  const blocks = html.split(/<li[^>]*class="[^"]*serp-item[^"]*"[^>]*>/).slice(1, 6);
  const items = blocks
    .map((b) => {
      const title = b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] || "";
      const hrefs = [...b.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
      const href = hrefs.find((h) => !/yandex\.(ru|com)/.test(h)) || hrefs[0] || "";
      return { title: decode(title), href };
    })
    .filter((x) => x.title && x.href);
  console.log(`yandex site: ${r.status} ${html.length}b captcha=${captcha} items=${items.length}`);
  for (const it of items) console.log(`  - ${it.title.slice(0, 80)} :: ${it.href.slice(0, 90)}`);
}

await googleWml();
await new Promise((r) => setTimeout(r, 2_000));
await yandexSite();
