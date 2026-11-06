/**
 * SSRF guard for `web_read` (SPEC §7.2, PLAN P4-A).
 *
 * `web_read` navigates the user's *real* Chrome, which can reach the router
 * admin page, cloud metadata at 169.254.169.254 and any service bound to
 * loopback — and it returns the response body to the agent. The guard therefore
 * runs twice: on the URL the caller supplied and again on `page.url()` after
 * navigation, because a public host is free to redirect to a private one.
 *
 * The rules are deliberately narrow and boring:
 * - `http:`/`https:` only (no `file:`, `data:`, `javascript:`);
 * - no `user:pass@host` (URL credentials are not how the user's session works
 *   and are a classic parser-confusion trick);
 * - literal addresses must be public;
 * - a hostname must resolve only to public addresses. DNS is injected so the
 *   offline suite never opens a socket: every test passes its own resolver.
 *
 * Failure is always `E_BLOCKED_URL` at stage `read`, with a hint that names the
 * reason (scheme / credentials / private range / resolution) and never echoes
 * URL credentials.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { fail } from "./errors.ts";

/** One step of DNS resolution; `assertPublicUrl` calls it for hostnames only. */
export type ResolveHost = (host: string) => Promise<readonly string[]>;

export interface SsrfOptions {
  /** Injectable resolver (tests must always provide one). Defaults to dns.lookup. */
  resolve?: ResolveHost;
}

const HINT_PRIVATE =
  "use a public http(s) URL; loopback, private, link-local, CGNAT and multicast ranges are blocked";
const HINT_SCHEME = "only http(s) URLs may be read; file:, data: and javascript: are blocked";
const HINT_CREDENTIALS = "remove the username/password from the URL; the browser session supplies authentication";
const HINT_RESOLUTION = "the hostname resolves to a non-public address; read a public site instead";
const HINT_LOOKUP = "the hostname could not be resolved; check the spelling or use a public site";
const HINT_PARSE = "pass a complete public http(s) URL";

/**
 * IPv4 blocks (base address, prefix length): 0/8, 10/8, 100.64/10 (CGNAT),
 * 127/8, 169.254/16, 172.16/12, 192.168/16 and 224/4 (multicast). Everything
 * outside these is treated as public; documentation ranges such as 192.0.2/24
 * stay public so fixtures can use them.
 */
const IPV4_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0xe0000000, 4],
];

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function ipv4ToInt(octets: readonly number[]): number {
  return (((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0;
}

function prefixMask(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

function isPublicIpv4(octets: readonly number[]): boolean {
  const address = ipv4ToInt(octets);
  for (const [base, bits] of IPV4_BLOCKS) {
    const mask = prefixMask(bits);
    if (((address & mask) >>> 0) === ((base & mask) >>> 0)) return false;
  }
  return true;
}

/**
 * Expand an IPv6 literal to eight 16-bit groups. Embedded IPv4 (`::ffff:1.2.3.4`)
 * is rewritten to two hex groups first, which is why a URL-normalised mapped
 * address (`::ffff:7f00:1`) and its dotted spelling reach the same code path.
 */
function parseIpv6(value: string): number[] | null {
  let ip = value.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip === "") return null;

  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (embedded !== null) {
    const octets = parseIpv4(embedded[1] ?? "");
    if (octets === null) return null;
    const pair = `${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
    ).toString(16)}`;
    // The dotted suffix always follows a colon, so the two hex groups attach
    // directly (`::ffff:1.2.3.4` → `::ffff:102:304`).
    ip = `${ip.slice(0, embedded.index)}${pair}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right = halves.length === 2 && (halves[1] ?? "") !== "" ? (halves[1] ?? "").split(":") : [];

  const group = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return Number.parseInt(part, 16);
  };

  const leftGroups: number[] = [];
  for (const part of left) {
    const parsed = group(part);
    if (parsed === null) return null;
    leftGroups.push(parsed);
  }
  const rightGroups: number[] = [];
  for (const part of right) {
    const parsed = group(part);
    if (parsed === null) return null;
    rightGroups.push(parsed);
  }

  if (halves.length === 1) {
    return leftGroups.length === 8 ? leftGroups : null;
  }
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (missing < 1) return null;
  return [...leftGroups, ...new Array<number>(missing).fill(0), ...rightGroups];
}

function isPublicIpv6(groups: readonly number[]): boolean {
  if (groups.length !== 8) return false;
  const g = groups;
  if (g.every((part) => part === 0)) return false; // :: unspecified
  const embedded = (hi: number, lo: number): number[] => [
    (hi >> 8) & 0xff,
    hi & 0xff,
    (lo >> 8) & 0xff,
    lo & 0xff,
  ];

  // ::1 and the deprecated IPv4-compatible ::/96 range share this shape.
  if (g.slice(0, 5).every((part) => part === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    return isPublicIpv4(embedded(g[6] ?? 0, g[7] ?? 0));
  }
  // SIIT-translated `::ffff:0:a.b.c.d` hides an IPv4 address in the last two
  // groups with a zero `ffff` group *after* the prefix (g[4] === ffff).
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
    return isPublicIpv4(embedded(g[6] ?? 0, g[7] ?? 0));
  }
  // NAT64 `64:ff9b::/96` and 6to4 `2002::/16` embed an IPv4 address the browser
  // will actually reach; a private one must not slip through as "public IPv6".
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPublicIpv4(embedded(g[6] ?? 0, g[7] ?? 0));
  }
  if (g[0] === 0x2002) {
    return isPublicIpv4(embedded(g[1] ?? 0, g[2] ?? 0));
  }
  if (((g[0] ?? 0) & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if (((g[0] ?? 0) & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  return true;
}

/**
 * True only for a literal address that is globally routable under this guard.
 * Anything unparsable is false: "unknown" must fail closed, never open.
 */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string") return false;
  const value = ip.trim();
  if (value === "") return false;
  const family = isIP(value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value);
  if (family === 4) {
    const octets = parseIpv4(value);
    return octets !== null && isPublicIpv4(octets);
  }
  if (family === 6) {
    const groups = parseIpv6(value);
    return groups !== null && isPublicIpv6(groups);
  }
  return false;
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function blocked(message: string, hint: string): ReturnType<typeof fail> {
  return fail("E_BLOCKED_URL", "read", { hint, message });
}

async function defaultResolve(host: string): Promise<readonly string[]> {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

/**
 * Validate, normalise and return a URL that `web_read` may navigate to.
 *
 * The returned `URL` is the WHATWG-normalised form (punycode hostname, default
 * port dropped, IPv4 shorthand expanded), so the caller can both navigate and
 * log it without re-parsing.
 */
export async function assertPublicUrl(raw: string, opts: SsrfOptions = {}): Promise<URL> {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw blocked("the URL is empty", HINT_PARSE);
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw blocked("the URL could not be parsed", HINT_PARSE);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // The scheme is safe to echo (it is one of a handful of known tokens) and
    // tells the caller exactly which rule fired.
    throw blocked(`scheme ${url.protocol.replace(/:$/, "")} is not allowed`, HINT_SCHEME);
  }

  if (url.username !== "" || url.password !== "") {
    // Never include the userinfo in the message: it is a credential.
    throw blocked("the URL embeds credentials", HINT_CREDENTIALS);
  }

  if (url.hostname === "") {
    throw blocked("the URL has no host", HINT_PARSE);
  }

  const host = unbracket(url.hostname);

  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) {
      throw blocked(`refusing to read a private or special-use address (${host})`, HINT_PRIVATE);
    }
    return url;
  }

  const name = host.replace(/\.$/, "");
  const resolve = opts.resolve ?? defaultResolve;

  let addresses: readonly string[];
  try {
    addresses = await resolve(name);
  } catch {
    throw blocked(`DNS resolution failed for ${name}`, HINT_LOOKUP);
  }
  if (addresses.length === 0) {
    throw blocked(`DNS returned no addresses for ${name}`, HINT_LOOKUP);
  }
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      // One private answer is enough: a round-robin record could otherwise
      // race the browser into the private branch on the next navigation.
      throw blocked(`refusing to read ${name}: it resolves to a non-public address`, HINT_RESOLUTION);
    }
  }

  return url;
}
