// Supplies the current machine token to the engine and knows how to rotate it. A rotation is only
// attempted when a push/fetch fails auth (the engine calls rotate() then retries once). rotate()
// reports which of three things happened - "rotated" (retry), "revoked" (401/403: the refresh token
// itself was rejected, the account is dead), or "offline" (transient, could not reach the server) -
// and a failed rotation of either kind must NOT wipe the account: the last-known pair is left in
// place so a later manual save can try again.
import type { AccountStore } from "./account-store.js";
import { refresh, ProvisionError } from "./provision-client.js";
import type { AuthRotation } from "../sync/engine.js";

export interface TokenProvider {
  current(): string | undefined;
  rotate(): Promise<AuthRotation>;
}

export function makeTokenProvider(deps: { store: AccountStore; fetch: typeof fetch }): TokenProvider {
  return {
    current(): string | undefined {
      return deps.store.tokens()?.machineToken;
    },
    async rotate(): Promise<AuthRotation> {
      const account = deps.store.load();
      const tokens = deps.store.tokens();
      if (!account || !tokens) return "offline"; // nothing to rotate - not a revocation, never wipe
      try {
        const rotated = await refresh({ fetch: deps.fetch, baseUrl: account.baseUrl }, tokens.refreshToken);
        deps.store.setTokens({ machineToken: rotated.machineToken, refreshToken: rotated.refreshToken });
        return "rotated";
      } catch (e) {
        // A 401/403 from /token/refresh means the refresh token itself is rejected - the account is
        // revoked and must be reconnected. Anything else (network = status 0, 5xx) is transient.
        // Either way the stored pair is left untouched: the account is never silently wiped.
        if (e instanceof ProvisionError && (e.status === 401 || e.status === 403)) return "revoked";
        return "offline";
      }
    },
  };
}
