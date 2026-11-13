/**
 * Config loading: an optional file over defaults, then env overrides.
 * A missing file is not an error; everything else is `E_CONFIG`.
 */

import { readFileSync } from "node:fs";

import { DEFAULT_CONFIG, type Config } from "./defaults.ts";
import { applyEnv, resolveConfigPath } from "./env.ts";
import { configError, parseConfig } from "./schema.ts";

export interface LoadConfigOptions {
  /** Explicit config file path; defaults to `resolveConfigPath(env)`. */
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const path = opts.path ?? resolveConfigPath(env);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return applyEnv(DEFAULT_CONFIG, env, path);
    throw configError(`cannot read ${path} (${code ?? "unknown error"})`, path);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw configError(`invalid JSON (${message})`, path);
  }

  return applyEnv(parseConfig(raw, { source: path }), env, path);
}
