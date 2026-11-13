/**
 * Version constants shared by the doctor, artifacts meta and the README.
 *
 * `EXTENSION_VERSION` is the package manifest's own version. v1 hand-maintained
 * this constant, so after the 0.1.1 release the tree still reported 0.1.0
 * (SPEC A5). The manifest is the single source, so a release bump cannot drift
 * from what the extension reports.
 */

import manifest from "../package.json" with { type: "json" };

export const EXTENSION_NAME: string = manifest.name;
export const EXTENSION_VERSION: string = manifest.version;
export const CONFIG_FILE_NAME = "web-search.json";
export const STATE_DIR_NAME = "web-search";
