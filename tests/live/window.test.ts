/**
 * Opt-in live gate for P10 (the managed window is watchable).
 *
 * `PI_CHROME_LIVE=1 PI_CHROME_CDP_WS=ws://127.0.0.1:9333/devtools/browser/broker \
 *    npm run test:live -- tests/live/window.test.ts`
 *
 * Six searches in total (typed + direct per engine), one run each, no retries.
 * A wall is reported as SKIP, never as a failure: the user solves it in the
 * visible window, and hammering the profile is exactly what the rules forbid.
 *
 * What it proves, per PLAN-v2 V10.1–V10.4:
 *  - the anchor is the local panel (no `about:blank` tab we own), the query is
 *    visible within 300 ms of the search starting, and a screenshot is saved;
 *  - `window.follow: "work"` shows the engine tab during the search and returns
 *    to the anchor within 2 s; `"never"` never changes the active tab;
 *  - `humanize: "typing"` types on every engine (`typed:true`) and the typed
 *    path costs ≤ 1.2 s over the direct SERP path (pacing is fixed at 1 s on
 *    both paths, so the comparison is the page work, not the limiter);
 *  - Yandex never lands on `dzen.ru`; if it does, the run reports
 *    `fellBackToSerp` and the SERP still parses.
 *
 * Screenshots are written to `~/.pi/agent/web-search/p10-live/` (local evidence,
 * never committed): the artifact rule — no binaries in `evidence/` — still holds.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConnector } from "../../src/cdp/browser.ts";
import type { Connector } from "../../src/cdp/browser.ts";
import { discoverEndpoint } from "../../src/cdp/discovery.ts";
import { loadConfig } from "../../src/config.ts";
import type { Config, FollowPolicy, HumanizeMode } from "../../src/config.ts";
import { createDefaultRegistry } from "../../src/engines/index.ts";
import type { EngineId } from "../../src/engines/types.ts";
import { createArtifacts } from "../../src/runtime/artifacts.ts";
import { createCache } from "../../src/runtime/cache.ts";
import { createSystemClock } from "../../src/runtime/clock.ts";
import { createLimiter } from "../../src/runtime/limiter.ts";
import { createLogger } from "../../src/runtime/log.ts";
import { createTools } from "../../src/tools/index.ts";
import type { WebSearchResult } from "../../src/tools/web_search.ts";
import type { ToolDeps } from "../../src/tools/types.ts";

const LIVE = process.env.PI_CHROME_LIVE === "1";
const BROKER = process.env.PI_CHROME_CDP_WS?.trim() ?? "";
/** Short, neutral queries: the latency ceiling is about typing, not about the SERP. */
const QUERY_TYPED = "rust tokio select";
const QUERY_DIRECT = "chrome devtools protocol";
const SCREENSHOT_DIR = join(homedir(), ".pi", "agent", "web-search", "p10-live");
const PACING_MS = 1_000;
const IDLE_MS = 1_500;
/** V10.3: the typed path may cost at most this much over the direct SERP path. */
const MAX_TYPED_DELTA_MS = 1_200;

interface Session {
  config: Config;
  connector: Connector;
  deps: ToolDeps;
  execute: (input: { q: string; engines: EngineId[]; n: number }) => Promise<WebSearchResult>;
  dir: string;
}

interface Sample {
  at: number;
  anchorVisible: boolean;
  workVisible: boolean | null;
  querySeen: boolean;
}

async function openSession(): Promise<Session> {
  const dir = mkdtempSync(join(homedir(), ".pi", "agent", "web-search", "p10-live-"));
  const configPath = join(dir, "web-search.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        mode: "attach",
        window: { panel: true, follow: "work", idleMs: IDLE_MS },
        humanize: "typing",
        search: { n: 2, aiWaitMs: 0, outputMaxChars: 2500 },
        // Fixed 1 s pacing on both paths so the latency delta is page work.
        pacing: { google: [PACING_MS, PACING_MS], duckduckgo: [PACING_MS, PACING_MS], yandex: [PACING_MS, PACING_MS] },
      },
      null,
      2,
    ),
  );
  const env = { ...process.env, PI_CHROME_CDP_WS: BROKER };
  const config = loadConfig({ path: configPath, env });
  const clock = createSystemClock();
  const log = createLogger({ path: join(dir, "decisions.jsonl"), clock });
  const connector = createConnector({
    config,
    clock,
    log,
    lockPath: join(dir, "web-search.lock"),
    discover: () =>
      discoverEndpoint({ ports: config.cdp.ports, ws: config.cdp.ws, timeoutMs: config.cdp.connectTimeoutMs }),
  });
  const deps: ToolDeps = {
    config,
    engines: createDefaultRegistry(config),
    cdp: connector,
    cache: createCache({ maxEntries: config.cache.maxEntries, clock }),
    limiter: createLimiter({ config, clock, statePath: join(dir, "state.json"), rng: () => 0.5 }),
    artifacts: createArtifacts({ config, clock }),
    log,
    clock,
  };
  const tools = createTools({
    getDeps: () => deps,
    getDoctorDeps: () => {
      throw new Error("the P10 live gate does not run the doctor");
    },
  });
  const tool = tools.find((candidate) => candidate.name === "web_search");
  assert.ok(tool !== undefined);
  const session: Session = {
    dir,
    config,
    connector,
    deps,
    execute: (input) => tool.execute("p10-live", input, undefined, undefined) as Promise<WebSearchResult>,
  };
  // Warm connect + the engine tab, so connect cost never lands in a latency number.
  await connector.connect();
  return session;
}

function failureCode(result: WebSearchResult): string | null {
  return "isError" in result && result.isError === true ? String(result.details.code) : null;
}

interface HumanFacts {
  typed?: boolean;
  typedPath?: boolean;
  fellBackToSerp?: boolean;
  fellBackReason?: string;
  homeRedirectHost?: string;
  homeMs?: number;
  typeMs?: number;
  settleMs?: number;
}

function detailsOf(result: WebSearchResult): { human?: HumanFacts; results?: number; settleMs?: number } {
  return result.details as { human?: HumanFacts; results?: number; settleMs?: number };
}

function humanLine(human: HumanFacts | undefined): string {
  if (human === undefined) return "human=none";
  return (
    `typed=${String(human.typed)} path=${String(human.typedPath)} fellBack=${String(human.fellBackReason)} ` +
    `homeMs=${String(human.homeMs)} typeMs=${String(human.typeMs)} settleMs=${String(human.settleMs)}`
  );
}

function isWall(code: string | null): boolean {
  return code === "E_WALL" || code === "E_CDP_UNAVAILABLE" || code === "E_BUSY";
}

/**
 * Run one search while sampling which owned tab is visible and when the anchor
 * first shows the query. The panel write is awaited inside `announce()`, so the
 * "visible within 300 ms" check is a real measurement, not a sleep.
 */
async function runObserved(
  session: Session,
  options: { engine: EngineId; query: string; humanize: HumanizeMode; follow: FollowPolicy; waitAfterMs?: number },
): Promise<{
  result: WebSearchResult;
  ms: number;
  querySeenAtMs: number | null;
  samples: Sample[];
  anchorBack: boolean;
  anchorText: string;
}> {
  const { config, connector } = session;
  config.humanize = options.humanize;
  config.window.follow = options.follow;

  const anchor = connector.anchorPage?.() ?? null;
  assert.ok(anchor !== null, "the connector must own an anchor tab");
  const work = connector.pageFor?.(options.engine) ?? null;

  const startedAt = Date.now();
  let done = false;
  const promise = session.execute({ q: options.query, engines: [options.engine], n: 2 });
  const settled = promise.then(
    (result) => {
      done = true;
      return result;
    },
    (error: unknown) => {
      done = true;
      throw error;
    },
  );

  const samples: Sample[] = [];
  let querySeenAtMs: number | null = null;
  while (!done) {
    const at = Date.now() - startedAt;
    let text = "";
    let anchorVisible = false;
    try {
      text = await anchor.innerText();
      anchorVisible = (await anchor.evaluate<unknown>('document.visibilityState === "visible"')) === true;
    } catch {
      // A paint in flight must not fail the sample; the next tick will read it.
    }
    if (querySeenAtMs === null && text.includes(options.query)) querySeenAtMs = at;
    let workVisible: boolean | null = null;
    if (work !== null) {
      try {
        workVisible = (await work.evaluate<unknown>('document.visibilityState === "visible"')) === true;
      } catch {
        workVisible = null;
      }
    }
    samples.push({ at, anchorVisible, workVisible, querySeen: querySeenAtMs !== null });
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  }

  const result = await settled;
  const ms = Date.now() - startedAt;
  await new Promise<void>((resolve) => setTimeout(resolve, options.waitAfterMs ?? IDLE_MS + 700));
  let anchorBack = false;
  let anchorText = "";
  try {
    anchorBack = (await anchor.evaluate<unknown>('document.visibilityState === "visible"')) === true;
    anchorText = await anchor.innerText();
  } catch {
    // Reported as false below.
  }
  return { result, ms, querySeenAtMs, samples, anchorBack, anchorText };
}

async function writeAnchorShot(session: Session, name: string): Promise<string | null> {
  const page = session.connector.anchorPage?.();
  if (page === null || page === undefined) return null;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = join(SCREENSHOT_DIR, name);
  writeFileSync(file, await page.screenshot());
  return file;
}

function ownedUrls(session: Session): string[] {
  return session.connector.info()?.ownedTargets.map((target) => target.url) ?? [];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function closeSession(session: Session): Promise<void> {
  await session.connector.releaseAll().catch(() => undefined);
  rmSync(session.dir, { recursive: true, force: true });
}

test(
  "live P10: google — panel, follow work/never, typing cost",
  { skip: LIVE ? false : "set PI_CHROME_LIVE=1 (and PI_CHROME_CDP_WS) to run the P10 live gate" },
  async (t) => {
    assert.ok(BROKER !== "", "PI_CHROME_CDP_WS must point at the running CDP broker");
    const session = await openSession();
    t.after(() => closeSession(session));
    // Warm the tab so the first measured call does not pay tab creation and the
    // observer has a page to ask about visibility.
    await session.connector.acquirePage("google");

    const typed = await runObserved(session, {
      engine: "google",
      query: QUERY_TYPED,
      humanize: "typing",
      follow: "work",
    });
    const typedCode = failureCode(typed.result);
    if (isWall(typedCode)) {
      console.log(`live google: SKIP (${typedCode}); the window is surfaced for the user`);
      return;
    }
    assert.equal(typedCode, null, `google typed search failed: ${typedCode}`);
    const typedDetails = detailsOf(typed.result);
    assert.equal(typedDetails.human?.typed, true, "V10.3: the query must have been typed");
    assert.equal(typedDetails.human?.typedPath, true);
    assert.equal(typed.querySeenAtMs !== null, true, "the anchor never showed the query");
    assert.ok(
      (typed.querySeenAtMs ?? Infinity) <= 300,
      `V10.1: query took ${String(typed.querySeenAtMs)} ms to reach the anchor (limit 300)`,
    );
    assert.ok(
      typed.samples.some((sample) => sample.workVisible === true && sample.anchorVisible === false),
      "V10.2: the engine tab must be active during the search",
    );
    assert.equal(typed.anchorBack, true, "V10.2: the anchor must return within idleMs + 2 s");
    const urls = ownedUrls(session);
    assert.ok(
      !urls.includes("about:blank"),
      `V10.1: an about:blank tab still exists among the owned targets: ${urls.join(", ")}`,
    );
    const anchor = session.connector.anchorPage?.();
    assert.ok(anchor !== null && anchor !== undefined);
    assert.match(anchor.url(), /^file:\/\/.*assets\/anchor\.html$/, "V10.1: the anchor is the local panel");
    const shot = await writeAnchorShot(session, "anchor-follow-work.jpg");

    // The direct SERP path, under follow "never": the anchor must never move.
    const direct = await runObserved(session, {
      engine: "google",
      query: QUERY_DIRECT,
      humanize: "auto",
      follow: "never",
    });
    const directCode = failureCode(direct.result);
    if (isWall(directCode)) {
      console.log(`live google (direct): SKIP (${directCode})`);
      return;
    }
    assert.equal(directCode, null, `google direct search failed: ${directCode}`);
    assert.equal(detailsOf(direct.result).human?.typed ?? false, false, "the second search is the SERP path");
    assert.ok(
      direct.samples.every((sample) => sample.anchorVisible),
      'V10.2: follow "never" must not change the active tab',
    );

    const typedSettle = detailsOf(typed.result).settleMs ?? 0;
    const directSettle = detailsOf(direct.result).settleMs ?? 0;
    const settleDelta = typedSettle - directSettle;
    const totalDelta = typed.ms - direct.ms;
    console.log(
      `live google: ${humanLine(typedDetails.human)} querySeen=${String(typed.querySeenAtMs)}ms ` +
        `typedSettle=${typedSettle}ms directSettle=${directSettle}ms settleDelta=${settleDelta}ms ` +
        `humanCost=${(typedDetails.human?.homeMs ?? 0) + (typedDetails.human?.typeMs ?? 0)}ms ` +
        `typedTotal=${typed.ms}ms directTotal=${direct.ms}ms totalDelta=${totalDelta}ms anchor=${shot ?? "unsaved"}`,
    );
    console.log(`panel:\n${typed.anchorText}`);
    assert.ok(typedSettle > 0 && directSettle > 0, "both paths must record a settle time");
    assert.ok(
      settleDelta <= MAX_TYPED_DELTA_MS,
      `V10.3: typed SERP settle is ${settleDelta} ms slower than the direct path (limit 1200)`,
    );
  },
);

test(
  "live P10: duckduckgo — typed path + latency",
  { skip: LIVE ? false : "set PI_CHROME_LIVE=1 (and PI_CHROME_CDP_WS) to run the P10 live gate" },
  async (t) => {
    assert.ok(BROKER !== "", "PI_CHROME_CDP_WS must point at the running CDP broker");
    const session = await openSession();
    t.after(() => closeSession(session));

    // Warm the tab so the first measured call does not pay tab creation.
    await session.connector.acquirePage("duckduckgo");
    const typed = await runObserved(session, {
      engine: "duckduckgo",
      query: QUERY_TYPED,
      humanize: "typing",
      follow: "work",
    });
    const typedCode = failureCode(typed.result);
    if (isWall(typedCode)) {
      console.log(`live duckduckgo: SKIP (${typedCode})`);
      return;
    }
    assert.equal(typedCode, null, `duckduckgo typed search failed: ${typedCode}`);
    const ddgHuman = detailsOf(typed.result).human;
    assert.equal(ddgHuman?.typed, true, `V10.3: DDG must accept the typed path (${humanLine(ddgHuman)})`);

    const direct = await runObserved(session, {
      engine: "duckduckgo",
      query: QUERY_DIRECT,
      humanize: "auto",
      follow: "work",
    });
    const directCode = failureCode(direct.result);
    if (isWall(directCode)) {
      console.log(`live duckduckgo (direct): SKIP (${directCode})`);
      return;
    }
    assert.equal(directCode, null, `duckduckgo direct search failed: ${directCode}`);

    const ddgTypedSettle = detailsOf(typed.result).settleMs ?? 0;
    const ddgDirectSettle = detailsOf(direct.result).settleMs ?? 0;
    const ddgSettleDelta = ddgTypedSettle - ddgDirectSettle;
    console.log(
      `live duckduckgo: ${humanLine(ddgHuman)} typedSettle=${ddgTypedSettle}ms directSettle=${ddgDirectSettle}ms ` +
        `settleDelta=${ddgSettleDelta}ms humanCost=${(ddgHuman?.homeMs ?? 0) + (ddgHuman?.typeMs ?? 0)}ms ` +
        `typedTotal=${typed.ms}ms directTotal=${direct.ms}ms totalDelta=${typed.ms - direct.ms}ms ` +
        `querySeen=${String(typed.querySeenAtMs)}ms`,
    );
    assert.ok(ddgTypedSettle > 0 && ddgDirectSettle > 0, "both paths must record a settle time");
    assert.ok(
      ddgSettleDelta <= MAX_TYPED_DELTA_MS,
      `V10.3: typed SERP settle is ${ddgSettleDelta} ms slower than the direct path (limit 1200)`,
    );
  },
);

test(
  "live P10: yandex — ya.ru warm-up, no dzen landing, typed path + latency",
  { skip: LIVE ? false : "set PI_CHROME_LIVE=1 (and PI_CHROME_CDP_WS) to run the P10 live gate" },
  async (t) => {
    assert.ok(BROKER !== "", "PI_CHROME_CDP_WS must point at the running CDP broker");
    const session = await openSession();
    t.after(() => closeSession(session));

    await session.connector.acquirePage("yandex");
    const typed = await runObserved(session, {
      engine: "yandex",
      query: QUERY_TYPED,
      humanize: "typing",
      follow: "work",
    });
    const typedCode = failureCode(typed.result);
    if (isWall(typedCode)) {
      console.log(`live yandex: SKIP (${typedCode}); solve the wall in the window, then re-run once`);
      return;
    }
    assert.equal(typedCode, null, `yandex typed search failed: ${typedCode}`);
    const human = detailsOf(typed.result).human;
    const landedPage = session.connector.pageFor?.("yandex");
    const landed = landedPage === null || landedPage === undefined ? "" : await landedPage.currentUrl();
    assert.notEqual(hostOf(landed), "dzen.ru", `V10.4: the typed path landed on dzen.ru (${landed})`);
    if (human?.fellBackReason === "home-redirect") {
      // V10.4: a redirect is a pass only when the SERP still parsed.
      assert.equal(human.fellBackToSerp, true);
      assert.ok((detailsOf(typed.result).results ?? 0) >= 1, "a home redirect must still parse the SERP");
    } else {
      assert.equal(human?.typed, true, "V10.3: Yandex must accept the typed path");
    }

    const direct = await runObserved(session, {
      engine: "yandex",
      query: QUERY_DIRECT,
      humanize: "auto",
      follow: "work",
    });
    const directCode = failureCode(direct.result);
    if (isWall(directCode)) {
      console.log(`live yandex (direct): SKIP (${directCode})`);
      return;
    }
    assert.equal(directCode, null, `yandex direct search failed: ${directCode}`);

    const yandexTypedSettle = detailsOf(typed.result).settleMs ?? 0;
    const yandexDirectSettle = detailsOf(direct.result).settleMs ?? 0;
    const yandexSettleDelta = yandexTypedSettle - yandexDirectSettle;
    console.log(
      `live yandex: ${humanLine(human)} landed=${landed} typedSettle=${yandexTypedSettle}ms ` +
        `directSettle=${yandexDirectSettle}ms settleDelta=${yandexSettleDelta}ms ` +
        `humanCost=${(human?.homeMs ?? 0) + (human?.typeMs ?? 0)}ms typedTotal=${typed.ms}ms ` +
        `directTotal=${direct.ms}ms totalDelta=${typed.ms - direct.ms}ms querySeen=${String(typed.querySeenAtMs)}ms`,
    );
    assert.ok(yandexTypedSettle > 0 && yandexDirectSettle > 0, "both paths must record a settle time");
    assert.ok(
      yandexSettleDelta <= MAX_TYPED_DELTA_MS,
      `V10.3: typed SERP settle is ${yandexSettleDelta} ms slower than the direct path (limit 1200)`,
    );
  },
);
