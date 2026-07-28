import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { BrainCloneResult } from '../../shared/buildex-brain-types'
import { gitExecFileAsync } from '../git/runner'
import { relinkBrainSkills } from './skill-link'
import { rememberClone } from './brain-bindings'
import { externalLocation } from './brain-location'

// Getting a brain onto this machine, for the operator who cloned the code repo
// and found a pointer to a brain they do not have yet.

/** The clone landed: give the repo that asked for it the brain's skills. */
function linkInto(repoPath: string | undefined, remote: string, targetPath: string): void {
  if (repoPath) {
    relinkBrainSkills(repoPath, externalLocation(targetPath, remote))
  }
}

export async function cloneBrain(
  remote: string,
  targetPath: string,
  options: { bindingsFile?: string; repoPath?: string } = {}
): Promise<BrainCloneResult> {
  // A leading dash makes git read the value as an option; the remote comes from a tracked file we did not write.
  if (remote.startsWith('-') || targetPath.startsWith('-')) {
    return { ok: false, error: `Refusing a brain remote or target path that starts with "-"` }
  }

  if (existsSync(targetPath)) {
    // Somebody cloned it by hand, which is a perfectly good way to have a brain.
    if (existsSync(path.join(targetPath, '.git'))) {
      rememberClone(remote, targetPath, options.bindingsFile)
      linkInto(options.repoPath, remote, targetPath)
      return { ok: true, path: targetPath }
    }
    return { ok: false, error: `${targetPath} already exists and is not a git repo` }
  }

  try {
    mkdirSync(path.dirname(targetPath), { recursive: true })
    await gitExecFileAsync(['clone', '--quiet', '--', remote, targetPath], {
      cwd: path.dirname(targetPath),
      useConfiguredSshCommandForNetwork: true
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  rememberClone(remote, targetPath, options.bindingsFile)
  linkInto(options.repoPath, remote, targetPath)
  return { ok: true, path: targetPath }
}
