import { useCallback, useState } from 'react'
import type { StoreEntry } from '../../../../shared/buildex-store-types'
import { storeEntryDisplayName } from './store-entry-search'

// Installing the whole roster.
//
// One at a time, deliberately: each install shells out to the agent's plugin
// CLI, and running them together interleaves their output and races them over
// the same plugin state. A failure part-way through is not a reason to abandon
// the rest — the operator asked for all of them — so the run continues and
// reports what did not land.

export type RosterBulkInstall = {
  running: boolean
  /** The app being installed right now, for the in-flight line. */
  currentName: string | null
  done: number
  total: number
  /** Names that failed, kept until the next run so the operator can read them. */
  failures: string[]
  run: (entries: StoreEntry[]) => Promise<void>
}

export function useRosterBulkInstall(
  repoPath: string | null,
  onFinished: () => void | Promise<void>
): RosterBulkInstall {
  const [running, setRunning] = useState(false)
  const [currentName, setCurrentName] = useState<string | null>(null)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [failures, setFailures] = useState<string[]>([])

  const run = useCallback(
    async (entries: StoreEntry[]): Promise<void> => {
      if (!repoPath || entries.length === 0) {
        return
      }
      setRunning(true)
      setFailures([])
      setDone(0)
      setTotal(entries.length)
      const failed: string[] = []
      try {
        // Why: the list is snapshotted at the start. Refreshing between installs
        // would shrink it underfoot and the run would skip apps.
        for (const entry of entries) {
          setCurrentName(storeEntryDisplayName(entry))
          const result = await window.api.buildexStore.install({
            repoPath,
            marketplaceId: entry.marketplaceId,
            pluginName: entry.plugin.name
          })
          if (!result.ok) {
            failed.push(storeEntryDisplayName(entry))
          }
          setDone((previous) => previous + 1)
        }
      } finally {
        setFailures(failed)
        setCurrentName(null)
        setRunning(false)
        await onFinished()
      }
    },
    [repoPath, onFinished]
  )

  return { running, currentName, done, total, failures, run }
}
