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
  /**
   * False until the operator sets a brain up here. BuildEx no longer scaffolds
   * on sight, so this is what tells the Brain screen to offer setup instead of
   * showing nine empty sections nobody asked for.
   */
  initialized: boolean
  /** How this repo's brain was resolved. Null only when there is no repo. */
  resolution: BrainResolution | null
  /**
   * True when `<repo>/.buildex` exists on disk, regardless of which location this
   * resolved to. The renderer cannot stat the filesystem itself, so this is how
   * it tells an embedded brain worth moving apart from a repo with nothing to
   * move — the difference between choosing `migrate` and choosing `bind`.
   */
  embeddedBrainPresent: boolean
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
  initialized: false,
  resolution: null,
  embeddedBrainPresent: false,
  documents: [],
  folders: [],
  orphanIds: [],
  totalLinks: 0,
  scannedAt: 0
}

export type BrainSetupRequest = {
  repoPath: string
  /** Section folders to create. Anything left out is simply never created. */
  folders: string[]
  /** The operator's answer to "what does this company do?", if they gave one. */
  summary?: string
}

export type BrainSetupResult = {
  ok: boolean
  /** Brain-relative paths written, sorted. */
  created: string[]
  error?: string
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
  /** True when the save also reached the brain's remote. External mode only. */
  pushed?: boolean
  /**
   * There was nowhere to push: the brain repo has no remote yet, which is a
   * supported way to keep a brain and never a failure. Distinct from
   * {@link pushError} so the renderer never has to read one to tell them apart.
   */
  localOnly?: boolean
  /** The push was attempted against a remote and failed. */
  pushError?: string
  error?: string
}

/** A skill in `.buildex/skills/` — what this company's agent knows how to do. */
export type BrainSkill = {
  /** Directory name, and the agent's handle for it. */
  name: string
  title: string
  description: string
  /** `pack` came from the Store; `company` was written here. */
  source: 'company'
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

/** One file the agent reads in full at the start of every session. */
export type AgentContextFile = {
  /** Repo-relative POSIX path. */
  path: string
  /** Why it is in front of the agent, in one line. */
  reason: string
  body: string
  /** True when this file is here because another one `@`-imported it. */
  imported: boolean
}

/**
 * Something the agent has been told about but has not read. The distinction from
 * {@link AgentContextFile} is the whole point of the view: operators assume a
 * skill's instructions are loaded when only its description is.
 */
export type AgentReachableItem = {
  kind: 'skill' | 'mcp' | 'document'
  name: string
  /** What the agent knows about it without opening it. */
  detail: string
  /** Where to open it: repo-relative POSIX when it's in the repo, absolute when it's an external brain document. */
  path?: string
}

export type AgentViewRequest = {
  repoPath: string
}

export type AgentView = {
  repoPath: string
  alwaysLoaded: AgentContextFile[]
  reachable: AgentReachableItem[]
  /** Characters loaded before the operator types anything. */
  loadedCharacters: number
}

export const EMPTY_AGENT_VIEW: AgentView = {
  repoPath: '',
  alwaysLoaded: [],
  reachable: [],
  loadedCharacters: 0
}

/** What removing the brain would do, worked out before anything is removed. */
export type BrainRemovalPlan = {
  documentCount: number
  /** Brain-relative paths git does not already hold. */
  unsavedPaths: string[]
  /** True when the removal can be recorded as a save. */
  canCommit: boolean
  /** True when a copy will be taken first, because git cannot get it back. */
  willBackUp: boolean
}

export type BrainRemovalRequest = {
  repoPath: string
}

export type BrainRemovalResult = {
  ok: boolean
  /** Where the copy was put, when one was taken. */
  backupPath?: string
  /** True when the removal itself was committed. */
  committed: boolean
  error?: string
}

export type BrainMode = 'embedded' | 'external'

/** Where a repo's brain is, resolved. The value that replaces `repoPath + '.buildex'`. */
export type BrainLocation = {
  /** Absolute path to the brain folder. */
  root: string
  /** Absolute path to the git repo versioning it; equals `root` in external mode. */
  gitRoot: string
  /** Pathspec scoping git commands to the brain: `.buildex` embedded, `.` external. */
  pathspec: string
  mode: BrainMode
  /** The brain repo's remote, when it has one. External only. */
  remote?: string
}

export type BrainResolution =
  | { status: 'ready'; location: BrainLocation }
  /** A pointer names a brain this machine has not cloned yet. */
  | { status: 'needs-clone'; remote: string; suggestedPath: string }
  | { status: 'broken'; reason: 'missing' | 'not-a-repo'; path: string }

export type BrainResolveRequest = { repoPath: string }

export type BrainCloneRequest = { repoPath: string; remote: string; targetPath: string }

export type BrainCloneResult = { ok: boolean; path?: string; error?: string }

export type BrainMigrateRequest = {
  repoPath: string
  brainPath: string
  remote?: string
  writePointer: boolean
}

export type BrainMigrationResult = {
  ok: boolean
  backupPath?: string
  /** Brain-relative paths now in the brain repo, sorted. */
  movedPaths: string[]
  error?: string
}

/**
 * Point a repo at a brain that already exists, with nothing to move — the
 * pristine-repo path `migrate` cannot serve, since `migrate` requires an
 * embedded brain on disk to copy from.
 */
export type BrainBindRequest = {
  repoPath: string
  brainPath: string
  remote?: string
  writePointer: boolean
}

export type BrainBindResult = {
  ok: boolean
  error?: string
}

export type BrainPushRequest = { repoPath: string }

/** Sharing a save that was already committed here. External mode only. */
export type BrainPushResult = {
  pushed: boolean
  /** No remote to push to — nothing failed, and a retry cannot help. */
  localOnly?: boolean
  /** The push was attempted and failed. */
  error?: string
}

export type BrainPullRequest = { repoPath: string }

export type BrainPullResult = {
  pulled: boolean
  diverged: boolean
  error?: string
}
