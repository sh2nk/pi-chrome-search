/**
 * Package entry point.
 *
 * pi names a locally installed extension by the path of its entry file, not by `package.json#name`:
 * an entry at `src/index.ts` loses the trailing `index.ts` and the Extensions panel shows `src`.
 * Declaring the entry here keeps the implementation in `src/` and makes the label the package
 * directory (`pi-chrome-search`). `src/index.ts` stays the real module and remains loadable with
 * `pi -e ./src/index.ts`.
 */

export { default } from "./src/index.ts";
export * from "./src/index.ts";
