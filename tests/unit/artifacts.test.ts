/**
 * Artifact writer contract (SPEC §10.2 / PLAN P4-C / V4.3).
 *
 * Everything runs against a temp root and the in-memory `FakePage`, so the suite
 * is offline. The assertions cover the parts a repair agent depends on: a stable
 * hash-named directory, the four files, scrubbed form values, an honest meta, a
 * non-fatal screenshot, retention that cannot eat foreign files, and `E_CONFIG`
 * when the root cannot be written.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";

import { DEFAULT_CONFIG } from "../../src/config.ts";
import type { ArtifactsConfig, Config } from "../../src/config.ts";
import { ENGINE_IDS } from "../../src/engines/types.ts";
import type { EngineId, RawSerp } from "../../src/engines/types.ts";
import {
  ARTIFACT_DIR_NAME,
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACTS_VERSION,
  createArtifacts,
  sanitizeHtml,
} from "../../src/runtime/artifacts.ts";
import { isWebSearchError } from "../../src/runtime/error-codes.ts";
import type { ArtifactInput, Clock } from "../../src/runtime/types.ts";
import { FakePage } from "../helpers/fake-page.ts";
import type { FakePageOptions } from "../helpers/fake-page.ts";

/** 2026-01-02T03:04:05Z → the deterministic directory stamp `20260102-030405`. */
const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const STAMP = "20260102-030405";

const SEARCH_URL = "https://www.google.com/search?q=test";
const SCREENSHOT = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/**
 * Values a real logged-in SERP would carry. Every one of them must be absent
 * from the saved page.html; the element names around them must survive.
 */
const SECRET_VALUES = [
  "secret query value",
  "hidden-csrf-value",
  "hidden-sxsrf-value",
  "textarea-secret-value",
  "option-secret-value",
  "url-token-value",
  "link-token-value",
  "meta-token-value",
  "header-cookie",
  "cookie-secret-value",
];

const SERP_HTML = [
  '<!DOCTYPE html><html><head><title>test - Google Search</title>',
  '<meta name="csrf-token" content="meta-token-value">',
  '<meta http-equiv="set-cookie" content="session=header-cookie">',
  "</head><body>",
  '<form action="/search?q=test&sxsrf=url-token-value" method="get">',
  '<input name="q" value="secret query value">',
  '<input type="hidden" name="_csrf" value="hidden-csrf-value">',
  '<input type="hidden" name="sxsrf" value="hidden-sxsrf-value">',
  '<textarea name="notes">textarea-secret-value</textarea>',
  '<select name="lang"><option value="option-secret-value" selected>ru</option></select>',
  '<a href="https://www.google.com/search?q=x&sxsrf=link-token-value&ved=abc">next</a>',
  '<script>document.cookie = "sid=cookie-secret-value";</script>',
  "</form>",
  '<div class="result"><h3>Result</h3><p>Result one</p></div>',
  "</body></html>",
].join("\n");

const SERP: RawSerp = {
  engine: "google",
  query: "test",
  ai: { text: "AI overview text", sources: ["example.com"] },
  results: [
    { title: "A", url: "https://example.com/a", snippet: "s" },
    { title: "B", url: "https://example.com/b", snippet: "s" },
  ],
  pageCarried: false,
  timings: { navigateMs: 120, settleMs: 80, extractMs: 15 },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class StepClock implements Clock {
  #now: number;

  constructor(start = FIXED_NOW) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  async sleep(ms: number): Promise<void> {
    this.#now += ms;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-chrome-search-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeConfig(patch: Partial<ArtifactsConfig> = {}): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.artifacts = { ...config.artifacts, ...patch };
  return config;
}

function serpPage(overrides: FakePageOptions = {}): FakePage {
  return new FakePage({
    url: SEARCH_URL,
    title: "test - Google Search",
    html: SERP_HTML,
    text: "Result one\nResult two",
    screenshot: SCREENSHOT,
    ...overrides,
  });
}

function artifactInput(overrides: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    code: "E_PARSE",
    stage: "extract",
    engine: "google",
    url: SEARCH_URL,
    query: "test",
    serp: SERP,
    page: serpPage(),
    ...overrides,
  };
}

/** Mirrors the implementation, asserted independently so a refactor cannot drift. */
function expectedHash(query: string, url: string, code: string): string {
  return createHash("sha256").update(`${query}\n${url}\n${code}`, "utf8").digest("hex").slice(0, 8);
}

async function dirBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

async function artifactNames(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => ARTIFACT_DIR_NAME.test(name)).sort();
}

async function readMeta(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test("names the directory <stamp>-<engine>-<hash8> and keeps the hash stable", async () => {
  const root = join(tempDir(), "artifacts");
  const clock = new StepClock();
  const artifacts = createArtifacts({ config: makeConfig(), clock, root });

  const hash = expectedHash("test", SEARCH_URL, "E_PARSE");
  const first = await artifacts.save(artifactInput());
  assert.equal(first, join(root, `${STAMP}-google-${hash}`));
  assert.match(basename(first), /^\d{8}-\d{6}-google-[0-9a-f]{8}$/);

  // Same second + same input: the second save must not overwrite the first.
  const second = await artifacts.save(artifactInput());
  assert.equal(second, `${first}-2`);

  // A different failure code is a different artifact, even at the same instant.
  const otherHash = expectedHash("test", SEARCH_URL, "E_WALL");
  assert.notEqual(otherHash, hash);
  const third = await artifacts.save(artifactInput({ code: "E_WALL" }));
  assert.equal(third, join(root, `${STAMP}-google-${otherHash}`));

  assert.equal(await artifacts.root(), root);
});

test("falls back to serp.engine, then to unknown, for the directory slug", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  const fromSerp = await artifacts.save(artifactInput({ engine: undefined }));
  assert.equal(basename(fromSerp), `${STAMP}-google-${expectedHash("test", SEARCH_URL, "E_PARSE")}`);
  assert.equal((await readMeta(fromSerp)).engine, "google");

  const unknown = await artifacts.save(artifactInput({ engine: undefined, serp: undefined }));
  assert.match(basename(unknown), new RegExp(`^${STAMP}-unknown-[0-9a-f]{8}$`));
  assert.equal((await readMeta(unknown)).engine, "unknown", "meta must name the same slug as the directory");
});

test("meta.engine is the directory slug, never the raw cast id", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  // `ArtifactInput.engine` is typed, but the value can still arrive from config
  // or a caller cast; the directory rejects it, so meta must agree.
  const dir = await artifacts.save(artifactInput({ engine: "bing" as EngineId }));
  assert.match(basename(dir), new RegExp(`^${STAMP}-unknown-[0-9a-f]{8}$`));
  assert.equal((await readMeta(dir)).engine, "unknown");
});

test("ARTIFACT_DIR_NAME is derived from ENGINE_IDS and rejects look-alikes", () => {
  for (const engine of ENGINE_IDS) {
    assert.match(`20260102-030405-${engine}-deadbeef`, ARTIFACT_DIR_NAME);
    assert.match(`20260102-030405-${engine}-deadbeef-12`, ARTIFACT_DIR_NAME);
  }
  assert.match("20260102-030405-unknown-deadbeef", ARTIFACT_DIR_NAME);

  for (const lookAlike of ["bing", "googl", "googles", "google-extra", "GOOGLE", "unknown2", "yandex1"]) {
    assert.doesNotMatch(`20260102-030405-${lookAlike}-deadbeef`, ARTIFACT_DIR_NAME);
  }
  assert.doesNotMatch("20260102-030405-google-notahash", ARTIFACT_DIR_NAME);
  assert.doesNotMatch("20260102-0304-google-deadbeef", ARTIFACT_DIR_NAME);
});

test("never overwrites an existing artifact directory", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });
  const base = join(root, `${STAMP}-google-${expectedHash("test", SEARCH_URL, "E_PARSE")}`);

  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "meta.json"), '{"sentinel":true}');

  const dir = await artifacts.save(artifactInput());
  assert.equal(dir, `${base}-2`);
  assert.equal(await readFile(join(base, "meta.json"), "utf8"), '{"sentinel":true}');
  assert.ok(existsSync(join(dir, "meta.json")));

  const third = await artifacts.save(artifactInput());
  assert.equal(third, `${base}-3`);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test("writes all four files with private modes", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  const dir = await artifacts.save(artifactInput());
  assert.deepEqual((await readdir(dir)).sort(), ["meta.json", "page.html", "page.txt", "screenshot.jpg"]);

  assert.equal(await readFile(join(dir, "page.txt"), "utf8"), "Result one\nResult two");
  assert.deepEqual([...(await readFile(join(dir, "screenshot.jpg")))], [...SCREENSHOT]);

  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, "meta.json"))).mode & 0o777, 0o600);
});

test("removes form values, hidden fields and csrf tokens from page.html", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  const dir = await artifacts.save(artifactInput());
  const html = await readFile(join(dir, "page.html"), "utf8");

  for (const secret of SECRET_VALUES) {
    assert.ok(!html.includes(secret), `page.html leaked a form/session value: ${secret}`);
  }
  assert.ok(html.includes('name="_csrf"'), "the hidden field's name must stay debuggable");
  assert.ok(html.includes('<input name="q" value="">'));
  assert.ok(html.includes('<textarea name="notes"></textarea>'));
  assert.ok(html.includes('<option value="" selected>ru</option>'));
  assert.ok(html.includes("/search?q=test&sxsrf=[redacted]"));
  assert.ok(html.includes('document.cookie = ""'));
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes('<div class="result"><h3>Result</h3>'));
});

test("sanitizes unquoted and uppercase attributes too", () => {
  const safe = sanitizeHtml('<INPUT NAME=q VALUE=typed-secret><input type=hidden name=_csrf value=csrf-secret>');
  assert.ok(!safe.includes("typed-secret"));
  assert.ok(!safe.includes("csrf-secret"));
  assert.ok(safe.includes('<INPUT name="q" value="">'));
  assert.ok(safe.includes('name="_csrf"'));
});

/**
 * Carriers the attribute-name pass cannot see. Every `LEAK_*` value is a
 * correlation token that used to survive sanitisation: `data-*` value blobs, CSS
 * `url()`, JSON islands and three inline-script forms.
 */
const TOKEN_CARRIERS = [
  '<div data-ved="LEAK_VED" data-usg="LEAK_USG">x</div>',
  '<div jsdata="filter:0;sxsrf=LEAK_JS_SXSFR;ved=LEAK_JS_VED;reqid=LEAK_JS_REQID">y</div>',
  '<div data-url="https://www.google.com/x?sca_esv=LEAK_SCA&amp;ei=LEAK_EI">z</div>',
  "<div style=\"background-image:url('https://www.google.com/x?sxsrf=LEAK_STYLE')\">s</div>",
  '<div data-gs_lcp="LEAK_GS_LCP" data-vet="LEAK_VET" data-uact="LEAK_UACT">t</div>',
  '<script>var q = "?sa=LEAK_SA&cd=LEAK_CD";</script>',
  '<script>{"sxsrf":"LEAK_JSON","ei":"LEAK_JSON_EI"}</script>',
  "<script>document.cookie = `sid=LEAK_TICK`;</script>",
  '<script>document["cookie"] = "sid=LEAK_BRACKET";</script>',
  "<script>document['cookie'] = 'sid=LEAK_SINGLE';</script>",
];

const LEAKED_TOKENS = [
  "LEAK_VED",
  "LEAK_USG",
  "LEAK_JS_SXSFR",
  "LEAK_JS_VED",
  "LEAK_JS_REQID",
  "LEAK_SCA",
  "LEAK_EI",
  "LEAK_STYLE",
  "LEAK_GS_LCP",
  "LEAK_VET",
  "LEAK_UACT",
  "LEAK_SA",
  "LEAK_CD",
  "LEAK_JSON",
  "LEAK_JSON_EI",
  "LEAK_TICK",
  "LEAK_BRACKET",
  "LEAK_SINGLE",
];

test("redacts correlation tokens from value blobs, styles, JSON and inline scripts", () => {
  const safe = sanitizeHtml(TOKEN_CARRIERS.join("\n"));

  for (const token of LEAKED_TOKENS) {
    assert.ok(!safe.includes(token), `correlation token leaked: ${token}`);
  }

  // The parameter names stay: the artifact must still be usable for debugging.
  assert.ok(safe.includes('<div data-ved="[redacted]" data-usg="[redacted]">'));
  assert.ok(safe.includes("jsdata=") && safe.includes("sxsrf=[redacted]"));
  assert.ok(safe.includes("sca_esv=[redacted]&amp;ei=[redacted]"));
  assert.ok(safe.includes("style=\"background-image:url('https://www.google.com/x?sxsrf=[redacted]')\""));
  assert.ok(safe.includes('<div data-gs_lcp="[redacted]" data-vet="[redacted]" data-uact="[redacted]">'));
  assert.ok(safe.includes('var q = "?sa=[redacted]&cd=[redacted]"'));
  assert.ok(safe.includes('{"sxsrf":"[redacted]","ei":"[redacted]"}'));
  assert.ok(safe.includes('document.cookie = ""'));
  assert.ok(safe.includes('document["cookie"] = ""'));
  assert.ok(safe.includes("document['cookie'] = \"\""));
});

test("does not mangle ordinary words that merely contain token-like letters", () => {
  const text = '<p class="vein eight">a vein in the eight ball, weighted</p><p data-vein="eight">vein</p>';
  assert.equal(sanitizeHtml(text), text);
});

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

test("writes a compact meta without HTML, cookies or headers", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  const dir = await artifacts.save(artifactInput());
  const raw = await readFile(join(dir, "meta.json"), "utf8");
  const meta = await readMeta(dir);

  assert.deepEqual(meta, {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    ts: "2026-01-02T03:04:05.000Z",
    code: "E_PARSE",
    stage: "extract",
    engine: "google",
    url: SEARCH_URL,
    query: "test",
    timings: { navigateMs: 120, settleMs: 80, extractMs: 15 },
    serp: { engine: "google", results: 2, ai: true },
    screenshot: true,
    artifactsVersion: ARTIFACTS_VERSION,
  });
  assert.equal(ARTIFACT_SCHEMA_VERSION, 1);

  assert.ok(!raw.includes("<"), "meta must not carry HTML");
  assert.ok(!raw.toLowerCase().includes("cookie"));
  for (const secret of SECRET_VALUES) assert.ok(!raw.includes(secret));
  assert.ok(!("cookies" in meta) && !("headers" in meta) && !("html" in meta));
});

test("reports ai:false and canaries/extra without duplicating them", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  const dir = await artifacts.save(
    artifactInput({
      serp: { engine: "yandex", query: "test", results: [{ title: "A", url: "https://e.com", snippet: "s" }], pageCarried: false, timings: {} },
      extra: { canaries: { results: 1, ai_block: 0 }, attempt: 2 },
    }),
  );
  const meta = await readMeta(dir);

  assert.deepEqual(meta.serp, { engine: "yandex", results: 1, ai: false });
  assert.deepEqual(meta.canaries, { results: 1, ai_block: 0 });
  assert.deepEqual(meta.extra, { attempt: 2 });
  assert.ok(!("timings" in meta), "an empty timings object is not worth persisting");
});

test("saves only meta.json when there is no page (fetch-level failure)", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  const dir = await artifacts.save(artifactInput({ page: undefined }));
  assert.deepEqual(await readdir(dir), ["meta.json"]);
  const meta = await readMeta(dir);
  assert.equal(meta.screenshot, false);
  assert.equal(meta.serp !== undefined, true);
});

// ---------------------------------------------------------------------------
// Failure tolerance
// ---------------------------------------------------------------------------

class NoScreenshotPage extends FakePage {
  override async screenshot(): Promise<Buffer> {
    throw new Error("Page.captureScreenshot: target closed");
  }
}

class BrokenReadsPage extends FakePage {
  override async html(): Promise<string> {
    throw new Error("E_TARGET_LOST");
  }

  override async innerText(): Promise<string> {
    throw new Error("E_TARGET_LOST");
  }
}

test("a failed screenshot is recorded, not fatal", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  const page = new NoScreenshotPage({ html: SERP_HTML, text: "visible" });
  const dir = await artifacts.save(artifactInput({ page }));

  assert.deepEqual((await readdir(dir)).sort(), ["meta.json", "page.html", "page.txt"]);
  assert.equal((await readMeta(dir)).screenshot, false);
});

test("failed DOM reads lose files, never the meta or the original error", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  const dir = await artifacts.save(artifactInput({ page: new BrokenReadsPage({ screenshot: SCREENSHOT }) }));
  assert.deepEqual((await readdir(dir)).sort(), ["meta.json", "screenshot.jpg"]);
  const meta = await readMeta(dir);
  assert.equal(meta.screenshot, true);
  assert.equal(meta.code, "E_PARSE");
});

test("disabled artifacts write nothing and do not create the root", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig({ enabled: false }), clock: new StepClock(), root });

  assert.equal(await artifacts.save(artifactInput()), "");
  assert.equal(existsSync(root), false);
});

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

test("root() honours the override and $PI_CODING_AGENT_DIR", () => {
  const override = join(tempDir(), "explicit");
  assert.equal(createArtifacts({ config: makeConfig(), clock: new StepClock(), root: override }).root(), override);

  const env = createArtifacts({
    config: makeConfig(),
    clock: new StepClock(),
    env: { PI_CODING_AGENT_DIR: "/srv/pi-agent" },
  });
  assert.equal(env.root(), "/srv/pi-agent/web-search/artifacts");

  const fallback = createArtifacts({ config: makeConfig(), clock: new StepClock(), env: {} });
  assert.ok(fallback.root().endsWith(join(".pi", "agent", "web-search", "artifacts")));
});

test("size() and prune() on a missing root are zero and create nothing", async () => {
  const root = join(tempDir(), "never-created");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  assert.equal(await artifacts.size(), 0);
  assert.deepEqual(await artifacts.prune(), { removed: 0, kept: 0, bytes: 0 });
  assert.equal(existsSync(root), false);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

test("prune keeps the newest 30 dirs by default and is idempotent", async () => {
  const root = join(tempDir(), "artifacts");
  const clock = new StepClock();
  const artifacts = createArtifacts({ config: makeConfig(), clock, root });

  const saved: string[] = [];
  for (let index = 0; index < 35; index += 1) {
    saved.push(
      await artifacts.save(
        artifactInput({ query: `query ${index}`, url: `https://example.com/${index}`, serp: undefined }),
      ),
    );
    clock.advance(1000);
  }

  const result = await artifacts.prune();
  assert.equal(result.removed, 5);
  assert.equal(result.kept, 30);

  const remaining = await artifactNames(root);
  assert.equal(remaining.length, 30);
  for (let index = 0; index < 5; index += 1) {
    assert.ok(!remaining.includes(basename(saved[index] ?? "")), "the five oldest dirs are gone");
  }
  assert.ok(remaining.includes(basename(saved[34] ?? "")), "the newest dir survives");

  const total = await dirBytes(root);
  assert.equal(result.bytes, total);

  const again = await artifacts.prune();
  assert.deepEqual(again, { removed: 0, kept: 30, bytes: total });
});

test("prune enforces maxBytes oldest-first, measured on file bytes", async () => {
  const root = tempDir();
  const artifacts = createArtifacts({ config: makeConfig({ keep: 100, maxBytes: 1200 }), clock: new StepClock(), root });

  // Five 400-byte artifact dirs: 2000 bytes total → three fit in 1200.
  for (let index = 0; index < 5; index += 1) {
    const name = `20260102-03040${index}-google-${String(index).padStart(8, "0")}`;
    assert.match(name, ARTIFACT_DIR_NAME);
    await mkdir(join(root, name));
    await writeFile(join(root, name, "page.txt"), "x".repeat(400));
  }

  const result = await artifacts.prune();
  assert.deepEqual(result, { removed: 2, kept: 3, bytes: 1200 });
  assert.deepEqual(await artifactNames(root), [
    "20260102-030402-google-00000002",
    "20260102-030403-google-00000003",
    "20260102-030404-google-00000004",
  ]);
});

test("prune deletes a dir that alone exceeds maxBytes rather than lying about size", async () => {
  const root = tempDir();
  const artifacts = createArtifacts({ config: makeConfig({ keep: 100, maxBytes: 300 }), clock: new StepClock(), root });

  await mkdir(join(root, "20260102-030405-google-deadbeef"));
  await writeFile(join(root, "20260102-030405-google-deadbeef", "page.txt"), "x".repeat(400));

  assert.deepEqual(await artifacts.prune(), { removed: 1, kept: 0, bytes: 0 });
  assert.deepEqual(await artifactNames(root), []);
});

test("prune keeps the newest same-second collision suffix", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig({ keep: 3 }), clock: new StepClock(), root });

  // Same second, same input: only the numeric suffix separates the twelve dirs.
  for (let index = 0; index < 12; index += 1) await artifacts.save(artifactInput());

  const base = `${STAMP}-google-${expectedHash("test", SEARCH_URL, "E_PARSE")}`;
  assert.equal((await artifactNames(root)).length, 12);

  const result = await artifacts.prune();
  assert.equal(result.removed, 9);
  assert.equal(result.kept, 3);

  // Numeric, not lexical: `-10`…`-12` are newer than `-2`…`-9` and the base name.
  assert.deepEqual(await artifactNames(root), [`${base}-10`, `${base}-11`, `${base}-12`]);
});

test("prune never touches foreign files, dirs or badly named look-alikes", async () => {
  const root = join(tempDir(), "artifacts");
  const clock = new StepClock();
  const artifacts = createArtifacts({ config: makeConfig({ keep: 1 }), clock, root });

  await mkdir(root, { recursive: true });
  await writeFile(join(root, "notes.txt"), "keep me");
  await mkdir(join(root, "old-backup"));
  await writeFile(join(root, "old-backup", "page.txt"), "keep me too");
  await mkdir(join(root, "20260101-000000-google-notahash"));
  await writeFile(join(root, "20260101-000000-google-notahash", "page.txt"), "look-alike");

  for (let index = 0; index < 3; index += 1) {
    await artifacts.save(artifactInput({ query: `q${index}`, url: `https://example.com/q${index}` }));
    clock.advance(1000);
  }

  const result = await artifacts.prune();
  assert.equal(result.removed, 2);
  assert.equal(result.kept, 1);

  assert.ok(existsSync(join(root, "notes.txt")));
  assert.equal(await readFile(join(root, "old-backup", "page.txt"), "utf8"), "keep me too");
  assert.ok(existsSync(join(root, "20260101-000000-google-notahash")));
  assert.equal((await artifactNames(root)).length, 1);

  // `size()` is the whole root (foreign files included), `kept` only counts ours.
  const total = await dirBytes(root);
  assert.equal(result.bytes, total);
  assert.equal(await artifacts.size(), total);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test("an unwritable root is E_CONFIG naming the path, and is left untouched", async () => {
  const base = tempDir();
  const rootFile = join(base, "root-is-a-file");
  writeFileSync(rootFile, "not a directory");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root: rootFile });

  let error: unknown;
  try {
    await artifacts.save(artifactInput());
  } catch (caught) {
    error = caught;
  }

  assert.ok(isWebSearchError(error), "must be a WebSearchError, never a bare Error");
  assert.equal(error.details.code, "E_CONFIG");
  assert.equal(error.details.stage, "config");
  assert.ok((error.details.message ?? "").includes(rootFile), "the path must be in the message");
  assert.equal(await readFile(rootFile, "utf8"), "not a directory");
});

test("a non-serialisable extra is E_CONFIG and leaves no empty artifact dir", async () => {
  const root = join(tempDir(), "artifacts");
  const artifacts = createArtifacts({ config: makeConfig(), clock: new StepClock(), root });

  await assert.rejects(
    artifacts.save(artifactInput({ extra: { impossible: 1n } })),
    (error: unknown) => {
      assert.ok(isWebSearchError(error), "must be a WebSearchError, never a bare Error");
      assert.equal(error.details.code, "E_CONFIG");
      assert.equal(error.details.stage, "config");
      return true;
    },
  );

  // The directory is claimed before meta.json is serialised: an empty shell would
  // look like a valid artifact to `prune()` and to a reader, so it must be gone.
  assert.ok(existsSync(root), "the root itself is left in place");
  assert.deepEqual(await readdir(root), []);
});
