import { requireBrainLocation } from '../buildex-brain/brain-location'
import { resolveCompanyIdentity } from '../buildex-company-identity'
import { readCompanyStoreEntries } from './store-catalog-source'
import { collectPluginEnv } from './plugin-env'

// The company's installed plugins' keys, on their way into a terminal.
//
// Everything a PTY spawn needs to know about business identity lives here rather
// than in `pty.ts`, which is upstream's file and only registers the call.
//
// Every terminal gets its own business's keys and nobody else's — which before
// this meant every terminal got every key on the machine. A workspace this
// machine cannot see (a remote one) has no local business to be, and gets
// nothing rather than a guess.

/**
 * The workspace a PTY spawn belongs to, or nothing when it belongs to none.
 *
 * `cwd` alone is just wherever a shell started. A bare `$HOME` terminal has a
 * cwd, is nobody's business, and used to receive every key on the machine — so
 * the workspace identity, not the directory, is what decides.
 */
export function companyWorkspacePathForSpawn(
  ctx: { cwd?: string; worktreeId?: string } | undefined
): string | undefined {
  return ctx?.worktreeId && ctx.cwd ? ctx.cwd : undefined
}

export function applyCompanyPluginEnv(
  baseEnv: Record<string, string>,
  opts: { workspacePath?: string; userDataPath: string }
): void {
  const workspacePath = opts.workspacePath
  if (!workspacePath) {
    return
  }
  const company = resolveCompanyIdentity(workspacePath)
  if (!company) {
    return
  }
  const deps = { userDataPath: opts.userDataPath, companyKey: company.key }
  try {
    // Why the brain: a catalogue read without this company's own marketplaces
    // does not contain the plugins installed from them, so their keys would be
    // saved, badged Connected by the Store — which does read them — and then
    // never reach a terminal.
    const entries = readCompanyStoreEntries(
      requireBrainLocation(workspacePath),
      company.key,
      opts.userDataPath
    )
    for (const [key, value] of Object.entries(collectPluginEnv(deps, entries))) {
      // Why: never override a variable the operator already exported — their
      // shell environment outranks a stored key.
      baseEnv[key] ??= value
    }
  } catch {
    // A terminal must open even when the catalog cannot be read.
  }
}
