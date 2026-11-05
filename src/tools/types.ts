/**
 * Frozen tool-layer contract. Tools receive dependencies; they never import the
 * browser or a socket directly. See PLAN.md Appendix A.
 */

import type { CdpConnector } from "../cdp/types.ts";
import type { EngineRegistry } from "../engines/types.ts";
import type { Config } from "../config.ts";
import type { Artifacts, Cache, Clock, Limiter, Logger } from "../runtime/types.ts";
import type { Reflex } from "../reflex/types.ts";

export interface ToolDeps {
  config: Config;
  engines: EngineRegistry;
  cdp: CdpConnector;
  cache: Cache;
  limiter: Limiter;
  artifacts: Artifacts;
  log: Logger;
  clock: Clock;
  /** Absent or disabled means rules-only behaviour; tools must work without it. */
  reflex?: Reflex;
  /**
   * Injectable transport for the /goto resolver (SPEC §6.1). Production leaves
   * it unset and the resolver uses the platform fetch; tests must set it so an
   * offline run can never reach Google.
   */
  fetchImpl?: typeof fetch;
}

export interface ToolFailureDetails {
  code: string;
  engine?: string;
  stage: string;
  wall?: string;
  artifact?: string;
  retryable: boolean;
}
