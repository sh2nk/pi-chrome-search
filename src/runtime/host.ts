/**
 * The host layer (PLAN v2 P15 / PO1–PO6).
 *
 * Everything that depends on the machine the extension happens to run on lives
 * here: platform facts, home/config paths, browser profile locations, executable
 * capability probes and the one signal-free process check. No other module in
 * `src/` may import `node:os`, read `$HOME`/`PATH`/`LOCALAPPDATA`, hardcode a
 * path such as `/proc/` or `.config/`, or inspect the filesystem for an
 * external binary. `scripts/audit.mjs` R13 enforces the boundary.
 *
 * Two properties are deliberate:
 *
 *  - **Nothing here spawns a process.** A capability is resolved with
 *    `access(X_OK)` over `PATH` (or `PATHEXT` on Windows), memoised per name, and
 *    an injected resolver can replace the whole registry in tests. P12's PDF
 *    fallback asks "is pdftotext installed?" — asking must never run it.
 *
 *  - **A missing capability is data, never an exception.** `capability()` returns
 *    the absolute path or `null`; the caller decides whether it has a CDP/JS
 *    fallback (PO1).
 *
 * The default context is memoised. `PI_CHROME_SEARCH_HOST_PLATFORM` overrides
 * only `platform()` so the offline suite can prove it does not assume Linux
 * (`darwin`/`win32` runs, gate V15.6); it is diagnostic, not user config, and
 * never changes paths by itself.
 */

import { accessSync, constants } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { isAbsolute, join } from "node:path";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Test seam for the capability probe: `access(path, mode)` with no side effects. */
export interface HostFileSystem {
  access(path: string, mode: number): boolean;
}

export interface HostContext {
  platform: NodeJS.Platform;
  /** Absolute home directory. Never read from `$HOME` directly. */
  home: string;
  env: NodeJS.ProcessEnv;
  fs: HostFileSystem;
  /**
   * Whole-registry override (tests, locked-down hosts). When set,
   * `capability()` never touches `env.PATH` or the filesystem.
   */
  capabilities?: (name: CapabilityName) => string | null;
}

export interface HostContextOverrides {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  fs?: HostFileSystem;
  capabilities?: (name: CapabilityName) => string | null;
}

/** `fs.constants.X_OK` with a name, because a bare `1` at a call site reads as a bug. */
export const ACCESS_EXECUTE = constants.X_OK;

const KNOWN_PLATFORMS: readonly NodeJS.Platform[] = [
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
];

/** Diagnostic-only override used by gate V15.6; not a user-facing setting. */
export const HOST_PLATFORM_ENV = "PI_CHROME_SEARCH_HOST_PLATFORM";

const systemFileSystem: HostFileSystem = {
  access(path, mode) {
    try {
      accessSync(path, mode);
      return true;
    } catch {
      return false;
    }
  },
};

function platformFrom(env: NodeJS.ProcessEnv): NodeJS.Platform {
  const raw = env[HOST_PLATFORM_ENV]?.trim();
  if (raw !== undefined && raw !== "" && (KNOWN_PLATFORMS as readonly string[]).includes(raw)) {
    return raw as NodeJS.Platform;
  }
  return osPlatform();
}

export function createHostContext(overrides: HostContextOverrides = {}): HostContext {
  const env = overrides.env ?? process.env;
  return {
    platform: overrides.platform ?? platformFrom(env),
    home: overrides.home ?? homedir(),
    env,
    fs: overrides.fs ?? systemFileSystem,
    ...(overrides.capabilities === undefined ? {} : { capabilities: overrides.capabilities }),
  };
}

let defaultContext: HostContext | undefined;

/** The process-wide host context. Built once; tests use `createHostContext`. */
export function host(): HostContext {
  defaultContext ??= createHostContext();
  return defaultContext;
}

/** Test seam: forget the memoised context after changing the environment. */
export function resetHostContext(): void {
  defaultContext = undefined;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Expand `~`, `~/…` and `~\…`; a relative path is relative to the home
 * directory, exactly like the pre-P15 helpers. Accepting `~\` on every platform
 * keeps a Windows-style override working when the value travelled through a
 * config file.
 */
export function expandHome(path: string, ctx: HostContext = host()): string {
  if (path === "~") return ctx.home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(ctx.home, path.slice(2));
  return isAbsolute(path) ? path : join(ctx.home, path);
}

/** Inverse of {@link expandHome} for human-readable doctor output. */
export function tildify(path: string, ctx: HostContext = host()): string {
  if (path === ctx.home) return "~";
  const sep = ctx.platform === "win32" ? "\\" : "/";
  return path.startsWith(`${ctx.home}${sep}`) ? `~${sep}${path.slice(ctx.home.length + 1)}` : path;
}

/**
 * `$PI_CODING_AGENT_DIR` (expanded) or `~/.pi/agent`. One definition for the
 * config, lock, state, artifacts and log paths; the CLI and extension cannot
 * drift apart.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env, ctx: HostContext = host()): string {
  const raw = env.PI_CODING_AGENT_DIR?.trim();
  const dir = raw !== undefined && raw !== "" ? expandHome(raw, ctx) : join(ctx.home, ".pi", "agent");
  return dir;
}

/**
 * Profile suffixes relative to the platform root, in precedence order:
 * Chrome stable → beta → dev → Chromium → Brave → Edge. The Linux column is
 * byte-identical to the pre-P15 list, so the current user's discovery order did
 * not change in this phase.
 */
const LINUX_PROFILE_SUFFIXES = [
  ".config/google-chrome",
  ".config/google-chrome-beta",
  ".config/google-chrome-unstable",
  ".config/chromium",
  ".config/chromium-browser",
  ".config/BraveSoftware/Brave-Browser",
  ".config/microsoft-edge",
] as const;

const DARWIN_PROFILE_SUFFIXES = [
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Google/Chrome Beta",
  "Library/Application Support/Google/Chrome Dev",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware/Brave-Browser",
  "Library/Application Support/Microsoft Edge",
] as const;

const WIN32_PROFILE_SUFFIXES = [
  "Google/Chrome/User Data",
  "Google/Chrome Beta/User Data",
  "Google/Chrome Dev/User Data",
  "Chromium/User Data",
  "BraveSoftware/Brave-Browser/User Data",
  "Microsoft/Edge/User Data",
] as const;

function profileSuffixes(p: NodeJS.Platform): readonly string[] {
  if (p === "darwin") return DARWIN_PROFILE_SUFFIXES;
  if (p === "win32") return WIN32_PROFILE_SUFFIXES;
  return LINUX_PROFILE_SUFFIXES;
}

function profileRoot(ctx: HostContext): string {
  if (ctx.platform !== "win32") return ctx.home;
  const local = ctx.env.LOCALAPPDATA?.trim();
  return local !== undefined && local !== "" ? local : join(ctx.home, "AppData", "Local");
}

/**
 * Candidate profile directories for CDP discovery. `PI_CHROME_SEARCH_PROFILE`
 * (the configured launch profile) is inspected first when set; discovery only
 * reads `DevToolsActivePort` from it and never writes to a profile.
 */
export function profileCandidates(ctx: HostContext = host()): string[] {
  const root = profileRoot(ctx);
  const candidates = profileSuffixes(ctx.platform).map((suffix) => join(root, suffix));
  const override = ctx.env.PI_CHROME_SEARCH_PROFILE?.trim();
  if (override === undefined || override === "") return candidates;
  const first = expandHome(override, ctx);
  return [first, ...candidates.filter((candidate) => candidate !== first)];
}

// ---------------------------------------------------------------------------
// Browser brand (PO5)
// ---------------------------------------------------------------------------

export type BrowserBrandId = "chrome" | "chromium" | "brave" | "edge";

export interface BrowserBrand {
  id: BrowserBrandId;
  label: string;
  /** URI scheme for the remote-debugging page, e.g. `edge://inspect`. */
  scheme: string;
}

const BROWSER_BRANDS: ReadonlyArray<{ brand: BrowserBrand; patterns: readonly RegExp[] }> = [
  {
    brand: { id: "brave", label: "Brave", scheme: "brave" },
    patterns: [/brave-browser/i, /bravesoftware/i],
  },
  {
    brand: { id: "edge", label: "Microsoft Edge", scheme: "edge" },
    patterns: [/microsoft-edge/i, /microsoft edge/i, /\/edge\//i],
  },
  {
    brand: { id: "chromium", label: "Chromium", scheme: "chromium" },
    patterns: [/chromium/i],
  },
  {
    brand: { id: "chrome", label: "Chrome", scheme: "chrome" },
    patterns: [/google-chrome/i, /google\/chrome/i, /google chrome/i],
  },
];

/**
 * Detect the browser family from a profile directory. Detection is deliberately
 * path-based: it must work before any socket exists, and it only feeds hints.
 */
export function browserBrandFor(profileDir: string | null | undefined): BrowserBrand | null {
  if (profileDir === null || profileDir === undefined || profileDir === "") return null;
  for (const { brand, patterns } of BROWSER_BRANDS) {
    if (patterns.some((pattern) => pattern.test(profileDir))) return brand;
  }
  return null;
}

/** `edge://inspect/#remote-debugging`, or the Chrome URL when the brand is unknown. */
export function inspectUrl(brand: BrowserBrand | null): string {
  const scheme = brand?.scheme ?? "chrome";
  return `${scheme}://inspect/#remote-debugging`;
}

/**
 * Brand-aware recovery hint for `E_CDP_UNAVAILABLE`. When discovery observed a
 * single family, the hint names that family's inspect page; otherwise it stays
 * generic and lists the schemes instead of pretending every user runs Chrome.
 */
export function cdpAllowHint(brand: BrowserBrand | null): string {
  const url =
    brand === null
      ? "chrome://inspect/#remote-debugging (edge://, brave:// or chromium:// for the other Chromium-family browsers)"
      : inspectUrl(brand);
  return (
    `open ${url}, tick "Discover network targets" and click Allow, then retry; ` +
    "or set PI_CHROME_CDP_WS=ws://127.0.0.1:<port><path>"
  );
}

// ---------------------------------------------------------------------------
// Process facts (PO4)
// ---------------------------------------------------------------------------

export interface ProcessProbe {
  /** `process.kill`-shaped, signal 0 only: checking liveness never signals. */
  kill(pid: number, signal: 0): void;
}

const systemProcessProbe: ProcessProbe = {
  kill(pid) {
    // The argument is deliberately not forwarded: the only signal this module
    // can ever send is 0 (existence check), so the audit pattern is literal and
    // a future edit cannot turn this into a real signal by accident.
    process.kill(pid, 0);
  },
};

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Portable liveness: `kill(pid, 0)` succeeds for a process we may signal and
 * throws `EPERM` for one we may not (both mean alive), `ESRCH` for a dead one.
 * Any other error is treated as alive, leaving the heartbeat as the authority —
 * a lock must not be reclaimed on an unclassifiable failure.
 */
export function isProcessAlive(pid: number, probe: ProcessProbe = systemProcessProbe): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    probe.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

// ---------------------------------------------------------------------------
// Executable capabilities (PO1)
// ---------------------------------------------------------------------------

/**
 * Declared names only: a typo cannot reach `PATH`, and the list is the whole
 * shell-out surface of the product. P11/P12 add consumers, not names.
 */
export const DECLARED_CAPABILITIES = [
  "pdftotext",
  "mutool",
  "notify-send",
  "gdbus",
  "dbus-send",
  "osascript",
  "powershell",
  "wmctrl",
  "xdotool",
  "kdotool",
  "hyprctl",
  "swaymsg",
  "gio",
] as const;

export type CapabilityName = (typeof DECLARED_CAPABILITIES)[number];

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

const capabilityCache = new WeakMap<HostContext, Map<CapabilityName, string | null>>();

function memoCapability(
  ctx: HostContext,
  name: CapabilityName,
  resolve: () => string | null,
): string | null {
  let cache = capabilityCache.get(ctx);
  if (cache === undefined) {
    cache = new Map();
    capabilityCache.set(ctx, cache);
  }
  if (cache.has(name)) return cache.get(name) ?? null;
  const value = resolve();
  cache.set(name, value);
  return value;
}

function executableNames(name: string, ctx: HostContext): string[] {
  if (ctx.platform !== "win32") return [name];
  if (/\.[a-z0-9]+$/i.test(name)) return [name];
  const raw = ctx.env.PATHEXT?.trim();
  const extensions = (raw === undefined || raw === "" ? DEFAULT_PATHEXT : raw)
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

function resolveOnPath(name: string, ctx: HostContext): string | null {
  const rawPath = ctx.env.PATH ?? ctx.env.Path ?? "";
  const delimiter = ctx.platform === "win32" ? ";" : ":";
  const dirs = rawPath
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir !== "");
  const files = executableNames(name, ctx);
  for (const dir of dirs) {
    for (const file of files) {
      const candidate = join(dir, file);
      if (ctx.fs.access(candidate, ACCESS_EXECUTE)) return candidate;
    }
  }
  return null;
}

/**
 * Absolute path of a declared executable, or `null`. Memoised per context, so a
 * repeated `capability("pdftotext")` is a map lookup; install a package and
 * start a new process to see it.
 */
export function capability(name: CapabilityName, ctx: HostContext = host()): string | null {
  // Checked before either resolution path: an injected resolver must not be able
  // to turn a declared name into an arbitrary path probe either.
  if (name.includes("/") || name.includes("\\")) return null;
  return memoCapability(ctx, name, () => {
    if (ctx.capabilities !== undefined) return ctx.capabilities(name);
    return resolveOnPath(name, ctx);
  });
}
