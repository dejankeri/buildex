import { useCallback, useEffect, useState } from 'react'
import { useActiveWorktree } from '@/store/selectors'
import type {
  BrainHistoryResult,
  BrainResolution,
  BrainScan,
  BrainSectionInfo
} from '../../../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../../../shared/buildex-brain-types'
import type { BrainPlacementChoice } from './BrainSetup'

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
  resolution: BrainResolution | null
  sections: BrainSectionInfo[]
  history: BrainHistoryResult
  loading: boolean
  /** The brain here and the brain on the remote have both moved. External only. */
  diverged: boolean
  refresh: () => Promise<void>
  openFile: BrainOpenFile | null
  openDocument: (documentId: string) => void
  openPath: (absolutePath: string, relativePath: string) => void
  closeFile: () => void
  /** Write the chosen sections into a repo that has no brain yet. */
  setUp: (folders: string[], summary: string, placement: BrainPlacementChoice) => Promise<void>
  /** Clone the brain a `needs-clone` resolution points at. */
  cloneBrain: (targetPath: string) => Promise<void>
  /** Detach this repo from an external brain, leaving the brain itself untouched. */
  disconnect: () => Promise<void>
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
  const [diverged, setDiverged] = useState(false)

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
      let scanned: BrainScan = EMPTY_BRAIN_SCAN
      try {
        const [nextScan, nextHistory] = await Promise.all([
          window.api.buildexBrain.scan({ repoPath }),
          window.api.buildexBrainSections.history({ repoPath })
        ])
        scanned = nextScan
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
      // Why: opening the Brain is when a shared brain catches up with the team.
      // After the render above, never before it: the screen shows local state
      // straight away and a fetch over the network must not hold that up.
      const resolution = scanned.resolution
      if (cancelled || resolution?.status !== 'ready' || resolution.location.mode !== 'external') {
        return
      }
      const pulled = await window.api.buildexBrain.pull({ repoPath })
      if (cancelled) {
        return
      }
      // Reported, never merged: only a person can say what the company decided.
      setDiverged(pulled.diverged)
      if (pulled.pulled) {
        await refresh()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refresh, repoPath])

  // Why: editing happens inside the Brain rather than in the workspace editor.
  // Handing the file to the editor meant leaving this screen and navigating back
  // for every small change, which is the wrong shape for writing a handbook.
  const openPath = useCallback((absolutePath: string, relativePath: string): void => {
    setOpenFile({ absolutePath, relativePath, title: titleForBrainPath(relativePath) })
  }, [])

  // Brain ids are relative to the brain root, which is not always inside the repo.
  // Joined by hand rather than with `node:path`, which the renderer does not have.
  const openDocument = useCallback(
    (documentId: string): void => {
      const root = scan.resolution?.status === 'ready' ? scan.resolution.location.root : null
      if (!root) {
        return
      }
      openPath(`${root.replace(/[/\\]$/, '')}/${documentId}`, documentId)
    },
    [openPath, scan.resolution]
  )

  const closeFile = useCallback((): void => setOpenFile(null), [])

  const setUp = useCallback(
    async (folders: string[], summary: string, placement: BrainPlacementChoice): Promise<void> => {
      if (!repoPath) {
        return
      }
      if (placement.mode === 'external') {
        const request = {
          repoPath,
          brainPath: placement.brainPath,
          ...(placement.remote ? { remote: placement.remote } : {}),
          writePointer: placement.writePointer
        }
        // migrate moves an embedded brain's files; a repo with nothing embedded
        // has nothing to move, and needs bind instead — the operation that only
        // points this repo at a brain that already exists. Choosing by what is
        // actually on disk, not by what the renderer cannot check, is what keeps
        // "in a separate brain repo" from silently landing embedded.
        const result = scan.embeddedBrainPresent
          ? await window.api.buildexBrain.migrate(request)
          : await window.api.buildexBrain.bind(request)
        if (!result.ok) {
          throw new Error(result.error ?? 'Could not connect this repo to the brain')
        }
      }
      await window.api.buildexBrain.setUp({ repoPath, folders, summary })
      // Rescanned rather than assumed: the scan is what decides whether the
      // setup screen is still showing, so it has to be the thing that changes.
      await refresh()
    },
    [refresh, repoPath, scan.embeddedBrainPresent]
  )

  const cloneBrain = useCallback(
    async (targetPath: string): Promise<void> => {
      if (!repoPath || scan.resolution?.status !== 'needs-clone') {
        return
      }
      await window.api.buildexBrain.clone({
        repoPath,
        remote: scan.resolution.remote,
        targetPath
      })
      await refresh()
    },
    [refresh, repoPath, scan.resolution]
  )

  const disconnect = useCallback(async (): Promise<void> => {
    if (!repoPath) {
      return
    }
    await window.api.buildexBrain.disconnect({ repoPath })
    await refresh()
  }, [refresh, repoPath])

  // Why: an open document belongs to the repo it came from. Keeping it across a
  // worktree switch would show one company's writing under another's name.
  useEffect(() => {
    setOpenFile(null)
  }, [repoPath])

  return {
    repoPath,
    scan,
    resolution: scan.resolution,
    sections,
    history,
    loading,
    diverged,
    refresh,
    openFile,
    openDocument,
    openPath,
    closeFile,
    setUp,
    cloneBrain,
    disconnect
  }
}
