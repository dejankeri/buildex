import { useCallback, useEffect, useRef, useState } from 'react'
import { useActiveWorktree } from '@/store/selectors'
import type { StoreCatalog } from '../../../../shared/buildex-store-types'
import { EMPTY_STORE_CATALOG } from '../../../../shared/buildex-store-types'

// Reads the marketplace indexes for the active workspace. The agent is left to
// the main process to resolve: the renderer only knows a global default agent,
// which is not the same claim as "the agent this workspace runs".
//
// Indexes are fetched into a cache rather than bundled, so reading and fetching
// are two calls. Reading never touches the network — it is also what a terminal
// spawn does — and this hook is what decides the cache is old enough to go and
// get a new one.

export type StoreCatalogState = {
  catalog: StoreCatalog
  repoPath: string | null
  loading: boolean
  /** True while the indexes themselves are being fetched, not merely read. */
  refreshingIndexes: boolean
  error: string | null
  refresh: () => Promise<void>
  refreshIndexes: () => Promise<void>
}

export function useStoreCatalog(): StoreCatalogState {
  const activeWorktree = useActiveWorktree()
  const repoPath = activeWorktree?.path ?? null
  const [catalog, setCatalog] = useState<StoreCatalog>(EMPTY_STORE_CATALOG)
  const [loading, setLoading] = useState(false)
  const [refreshingIndexes, setRefreshingIndexes] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Why: without this, every worktree switch re-fetches every index. The cache
  // is machine-wide, so one attempt per session is enough.
  const attemptedFetch = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setCatalog(await window.api.buildexStore.catalog({ repoPath: repoPath ?? '' }))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  /** Go and get the indexes. Slow and networked, so never on the read path. */
  const refreshIndexes = useCallback(async (): Promise<void> => {
    attemptedFetch.current = true
    setRefreshingIndexes(true)
    try {
      const result = await window.api.buildexStore.refresh({ repoPath: repoPath ?? '' })
      setCatalog(result.catalog)
      // Why: a marketplace that could not be reached is worth saying only when
      // it left us with nothing to show. Otherwise the shelf we already had is
      // the better answer than an error the operator cannot act on.
      setError(
        result.errors.length > 0 && result.catalog.entries.length === 0
          ? result.errors.join('\n')
          : null
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRefreshingIndexes(false)
    }
  }, [repoPath])

  useEffect(() => {
    let cancelled = false
    // Why: switching worktrees mid-fetch must not let a stale catalog land on
    // top of the newer repo's entries.
    void (async () => {
      setLoading(true)
      try {
        const next = await window.api.buildexStore.catalog({ repoPath: repoPath ?? '' })
        if (cancelled) {
          return
        }
        setCatalog(next)
        setError(null)
        // First open on a new machine has no indexes at all; after that this only
        // fires once the cache has aged out.
        if (next.indexStale && !attemptedFetch.current) {
          void refreshIndexes()
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
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
  }, [repoPath, refreshIndexes])

  return { catalog, repoPath, loading, refreshingIndexes, error, refresh, refreshIndexes }
}
