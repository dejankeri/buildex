// The git permission gate - the permission-matrix invariant, enforced as pure logic before any git
// bytes flow. "core read-only by construction" lives here: a write op against a repo the principal
// only has read (or no) access to is rejected. A revoked machine's token no longer resolves, so it
// loses read+write within one request (invariant 6).
import type { Access } from "../store/store.js";

export type GitOp = "read" | "write";

/** The minimal store surface the authorizer needs (the real ControlPlaneStore satisfies it). */
export interface AuthzStore {
  findMachineByTokenHash(tokenHash: string): { operatorId: string } | undefined;
  getAccess(principal: string, repo: string): Access;
}

export type GitAuthResult = { ok: true; principal: string } | { ok: false; status: 401 | 403 };

const SERVICE_OP: Record<string, GitOp> = {
  "git-upload-pack": "read",
  "git-receive-pack": "write",
};

/** Map a git smart-HTTP service to the access it requires. Throws on an unknown service. */
export function opForService(service: string): GitOp {
  const op = SERVICE_OP[service];
  if (!op) throw new Error(`unknown git service: ${service}`);
  return op;
}

/** Decide whether `tokenHash` may perform `op` on `repo`. 401 = no valid principal; 403 = forbidden. */
export function authorizeGit(
  store: AuthzStore,
  tokenHash: string,
  repo: string,
  op: GitOp,
): GitAuthResult {
  const machine = store.findMachineByTokenHash(tokenHash);
  if (!machine) return { ok: false, status: 401 };

  const access = store.getAccess(machine.operatorId, repo);
  const permitted = op === "write" ? access === "write" : access === "read" || access === "write";
  if (!permitted) return { ok: false, status: 403 };

  return { ok: true, principal: machine.operatorId };
}
