/**
 * Public config surface. The implementation is split by responsibility:
 * `defaults` (types + values), `schema` (validation), `env` (overrides),
 * `load` (filesystem), `doc` (generated documentation).
 */

export * from "./defaults.ts";
export * from "./env.ts";
export * from "./load.ts";
export * from "./schema.ts";
