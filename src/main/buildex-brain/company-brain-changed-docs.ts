import type { BrainLocation } from '../../shared/buildex-brain-types'
import { readChangedBrainPaths } from './brain-git-paths'

// Which brain documents differ from the committed tree. Git is the company's
// record, so "changed" means "not yet saved into the company's history".

/** Brain-relative POSIX ids of markdown files with uncommitted changes. */
export async function listChangedDocumentIds(location: BrainLocation): Promise<string[]> {
  const changed = await readChangedBrainPaths(location)
  return changed.filter((id) => id.toLowerCase().endsWith('.md'))
}
