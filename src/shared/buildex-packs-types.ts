// Capability packs — the App Store's unit of installation. A pack bundles one
// system's faces: an external app link, an MCP server the agent connects to,
// and the skills that teach the agent to use it well. Every face is optional;
// a pack declares only what it has.

export type PackAppFace = {
  url: string
}

export type PackMcpFace = {
  kind: 'http' | 'stdio'
  url?: string
  command?: string
  direct?: boolean
}

export type BuildExPack = {
  id: string
  name: string
  icon: string
  summary: string
  app?: PackAppFace
  mcp?: PackMcpFace
  skills: string[]
  /** POSIX path of the pack.json this came from, relative to its catalog root. */
  manifestPath: string
  /** Absolute directory the pack's files are copied from on install. */
  sourceDir: string
  /** `bundle` ships with the app; `repo` is the company's own fork of a pack. */
  source: PackSource
  /** True when every skill this pack declares exists in the repo. */
  installed: boolean
}

/** Where a pack was read from. A repo pack overrides a bundled one of the same id. */
export type PackSource = 'repo' | 'bundle'

export type PackCatalog = {
  repoPath: string
  /** Repo-relative catalog roots that were scanned. */
  catalogRoots: string[]
  packs: BuildExPack[]
}

export type PackCatalogRequest = {
  repoPath: string
}

export type PackInstallRequest = {
  repoPath: string
  packId: string
}

export type PackInstallResult = {
  ok: boolean
  /** Repo-relative POSIX paths written, sorted. Empty when nothing changed. */
  writtenPaths: string[]
  /**
   * Files the operator had edited, so a newer catalog version was NOT written
   * over them. Reported rather than resolved — the operator decides.
   */
  keptOperatorEdits: string[]
  error?: string
}

/** Result of re-syncing already-installed packs against the shipped catalog. */
export type PackRefreshResult = {
  /** Pack ids that gained at least one updated file. */
  updatedPackIds: string[]
  writtenPaths: string[]
  keptOperatorEdits: string[]
}

export const EMPTY_PACK_CATALOG: PackCatalog = {
  repoPath: '',
  catalogRoots: [],
  packs: []
}
