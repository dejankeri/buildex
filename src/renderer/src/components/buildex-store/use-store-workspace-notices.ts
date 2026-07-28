import { useEffect, useState } from 'react'

// Two things the Store says about the workspace itself rather than about any one
// plugin, so they load once for the page instead of per card.

export type StoreWorkspaceNotices = {
  /** Null until the gate preset for this repo has been read. */
  gateRuleCount: number | null
  sharedBrain: boolean
}

/** Why: an answer is only about the repo it was asked for — switching workspaces
 *  must read as "not known yet", never as the previous repo's number. */
type AnswerFor<T> = { repoPath: string; value: T }

export function useStoreWorkspaceNotices(repoPath: string | null): StoreWorkspaceNotices {
  const [gate, setGate] = useState<AnswerFor<number> | null>(null)
  const [brain, setBrain] = useState<AnswerFor<boolean> | null>(null)

  // The gate belongs next to the Store: installing a capability and deciding
  // which of its actions wait for a person are the same question asked twice.
  useEffect(() => {
    if (!repoPath) {
      return
    }
    let cancelled = false
    void window.api.buildexGate.sync({ repoPath }).then((result) => {
      if (!cancelled) {
        setGate({ repoPath, value: result.preset.ask.length + result.preset.deny.length })
      }
    })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  // Why: a shared brain carries the company context and credentials an installed
  // app contributes to every repo pointing at it, not just this one — worth
  // saying before the operator meets it somewhere they never installed anything.
  useEffect(() => {
    if (!repoPath) {
      return
    }
    let cancelled = false
    void window.api.buildexBrain.resolve({ repoPath }).then((resolution) => {
      if (!cancelled) {
        setBrain({
          repoPath,
          value: resolution?.status === 'ready' && resolution.location.mode === 'external'
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  return {
    gateRuleCount: gate && gate.repoPath === repoPath ? gate.value : null,
    sharedBrain: brain?.repoPath === repoPath && brain.value
  }
}
