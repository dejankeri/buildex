import { resolveCompanyIdentity } from '../buildex-company-identity'
import { readAppStoreCatalog } from './store-catalog-source'
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

export function applyCompanyPluginEnv(
  baseEnv: Record<string, string>,
  opts: { workspacePath?: string; userDataPath: string }
): void {
  const company = resolveCompanyIdentity(opts.workspacePath)
  if (!company) {
    return
  }
  const deps = { userDataPath: opts.userDataPath, companyKey: company.key }
  try {
    const catalog = readAppStoreCatalog(deps)
    for (const [key, value] of Object.entries(collectPluginEnv(deps, catalog.entries))) {
      // Why: never override a variable the operator already exported — their
      // shell environment outranks a stored key.
      baseEnv[key] ??= value
    }
  } catch {
    // A terminal must open even when the catalog cannot be read.
  }
}
