/**
 * Engine registry. The map is append-only: adapters are registered here by the
 * orchestrator once their lane is green (P3+). Auto order is canonical, yandex
 * last (D10); explicit lists keep the caller's order.
 */

import type { Config } from "../config.ts";
import { WebSearchError } from "../runtime/error-codes.ts";
import {
  ENGINE_IDS,
  type Engine,
  type EngineId,
  type EngineRegistry,
  type EngineSelection,
} from "./types.ts";

export type EngineMap = Partial<Record<EngineId, Engine>>;

class Registry implements EngineRegistry {
  readonly #engines: EngineMap;
  readonly #config: Config;

  constructor(engines: EngineMap, config: Config) {
    this.#engines = engines;
    this.#config = config;
  }

  has(id: EngineId): boolean {
    return this.#engines[id] !== undefined;
  }

  get(id: EngineId): Engine {
    const engine = this.#engines[id];
    if (!engine) {
      throw new WebSearchError({
        code: "E_UNSUPPORTED",
        engine: id,
        stage: "resolve",
        retryable: false,
        message: `engine "${id}" is not registered`,
        hint: `engine "${id}" has no adapter yet; run /web-doctor for per-engine status`,
      });
    }
    return engine;
  }

  enabled(): EngineId[] {
    return ENGINE_IDS.filter((id) => this.#config.engines[id].enabled && this.#engines[id] !== undefined);
  }

  select(requested: EngineSelection): EngineId[] {
    const enabled = this.enabled();
    if (requested === "auto") return enabled;

    const list = Array.isArray(requested) ? requested : [requested];
    const seen = new Set<EngineId>();
    const selected: EngineId[] = [];
    for (const id of list) {
      if (seen.has(id) || !enabled.includes(id)) continue;
      seen.add(id);
      selected.push(id);
    }
    return selected;
  }
}

export function createEngineRegistry(engines: EngineMap, config: Config): EngineRegistry {
  return new Registry(engines, config);
}
