/**
 * `/web-focus` command handler (SPEC §5.3, PLAN P1-E).
 *
 * Raises the extension's own Chrome window. It never navigates, never opens a
 * tab and never steals focus from a tab this extension does not own: `focus()`
 * on the connector only calls `Page.bringToFront` on owned targets. When there
 * is no live session yet, a connect is enough to create the anchor window —
 * that is the one case where focusing opens something.
 */

import type { Session } from "../session/index.ts";
import { toFailure } from "../runtime/errors.ts";
import type { NotifyContext } from "./doctor.ts";

export interface FocusDeps {
  connector?: Session;
}

export type FocusDepsFactory = () => FocusDeps | Promise<FocusDeps>;

/** Bring the owned window forward, reporting honestly when there is none. */
export async function handleFocusCommand(
  ctx: NotifyContext,
  depsFactory: FocusDepsFactory,
): Promise<void> {
  try {
    const { connector } = await depsFactory();
    if (connector === undefined) {
      ctx.ui.notify("web-focus: no browser connector is available in this session", "warning");
      return;
    }

    if (!connector.isConnected()) await connector.connect();
    await connector.focus();
    ctx.ui.notify("web-focus: brought the extension's Chrome window to the front", "info");
  } catch (error) {
    const details = toFailure(error, { code: "E_CDP_UNAVAILABLE", stage: "connect" });
    ctx.ui.notify(`web-focus failed [${details.code}] ${details.hint}`, "error");
  }
}
