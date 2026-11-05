/**
 * Extension entry point.
 *
 * P0 registers the command surface only: no tools, no sockets, no background
 * work (the factory runs in invocations that never start a session). Tool
 * registration lands in P2-E; the doctor command is wired in P1-E.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function register(pi: ExtensionAPI): void {
  pi.registerCommand("web-doctor", {
    description: "Diagnose CDP attach, lock, cache and per-engine probes (JSON with --json)",
    handler: async (args, ctx) => {
      const json = args.split(/\s+/).includes("--json");
      if (json) {
        // Print mode has no notification channel; the CLI is the canonical JSON surface.
        ctx.ui.notify("web-doctor: JSON output is produced by `node src/cli/doctor.ts --json`", "warning");
        return;
      }
      ctx.ui.notify("web-doctor is wired in P1 (currently a stub)", "warning");
    },
  });

  pi.registerCommand("web-focus", {
    description: "Bring the extension's Chrome window to the front",
    handler: async (_args, ctx) => {
      ctx.ui.notify("web-focus is wired in P1 (currently a stub)", "warning");
    },
  });
}
