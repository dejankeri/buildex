import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BuildExPack, PackCatalog } from '../../shared/buildex-packs-types'
import { parsePackManifest } from './pack-manifest'

// Reads the capability-pack catalog out of a company repo. Packs ship read-only
// inside the repo and are installed into it, so the repo — not a server — is the
// source of truth for what a company can do.

// Why: layouts differ between a company repo that vendors `core` wholesale and
// one that keeps a bare catalog at the root. Probing a small ordered list beats
// making every company adopt one path.
const CATALOG_ROOT_CANDIDATES = [
  'catalog',
  'core/catalog',
  'packs/core/catalog',
  '.buildex/catalog'
]

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

export function findCatalogRoots(repoPath: string): string[] {
  return CATALOG_ROOT_CANDIDATES.filter((candidate) => {
    const absolute = path.join(repoPath, candidate)
    try {
      return existsSync(absolute) && statSync(absolute).isDirectory()
    } catch {
      return false
    }
  })
}

/** A pack counts as installed once every skill it declares exists in the repo. */
export function isPackInstalled(repoPath: string, skills: string[]): boolean {
  if (skills.length === 0) {
    return false
  }
  return skills.every((skill) => existsSync(path.join(repoPath, 'skills', skill, 'SKILL.md')))
}

export function readPackCatalog(repoPath: string): PackCatalog {
  const catalogRoots = findCatalogRoots(repoPath)
  const byId = new Map<string, BuildExPack>()

  for (const root of catalogRoots) {
    const absoluteRoot = path.join(repoPath, root)
    let entries: string[]
    try {
      entries = readdirSync(absoluteRoot).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) {
        continue
      }
      const manifestAbsolute = path.join(absoluteRoot, entry, 'pack.json')
      if (!existsSync(manifestAbsolute)) {
        continue
      }
      let body: string
      try {
        body = readFileSync(manifestAbsolute, 'utf8')
      } catch {
        continue
      }
      const manifestPath = toPosix(path.relative(repoPath, manifestAbsolute))
      const parsed = parsePackManifest(body, manifestPath)
      if (!parsed) {
        continue
      }
      // Why: earlier roots win. CATALOG_ROOT_CANDIDATES is ordered most-specific
      // first, so a company's own catalog overrides a vendored copy of core.
      if (byId.has(parsed.id)) {
        continue
      }
      byId.set(parsed.id, {
        ...parsed,
        installed: isPackInstalled(repoPath, parsed.skills)
      })
    }
  }

  return {
    repoPath,
    catalogRoots,
    packs: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}
