// The company brain's wire contract. Deterministic by construction: every list
// is sorted, so scanning the same tree twice yields byte-identical output. No
// model is involved at any point — this is a rendering of files on disk.

export type BrainDocument = {
  /** Repo-relative POSIX path, e.g. `knowledge/method.md`. Stable node id. */
  id: string
  /** Filename without extension, used as the wikilink target. */
  name: string
  /** Containing directory, `''` at the repo root. */
  folder: string
  /** Documents this one links to, by id. */
  linksTo: string[]
  /** Documents linking here, by id. */
  linkedFrom: string[]
  /** Uncommitted per `git status`. */
  changed: boolean
  headingCount: number
  wordCount: number
}

export type BrainFolder = {
  path: string
  documentCount: number
}

export type BrainScan = {
  repoPath: string
  documents: BrainDocument[]
  folders: BrainFolder[]
  /** Documents nothing links to and which link nowhere — the brain's dead ends. */
  orphanIds: string[]
  totalLinks: number
  scannedAt: number
}

export type BrainScanRequest = {
  repoPath: string
}

export const EMPTY_BRAIN_SCAN: BrainScan = {
  repoPath: '',
  documents: [],
  folders: [],
  orphanIds: [],
  totalLinks: 0,
  scannedAt: 0
}
