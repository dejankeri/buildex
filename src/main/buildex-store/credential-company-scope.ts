import { app } from 'electron'
import { resolveCompanyIdentity } from '../buildex-company-identity'

// Which business a credential call is about, or why there is none.
//
// Reading tolerates having no company — a pre-company key still answers. Writing
// does not: with nowhere of its own to file a key, the only place left is the
// slot every business reads, and putting one business's key there hands it to
// the next one's agent. So saving and disconnecting both refuse, and say which
// of three different problems it is.

export type CredentialScope = { userDataPath: string; companyKey: string }

/**
 * What the Store writes with, or an error in the operator's terms.
 *
 * `connectionId` decides the remote case rather than the path, deliberately: SSH
 * to a host with the same username and `/home/ubuntu/acme` exists on both sides,
 * so letting the filesystem answer would file the remote business's key under
 * the local business's name and inject it into local terminals. Host identity is
 * carried, never inferred — the same reason `gateCompanyWorktreeOnActivation`
 * takes one.
 */
export function credentialWriteScope(request: {
  repoPath?: string
  connectionId?: string | null
}): CredentialScope | { error: string } {
  if (request.connectionId?.trim()) {
    return {
      error:
        'This workspace runs on another machine. BuildEx cannot store a key for a remote workspace yet.'
    }
  }
  const repoPath = request.repoPath?.trim()
  if (!repoPath) {
    return { error: 'Open a workspace first — a key is saved per company.' }
  }
  const companyKey = resolveCompanyIdentity(repoPath)?.key
  return companyKey
    ? { userDataPath: app.getPath('userData'), companyKey }
    : { error: `BuildEx cannot see ${repoPath} on this machine, so it has nowhere to put a key.` }
}
