import { resolveCompanyIdentity } from '../buildex-company-identity'
import { readAppStoreCatalog } from './store-catalog-source'
import { collectPluginEnv } from './plugin-env'

// The company's installed plugins' keys, on their way into a terminal.
//
// Everything a PTY spawn needs to know about business identity lives here rather
// than in `pty.ts`, which is upstream's file and only registers the call.
//
// A workspace that is not a company gets nothing. That is the point: a shell
// somewhere outside a business has no business holding that business's Stripe
// key, and before this it held every one of them.

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
