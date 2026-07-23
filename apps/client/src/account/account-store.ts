// The split the whole feature turns on: secrets in the OS keychain, everything else in a plain JSON
// file. account.json records baseUrl and the returned clone URLs (the server owns repo naming, so we
// keep its URLs verbatim) plus the operatorId/companySlug we can derive from the repo names. It never
// holds a token. The token pair lives under per-org keychain keys so two companies never share one
// credential (invariant 6).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Keychain } from "../keychain/keychain.js";
import type { ProvisionResult } from "./provision-client.js";

export interface StoredAccount {
  baseUrl: string;
  repos: { core: string; team: string; private: string };
  operatorId: string;
  companySlug: string;
}
export interface AccountTokens {
  machineToken: string;
  refreshToken: string;
}

export const machineTokenKey = (orgId: string): string => `org:${orgId}:machine-token`;
export const refreshTokenKey = (orgId: string): string => `org:${orgId}:refresh-token`;

/** Pull the operator id out of `…/git/private-<id>.git` and the slug out of `…/git/team-<slug>.git`.
 *  These are the only identity fields /provision leaves recoverable - companyId is not on the wire. */
function derive(repos: ProvisionResult["repos"]): { operatorId: string; companySlug: string } {
  const priv = /\/private-([a-z0-9_-]+)\.git$/.exec(repos.private);
  const team = /\/team-([a-z0-9_-]+)\.git$/.exec(repos.team);
  return { operatorId: priv?.[1] ?? "", companySlug: team?.[1] ?? "" };
}

export class AccountStore {
  private readonly path: string;
  constructor(private readonly deps: { orgId: string; orgDir: string; keychain: Keychain }) {
    this.path = join(deps.orgDir, "account.json");
  }

  save(baseUrl: string, result: ProvisionResult): StoredAccount {
    const { operatorId, companySlug } = derive(result.repos);
    const account: StoredAccount = { baseUrl, repos: result.repos, operatorId, companySlug };
    mkdirSync(this.deps.orgDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(account, null, 2) + "\n");
    this.setTokens({ machineToken: result.machineToken, refreshToken: result.refreshToken });
    return account;
  }

  load(): StoredAccount | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as StoredAccount;
    } catch {
      return null; // a corrupt file reads as not-connected rather than crashing the daemon
    }
  }

  tokens(): AccountTokens | null {
    const machineToken = this.deps.keychain.get(machineTokenKey(this.deps.orgId));
    const refreshToken = this.deps.keychain.get(refreshTokenKey(this.deps.orgId));
    if (!machineToken || !refreshToken) return null;
    return { machineToken, refreshToken };
  }

  setTokens(t: AccountTokens): void {
    this.deps.keychain.set(machineTokenKey(this.deps.orgId), t.machineToken);
    this.deps.keychain.set(refreshTokenKey(this.deps.orgId), t.refreshToken);
  }

  connected(): boolean {
    return this.load() !== null;
  }

  /** Local-disconnect primitive: wipe both keychain secrets and account.json, reverting this org to
   *  unconnected. Best-effort on the file - `force: true` makes a missing account.json (already
   *  cleared, or never saved) a no-op rather than a throw, so `disconnect()` can call this on every
   *  root's org without first checking whether it was ever attached. */
  clear(): void {
    this.deps.keychain.delete(machineTokenKey(this.deps.orgId));
    this.deps.keychain.delete(refreshTokenKey(this.deps.orgId));
    rmSync(this.path, { force: true });
  }
}
