// The embedded-git seam. Provisioning depends only on this interface; the real implementation
// (EmbeddedGitService) manages bare repos and serves them over smart-HTTP. Access enforcement does
// NOT live here - it lives in the control-plane permission matrix, checked per request by the HTTP
// git handler (so "core read-only by construction" is one identity system, not a forge's ACLs).
export interface GitService {
  /** Idempotently ensure a bare repo of this name exists. */
  ensureRepo(name: string): Promise<void>;
  /** Idempotently remove a bare repo. Absent is success, not an error - deleting a company must be
   *  re-runnable after a partial failure. Irreversible: there is no other copy of a team or private
   *  repo on the server, so callers own the decision, not this seam. */
  removeRepo(name: string): Promise<void>;
}

/** Repo names are path segments under the repos root - reject anything that could escape it. */
export function assertSafeRepoName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`unsafe repo name: ${JSON.stringify(name)}`);
  }
}
