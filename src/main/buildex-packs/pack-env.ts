import type { BuildExPack } from '../../shared/buildex-packs-types'
import { envKeyForPack, readPackCredential, type PackCredentialDeps } from './pack-credentials'

// Put installed packs' keys into the agent's environment.
//
// This is the one moment a key is in the clear, and it is the moment it has to
// be: `.claude/mcp.json` references ${VAR}, and the skills of `rest`-transport
// packs read the same variable. Everything either side of this — storage, the
// repo, git — stays free of it.
//
// Only installed packs contribute. A key saved for a pack the company later
// removed must not keep reaching the agent.

export function collectPackEnv(
  deps: PackCredentialDeps,
  packs: BuildExPack[]
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pack of packs) {
    if (!pack.installed || !pack.apiKey) {
      continue
    }
    const value = readPackCredential(deps, pack.id)
    if (!value) {
      continue
    }
    env[envKeyForPack(pack)] = value
    // Why: the old catalog paired a key with its API base (PROTOCOL_API_URL), and
    // skills read both. Carry it when the manifest states one.
    if (pack.apiKey.apiBase) {
      env[`${envKeyForPack(pack).replace(/_API_KEY$/, '')}_API_URL`] = pack.apiKey.apiBase
    }
  }
  return env
}
