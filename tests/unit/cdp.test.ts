/**
 * CDP discovery and the per-slot read lock.
 *
 * Discovery is the only way in: env URL → env ports → `DevToolsActivePort` in
 * the profile dirs → configured port scan, loopback only. The lock is what keeps
 * two concurrent reads off one tab.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type DevToolsActivePortEndpoint, type DevToolsActivePortResult, type DiscoverOptions, type FetchJson, type ReadTextFile, discoverEndpoint, parseDevToolsActivePort } from "../../src/cdp/discovery.ts";
import { createKeyedLock, pageLockFor, readSlotKeys } from "../../src/cdp/page-lock.ts";
import { type ErrorCode, WebSearchError, isWebSearchError } from "../../src/runtime/error-codes.ts";

// ---------------------------------------------------------------------------
// from tests/unit/discovery.test.ts
// ---------------------------------------------------------------------------
{
const VALID_PATH = "/devtools/browser/5f0c9a52-1d3e-4b7a-9c6e-0a1b2c3d4e5f";
const VALID_WS = `ws://127.0.0.1:9222${VALID_PATH}`;

/**
 * Sanitized shapes of `DevToolsActivePort`, inlined: one file per Chrome quirk
 * (CRLF, blank lines, a missing/invalid path, a NUL byte). No fixture directory,
 * so the file shape stays next to the assertions that read it.
 */
const PORT_FILES: Readonly<Record<string, string>> = {
  "valid.txt": `9222\n${VALID_PATH}\n`,
  "valid-crlf.txt": `9222\r\n/devtools/browser/8a7b6c5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d\r\n`,
  "blank-lines.txt": `\n9223\n\n/devtools/browser/8a7b6c5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d\n\n`,
  "path-without-slash.txt": `9224\ndevtools/browser/5f0c9a52-1d3e-4b7a-9c6e-0a1b2c3d4e5f\n`,
  "non-numeric-port.txt": `not-a-port\n${VALID_PATH}\n`,
  "out-of-range-port.txt": `70000\n${VALID_PATH}\n`,
  "missing-path.txt": `9222\n`,
  "invalid-path.txt": `9225\n/devtools/browser/has space\n`,
  "control-char-path.txt": `9222\n${VALID_PATH}\0tail\n`,
};

function fixture(name: string): string {
  const value = PORT_FILES[name];
  assert.ok(value !== undefined, `unknown DevToolsActivePort fixture: ${name}`);
  return value;
}

function versionPayload(wsUrl: string): unknown {
  return {
    Browser: "Chrome/157.0.8103.38",
    "Protocol-Version": "1.3",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "V8-Version": "15.7.0",
    "WebKit-Version": "537.36",
    webSocketDebuggerUrl: wsUrl,
  };
}

interface FetchCall {
  url: string;
  timeoutMs: number;
}

function fakeFetch(
  handler: (url: string) => unknown,
  calls: FetchCall[] = [],
): FetchJson {
  return async (url, timeoutMs) => {
    calls.push({ url, timeoutMs });
    return handler(url);
  };
}

function fileReader(files: Record<string, string>, opened: string[] = []): ReadTextFile {
  return async (path) => {
    opened.push(path);
    const content = files[path];
    if (content === undefined) {
      const error: NodeJS.ErrnoException = new Error(
        `ENOENT: no such file or directory, open '${path}'`,
      );
      error.code = "ENOENT";
      throw error;
    }
    return content;
  };
}

/** Defaults that never touch the network or the real profile. */
function baseOptions(overrides: DiscoverOptions = {}): DiscoverOptions {
  return {
    env: {},
    profileDirs: [],
    ports: [],
    timeoutMs: 50,
    readFile: fileReader({}),
    fetchJson: fakeFetch(() => {
      throw new Error("unexpected /json/version probe");
    }),
    ...overrides,
  };
}

function expectOk(result: DevToolsActivePortResult): DevToolsActivePortEndpoint {
  if (!result.ok) assert.fail(`expected a parsed endpoint, got reason "${result.reason}"`);
  return result.endpoint;
}

function expectReason(result: DevToolsActivePortResult): string {
  if (result.ok) assert.fail(`expected a parse failure, got ${result.endpoint.wsUrl}`);
  return result.reason;
}

async function expectError(promise: Promise<unknown>, code: ErrorCode): Promise<WebSearchError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isWebSearchError(error), `expected WebSearchError, got ${String(error)}`);
    assert.equal(error.details.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test("parseDevToolsActivePort accepts LF, CRLF, padding and blank lines", () => {
  const lf = expectOk(parseDevToolsActivePort(fixture("valid.txt")));
  assert.equal(lf.port, 9222);
  assert.equal(lf.path, VALID_PATH);
  assert.equal(lf.wsUrl, VALID_WS);

  const crlf = expectOk(parseDevToolsActivePort(fixture("valid-crlf.txt")));
  assert.equal(crlf.port, 9222);
  assert.equal(
    crlf.wsUrl,
    "ws://127.0.0.1:9222/devtools/browser/8a7b6c5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d",
  );

  const blank = expectOk(parseDevToolsActivePort(fixture("blank-lines.txt")));
  assert.equal(blank.port, 9223);

  const padded = expectOk(parseDevToolsActivePort("  9222  \r\n\t/devtools/browser/abc  \r\n"));
  assert.equal(padded.wsUrl, "ws://127.0.0.1:9222/devtools/browser/abc");
});

test("parseDevToolsActivePort normalises a path without a leading slash", () => {
  const result = expectOk(parseDevToolsActivePort(fixture("path-without-slash.txt")));
  assert.equal(result.port, 9224);
  assert.equal(result.path, VALID_PATH);
  assert.equal(result.wsUrl, "ws://127.0.0.1:9224" + VALID_PATH);
});

test("parseDevToolsActivePort reports malformed files instead of throwing", () => {
  assert.equal(
    expectReason(parseDevToolsActivePort(fixture("non-numeric-port.txt"))),
    "port-not-numeric",
  );
  assert.equal(
    expectReason(parseDevToolsActivePort(fixture("out-of-range-port.txt"))),
    "port-out-of-range",
  );
  assert.equal(
    expectReason(parseDevToolsActivePort(fixture("missing-path.txt"))),
    "missing-path",
  );
  assert.equal(
    expectReason(parseDevToolsActivePort(fixture("invalid-path.txt"))),
    "invalid-path",
  );
  assert.equal(expectReason(parseDevToolsActivePort("")), "empty");
  assert.equal(expectReason(parseDevToolsActivePort(" \r\n\t\r\n")), "empty");

  for (const junk of [
    "\u0000\u0001",
    "0\n/devtools/browser/x",
    "-1\n/devtools/browser/x",
    "65536\n/devtools/browser/x",
    "9222\n",
    "9222\n/",
    "9222\n/devtools/browser/x?y=1",
  ]) {
    assert.doesNotThrow(() => parseDevToolsActivePort(junk), `threw on ${JSON.stringify(junk)}`);
  }

  assert.equal(expectOk(parseDevToolsActivePort("1\n/devtools/browser/x")).port, 1);
  assert.equal(expectOk(parseDevToolsActivePort("65535\n/devtools/browser/x")).port, 65535);
});

test("PI_CHROME_CDP_WS wins over env ports and DevToolsActivePort files", async () => {
  const calls: FetchCall[] = [];
  const opened: string[] = [];
  const dir = "/home/test/.config/google-chrome";
  const endpoint = await discoverEndpoint(
    baseOptions({
      env: {
        PI_CHROME_CDP_WS: "ws://127.0.0.1:9333/devtools/browser/env-wins",
        PI_CHROME_CDP_PORTS: "9222",
      },
      profileDirs: [dir],
      fetchJson: fakeFetch(
        () => versionPayload("ws://127.0.0.1:9222/devtools/browser/probe"),
        calls,
      ),
      readFile: fileReader({ [join(dir, "DevToolsActivePort")]: fixture("valid.txt") }, opened),
    }),
  );

  assert.equal(endpoint.source, "env-ws");
  assert.equal(endpoint.port, 9333);
  assert.equal(endpoint.wsUrl, "ws://127.0.0.1:9333/devtools/browser/env-wins");
  assert.equal(calls.length, 0, "env-ws must not probe /json/version");
  assert.equal(opened.length, 0, "env-ws must not read profile dirs");
});

test("an explicit config ws beats the raw env var but is still loopback-checked", async () => {
  const endpoint = await discoverEndpoint(
    baseOptions({
      ws: "ws://127.0.0.1:9555/devtools/browser/config",
      env: { PI_CHROME_CDP_WS: "ws://127.0.0.1:9666/devtools/browser/env" },
    }),
  );
  assert.equal(endpoint.port, 9555);
  assert.equal(endpoint.wsUrl, "ws://127.0.0.1:9555/devtools/browser/config");

  const error = await expectError(
    discoverEndpoint(baseOptions({ ws: "ws://192.0.2.10:9555/devtools/browser/config" })),
    "E_CONFIG",
  );
  assert.match(error.details.message ?? "", /cdp\.ws/);
});

test("loopback aliases localhost and [::1] are accepted", async () => {
  for (const ws of [
    "ws://localhost:9222/devtools/browser/localhost",
    "ws://[::1]:9222/devtools/browser/ipv6",
    "wss://127.0.0.1:9443/devtools/browser/secure",
  ]) {
    const endpoint = await discoverEndpoint(baseOptions({ env: { PI_CHROME_CDP_WS: ws } }));
    assert.equal(endpoint.source, "env-ws");
    assert.equal(endpoint.wsUrl, ws);
  }
});

test("a non-loopback or malformed PI_CHROME_CDP_WS is E_CONFIG", async () => {
  const remote = await expectError(
    discoverEndpoint(
      baseOptions({ env: { PI_CHROME_CDP_WS: "ws://192.0.2.10:9222/devtools/browser/x" } }),
    ),
    "E_CONFIG",
  );
  assert.equal(remote.details.stage, "config");
  assert.equal(remote.details.retryable, false);
  assert.ok(remote.details.hint.includes("127.0.0.1"), remote.details.hint);
  assert.match(remote.details.message ?? "", /192\.0\.2\.10/);

  await expectError(
    discoverEndpoint(
      baseOptions({ env: { PI_CHROME_CDP_WS: "http://127.0.0.1:9222/devtools/browser/x" } }),
    ),
    "E_CONFIG",
  );
  await expectError(
    discoverEndpoint(baseOptions({ env: { PI_CHROME_CDP_WS: "ws://127.0.0.1:9222" } })),
    "E_CONFIG",
  );
});

test("PI_CHROME_CDP_PORTS probes /json/version in order and uses webSocketDebuggerUrl", async () => {
  const calls: FetchCall[] = [];
  const opened: string[] = [];
  const dir = "/home/test/.config/google-chrome";
  const fetchJson = fakeFetch((url) => {
    if (url === "http://127.0.0.1:9444/json/version") {
      return versionPayload("ws://127.0.0.1:9444/devtools/browser/env-port");
    }
    throw new Error("ECONNREFUSED");
  }, calls);

  const endpoint = await discoverEndpoint(
    baseOptions({
      env: { PI_CHROME_CDP_PORTS: " 9333 , 9444 " },
      profileDirs: [dir],
      readFile: fileReader({ [join(dir, "DevToolsActivePort")]: fixture("valid.txt") }, opened),
      timeoutMs: 250,
      fetchJson,
    }),
  );

  assert.equal(opened.length, 0, "env ports take precedence over DevToolsActivePort files");
  assert.equal(endpoint.source, "env-ports");
  assert.equal(endpoint.port, 9444);
  assert.equal(endpoint.wsUrl, "ws://127.0.0.1:9444/devtools/browser/env-port");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["http://127.0.0.1:9333/json/version", "http://127.0.0.1:9444/json/version"],
  );
  assert.ok(
    calls.every((call) => call.timeoutMs === 250),
    "each probe must receive the injected timeout",
  );
});

test("malformed PI_CHROME_CDP_PORTS is E_CONFIG naming the variable", async () => {
  for (const value of ["9222,abc", "0", "70000"]) {
    const error = await expectError(
      discoverEndpoint(baseOptions({ env: { PI_CHROME_CDP_PORTS: value } })),
      "E_CONFIG",
    );
    assert.equal(error.details.stage, "config");
    assert.match(error.details.message ?? "", /PI_CHROME_CDP_PORTS/);
  }
});

test("a DevToolsActivePort file wins while /json/version is disabled (user's Chrome state)", async () => {
  const calls: FetchCall[] = [];
  const opened: string[] = [];
  const dir = "/home/test/.config/google-chrome";
  const fetchJson = fakeFetch(() => {
    throw new Error("ECONNREFUSED: /json/version is disabled in chrome://inspect mode");
  }, calls);
  const readFile = fileReader(
    { [join(dir, "DevToolsActivePort")]: fixture("valid.txt") },
    opened,
  );

  const endpoint = await discoverEndpoint(
    baseOptions({
      env: { PI_CHROME_CDP_PORTS: "9222" },
      ports: [9222],
      profileDirs: [dir],
      fetchJson,
      readFile,
    }),
  );

  assert.equal(endpoint.source, "devtools-active-port");
  assert.equal(endpoint.profileDir, dir);
  assert.equal(endpoint.port, 9222);
  assert.equal(endpoint.wsUrl, VALID_WS);
  assert.equal(calls.length, 1, "the env port was probed and failed before the file was read");
  assert.equal(calls[0].url, "http://127.0.0.1:9222/json/version");
  assert.deepEqual(opened, [join(dir, "DevToolsActivePort")]);
});

test("a malformed DevToolsActivePort file is skipped, not fatal", async () => {
  const bad = "/home/test/.config/google-chrome";
  const good = "/home/test/.config/chromium";
  const opened: string[] = [];
  const readFile = fileReader(
    {
      [join(bad, "DevToolsActivePort")]: fixture("non-numeric-port.txt"),
      [join(good, "DevToolsActivePort")]: fixture("valid.txt"),
    },
    opened,
  );

  const endpoint = await discoverEndpoint(
    baseOptions({ profileDirs: [bad, good], readFile }),
  );

  assert.equal(endpoint.source, "devtools-active-port");
  assert.equal(endpoint.profileDir, good);
  assert.equal(endpoint.wsUrl, VALID_WS);
  assert.deepEqual(opened, [
    join(bad, "DevToolsActivePort"),
    join(good, "DevToolsActivePort"),
  ]);
});

test("profile dirs are checked in the given order and the first valid file wins", async () => {
  const first = "/home/test/.config/google-chrome";
  const second = "/home/test/.config/google-chrome-beta";
  const opened: string[] = [];
  const readFile = fileReader(
    {
      [join(first, "DevToolsActivePort")]: fixture("valid.txt"),
      [join(second, "DevToolsActivePort")]: fixture("blank-lines.txt"),
    },
    opened,
  );

  const endpoint = await discoverEndpoint(
    baseOptions({ profileDirs: [first, second], readFile }),
  );

  assert.equal(endpoint.profileDir, first);
  assert.equal(endpoint.port, 9222);
  assert.equal(opened.length, 1, "later profile dirs must not be read after a hit");
});

test("nothing found is E_CDP_UNAVAILABLE with the exact chrome://inspect hint", async () => {
  const dir = "/home/test/.config/google-chrome";
  const error = await expectError(
    discoverEndpoint(
      baseOptions({
        profileDirs: [dir],
        ports: [9222],
        fetchJson: fakeFetch(() => {
          throw new Error("ECONNREFUSED");
        }),
      }),
    ),
    "E_CDP_UNAVAILABLE",
  );

  assert.equal(error.details.stage, "discover");
  assert.equal(error.details.retryable, false);
  for (const needle of [
    "chrome://inspect/#remote-debugging",
    "Discover network targets",
    "Allow",
    "PI_CHROME_CDP_WS",
  ]) {
    assert.ok(
      error.details.hint.includes(needle),
      `hint lacks "${needle}": ${error.details.hint}`,
    );
  }

  const message = error.details.message ?? "";
  assert.match(message, /9222/);
  assert.match(message, /DevToolsActivePort/);
  assert.match(message, /no file/);
});

test("every /json/version probe is bounded by the injected timeout", async () => {
  const timeouts: number[] = [];
  const fetchJson: FetchJson = (_url, timeoutMs) => {
    timeouts.push(timeoutMs);
    return new Promise<unknown>((_resolve, reject) => {
      setTimeout(() => {
        const error = new Error(`timed out after ${timeoutMs}ms`);
        error.name = "TimeoutError";
        reject(error);
      }, timeoutMs);
    });
  };

  const started = Date.now();
  const error = await expectError(
    discoverEndpoint(baseOptions({ ports: [9222, 9333], fetchJson, timeoutMs: 25 })),
    "E_CDP_UNAVAILABLE",
  );
  const elapsed = Date.now() - started;

  assert.deepEqual(timeouts, [25, 25], "both candidates must be probed with the injected bound");
  assert.ok(elapsed >= 20, `returned in ${elapsed}ms, before a probe could time out`);
  assert.ok(elapsed < 1000, `discovery took ${elapsed}ms`);
  assert.match(error.details.message ?? "", /timed out after 25ms/);
});

test("PO5 the failure hint names the browser family discovery observed", async () => {
  const edge = await expectError(
    discoverEndpoint(baseOptions({ profileDirs: ["/home/test/.config/microsoft-edge"], ports: [] })),
    "E_CDP_UNAVAILABLE",
  );
  assert.ok(
    edge.details.hint.includes("edge://inspect/#remote-debugging"),
    `edge hint lacks the edge scheme: ${edge.details.hint}`,
  );
  assert.ok(!edge.details.hint.includes("open chrome://inspect"), edge.details.hint);

  const mixed = await expectError(
    discoverEndpoint(
      baseOptions({
        profileDirs: ["/home/test/.config/google-chrome", "/home/test/.config/microsoft-edge"],
        ports: [],
      }),
    ),
    "E_CDP_UNAVAILABLE",
  );
  assert.ok(mixed.details.hint.includes("chrome://inspect/#remote-debugging"), mixed.details.hint);
  assert.ok(mixed.details.hint.includes("edge://"), "a mixed set must stay generic");
});

test("a hanging DevToolsActivePort read is bounded by the timeout", async () => {
  const readFile: ReadTextFile = () => new Promise<string>(() => {});
  const started = Date.now();
  const error = await expectError(
    discoverEndpoint(
      baseOptions({
        profileDirs: ["/home/test/.config/chromium"],
        readFile,
        timeoutMs: 25,
      }),
    ),
    "E_CDP_UNAVAILABLE",
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 20, `returned in ${elapsed}ms, before the read could time out`);
  assert.ok(elapsed < 1000, `discovery took ${elapsed}ms`);
  assert.match(error.details.message ?? "", /read timed out/);
});

test("the configured port scan is the last resort and reports source port-scan", async () => {
  const calls: FetchCall[] = [];
  const fetchJson = fakeFetch((url) => {
    if (url === "http://127.0.0.1:9333/json/version") {
      return versionPayload("ws://127.0.0.1:9333/devtools/browser/scan");
    }
    return undefined; // non-200 / endpoint disabled
  }, calls);

  const endpoint = await discoverEndpoint(
    baseOptions({ ports: [9222, 9333], fetchJson }),
  );

  assert.equal(endpoint.source, "port-scan");
  assert.equal(endpoint.port, 9333);
  assert.equal(endpoint.wsUrl, "ws://127.0.0.1:9333/devtools/browser/scan");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["http://127.0.0.1:9222/json/version", "http://127.0.0.1:9333/json/version"],
  );
});

test("a non-loopback webSocketDebuggerUrl is refused as a miss", async () => {
  const error = await expectError(
    discoverEndpoint(
      baseOptions({
        ports: [9222],
        fetchJson: fakeFetch(() =>
          versionPayload("ws://192.0.2.10:9222/devtools/browser/remote"),
        ),
      }),
    ),
    "E_CDP_UNAVAILABLE",
  );
  assert.match(error.details.message ?? "", /not loopback/);
});

test("parseDevToolsActivePort rejects control bytes and non-browser paths", () => {
  for (const bad of [
    "9222\n/\u0000",
    "9222\n/devtools/browser/a\u0000b",
    "9222\n/devtools/browser/a\u0001b",
    "9222\n/devtools/browser/a\u001fb",
    "9222\n/devtools/browser/a\u007fb",
    "9222\n/devtools/page/abc",
    "9222\n/foo",
  ]) {
    assert.equal(
      expectReason(parseDevToolsActivePort(bad)),
      "invalid-path",
      `expected invalid-path for ${JSON.stringify(bad)}`,
    );
  }

  // Control bytes in the port line are a port problem, not a path problem.
  assert.equal(
    expectReason(parseDevToolsActivePort("92\u000022\n/devtools/browser/x")),
    "port-not-numeric",
  );
  assert.equal(
    expectReason(parseDevToolsActivePort("9222\u007f\n/devtools/browser/x")),
    "port-not-numeric",
  );
});

test("a DevToolsActivePort with a control byte is skipped for the next profile dir", async () => {
  const bad = "/home/test/.config/google-chrome";
  const good = "/home/test/.config/chromium";
  const opened: string[] = [];
  const readFile = fileReader(
    {
      [join(bad, "DevToolsActivePort")]: fixture("control-char-path.txt"),
      [join(good, "DevToolsActivePort")]: fixture("valid.txt"),
    },
    opened,
  );

  const endpoint = await discoverEndpoint(baseOptions({ profileDirs: [bad, good], readFile }));

  assert.equal(endpoint.source, "devtools-active-port");
  assert.equal(endpoint.profileDir, good);
  assert.equal(endpoint.wsUrl, VALID_WS);
  assert.deepEqual(opened, [
    join(bad, "DevToolsActivePort"),
    join(good, "DevToolsActivePort"),
  ]);
});

test("an injected fetch that ignores timeoutMs is still bounded and never rejects unhandled", async () => {
  const calls: FetchCall[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const fetchJson: FetchJson = (url, timeoutMs) => {
      calls.push({ url, timeoutMs });
      if (url.includes(":9333")) {
        // Rejects after our deadline: the race must absorb it.
        return new Promise<unknown>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("late ECONNREFUSED"));
          }, 120);
        });
      }
      // Ignores timeoutMs entirely — the classic hang.
      return new Promise<unknown>(() => {});
    };

    const started = Date.now();
    const error = await expectError(
      discoverEndpoint(baseOptions({ ports: [9222, 9333], fetchJson, timeoutMs: 25 })),
      "E_CDP_UNAVAILABLE",
    );
    const elapsed = Date.now() - started;

    assert.equal(calls.length, 2, "both candidates must still be probed");
    assert.ok(elapsed >= 40, `returned in ${elapsed}ms, before both deadlines could fire`);
    assert.ok(elapsed < 1000, `discovery took ${elapsed}ms`);
    assert.match(error.details.message ?? "", /timed out after 25ms/);

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 150);
    });
    assert.deepEqual(unhandled, [], "a late rejection must not surface as unhandled");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the probed port is reported even when webSocketDebuggerUrl omits or changes the port", async () => {
  const missingPort = await discoverEndpoint(
    baseOptions({
      ports: [9444],
      fetchJson: fakeFetch(() => versionPayload("ws://127.0.0.1/devtools/browser/no-port")),
    }),
  );
  assert.equal(missingPort.source, "port-scan");
  assert.equal(missingPort.port, 9444, "the probed port wins over the URL default (80)");
  assert.equal(missingPort.wsUrl, "ws://127.0.0.1/devtools/browser/no-port");

  const differentPort = await discoverEndpoint(
    baseOptions({
      env: { PI_CHROME_CDP_PORTS: "9555" },
      fetchJson: fakeFetch(() =>
        versionPayload("ws://127.0.0.1:9666/devtools/browser/other-port"),
      ),
    }),
  );
  assert.equal(differentPort.source, "env-ports");
  assert.equal(differentPort.port, 9555, "the probed port stays authoritative");
  assert.equal(differentPort.wsUrl, "ws://127.0.0.1:9666/devtools/browser/other-port");
});

test("discovered endpoints require /devtools/browser/, the env ws escape hatch stays permissive", async () => {
  const error = await expectError(
    discoverEndpoint(
      baseOptions({
        ports: [9222],
        fetchJson: fakeFetch(() => versionPayload("ws://127.0.0.1:9222/foo")),
      }),
    ),
    "E_CDP_UNAVAILABLE",
  );
  assert.match(error.details.message ?? "", /no \/devtools\/browser\/ path/);

  const page = await discoverEndpoint(
    baseOptions({ env: { PI_CHROME_CDP_WS: "ws://127.0.0.1:9222/devtools/page/PAGE-ID" } }),
  );
  assert.equal(page.source, "env-ws");
  assert.equal(page.port, 9222);
  assert.equal(page.wsUrl, "ws://127.0.0.1:9222/devtools/page/PAGE-ID");
});

test("a DevToolsActivePort file with env {} wins with zero HTTP probes", async () => {
  const calls: FetchCall[] = [];
  const opened: string[] = [];
  const dir = "/home/test/.config/google-chrome";
  const fetchJson = fakeFetch(() => {
    throw new Error("must not probe /json/version");
  }, calls);

  const endpoint = await discoverEndpoint(
    baseOptions({
      env: {},
      profileDirs: [dir],
      readFile: fileReader({ [join(dir, "DevToolsActivePort")]: fixture("valid.txt") }, opened),
      fetchJson,
    }),
  );

  assert.equal(endpoint.source, "devtools-active-port");
  assert.equal(endpoint.port, 9222);
  assert.equal(endpoint.wsUrl, VALID_WS);
  assert.equal(calls.length, 0, "the file is authoritative: no HTTP is allowed");
  assert.deepEqual(opened, [join(dir, "DevToolsActivePort")]);
});
}

// ---------------------------------------------------------------------------
// from tests/unit/page_lock.test.ts
// ---------------------------------------------------------------------------
{
/**
 * P9-A: the keyed FIFO page lock.
 *
 * The lock is the only thing standing between two concurrent `web_read` calls
 * and one shared tab, so the tests are about *timing*: strict FIFO order, no
 * overlap inside a key, full parallelism across keys, and no leaked waiter when
 * a task throws or a caller is aborted.
 */



/** Resolve on the next macrotask, so `Promise.all` really interleaves. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("same key runs one task at a time, in arrival order", async () => {
  const lock = createKeyedLock();
  const events: string[] = [];

  const make = (id: string) => async (): Promise<void> => {
    events.push(`start ${id}`);
    await tick();
    events.push(`end ${id}`);
  };

  await Promise.all([
    lock.run("read", make("a")),
    lock.run("read", make("b")),
    lock.run("read", make("c")),
  ]);

  assert.deepEqual(events, [
    "start a",
    "end a",
    "start b",
    "end b",
    "start c",
    "end c",
  ]);
});

test("different keys run in parallel", async () => {
  const lock = createKeyedLock();
  const events: string[] = [];

  await Promise.all([
    lock.run("read", async () => {
      events.push("a start");
      await tick();
      events.push("a end");
    }),
    lock.run("read#2", async () => {
      events.push("b start");
      await tick();
      events.push("b end");
    }),
  ]);

  assert.deepEqual(events.slice(0, 2), ["a start", "b start"], "slots must not serialise each other");
});

test("a throwing task releases the queue and rejects only its own caller", async () => {
  const lock = createKeyedLock();
  const order: string[] = [];

  const failing = lock.run("read", async () => {
    order.push("fail");
    throw new Error("boom");
  });
  const after = lock.run("read", async () => {
    order.push("after");
    return "ok";
  });

  await assert.rejects(failing, /boom/);
  assert.equal(await after, "ok");
  assert.deepEqual(order, ["fail", "after"]);
  assert.equal(lock.pending(), 0);
});

test("pending() counts queued and running tasks, then returns to zero", async () => {
  const lock = createKeyedLock();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = lock.run("read", async () => {
    await gate;
  });
  const second = lock.run("read", async () => {});

  assert.equal(lock.pending("read"), 2);
  assert.equal(lock.pending(), 2);

  release();
  await Promise.all([first, second]);
  assert.equal(lock.pending("read"), 0);
  assert.equal(lock.pending(), 0, "a released lock must not leak into the next session");
});

test("pick() returns the least-loaded key and keeps caller order on ties", () => {
  const lock = createKeyedLock();
  const keys = ["read", "read#2", "read#3"];

  assert.equal(lock.pick(keys), "read");
  assert.equal(lock.pick(["read#2", "read#3"]), "read#2");

  // A queued task makes its key less attractive; this is what keeps two
  // simultaneous readers on different slots instead of behind one tab.
  void lock.run("read", async () => {
    await tick();
  });
  assert.equal(lock.pick(keys), "read#2");
});

test("pageLockFor() is per connector and stable across calls", () => {
  const one = {};
  const two = {};
  assert.equal(pageLockFor(one), pageLockFor(one));
  assert.notEqual(pageLockFor(one), pageLockFor(two));
});

test("readSlotKeys() maps the pool size onto slot ids", () => {
  assert.deepEqual(readSlotKeys(1), ["read"]);
  assert.deepEqual(readSlotKeys(2), ["read", "read#2"]);
  assert.deepEqual(readSlotKeys(3), ["read", "read#2", "read#3"]);
  // Defensive: config validation already forbids these, but a pooled caller
  // must never ask the browser for a 99th read tab.
  assert.deepEqual(readSlotKeys(99), ["read", "read#2", "read#3"]);
  assert.deepEqual(readSlotKeys(0), ["read"]);
  assert.deepEqual(readSlotKeys(Number.NaN), ["read"]);
});
}
