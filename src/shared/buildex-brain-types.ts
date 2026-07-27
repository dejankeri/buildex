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

/** Sections the Brain panel groups documents into, seeded on first open. */
export type BrainSectionInfo = {
  folder: string
  title: string
  purpose: string
}

export type BrainSectionsResult = {
  sections: BrainSectionInfo[]
}

export type BrainCreateDocumentRequest = {
  repoPath: string
  /** Section folder under `.buildex/`, or '' for the brain root. */
  folder: string
  /** What the operator typed; turned into a filename. */
  title: string
}

export type BrainCreateDocumentResult = {
  ok: boolean
  /** Brain-relative id of the new document, e.g. `strategy/pricing.md`. */
  documentId?: string
  /** Absolute path, so the renderer can open it in the editor. */
  absolutePath?: string
  error?: string
}

/** One saved snapshot of the brain — a commit touching `.buildex/`. */
export type BrainSave = {
  hash: string
  shortHash: string
  /** The name the operator gave this save. */
  subject: string
  author: string
  /** Unix seconds, so the renderer formats in the operator's locale. */
  timestamp: number
  /** Brain-relative paths changed in this save, sorted. */
  changedPaths: string[]
}

export type BrainHistoryRequest = {
  repoPath: string
  limit?: number
}

export type BrainHistoryResult = {
  saves: BrainSave[]
  /** True when the repo has no git — history and saving are unavailable. */
  unavailable: boolean
  /** Brain-relative paths changed since the last save. */
  unsavedPaths: string[]
}

export type BrainSaveRequest = {
  repoPath: string
  message: string
}

export type BrainSaveResult = {
  ok: boolean
  /** Brain-relative paths committed, sorted. */
  savedPaths: string[]
  error?: string
}

/** A skill in `.buildex/skills/` — what this company's agent knows how to do. */
export type BrainSkill = {
  /** Directory name, and the agent's handle for it. */
  name: string
  title: string
  description: string
  /** `pack` came from the Store; `company` was written here. */
  source: 'pack' | 'company'
  /** True when `.claude/skills/<name>` points at it, which is how the agent sees it. */
  linked: boolean
}

export type BrainSkillsRequest = {
  repoPath: string
}

export type BrainSkillsResult = {
  skills: BrainSkill[]
}

export type BrainSkillCreateRequest = {
  repoPath: string
  title: string
}

export type BrainSkillCreateResult = {
  ok: boolean
  name?: string
  absolutePath?: string
  error?: string
}
