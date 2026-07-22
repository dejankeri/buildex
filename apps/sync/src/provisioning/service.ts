// Provisioning lifecycle. Adapts the prototype's ProvisioningService orchestration
// but drops Gitea: repos are ensured through the GitService seam, and the permission matrix lives in
// the control-plane store (not a forge). Tokens are minted here and only their hashes are persisted.
import type { ControlPlaneStore } from "../store/store.js";
import type { GitService } from "../git/types.js";
import { AuthError } from "../lib/errors.js";
import { newToken, hashToken, TOKEN_PREFIX } from "../lib/tokens.js";

export const CORE_REPO = "core";
export const teamRepo = (companySlug: string) => `team-${companySlug}`;
export const privateRepo = (operatorId: string) => `private-${operatorId}`;

export interface Credentials {
  machineToken: string;
  refreshToken: string;
  repos: { core: string; team: string; private: string };
}

export interface ProvisioningDeps {
  store: ControlPlaneStore;
  git: GitService;
  /** Injected id generator (no Math.random in the seam - keeps provisioning deterministic/testable). */
  idFactory: () => string;
}

export class ProvisioningService {
  constructor(private readonly deps: ProvisioningDeps) {}

  /** Ensure the global read-only core repo exists (idempotent; call at boot). */
  async ensureCoreRepo(): Promise<void> {
    await this.deps.git.ensureRepo(CORE_REPO);
  }

  /** Consume a setup token → provision the operator's three repos, matrix, and a machine credential. */
  async provision(opts: { setupToken: string; machineName: string }): Promise<Credentials> {
    const { store, git } = this.deps;
    const { operatorId } = store.consumeSetupToken(opts.setupToken); // throws AuthError if invalid
    const operator = store.getOperator(operatorId);
    if (!operator) throw new AuthError("operator not found");
    const company = store.getCompany(operator.companyId);
    if (!company) throw new AuthError("company not found");

    const repos = {
      core: CORE_REPO,
      team: teamRepo(company.slug),
      private: privateRepo(operatorId),
    };

    await git.ensureRepo(repos.core);
    await git.ensureRepo(repos.team);
    await git.ensureRepo(repos.private);

    // Permission matrix - core read-only for the operator (non-admin), team + private writable.
    store.setRepoPermission({ principal: operatorId, repo: repos.core, access: "read" });
    store.setRepoPermission({ principal: operatorId, repo: repos.team, access: "write" });
    store.setRepoPermission({ principal: operatorId, repo: repos.private, access: "write" });

    const creds = this.mintMachine(operatorId, opts.machineName);
    store.addAuditEvent({ actor: operatorId, companyId: company.id, action: "provision" });
    return creds;
  }

  /** Find-or-create a company-of-one for a verified Supabase user and mint machine credentials.
   *  Same shape as `provision()`'s output, but the entry point is a Supabase session (`sub`)
   *  instead of a setup token: no invite required, one operator per company. Idempotent - the
   *  same `sub` always resolves to the same company/operator; each call mints a fresh machine
   *  token pair. */
  async provisionBySession(opts: { sub: string; email?: string; machineName: string }): Promise<Credentials> {
    const { store, git } = this.deps;

    const existing = store.findOperatorBySupabaseSub(opts.sub);
    if (existing) {
      return this.mintMachine(existing.operatorId, opts.machineName);
    }

    // Tight read -> create: no `await` between resolving the slug and inserting the company, so
    // two concurrent sign-ins for a brand-new email can't both land on the same fallback slug.
    const slug = store.slugFromEmail(opts.email ?? "user");
    const companyId = this.deps.idFactory();
    store.createCompany({ id: companyId, slug, name: slug });
    const operatorId = this.deps.idFactory();
    store.createOperator({ id: operatorId, companyId, email: opts.email ?? "" });
    store.linkOperatorSupabaseSub(operatorId, opts.sub);

    const repos = {
      core: CORE_REPO,
      team: teamRepo(slug),
      private: privateRepo(operatorId),
    };
    await this.ensureCoreRepo();
    await git.ensureRepo(repos.team);
    await git.ensureRepo(repos.private);

    store.setRepoPermission({ principal: operatorId, repo: repos.core, access: "read" });
    store.setRepoPermission({ principal: operatorId, repo: repos.team, access: "write" });
    store.setRepoPermission({ principal: operatorId, repo: repos.private, access: "write" });

    const creds = this.mintMachine(operatorId, opts.machineName);
    store.addAuditEvent({ actor: operatorId, companyId, action: "provision" });
    return creds;
  }

  /** Rotate a machine's credential pair, keyed on the presented refresh token. */
  async refresh(refreshToken: string): Promise<Credentials> {
    const { store } = this.deps;
    const machineToken = newToken(TOKEN_PREFIX.machine);
    const newRefresh = newToken(TOKEN_PREFIX.refresh);
    const machine = store.rotateMachineTokens({
      refreshTokenHash: hashToken(refreshToken),
      newTokenHash: hashToken(machineToken),
      newRefreshTokenHash: hashToken(newRefresh),
    });
    return this.credsFor(machine.operatorId, machineToken, newRefresh);
  }

  /** Revoke an operator: store drops machines + permissions in one tx (loses access immediately). */
  async revoke(operatorId: string): Promise<void> {
    const { store } = this.deps;
    const operator = store.getOperator(operatorId);
    store.revokeOperator(operatorId);
    if (operator) store.addAuditEvent({ actor: operatorId, companyId: operator.companyId, action: "revoke" });
  }

  private mintMachine(operatorId: string, machineName: string): Credentials {
    const machineToken = newToken(TOKEN_PREFIX.machine);
    const refreshToken = newToken(TOKEN_PREFIX.refresh);
    this.deps.store.registerMachine({
      id: this.deps.idFactory(),
      operatorId,
      name: machineName,
      tokenHash: hashToken(machineToken),
      refreshTokenHash: hashToken(refreshToken),
    });
    return this.credsFor(operatorId, machineToken, refreshToken);
  }

  private credsFor(operatorId: string, machineToken: string, refreshToken: string): Credentials {
    const operator = this.deps.store.getOperator(operatorId)!;
    const company = this.deps.store.getCompany(operator.companyId)!;
    return {
      machineToken,
      refreshToken,
      repos: { core: CORE_REPO, team: teamRepo(company.slug), private: privateRepo(operatorId) },
    };
  }
}
