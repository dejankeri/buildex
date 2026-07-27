import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BuildExPack, PackCatalog, PackSource } from '../../shared/buildex-packs-types'
import { parsePackManifest } from './pack-manifest'

// The capability-pack catalog. Packs ship with the app so a brand-new operator
// has a full shelf on first launch; a company repo may also carry its own
// catalog, and those override the shipped ones by id, so a company can fork a
// pack without losing the rest.

// Why: layouts differ between a company repo that vendors `core` wholesale and
// one that keeps a bare catalog at the root. Probing a small ordered list beats
// making every company adopt one path.
const REPO_CATALOG_CANDIDATES = [
  'catalog',
  'core/catalog',
  'packs/core/catalog',
  '.buildex/catalog'
]

/** Label used in `PackCatalog.catalogRoots` for the catalog shipped with the app. */
export const BUNDLED_CATALOG_LABEL = 'bundle'

export type CatalogSource = {
  /** Absolute directory holding one subdirectory per pack. */
  root: string
  /** Repo-relative path, or BUNDLED_CATALOG_LABEL. */
  label: string
  source: PackSource
}

function isDirectory(absolute: string): boolean {
  try {
    return existsSync(absolute) && statSync(absolute).isDirectory()
  } catch {
    return false
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

export function findCatalogRoots(repoPath: string): string[] {
  return REPO_CATALOG_CANDIDATES.filter((candidate) => isDirectory(path.join(repoPath, candidate)))
}

/**
 * Every place packs can come from, most authoritative first. The company's own
 * catalog precedes the shipped one so a repo pack shadows a bundled pack of the
 * same id.
 */
export function resolveCatalogSources(
  repoPath: string,
  bundledRoot: string | null
): CatalogSource[] {
  const sources: CatalogSource[] = findCatalogRoots(repoPath).map((label) => ({
    root: path.join(repoPath, label),
    label,
    source: 'repo' as const
  }))
  if (bundledRoot && isDirectory(bundledRoot)) {
    sources.push({ root: bundledRoot, label: BUNDLED_CATALOG_LABEL, source: 'bundle' })
  }
  return sources
}

/** A pack counts as installed once every skill it declares exists in the repo. */
export function isPackInstalled(repoPath: string, skills: string[]): boolean {
  if (skills.length === 0) {
    return false
  }
  return skills.every((skill) => existsSync(path.join(repoPath, 'skills', skill, 'SKILL.md')))
}

function readPacksFrom(
  source: CatalogSource,
  byId: Map<string, BuildExPack>,
  repoPath: string
): void {
  let entries: string[]
  try {
    entries = readdirSync(source.root).sort()
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue
    }
    const packDir = path.join(source.root, entry)
    const manifestAbsolute = path.join(packDir, 'pack.json')
    if (!existsSync(manifestAbsolute)) {
      continue
    }
    let body: string
    try {
      body = readFileSync(manifestAbsolute, 'utf8')
    } catch {
      continue
    }
    const parsed = parsePackManifest(body, toPosix(path.relative(source.root, manifestAbsolute)))
    if (!parsed) {
      continue
    }
    // Why: sources are ordered most-authoritative first, so the first pack to
    // claim an id keeps it.
    if (byId.has(parsed.id)) {
      continue
    }
    byId.set(parsed.id, {
      ...parsed,
      sourceDir: packDir,
      source: source.source,
      installed: isPackInstalled(repoPath, parsed.skills)
    })
  }
}

export function readPackCatalog(repoPath: string, bundledRoot: string | null = null): PackCatalog {
  const sources = resolveCatalogSources(repoPath, bundledRoot)
  const byId = new Map<string, BuildExPack>()
  for (const source of sources) {
    readPacksFrom(source, byId, repoPath)
  }
  return {
    repoPath,
    catalogRoots: sources.map((source) => source.label),
    packs: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}
