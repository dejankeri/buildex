// Supplies the current machine token to the engine and knows how to rotate it. A rotation is only
// attempted when a push/fetch fails auth (the engine calls rotate() then retries once). A failed
// rotation must NOT wipe the account - the token may be revoked, but the operator's work stays local
// and the status surfaces `needs-help`; the last-known pair is left in place so a later manual save
// can try again.
import type { AccountStore } from "./account-store.js";
import { refresh } from "./provision-client.js";

export interface TokenProvider {
  current(): string | undefined;
  rotate(): Promise<boolean>;
}

export function makeTokenProvider(deps: { store: AccountStore; fetch: typeof fetch }): TokenProvider {
  return {
    current(): string | undefined {
      return deps.store.tokens()?.machineToken;
    },
    async rotate(): Promise<boolean> {
      const account = deps.store.load();
      const tokens = deps.store.tokens();
      if (!account || !tokens) return false;
      try {
        const rotated = await refresh({ fetch: deps.fetch, baseUrl: account.baseUrl }, tokens.refreshToken);
        deps.store.setTokens({ machineToken: rotated.machineToken, refreshToken: rotated.refreshToken });
        return true;
      } catch {
        return false; // revoked / offline - leave the stored pair untouched
      }
    },
  };
}
