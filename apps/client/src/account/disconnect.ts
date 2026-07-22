// The "Log out" orchestration: revert the active org to a clean, unconnected local state while
// KEEPING every root's git history (invariant 8 - a disconnect removes the connection, never the
// work). Mirrors persistAndAttach's shape (a thin sequence over the engine + account seams) so a
// future caller can compose it the same way open-account.ts composes provision/attach.
import type { SyncEngine } from "../sync/engine.js";
import type { AccountStore } from "./account-store.js";

export async function disconnect(deps: {
  engine: SyncEngine;
  account: AccountStore;
  /** Every local root to detach - including core, so the revert is uniform across the whole org. */
  roots: { name: string; dir: string }[];
}): Promise<{ state: "local" }> {
  for (const root of deps.roots) {
    await deps.engine.removeRemote(root.dir);
  }
  deps.account.clear();
  return { state: "local" };
}
