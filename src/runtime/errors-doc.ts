/**
 * Documentation data for `docs/errors.md` (S9.5, S13.3 pattern).
 *
 * The page is rendered from the closed taxonomy and the one hint per code, so a
 * new code without a hint, a changed retry flag or a stale action cannot survive
 * `npm run lint`. The README deliberately keeps no copy of this table: it links
 * here instead, and the link is checked by the audit.
 */

import { ERROR_CODES, ERROR_HINTS, RETRYABLE } from "./error-codes.ts";

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function errorDocRows(): string[] {
  return ERROR_CODES.map(
    (code) => `| \`${code}\` | ${RETRYABLE[code] ? "yes" : "no"} | ${cell(ERROR_HINTS[code])} |`,
  );
}

export function renderErrorsDoc(): string {
  return [
    "# Errors",
    "",
    "Generated from `src/runtime/error-codes.ts`; do not hand-edit. `node scripts/gen-errors-doc.mjs",
    "--check` fails when this page drifts from the taxonomy.",
    "",
    "Every failure is a `WebSearchError`: `code`, `stage`, `retryable`, `hint`, and, for page states, an",
    "artifact directory. The hint is the action, shown to the agent and the user verbatim.",
    "",
    "| Code | Retry | Action |",
    "|---|---|---|",
    ...errorDocRows(),
    "",
    "`web_doctor` (or `/web-doctor`) is the first stop for CDP, lock, window and per-engine verdicts:",
    "`node src/cli/doctor.ts --json` prints the same report headlessly. Artifacts:",
    "`~/.pi/agent/web-search/artifacts/<ts>-<engine>-<hash>/` (`page.html`, `page.txt`, `screenshot.jpg`,",
    "`meta.json`). Decisions: `~/.pi/agent/web-search/decisions.jsonl`.",
    "",
    "Every code here has an offline test; `RESERVED_CODES` is empty and stays that way unless a future code",
    "is deliberately reserved with a phase and a reason.",
    "",
  ].join("\n");
}
