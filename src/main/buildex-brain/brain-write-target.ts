import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import { BRAIN_SECTIONS } from './brain-scaffold'

// Where a write from the renderer is allowed to land.
//
// The old rule was an allow-list of declared section names. It held the line on
// `../` but could not express a nested folder, so nothing could be created
// inside `clients/acme` — a hole once entities became a shape the brain has.
//
// This is stricter, not looser: containment is checked against the resolved
// path, so no spelling of `..`, no absolute path, and no symlink-free trickery
// lands outside the brain. A declared section is additionally allowed when it
// does not exist yet, because setup only creates the sections the operator
// chose and the empty ones still offer an Add button.

const DECLARED_FOLDERS = new Set(BRAIN_SECTIONS.map((section) => section.folder))

export type BrainWriteTarget = { ok: true; absolutePath: string } | { ok: false; error: string }

/** POSIX-ish folder id from the renderer -> an absolute path inside the brain. */
export function resolveBrainFolder(location: BrainLocation, folder: string): BrainWriteTarget {
  const cleaned = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (cleaned === '') {
    return { ok: true, absolutePath: location.root }
  }

  const root = path.resolve(location.root)
  const absolutePath = path.resolve(root, ...cleaned.split('/'))
  const relative = path.relative(root, absolutePath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: `Outside the brain: ${folder}` }
  }

  if (DECLARED_FOLDERS.has(cleaned)) {
    // A section the operator declined at setup has no directory yet; creating
    // the first document in it is how it comes into being.
    return { ok: true, absolutePath }
  }

  try {
    if (!statSync(absolutePath).isDirectory()) {
      return { ok: false, error: `Not a folder: ${folder}` }
    }
  } catch {
    return { ok: false, error: `No such folder: ${folder}` }
  }
  return { ok: true, absolutePath }
}

/** True when nothing occupies this path yet. */
export function isFree(absolutePath: string): boolean {
  return !existsSync(absolutePath)
}
