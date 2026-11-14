/** Public session surface: one lifecycle for the tools, doctor and commands. */

export { createSession, BrowserSession } from "./session.ts";
export type {
  AwaitingAllowInfo,
  ConnectClientOptions,
  Session,
  SessionInfo,
  SessionOptions,
  SessionState,
} from "./session.ts";
export { createKeyedLock, pageLockFor, readSlotKeys } from "./page-lock.ts";
export type { KeyedLock } from "./page-lock.ts";
export {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STALE_MS,
  LOCK_VERSION,
  SessionLock,
  defaultLockPath,
  parseLockRecord,
  pidAlive,
} from "./lock.ts";
export type { LockRecord, SessionLockOptions } from "./lock.ts";
export { discoverEndpoint, parseDevToolsActivePort } from "./discover.ts";
export type {
  DevToolsActivePortEndpoint,
  DevToolsActivePortReason,
  DevToolsActivePortResult,
  DiscoverOptions,
  FetchJson,
  ReadTextFile,
} from "./discover.ts";
export { ANCHOR_BLANK_PAGE, TabPool } from "./tabs.ts";
export type { OwnedTab, OwnedTabInfo, TabPoolOptions } from "./tabs.ts";
