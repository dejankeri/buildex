import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrainCreateEntityResult, BrainLocation } from '../../shared/buildex-brain-types'
import { toDocumentFileName } from './brain-document-create'
import { isFree, resolveBrainFolder } from './brain-write-target'

// Creating an entity — a client, a person — from the panel.
//
// An entity is a folder plus the main file that stands for it, which is the one
// convention the Brain reads to tell "this is one thing" from "this is a pile of
// documents". Making one by hand means knowing that convention; this is the
// affordance that means nobody has to.

/** The main file every entity is recognised by. */
export const ENTITY_MAIN_FILE = 'index.md'

export function createBrainEntity(
  location: BrainLocation,
  parentFolder: string,
  title: string
): BrainCreateEntityResult {
  const parent = resolveBrainFolder(location, parentFolder)
  if (!parent.ok) {
    return { ok: false, error: parent.error }
  }

  // The folder is named the way a document would be — same slug rules, so an
  // entity and a document made from the same title never disagree on spelling.
  const slug = toDocumentFileName(title)?.replace(/\.md$/, '')
  if (!slug) {
    return { ok: false, error: 'Give it a name' }
  }

  const directory = path.join(parent.absolutePath, slug)
  if (!isFree(directory)) {
    return { ok: false, error: `Already exists: ${slug}` }
  }

  const absolutePath = path.join(directory, ENTITY_MAIN_FILE)
  try {
    mkdirSync(directory, { recursive: true })
    // A heading and nothing else, matching document creation: the first thing
    // typed should be the company's own words.
    writeFileSync(absolutePath, `# ${title.trim()}\n\n`, 'utf8')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const toId = (value: string): string =>
    path.relative(location.root, value).split(path.sep).join('/')
  return { ok: true, entityPath: toId(directory), documentId: toId(absolutePath), absolutePath }
}
