/**
 * Host layer matrix (PLAN v2 P15, gates V15.1–V15.6).
 *
 * Every case builds its own `HostContext`: the real home directory, the real
 * `PATH` and the real filesystem are never consulted (PO6). The platform is a
 * parameter, so the Linux/macOS/Windows tables are asserted on one machine.
 */

import assert from "node:assert/strict";
import { platform as osPlatform } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACCESS_EXECUTE,
  DECLARED_CAPABILITIES,
  HOST_PLATFORM_ENV,
  agentDir,
  browserBrandFor,
  capability,
  cdpAllowHint,
  createHostContext,
  expandHome,
  inspectUrl,
  isProcessAlive,
  profileCandidates,
  tildify,
  type CapabilityName,
  type HostContext,
  type ProcessProbe,
} from "../../src/runtime/host.ts";

const LINUX_HOME = "/home/test";
const DARWIN_HOME = "/Users/test";
const WIN_HOME = "C:\\Users\\test";

function linux(env: NodeJS.ProcessEnv = {}): HostContext {
  return createHostContext({ platform: "linux", home: LINUX_HOME, env });
}

function darwin(env: NodeJS.ProcessEnv = {}): HostContext {
  return createHostContext({ platform: "darwin", home: DARWIN_HOME, env });
}

function win32(env: NodeJS.ProcessEnv = {}): HostContext {
  return createHostContext({
    platform: "win32",
    home: WIN_HOME,
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", ...env },
  });
}

/** Compare paths independent of the separator node:path picked on this host. */
function slashed(paths: readonly string[]): string[] {
  return paths.map((path) => path.replaceAll("\\", "/"));
}

const capabilityProbe = (
  present: ReadonlySet<string>,
  calls: string[] = [],
): HostContext["fs"] => ({
  access(path, mode) {
    calls.push(`${path}:${mode}`);
    return present.has(path);
  },
});

// ---------------------------------------------------------------------------
// V15.1 — profile candidates per platform
// ---------------------------------------------------------------------------

test("V15.1 linux profile candidates are byte-identical to the pre-P15 list", () => {
  assert.deepEqual(profileCandidates(linux()), [
    "/home/test/.config/google-chrome",
    "/home/test/.config/google-chrome-beta",
    "/home/test/.config/google-chrome-unstable",
    "/home/test/.config/chromium",
    "/home/test/.config/chromium-browser",
    "/home/test/.config/BraveSoftware/Brave-Browser",
    "/home/test/.config/microsoft-edge",
  ]);
});

test("V15.1 macOS candidates use Application Support with the same precedence", () => {
  assert.deepEqual(profileCandidates(darwin()), [
    "/Users/test/Library/Application Support/Google/Chrome",
    "/Users/test/Library/Application Support/Google/Chrome Beta",
    "/Users/test/Library/Application Support/Google/Chrome Dev",
    "/Users/test/Library/Application Support/Chromium",
    "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
    "/Users/test/Library/Application Support/Microsoft Edge",
  ]);
});

test("V15.1 windows candidates resolve under LOCALAPPDATA, with a home fallback", () => {
  const explicit = profileCandidates(win32());
  assert.equal(explicit.length, 6);
  assert.deepEqual(slashed(explicit), [
    "C:/Users/test/AppData/Local/Google/Chrome/User Data",
    "C:/Users/test/AppData/Local/Google/Chrome Beta/User Data",
    "C:/Users/test/AppData/Local/Google/Chrome Dev/User Data",
    "C:/Users/test/AppData/Local/Chromium/User Data",
    "C:/Users/test/AppData/Local/BraveSoftware/Brave-Browser/User Data",
    "C:/Users/test/AppData/Local/Microsoft/Edge/User Data",
  ]);

  const fallback = createHostContext({ platform: "win32", home: WIN_HOME, env: {} });
  assert.ok(slashed(profileCandidates(fallback))[0]!.startsWith("C:/Users/test/AppData/Local/"));
});

test("V15.1 PI_CHROME_SEARCH_PROFILE is inspected first, with ~/~\\ expansion and no duplicate", () => {
  const override = profileCandidates(linux({ PI_CHROME_SEARCH_PROFILE: "~/custom-profile" }));
  assert.equal(override[0], "/home/test/custom-profile");
  assert.equal(override.length, 8);

  const duplicate = profileCandidates(
    linux({ PI_CHROME_SEARCH_PROFILE: "~/.config/google-chrome" }),
  );
  assert.equal(duplicate.length, 7, "the override must not duplicate a table entry");
  assert.equal(duplicate[0], "/home/test/.config/google-chrome");

  const windows = profileCandidates(win32({ PI_CHROME_SEARCH_PROFILE: "~\\custom" }));
  assert.equal(windows[0], join(WIN_HOME, "custom"));
});

// ---------------------------------------------------------------------------
// V15.2 — home/config paths (the live doctor half is in evidence/P15.md)
// ---------------------------------------------------------------------------

test("expandHome accepts ~, ~/ and ~\\ and treats relative paths as home-relative", () => {
  const ctx = linux();
  assert.equal(expandHome("~", ctx), LINUX_HOME);
  assert.equal(expandHome("~/state", ctx), join(LINUX_HOME, "state"));
  assert.equal(expandHome("~\\state", ctx), join(LINUX_HOME, "state"));
  assert.equal(expandHome("state", ctx), join(LINUX_HOME, "state"));
  assert.equal(expandHome("/var/state", ctx), "/var/state");

  const winPath = expandHome("~\\state", win32());
  assert.equal(winPath, join(WIN_HOME, "state"));
});

test("agentDir is one definition for config, lock, state, artifacts and logs", () => {
  assert.equal(agentDir({}, linux()), join(LINUX_HOME, ".pi", "agent"));
  assert.equal(
    agentDir({ PI_CODING_AGENT_DIR: "~/agent" }, linux()),
    join(LINUX_HOME, "agent"),
  );
  assert.equal(
    agentDir({ PI_CODING_AGENT_DIR: "~\\agent" }, win32()),
    join(WIN_HOME, "agent"),
  );
});

test("tildify is separator-aware and leaves unrelated paths alone", () => {
  assert.equal(tildify("/home/test", linux()), "~");
  assert.equal(tildify("/home/test/a/b", linux()), "~/a/b");
  assert.equal(tildify("/var/lib", linux()), "/var/lib");
  assert.equal(tildify("C:\\Users\\test\\a", win32()), "~\\a");
  assert.equal(tildify("C:\\other", win32()), "C:\\other");
});

test("the platform override is read from the environment and ignored when invalid", () => {
  const stubbed = createHostContext({ home: "/home/test", env: { [HOST_PLATFORM_ENV]: "darwin" } });
  assert.equal(stubbed.platform, "darwin");
  const bogus = createHostContext({
    home: "/home/test",
    env: { [HOST_PLATFORM_ENV]: "plan9" },
  });
  assert.equal(bogus.platform, osPlatform(), "an invalid override falls back to the real platform");
});

// ---------------------------------------------------------------------------
// V15.3 — portable liveness with an injected kill
// ---------------------------------------------------------------------------

function probe(result: Error | null, seen: Array<[number, 0]> = []): ProcessProbe {
  return {
    kill(pid, signal) {
      seen.push([pid, signal]);
      if (result !== null) throw result;
    },
  };
}

function errno(code: string): Error {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("V15.3 a live pid is alive and the probe only ever uses signal 0", () => {
  const seen: Array<[number, 0]> = [];
  assert.equal(isProcessAlive(4242, probe(null, seen)), true);
  assert.deepEqual(seen, [[4242, 0]]);
});

test("V15.3 ESRCH is dead, EPERM is alive (exists, not ours)", () => {
  assert.equal(isProcessAlive(4242, probe(errno("ESRCH"))), false);
  assert.equal(isProcessAlive(1, probe(errno("EPERM"))), true);
});

test("V15.3 an unclassifiable error leaves the heartbeat in charge (alive)", () => {
  assert.equal(isProcessAlive(4242, probe(errno("EINVAL"))), true);
});

test("V15.3 invalid pids are dead without probing", () => {
  const seen: Array<[number, 0]> = [];
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    assert.equal(isProcessAlive(pid, probe(null, seen)), false, `pid ${pid}`);
  }
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------------------
// V15.4 — capability registry (the live host probe is in evidence/P15.md)
// ---------------------------------------------------------------------------

test("V15.4 an empty capability resolver reports every declared name as absent", () => {
  const ctx = createHostContext({
    platform: "linux",
    home: LINUX_HOME,
    env: { PATH: "/usr/bin:/bin" },
    fs: capabilityProbe(new Set()),
  });
  for (const name of DECLARED_CAPABILITIES) {
    assert.equal(capability(name, ctx), null, name);
  }
});

test("V15.4 POSIX resolution walks PATH in order with X_OK only", () => {
  const calls: string[] = [];
  const ctx = createHostContext({
    platform: "linux",
    home: LINUX_HOME,
    env: { PATH: "/one:/two" },
    fs: capabilityProbe(new Set([join("/two", "pdftotext")]), calls),
  });
  assert.equal(capability("pdftotext", ctx), join("/two", "pdftotext"));
  assert.deepEqual(calls, [
    `${join("/one", "pdftotext")}:${ACCESS_EXECUTE}`,
    `${join("/two", "pdftotext")}:${ACCESS_EXECUTE}`,
  ]);
});

test("V15.4 Windows resolution uses PATHEXT", () => {
  const calls: string[] = [];
  const ctx = createHostContext({
    platform: "win32",
    home: WIN_HOME,
    env: { PATH: "C:\\bin", PATHEXT: ".COM;.EXE;.BAT" },
    fs: capabilityProbe(new Set([join("C:\\bin", "pdftotext.EXE")]), calls),
  });
  assert.equal(capability("pdftotext", ctx), join("C:\\bin", "pdftotext.EXE"));
  assert.ok(calls.some((call) => call.includes("pdftotext.EXE")));
});

test("V15.4 a resolver is memoised: one decision per name per context", () => {
  let calls = 0;
  const ctx = createHostContext({
    platform: "linux",
    home: LINUX_HOME,
    env: {},
    capabilities: (name) => {
      calls += 1;
      return name === "gio" ? "/usr/bin/gio" : null;
    },
  });
  assert.equal(capability("gio", ctx), "/usr/bin/gio");
  assert.equal(capability("gio", ctx), "/usr/bin/gio");
  assert.equal(capability("wmctrl", ctx), null);
  assert.equal(capability("wmctrl", ctx), null);
  assert.equal(calls, 2);
});

test("V15.4 a declared name is never turned into a path traversal", () => {
  const calls: string[] = [];
  const ctx = createHostContext({
    platform: "linux",
    home: LINUX_HOME,
    env: { PATH: "/usr/bin" },
    fs: capabilityProbe(new Set(["/usr/bin/sh"]), calls),
  });
  assert.equal(capability("../bin/sh" as CapabilityName, ctx), null);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// PO5 — brand-aware hints
// ---------------------------------------------------------------------------

test("PO5 the brand is detected from the profile dir and drives the hint", () => {
  assert.equal(browserBrandFor("/home/u/.config/microsoft-edge")?.id, "edge");
  assert.equal(browserBrandFor("/home/u/.config/BraveSoftware/Brave-Browser")?.id, "brave");
  assert.equal(browserBrandFor("/home/u/.config/chromium")?.id, "chromium");
  assert.equal(browserBrandFor("/home/u/.config/google-chrome")?.id, "chrome");
  assert.equal(browserBrandFor("/Users/u/Library/Application Support/Google/Chrome")?.id, "chrome");
  assert.equal(browserBrandFor("/nowhere/at/all"), null);
  assert.equal(browserBrandFor(undefined), null);

  assert.equal(inspectUrl(browserBrandFor("/home/u/.config/microsoft-edge")), "edge://inspect/#remote-debugging");
  const edge = cdpAllowHint(browserBrandFor("/home/u/.config/microsoft-edge"));
  assert.match(edge, /edge:\/\/inspect\/#remote-debugging/);
  assert.doesNotMatch(edge, /open chrome:\/\//);

  const generic = cdpAllowHint(null);
  for (const needle of [
    "chrome://inspect/#remote-debugging",
    "edge://",
    "brave://",
    "chromium://",
    "PI_CHROME_CDP_WS",
  ]) {
    assert.ok(generic.includes(needle), `generic hint lacks ${needle}: ${generic}`);
  }
});
