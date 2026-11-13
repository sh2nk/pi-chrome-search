/**
 * Engine registry (SPEC §7.1/§7.5, D9/D10; PLAN P2-E).
 *
 * The adapter map is **append-only**. P3 adds one line per green adapter to
 * `DEFAULT_ENGINES` (`google: googleEngine,`) and nothing else in this file
 * changes. Adapters never self-register: an `import "./google.ts"` that called
 * `registry.add(...)` on load would make `select()` depend on module evaluation
 * order — untestable, unreviewable, and a second `web_search` registration path
 * nobody asked for.
 *
 * `auto` order is canonical google → duckduckgo → yandex, yandex last by policy
 * (D10); an explicit list keeps the caller's order so `web_search` falls back
 * and merges exactly as the agent asked.
 *
 * Two different questions are answered here, deliberately separately:
 * - `has(id)` — is there an adapter? (wiring fact, what the doctor reports)
 * - `get(id)` / `enabled()` — may this session actually use it? (adapter +
 *   `config.engines.<id>.enabled`, the tool-facing answer)
 */

import type { Config } from "../config/index.ts";
import { duckduckgoEngine } from "./duckduckgo.ts";
import { googleEngine } from "./google.ts";
import { yandexEngine } from "./yandex.ts";
import { WebSearchError } from "../runtime/error-codes.ts";
import {
  ENGINE_IDS,
  type Engine,
  type EngineId,
  type EngineRegistry,
  type EngineSelection,
} from "./types.ts";

export type EngineMap = Partial<Record<EngineId, Engine>>;

/**
 * Append-only adapter map — the single source of truth for wiring.
 *
 * Empty until P3: no adapter exists yet, so `createDefaultRegistry()` is a
 * registry that honestly reports "registered: false" for every engine instead
 * of pretending a search would work. P3 appends, e.g.:
 *
 * ```ts
 * export const DEFAULT_ENGINES: EngineMap = Object.freeze({
 *   google: googleEngine,
 * });
 * ```
 *
 * Frozen so a runtime bug cannot inject an adapter behind a live registry's
 * back; tests build their own maps with `createEngineRegistry(map, config)`.
 */
export const DEFAULT_ENGINES: EngineMap = Object.freeze({
  google: googleEngine,
  duckduckgo: duckduckgoEngine,
  yandex: yandexEngine,
});

/**
 * Pure append: returns a *new* map with `engine` stored under its own id.
 *
 * Re-registering the identical adapter is a no-op (a wiring layer may call this
 * defensively); replacing a registered adapter with a different object is
 * `E_CONFIG`, because two adapters for one id is exactly the ambiguity the
 * append-only rule exists to prevent. The input map is never mutated.
 */
export function registerAdapter(map: EngineMap, engine: Engine): EngineMap {
  const existing = map[engine.id];
  if (existing !== undefined && existing !== engine) {
    throw new WebSearchError({
      code: "E_CONFIG",
      engine: engine.id,
      stage: "config",
      retryable: false,
      message: `two adapters registered for engine "${engine.id}"`,
      hint: `engine adapters are append-only: keep exactly one "${engine.id}" entry in DEFAULT_ENGINES`,
    });
  }
  const next: EngineMap = { ...map };
  next[engine.id] = engine;
  return next;
}

function missingEngine(id: EngineId): WebSearchError {
  return new WebSearchError({
    code: "E_UNSUPPORTED",
    engine: id,
    stage: "resolve",
    retryable: false,
    message: `engine "${id}" is not registered`,
    hint: `engine "${id}" has no adapter yet; run /web-doctor for per-engine status`,
  });
}

function disabledEngine(id: EngineId): WebSearchError {
  return new WebSearchError({
    code: "E_UNSUPPORTED",
    engine: id,
    stage: "resolve",
    retryable: false,
    message: `engine "${id}" is disabled in config`,
    hint: `set config.engines.${id}.enabled = true (or pick another engine); /web-doctor shows the current state`,
  });
}

class Registry implements EngineRegistry {
  readonly #engines: Readonly<EngineMap>;
  readonly #config: Config;

  constructor(engines: EngineMap, config: Config) {
    // Defensive copy: a caller that keeps mutating its literal after
    // construction must not silently change a live registry.
    this.#engines = Object.freeze({ ...engines });
    this.#config = config;
  }

  has(id: EngineId): boolean {
    return this.#engines[id] !== undefined;
  }

  get(id: EngineId): Engine {
    const engine = this.#engines[id];
    if (engine === undefined) throw missingEngine(id);
    if (!this.#config.engines[id].enabled) throw disabledEngine(id);
    return engine;
  }

  enabled(): EngineId[] {
    return ENGINE_IDS.filter((id) => this.#config.engines[id].enabled && this.#engines[id] !== undefined);
  }

  select(requested: EngineSelection): EngineId[] {
    const usable = new Set(this.enabled());
    // `auto` is the canonical order by construction: `enabled()` walks ENGINE_IDS.
    if (requested === "auto") return this.enabled();

    const list = Array.isArray(requested) ? requested : [requested];
    const selected: EngineId[] = [];
    for (const id of list) {
      // Dedup keeps the first position; unknown/disabled ids vanish rather than
      // failing the call (an engine may simply not have an adapter yet).
      if (!usable.has(id) || selected.includes(id)) continue;
      selected.push(id);
    }
    return selected;
  }
}

export function createEngineRegistry(engines: EngineMap, config: Config): EngineRegistry {
  return new Registry(engines, config);
}

/**
 * The production registry: `DEFAULT_ENGINES` + config. Kept separate from
 * `createEngineRegistry` so tests can inject stub adapters without touching the
 * append-only map.
 */
export function createDefaultRegistry(config: Config): EngineRegistry {
  return createEngineRegistry(DEFAULT_ENGINES, config);
}

/** One engine's wiring/config state for the doctor and `web_doctor --json`. */
export interface EngineStatus {
  id: EngineId;
  /** An adapter exists in the map (P3 wiring fact). */
  registered: boolean;
  /** `config.engines.<id>.enabled`; null when no config was supplied. */
  configEnabled: boolean | null;
  /** `get()`/`select()` will accept this engine right now (registered AND enabled). */
  available: boolean;
}

export interface RegistryStatus {
  /** Every supported engine in canonical order, registered or not. */
  engines: EngineStatus[];
  /** The exact try-order `select("auto")` returns. */
  auto: EngineId[];
  /** `auto.length` — engines usable in this session. */
  ready: number;
  /** ENGINE_IDS.length — every engine the contract knows, ready or not. */
  total: number;
}

/**
 * Serializable registry snapshot for the doctor.
 *
 * `configEnabled` is `null` when the caller passes no config, in which case
 * `available` degrades to "registered". Pass the config whenever it is at hand:
 * "no adapter yet" and "disabled in config" are different fixes (P3 vs
 * `web-search.json`) and the doctor must never conflate them.
 *
 * Adapter-level metadata (wall retry, human-search box) is intentionally absent:
 * `EngineRegistry` has no accessor that returns a config-disabled adapter, and
 * adding one would widen the frozen contract for a display-only field.
 */
export function describeRegistry(registry: EngineRegistry, config?: Config): RegistryStatus {
  const engines: EngineStatus[] = ENGINE_IDS.map((id) => {
    const registered = registry.has(id);
    const configEnabled = config === undefined ? null : config.engines[id].enabled;
    return {
      id,
      registered,
      configEnabled,
      available: registered && configEnabled !== false,
    };
  });
  const auto = registry.select("auto");
  return { engines, auto, ready: auto.length, total: ENGINE_IDS.length };
}
