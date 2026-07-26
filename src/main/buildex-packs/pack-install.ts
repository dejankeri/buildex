import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PackInstallResult } from '../../shared/buildex-packs-types'
import { readPackCatalog } from './pack-catalog'

// Installing a pack writes skill scaffolds into the company repo. Nothing is
// recorded anywhere else: git is the database, so `git status` after an install
// shows exactly what the company gained, and reverting is a checkout.

function skillScaffold(packName: string, skillName: string): string {
  return `---
name: ${skillName}
description: Use when working with ${packName}.
---

# ${skillName}

Installed from the ${packName} capability pack. Replace this with the steps the
agent should follow — what to do, in what order, and what to check afterwards.
`
}

/**
 * Write scaffolds for every skill a pack declares. Existing skills are never
 * overwritten, so re-installing is safe and cannot clobber an operator's edits.
 */
export function installPack(repoPath: string, packId: string): PackInstallResult {
  const catalog = readPackCatalog(repoPath)
  const pack = catalog.packs.find((candidate) => candidate.id === packId)
  if (!pack) {
    return { ok: false, writtenPaths: [], error: `Unknown pack: ${packId}` }
  }
  if (pack.skills.length === 0) {
    return { ok: false, writtenPaths: [], error: `Pack declares no skills: ${packId}` }
  }

  const written: string[] = []
  for (const skill of pack.skills) {
    const skillDir = path.join(repoPath, 'skills', skill)
    const manifestPath = path.join(skillDir, 'SKILL.md')
    if (existsSync(manifestPath)) {
      continue
    }
    try {
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(manifestPath, skillScaffold(pack.name, skill), 'utf8')
    } catch (error) {
      return {
        ok: false,
        writtenPaths: written.sort(),
        error: error instanceof Error ? error.message : String(error)
      }
    }
    written.push(`skills/${skill}/SKILL.md`)
  }

  return { ok: true, writtenPaths: written.sort() }
}
