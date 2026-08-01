import type { BrainLocation, BrainResolution } from '../../shared/buildex-brain-types'
import {
  requireBrainLocation as requireLocation,
  resolveBrainLocation as resolveLocation
} from '../buildex-brain/brain-location'
import { authorizeExternalPath } from './filesystem-auth'

// An external brain is its own repo, outside every root the filesystem
// allow-list knows, so `fs:readFile` denies the documents a scan just handed the
// renderer. Resolving is when the main process knows the root is legitimate — it
// came from a tracked pointer or a local binding — so it is when to authorize.
//
// The IPC layer takes its resolvers from here rather than from brain-location,
// so a handler added later cannot forget to.

type BrainResolveOptions = { bindingsFile?: string }

export function authorizeBrainLocation<T extends BrainLocation | null>(
  location: T,
  repoPath?: string
): T {
  if (!location) {
    return location
  }
  // An embedded brain resolved from a worktree lives in the primary checkout, so
  // the repo root that allows it there does not allow it from here. Only the
  // converged case: an embedded brain in the very path asked about still needs
  // nothing, and widening it would hand out access it never needed.
  const converged =
    location.mode === 'embedded' && repoPath !== undefined && location.gitRoot !== repoPath
  if (location.mode === 'external' || converged) {
    // Every document, skill and pack file is under the root, and the allow-list
    // matches descendants. Authorizing on each resolve rather than once at
    // setup: the set is in-memory and LRU-evicted, so it does not survive.
    authorizeExternalPath(location.root)
  }
  return location
}

export function requireBrainLocation(
  repoPath: string,
  options: BrainResolveOptions = {}
): BrainLocation | null {
  return authorizeBrainLocation(requireLocation(repoPath, options), repoPath)
}

export function resolveBrainLocation(
  repoPath: string,
  options: BrainResolveOptions = {}
): BrainResolution {
  const resolution = resolveLocation(repoPath, options)
  if (resolution.status === 'ready') {
    authorizeBrainLocation(resolution.location, repoPath)
  }
  return resolution
}
