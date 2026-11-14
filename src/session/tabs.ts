/**
 * Owned-tab model (SPEC S12.1, S12.3; PLAN P3).
 *
 * One anchor tab hosts the local panel and keeps the owned window alive; each
 * engine gets one work tab, and reads get `read#n` slots. Acquisition is
 * idempotent: asking twice for the same key returns the same tab while it
 * exists, and a tab the user closed is forgotten and recreated.
 *
 * The only tab ids this module ever closes are ids it created (`#owned`).
 * A target that appeared in the user's window by other means is invisible
 * here, which is what makes "never close a foreign tab" structural.
 */

import type { Clock } from "../runtime/types.ts";
import { createCdpPage } from "../cdp/page.ts";
import type { CdpClient, CdpPage, PageKey } from "../cdp/types.ts";

export const ANCHOR_BLANK_PAGE = "about:blank";

export interface OwnedTab {
  targetId: string;
  /** `null` only for the anchor. */
  key: PageKey | null;
  page: CdpPage;
}

export interface OwnedTabInfo {
  targetId: string;
  key: PageKey | null;
  url: string;
}

export interface TabPoolOptions {
  client: CdpClient;
  clock: Clock;
  warn: (event: string, detail: string) => void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TabPool {
  readonly #client: CdpClient;
  readonly #clock: Clock;
  readonly #warn: (event: string, detail: string) => void;

  #anchor: OwnedTab | undefined;
  readonly #pages = new Map<PageKey, OwnedTab>();
  /** Target ids this pool created. The only ids `release*` may close. */
  readonly #owned = new Set<string>();

  #windowId: number | null = null;
  #windowDegraded = false;

  constructor(options: TabPoolOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#warn = options.warn;
  }

  anchor(): OwnedTab | undefined {
    return this.#anchor;
  }

  pageFor(key: PageKey): CdpPage | undefined {
    return this.#pages.get(key)?.page;
  }

  windowId(): number | null {
    return this.#windowId;
  }

  windowDegraded(): boolean {
    return this.#windowDegraded;
  }

  ownedIds(): string[] {
    return [...this.#owned];
  }

  ownedInfo(): OwnedTabInfo[] {
    const list: OwnedTabInfo[] = [];
    const anchor = this.#anchor;
    if (anchor !== undefined && this.#owned.has(anchor.targetId)) {
      list.push({ targetId: anchor.targetId, key: null, url: anchor.page.url() });
    }
    for (const tab of this.#pages.values()) {
      if (!this.#owned.has(tab.targetId)) continue;
      list.push({ targetId: tab.targetId, key: tab.key, url: tab.page.url() });
    }
    return list;
  }

  /** Ensure the anchor exists and belongs to the owned window. */
  async ensureAnchor(url: string): Promise<OwnedTab> {
    const anchor = this.#anchor;
    if (anchor !== undefined && (await this.#targetExists(anchor.targetId))) return anchor;
    if (anchor !== undefined) {
      this.#owned.delete(anchor.targetId);
      this.#warn("anchor_lost", `the anchor tab ${anchor.targetId} is gone; creating a new window`);
    }
    return await this.#createAnchor(url);
  }

  /** Idempotent work-tab acquisition. A closed tab is recreated, never reused. */
  async acquire(key: PageKey, anchorUrl: string): Promise<CdpPage> {
    const existing = this.#pages.get(key);
    if (existing !== undefined) {
      if (await this.#targetExists(existing.targetId)) {
        if (this.#client.sessionIdFor(existing.targetId) === undefined) {
          await this.#client.attach(existing.targetId);
        }
        return existing.page;
      }
      this.#pages.delete(key);
      this.#owned.delete(existing.targetId);
      this.#warn("tab_lost", `owned ${key} tab ${existing.targetId} is gone; opening a new one`);
    }

    await this.ensureAnchor(anchorUrl);
    const created = await this.#createWorkTarget();
    const owned: OwnedTab = { targetId: created.targetId, key, page: created.page };
    this.#pages.set(key, owned);
    return owned.page;
  }

  /**
   * Drop one cached work tab and close it when we created it. A PDF read uses
   * this because Chrome swaps a PDF tab's document into an out-of-process
   * viewer, leaving the flattened session detached and the next read broken.
   */
  async release(key: PageKey): Promise<void> {
    const owned = this.#pages.get(key);
    if (owned === undefined) return;
    this.#pages.delete(key);
    this.#owned.delete(owned.targetId);
    if (owned.targetId !== this.#anchor?.targetId) {
      await this.#closeTargetQuietly(owned.targetId);
    }
  }

  /** Close every tab this pool created. Foreign targets are never in `#owned`. */
  async releaseAll(): Promise<void> {
    const ids = this.#orderedOwnedIds();
    this.#owned.clear();
    this.#pages.clear();
    this.#anchor = undefined;
    this.#windowId = null;
    this.#windowDegraded = false;
    for (const targetId of ids) await this.#closeTargetQuietly(targetId);
  }

  /**
   * Forget the owned tabs without closing them and return their ids. Used when
   * the socket died past its one reconnect: the tabs still exist in Chrome and
   * must be closed through the *next* client, but the old one cannot do it.
   */
  detach(): string[] {
    const ids = this.#orderedOwnedIds();
    this.#owned.clear();
    this.#pages.clear();
    this.#anchor = undefined;
    this.#windowId = null;
    this.#windowDegraded = false;
    return ids;
  }

  /** Work tabs first, the anchor last: the last tab in a window closes it. */
  #orderedOwnedIds(): string[] {
    const anchor = this.#anchor?.targetId;
    const ids = [...this.#owned];
    if (anchor === undefined) return ids;
    return [...ids.filter((id) => id !== anchor), anchor];
  }

  async closeTargets(ids: readonly string[]): Promise<void> {
    for (const targetId of ids) await this.#closeTargetQuietly(targetId);
  }

  async #createAnchor(url: string): Promise<OwnedTab> {
    const wantsPanel = url !== ANCHOR_BLANK_PAGE;
    let targetUrl = url;
    let targetId: string;
    try {
      targetId = await this.#client.createTarget(targetUrl, { newWindow: true });
    } catch (error) {
      if (!wantsPanel) throw error;
      this.#warn(
        "panel_unavailable",
        `the local anchor panel was refused (${describeError(error)}); falling back to about:blank`,
      );
      targetUrl = ANCHOR_BLANK_PAGE;
      targetId = await this.#client.createTarget(ANCHOR_BLANK_PAGE, { newWindow: true });
    }

    this.#owned.add(targetId);
    await this.#client.attach(targetId);
    const page = createCdpPage(this.#client, targetId, { clock: this.#clock, initialUrl: targetUrl });
    this.#anchor = { targetId, key: null, page };

    const windowId = await this.#windowForTarget(targetId);
    if (windowId !== null) this.#windowId = windowId;
    return this.#anchor;
  }

  async #createWorkTarget(): Promise<{ targetId: string; page: CdpPage }> {
    let targetId: string;
    let dedicated = false;
    try {
      targetId = await this.#client.createTarget(ANCHOR_BLANK_PAGE, { newWindow: false });
    } catch (error) {
      this.#warn("tab_placement_failed", `could not create a tab in the owned window: ${describeError(error)}`);
      targetId = await this.#client.createTarget(ANCHOR_BLANK_PAGE, { newWindow: true });
      dedicated = true;
      this.#windowDegraded = true;
    }

    if (!dedicated) {
      const placedIn = await this.#windowForTarget(targetId);
      if (this.#windowId !== null && placedIn !== null && placedIn !== this.#windowId) {
        this.#warn(
          "tab_foreign_window",
          `new tab landed in window ${placedIn}, not the owned window ${this.#windowId}; forcing a dedicated window`,
        );
        // We created this target, so closing it is allowed; the user's window and
        // its tabs are untouched.
        await this.#closeTargetQuietly(targetId);
        this.#owned.delete(targetId);
        targetId = await this.#client.createTarget(ANCHOR_BLANK_PAGE, { newWindow: true });
        dedicated = true;
        this.#windowDegraded = true;
      }
    }

    if (dedicated) {
      const windowId = await this.#windowForTarget(targetId);
      if (windowId !== null) this.#windowId = windowId;
    }

    this.#owned.add(targetId);
    await this.#client.attach(targetId);
    const page = createCdpPage(this.#client, targetId, { clock: this.#clock, initialUrl: ANCHOR_BLANK_PAGE });
    return { targetId, page };
  }

  async #targetExists(targetId: string): Promise<boolean> {
    const targets = await this.#client.targets();
    return targets.some((target) => target.id === targetId);
  }

  async #windowForTarget(targetId: string): Promise<number | null> {
    try {
      const result = await this.#client.send<Record<string, unknown>>("Browser.getWindowForTarget", { targetId });
      const windowId = isRecord(result) ? result.windowId : undefined;
      return typeof windowId === "number" && Number.isFinite(windowId) ? windowId : null;
    } catch (error) {
      // An unknown window id disables placement checks; it must not fail a search.
      this.#warn("window_lookup_failed", describeError(error));
      return null;
    }
  }

  async #closeTargetQuietly(targetId: string): Promise<void> {
    try {
      await this.#client.closeTarget(targetId);
    } catch (error) {
      this.#warn("target_close_failed", `could not close owned target ${targetId}: ${describeError(error)}`);
    }
  }
}
