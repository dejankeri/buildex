import { useCallback, useState } from 'react'
import type { StoreSegment } from '../../../../shared/buildex-store-types'

// Adding and removing the marketplaces a company reads.
//
// Both write a file in the brain, so both end by re-reading the catalog: adding
// caches the index it just fetched, which is what puts the new marketplace's
// apps on the shelf without a second round trip to the network.

export type CompanyMarketplacesState = {
  busy: boolean
  error: string | null
  /** True when it landed. False leaves the form alone so a typo can be corrected. */
  add: (input: { label: string; repo: string; defaultSegment: StoreSegment }) => Promise<boolean>
  remove: (id: string) => Promise<void>
  clearError: () => void
}

export function useCompanyMarketplaces(
  repoPath: string | null,
  refresh: () => Promise<void>
): CompanyMarketplacesState {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = useCallback(
    async (input: {
      label: string
      repo: string
      defaultSegment: StoreSegment
    }): Promise<boolean> => {
      if (!repoPath) {
        return false
      }
      setBusy(true)
      setError(null)
      try {
        const result = await window.api.buildexStore.addMarketplace({ repoPath, ...input })
        if (!result.ok) {
          setError(result.error ?? 'Could not add that marketplace.')
          return false
        }
        await refresh()
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        return false
      } finally {
        setBusy(false)
      }
    },
    [repoPath, refresh]
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!repoPath) {
        return
      }
      setBusy(true)
      setError(null)
      try {
        const result = await window.api.buildexStore.removeMarketplace({ repoPath, id })
        if (!result.ok) {
          setError(result.error ?? 'Could not remove that marketplace.')
          return
        }
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [repoPath, refresh]
  )

  return { busy, error, add, remove, clearError: useCallback(() => setError(null), []) }
}
