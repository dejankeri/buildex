import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrainCreateDocumentResult, BrainLocation } from '../../shared/buildex-brain-types'
import { BRAIN_SECTIONS } from './brain-scaffold'

// Creating a brain document from the panel.
//
// The operator types a title, not a filename — "Q3 pricing", not
// "q3-pricing.md". Turning one into the other is our job, and it has to be a job
// that cannot write outside the brain however the title is spelled.

const KNOWN_FOLDERS = new Set(BRAIN_SECTIONS.map((section) => section.folder))

/** A title as a filename: lowercase, hyphenated, ASCII-safe, never empty. */
export function toDocumentFileName(title: string): string | null {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug ? `${slug}.md` : null
}

export function createBrainDocument(
  location: BrainLocation,
  folder: string,
  title: string
): BrainCreateDocumentResult {
  // Why: the folder comes from the renderer. Accepting only sections we declared
  // means no crafted value can walk out of the brain with `../`.
  if (folder !== '' && !KNOWN_FOLDERS.has(folder)) {
    return { ok: false, error: `Unknown section: ${folder}` }
  }
  const fileName = toDocumentFileName(title)
  if (!fileName) {
    return { ok: false, error: 'Give the document a name' }
  }

  const directory = folder ? path.join(location.root, folder) : location.root
  const absolutePath = path.join(directory, fileName)
  if (existsSync(absolutePath)) {
    return { ok: false, error: `Already exists: ${fileName}` }
  }

  try {
    mkdirSync(directory, { recursive: true })
    // A heading, and nothing else — the operator's first keystroke should be
    // their own words, not deleting boilerplate.
    writeFileSync(absolutePath, `# ${title.trim()}\n\n`, 'utf8')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  return {
    ok: true,
    documentId: folder ? `${folder}/${fileName}` : fileName,
    absolutePath
  }
}
