import { useCallback, useEffect, useState } from 'react'
import { useActiveWorktree } from '@/store/selectors'
import type {
  BrainHistoryResult,
  BrainScan,
  BrainSectionInfo
} from '../../../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../../../shared/buildex-brain-types'

// Everything the Brain screen reads, in one place.
//
// Every tab renders from the same scan, so fetching per-tab would make them
// disagree with each other mid-refresh — history showing a document the sections
// list has already dropped.

const EMPTY_HISTORY: BrainHistoryResult = { saves: [], unavailable: true, unsavedPaths: [] }

/** A document opened for editing, without leaving the Brain. */
export type BrainOpenFile = {
  absolutePath: string
  relativePath: string
  /** What the header says, e.g. "Decisions / pricing". */
  title: string
}

export type BrainState = {
  repoPath: string | null
  scan: BrainScan
  sections: BrainSectionInfo[]
  history: BrainHistoryResult
  loading: boolean
  refresh: () => Promise<void>
  openFile: BrainOpenFile | null
  openDocument: (documentId: string) => void
  openPath: (absolutePath: string, relativePath: string) => void
  closeFile: () => void
}

/** "decisions/pricing.md" reads as "decisions / pricing" — the folder is the section. */
export function titleForBrainPath(relativePath: string): string {
  const parts = relativePath
    .replace(/^\.buildex\//, '')
    .split('/')
    .filter(Boolean)
  // A skill is `skills/<name>/SKILL.md`, where the folder is the name worth
  // showing and the file name is the same for every one of them.
  const meaningful = parts.at(-1) === 'SKILL.md' ? parts.slice(0, -1) : parts
  return meaningful.map((part) => part.replace(/\.md$/i, '')).join(' / ')
}

export function useBrain(): BrainState {
  const activeWorktree = useActiveWorktree()
  const repoPath = activeWorktree?.path ?? null

  const [openFile, setOpenFile] = useState<BrainOpenFile | null>(null)
  const [scan, setScan] = useState<BrainScan>(EMPTY_BRAIN_SCAN)
  const [sections, setSections] = useState<BrainSectionInfo[]>([])
  const [history, setHistory] = useState<BrainHistoryResult>(EMPTY_HISTORY)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void window.api.buildexBrainSections.list().then((result) => setSections(result.sections))
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (!repoPath) {
      setScan(EMPTY_BRAIN_SCAN)
      setHistory(EMPTY_HISTORY)
      return
    }
    setLoading(true)
    try {
      // Together, so the "unsaved" count in the header and the dots on documents
      // can never describe different moments.
      const [nextScan, nextHistory] = await Promise.all([
        window.api.buildexBrain.scan({ repoPath }),
        window.api.buildexBrainSections.history({ repoPath })
      ])
      setScan(nextScan)
      setHistory(nextHistory)
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!repoPath) {
        setScan(EMPTY_BRAIN_SCAN)
        setHistory(EMPTY_HISTORY)
        return
      }
      setLoading(true)
      try {
        const [nextScan, nextHistory] = await Promise.all([
          window.api.buildexBrain.scan({ repoPath }),
          window.api.buildexBrainSections.history({ repoPath })
        ])
        // Why: switching worktrees mid-fetch must not drop the previous repo's
        // brain on top of the new one.
        if (!cancelled) {
          setScan(nextScan)
          setHistory(nextHistory)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoPath])

  // Why: editing happens inside the Brain rather than in the workspace editor.
  // Handing the file to the editor meant leaving this screen and navigating back
  // for every small change, which is the wrong shape for writing a handbook.
  const openPath = useCallback((absolutePath: string, relativePath: string): void => {
    setOpenFile({ absolutePath, relativePath, title: titleForBrainPath(relativePath) })
  }, [])

  // Brain ids are relative to `.buildex/`; the file on disk is not.
  const openDocument = useCallback(
    (documentId: string): void => {
      if (!repoPath) {
        return
      }
      const relativePath = `.buildex/${documentId}`
      openPath(`${repoPath}/${relativePath}`, relativePath)
    },
    [openPath, repoPath]
  )

  const closeFile = useCallback((): void => setOpenFile(null), [])

  // Why: an open document belongs to the repo it came from. Keeping it across a
  // worktree switch would show one company's writing under another's name.
  useEffect(() => {
    setOpenFile(null)
  }, [repoPath])

  return {
    repoPath,
    scan,
    sections,
    history,
    loading,
    refresh,
    openFile,
    openDocument,
    openPath,
    closeFile
  }
}
