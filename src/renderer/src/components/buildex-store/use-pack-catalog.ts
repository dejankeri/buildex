import { useCallback, useEffect, useState } from 'react'
import { useActiveWorktree } from '@/store/selectors'
import type { PackCatalog } from '../../../../shared/buildex-packs-types'
import { EMPTY_PACK_CATALOG } from '../../../../shared/buildex-packs-types'

// Shared catalog loader for the Store and Apps surfaces. Both read the same
// packs from the active company repo, so the fetch/refresh logic lives once.

export type PackCatalogState = {
  catalog: PackCatalog
  repoPath: string | null
  loading: boolean
  refresh: () => Promise<void>
}

export function usePackCatalog(): PackCatalogState {
  const activeWorktree = useActiveWorktree()
  const repoPath = activeWorktree?.path ?? null
  const [catalog, setCatalog] = useState<PackCatalog>(EMPTY_PACK_CATALOG)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!repoPath) {
      setCatalog(EMPTY_PACK_CATALOG)
      return
    }
    setLoading(true)
    try {
      setCatalog(await window.api.buildexPacks.catalog({ repoPath }))
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    let cancelled = false
    // Why: switching worktrees mid-fetch must not let a stale catalog land on
    // top of the newer repo's packs.
    void (async () => {
      if (!repoPath) {
        setCatalog(EMPTY_PACK_CATALOG)
        return
      }
      setLoading(true)
      try {
        const next = await window.api.buildexPacks.catalog({ repoPath })
        if (!cancelled) {
          setCatalog(next)
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

  return { catalog, repoPath, loading, refresh }
}
