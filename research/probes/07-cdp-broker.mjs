#!/usr/bin/env node
/**
 * 07 — local CDP broker: ONE Chrome connection, many short-lived clients.
 *
 * Why this exists: since Chrome 136 the default profile refuses
 * `--remote-debugging-port` and asks the user to Allow every debugging
 * connection in `chrome://inspect/#remote-debugging`. There is no supported
 * "always allow" for the default profile (ChromeDevTools/chrome-devtools-mcp
 * issue #825), and every capture/doctor/bench process otherwise costs the user
 * a click. The broker connects to Chrome once, keeps the socket open, and lets
 * sequential clients reuse it over a local WebSocket, so one Allow covers a
 * whole work session.
 *
 * Design constraints, all from AGENTS.md:
 *  - attach only (the endpoint comes from DevToolsActivePort, never a launch);
 *  - one client at a time — "one browser, one writer". A second client is
 *    refused instead of interleaving commands from two agents;
 *  - never touch the user's tabs. The broker is a pipe: it forwards CDP frames
 *    and nothing else. Targets are created/closed by the client, as before;
 *  - no reconnect loop. If Chrome goes away the broker reports it and exits;
 *    reconnecting is a new permission prompt, which is the user's decision.
 *
 * Usage:
 *   node research/probes/07-cdp-broker.mjs [--port 9333] [--idle-min 30]
 *   PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker node src/cli/doctor.ts --json
 *
 * Security: binds 127.0.0.1 only and has no auth, exactly like Chrome's own
 * debugging port. Anyone who can connect to 127.0.0.1:9222 can already attach;
 * the broker does not widen that.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const port = Number(arg("--port", "9333"));
const idleMinutes = Number(arg("--idle-min", "30"));
const profileDir = arg("--profile", join(homedir(), ".config", "google-chrome"));
const BROKER_PATH = "/devtools/browser/broker";

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("broker: --port must be an integer 1..65535");
  process.exit(2);
}

function readEndpoint() {
  const file = join(profileDir, "DevToolsActivePort");
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    console.error(`broker: cannot read ${file} — enable remote debugging in chrome://inspect/#remote-debugging first`);
    process.exit(2);
  }
  const [portLine, path] = raw.trim().split("\n");
  const cdpPort = Number(portLine);
  if (!Number.isInteger(cdpPort) || cdpPort <= 0 || !path) {
    console.error(`broker: ${file} is malformed`);
    process.exit(2);
  }
  return { wsUrl: `ws://127.0.0.1:${cdpPort}${path}` };
}

const endpoint = readEndpoint();
const upstream = new WebSocket(endpoint.wsUrl);
/** The single client allowed to drive Chrome right now. */
let client = null;
let clientId = 0;
let idleTimer = null;
let frames = 0;

const log = (line) => console.log(`[broker ${new Date().toISOString().slice(11, 19)}] ${line}`);

function armIdleTimer() {
  clearTimeout(idleTimer);
  const ms = idleMinutes * 60_000;
  if (!Number.isFinite(ms) || ms <= 0) return;
  idleTimer = setTimeout(() => {
    if (client !== null) return;
    log(`no client for ${idleMinutes} min — closing the Chrome connection`);
    shutdown(0);
  }, ms);
  idleTimer.unref();
}

function shutdown(code) {
  if (client !== null) {
    try {
      client.close(1001, "broker shutting down");
    } catch {
      // already gone
    }
    client = null;
  }
  try {
    upstream.close();
  } catch {
    // already gone
  }
  server.close(() => process.exit(code));
  // Do not hang on a half-closed socket.
  setTimeout(() => process.exit(code), 500).unref();
}

upstream.on("open", () => {
  log(`connected to Chrome ${endpoint.wsUrl} (client url ws://127.0.0.1:${port}${BROKER_PATH})`);
  armIdleTimer();
});

upstream.on("message", (raw, isBinary) => {
  if (client === null) return;
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(raw, { binary: isBinary });
});

upstream.on("close", (code, reason) => {
  log(`Chrome closed the connection (${code} ${String(reason)}); no reconnect loop — rerun the broker`);
  if (client !== null) client.close(1011, "Chrome connection closed");
  client = null;
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 500).unref();
});

upstream.on("error", (error) => {
  log(`Chrome socket error: ${error.message}`);
});

const server = new WebSocketServer({ host: "127.0.0.1", port, path: BROKER_PATH });

server.on("listening", () => {
  log(`listening on ws://127.0.0.1:${port}${BROKER_PATH}`);
});

server.on("connection", (socket, request) => {
  if (upstream.readyState !== WebSocket.OPEN) {
    socket.close(1013, "Chrome is not connected yet");
    return;
  }
  if (client !== null) {
    // Two writers on one browser is the exact failure the lock exists to stop.
    socket.close(1013, "busy: another client is using the browser");
    log(`refused a second client from ${request.socket.remoteAddress}`);
    return;
  }
  const id = ++clientId;
  client = socket;
  clearTimeout(idleTimer);
  log(`client ${id} attached`);

  socket.on("message", (raw, isBinary) => {
    frames += 1;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(raw, { binary: isBinary });
  });
  socket.on("close", () => {
    if (client !== socket) return;
    client = null;
    log(`client ${id} detached (${frames} frames this run)`);
    armIdleTimer();
  });
  socket.on("error", () => {
    // A dropped client must not take the broker (and the Chrome link) down.
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`${signal} — closing the Chrome connection`);
    shutdown(0);
  });
}
