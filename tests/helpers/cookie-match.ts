/**
 * Cookie↔URL matching shared by `FakePage.cookiesFor()` and the fake CDP
 * server's `Network.getCookies`.
 *
 * Real Chrome returns only the cookies whose domain applies to one of the
 * requested URLs. A fake that always returned every cookie would hide exactly
 * the bugs P1-B/P3 need to catch: sending a `.google.com` session cookie to a
 * yandex tab, or dropping the `.yandex.ru` cookies a `/goto` resolve needs.
 *
 * Rules (RFC 6265 §5.1.3, simplified):
 *  - `Domain=.example.com` matches `example.com` and every subdomain;
 *  - `Domain=example.com` (host-only in a capture) matches the host itself and,
 *    because CDP does not expose `hostOnly` in `CookieInfo`, its subdomains too;
 *  - a plain suffix must not match a different registrable name
 *    (`example.com` vs `notexample.com`), so the dot boundary is required;
 *  - an unparsable URL contributes no host; `about:blank` has no host at all.
 *
 * Path and `Secure` scoping are intentionally ignored: the harness models the
 * domain filter that callers depend on, not the whole cookie store.
 */

export interface DomainScopedCookie {
  domain: string;
}

/** Lowercases and strips the `Domain=` leading dot and a trailing root dot. */
export function normalizeCookieDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
}

/** Hostname of `url`, or `undefined` for a relative/unparsable/opaque URL. */
export function hostFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname.length === 0) return undefined;
  return parsed.hostname.toLowerCase().replace(/\.$/, "");
}

export function cookieMatchesHost(domain: string, host: string): boolean {
  const cookieDomain = normalizeCookieDomain(domain);
  const urlHost = host.trim().toLowerCase().replace(/\.$/, "");
  if (cookieDomain.length === 0 || urlHost.length === 0) return false;
  if (urlHost === cookieDomain) return true;
  return urlHost.endsWith(`.${cookieDomain}`);
}

/**
 * Domain filter used by `cookiesFor()`/`Network.getCookies`: an empty or
 * omitted `urls` list means "the whole jar", matching CDP's `getAllCookies`.
 * When URLs are given but none parse, nothing matches — never everything.
 */
export function filterCookiesForUrls<T extends DomainScopedCookie>(
  cookies: readonly T[],
  urls?: readonly string[],
): T[] {
  if (urls === undefined || urls.length === 0) return [...cookies];
  const hosts = new Set<string>();
  for (const url of urls) {
    const host = hostFromUrl(url);
    if (host !== undefined) hosts.add(host);
  }
  if (hosts.size === 0) return [];
  return cookies.filter((cookie) => [...hosts].some((host) => cookieMatchesHost(cookie.domain, host)));
}
