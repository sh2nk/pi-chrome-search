/**
 * URL hygiene for SERP extraction (SPEC §8, PLAN P2-A).
 *
 * Pure string work: no network, no guesswork. Google's organic hrefs are opaque
 * `/goto?url=<protobuf>` wrappers whose target only the browser can resolve; we
 * report `url: null` for those instead of inventing a destination. Adapters feed
 * the wrapper to the resolver/cache later, never a fabricated link.
 */

export type LinkKind = "direct" | "url" | "goto";

export interface ParsedLink {
  kind: LinkKind;
  /** Resolved http(s) destination, or null when the wrapper hides it (`/goto`). */
  url: string | null;
  /** Absolute wrapper URL (`/goto`, `/url`, DDG `/l/`); null for a direct link. */
  wrapperUrl: string | null;
}

/** Exact query parameters that only carry attribution/click-tracking state. */
const TRACKING_EXACT: ReadonlySet<string> = new Set([
  "gclid",
  "yclid",
  "fbclid",
  "msclkid",
  "mc_eid",
  "igshid",
  "ref_src",
  "spm",
  "_openstat",
  "from",
  "redircnt",
  "si",
  "sca_esv",
  "sxsrf",
  // Plan-listed marketing parameters that survive on copied links.
  "ref",
]);

/** Prefix families (`utm_source`, `utm_medium`, …). Compared case-insensitively. */
const TRACKING_PREFIXES: readonly string[] = ["utm_"];

export function isTrackingParam(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (TRACKING_EXACT.has(key)) return true;
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isHttpUrl(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Canonical form for dedup and rendering: http(s) only, lowercase scheme/host,
 * no default port, no fragment, tracking params removed, remaining params sorted.
 *
 * The sort makes two links that differ only in parameter order collapse to one
 * key — that is why dedup can be a plain Map lookup. Returns null for anything
 * that is not a parseable http(s) URL.
 */
export function normalizeUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // URL already lowercases scheme/host and drops :80/:443 for http/https.
  parsed.hash = "";

  const kept = [...parsed.searchParams].filter(([key]) => !isTrackingParam(key));
  kept.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });

  parsed.search = "";
  for (const [key, value] of kept) parsed.searchParams.append(key, value);

  if (parsed.pathname === "") parsed.pathname = "/";
  return parsed.toString();
}

/**
 * Remove tracking parameters and keep everything else byte-identical in spirit.
 * Invalid input is returned unchanged: callers use this on hrefs they intend to
 * open, so silently dropping a URL would be worse than passing it through.
 */
export function stripTrackingParams(raw: string): string {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return raw;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return raw;

  const kept = [...parsed.searchParams].filter(([key]) => !isTrackingParam(key));
  if (kept.length === parsed.searchParams.size) return raw;

  parsed.search = "";
  for (const [key, value] of kept) parsed.searchParams.append(key, value);
  return parsed.toString();
}

/**
 * Source identity for de-duplication and citation folding (PLAN-v2 P13-B).
 *
 * Canonical host (no `www.`) + path, with the whole query string dropped. Two
 * links that differ only in tracking or campaign parameters are the same source,
 * and a source can never appear twice in a research bundle.
 *
 * Deliberately *not* the registrable domain: folding `docs.python.org/x` and
 * `blog.python.org/x` into `python.org/x` would merge two independent sources
 * and quietly destroy the corroboration signal the research bundle relies on.
 * Returns null for anything that is not a parseable http(s) URL.
 */
export function sourceKey(raw: string): string | null {
  const normalized = normalizeUrl(raw);
  if (normalized === null) return null;
  const parsed = new URL(normalized);
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.hostname.replace(/^www\./, "")}${path}`;
}

/** Hostname without a leading `www.`, lowercase; empty string for unparsable input. */
export function domainOf(raw: string): string {
  if (typeof raw !== "string") return "";
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  return parsed.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Strip tracking parameters from every URL inside prose or Markdown link text
 * (PLAN-v2 P13-B). A research claim is quoted text, and the shipped bundle was
 * returning a truncated `[label](https://…?utm_source=…)` tail.
 *
 * Markdown links are cleaned on both sides: the href loses its tracking
 * parameters and a URL used as the label is cleaned too. Trailing punctuation is
 * preserved, so a sentence stays a sentence. Input that is not a string is
 * returned unchanged.
 */
export function stripTrackingFromText(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  return cleanBareUrls(
    text.replace(MARKDOWN_LINK, (_match, label: string, href: string) =>
      `[${cleanBareUrls(label)}](${stripTrackingParams(href)})`,
    ),
  );
}

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^()\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[.,;:!?]/;

function cleanBareUrls(text: string): string {
  return text.replace(BARE_URL, (match) => {
    // Keep sentence punctuation outside the URL, and keep a closing paren only
    // when the URL itself opened one (wikimedia-style `/wiki/Foo_(bar)`).
    let end = match.length;
    while (end > 0 && TRAILING_PUNCT.test(match[end - 1] ?? "")) end -= 1;
    while (end > 0 && match[end - 1] === ")") {
      const head = match.slice(0, end);
      const opens = head.split("(").length - 1;
      const closes = head.split(")").length - 1;
      if (closes <= opens) break;
      end -= 1;
    }
    return `${stripTrackingParams(match.slice(0, end))}${match.slice(end)}`;
  });
}

/**
 * Scheme-less key of the normalized URL. Useful when the same page is offered
 * over http and https, or when a cache key should ignore scheme upgrades.
 */
export function stableQueryKey(raw: string): string | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  return normalized.replace(/^https?:\/\//, "");
}

/**
 * Google's host shape, spelled out instead of "anything under google.*".
 *
 * `parseLink` decides whether an absolute href is Google's own wrapper, and the
 * resolver then sends the browser's cookies to that host. A wildcard such as
 * `google.duckdns.org` would therefore let a hostile SERP href aim the
 * cookie-bearing request at an attacker, so only the real shapes pass: an
 * optional `www.`, then `google.com`, `google.<2-3 letter ccTLD>` (google.de,
 * google.ru) or `google.<co|com>.<2 letter ccTLD>` (google.co.uk,
 * google.com.br).
 */
const GOOGLE_CC_TLD = /^google\.[a-z]{2,3}$/;
const GOOGLE_CO_CC_TLD = /^google\.(?:co|com)\.[a-z]{2}$/;

export function isGoogleHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return host === "google.com" || GOOGLE_CC_TLD.test(host) || GOOGLE_CO_CC_TLD.test(host);
}

function isDuckDuckGoHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
}

function resolveHref(raw: string, baseUrl: string): URL | null {
  // Absolute first: `new URL(href, badBase)` throws even for an absolute href.
  try {
    return new URL(raw);
  } catch {
    // not absolute — fall through
  }
  if (!baseUrl) return null;
  try {
    return new URL(raw, baseUrl);
  } catch {
    return null;
  }
}

function decodeTarget(raw: string | null): string | null {
  if (!raw) return null;
  const candidate = raw.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Classify one href as it appears in a SERP:
 *
 * - Google `/goto?url=<opaque>` → `{kind:"goto", url:null, wrapperUrl}` — the
 *   protobuf is never decoded; the caller resolves it through the browser.
 * - Google `/url?q=<url>` (and DDG `/l/?uddg=<url>`, whose hrefs are plain) →
 *   `{kind:"url", url, wrapperUrl}`.
 * - anything else http(s), relative or absolute → `{kind:"direct", url}`.
 *
 * Returns null when the href is empty, unresolvable, or not http(s): an
 * unusable link is dropped, never repaired.
 */
export function parseLink(href: string, baseUrl: string): ParsedLink | null {
  if (typeof href !== "string") return null;
  const raw = href.trim();
  if (!raw) return null;
  // A fragment-only href points at the SERP itself, not at a result.
  if (raw.startsWith("#")) return null;

  const resolved = resolveHref(raw, baseUrl);
  if (!resolved) return null;
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;

  // A relative href inherits the SERP host, so treating its path as a wrapper is
  // safe; an absolute href must actually belong to that engine.
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("//");
  const path = resolved.pathname.toLowerCase();

  if ((relative || isGoogleHost(resolved.hostname)) && path.endsWith("/goto")) {
    return { kind: "goto", url: null, wrapperUrl: resolved.href };
  }

  if ((relative || isGoogleHost(resolved.hostname)) && path.endsWith("/url")) {
    const target = decodeTarget(resolved.searchParams.get("q") ?? resolved.searchParams.get("url"));
    if (!target) return null;
    return { kind: "url", url: target, wrapperUrl: resolved.href };
  }

  if ((relative || isDuckDuckGoHost(resolved.hostname)) && (path.endsWith("/l/") || path.endsWith("/l"))) {
    const target = decodeTarget(resolved.searchParams.get("uddg"));
    if (!target) return null;
    return { kind: "url", url: target, wrapperUrl: resolved.href };
  }

  return { kind: "direct", url: resolved.href, wrapperUrl: null };
}
