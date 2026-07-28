import type {
  BrainLocation,
  BrainPullResult,
  BrainPushResult as BrainPushReport
} from '../../shared/buildex-brain-types'
import { gitExecFileAsync } from '../git/runner'

// Sharing a brain that lives in its own repo.
//
// Only ever in external mode. In embedded mode the brain's git root IS the
// company's code repo, and a Save button that pushes somebody's code is not a
// thing we ship — so both functions return early on `mode === 'embedded'`
// before any git runs.
//
// A pull that cannot fast-forward is reported, never merged. Auto-merging a
// company's decisions is a worse failure than asking someone to look.

export type BrainPushResult = {
  pushed: boolean
  reason?: 'embedded' | 'no-upstream' | 'failed'
  error?: string
}

async function hasUpstream(location: BrainLocation): Promise<boolean> {
  try {
    await gitExecFileAsync(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: location.gitRoot
    })
    return true
  } catch {
    return false
  }
}

export async function pushBrain(location: BrainLocation): Promise<BrainPushResult> {
  if (location.mode === 'embedded') {
    return { pushed: false, reason: 'embedded' }
  }
  if (!(await hasUpstream(location))) {
    return { pushed: false, reason: 'no-upstream' }
  }
  try {
    await gitExecFileAsync(['push'], {
      cwd: location.gitRoot,
      useConfiguredSshCommandForNetwork: true
    })
    return { pushed: true }
  } catch (error) {
    return {
      pushed: false,
      reason: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * What a push that did not happen should read as.
 *
 * A brain repo with no remote is a supported setup — `bindExistingBrain` asks
 * only for a `.git` — so "there is nowhere to push" is a state, not a failure,
 * and no retry can change it. Decided here rather than at each caller, so
 * nobody downstream has to match on a reason string.
 */
export function reportPush(push: BrainPushResult): BrainPushReport {
  if (push.pushed) {
    return { pushed: true }
  }
  if (push.reason === 'no-upstream' || push.reason === 'embedded') {
    return { pushed: false, localOnly: true }
  }
  return { pushed: false, error: push.error ?? 'not shared' }
}

export async function pullBrain(location: BrainLocation): Promise<BrainPullResult> {
  if (location.mode === 'embedded' || !(await hasUpstream(location))) {
    return { pulled: false, diverged: false }
  }
  try {
    await gitExecFileAsync(['fetch', '--quiet'], {
      cwd: location.gitRoot,
      useConfiguredSshCommandForNetwork: true
    })
  } catch (error) {
    return {
      pulled: false,
      diverged: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  try {
    await gitExecFileAsync(['merge', '--ff-only', '--quiet', '@{u}'], { cwd: location.gitRoot })
    return { pulled: true, diverged: false }
  } catch {
    // Not an error to report as a failure: the brain here and the brain there
    // have both moved, and only a person can say what the company decided.
    return { pulled: false, diverged: true }
  }
}
