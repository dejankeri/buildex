import path from 'node:path'
import type { BrainDocument, BrainFolder, BrainScan } from '../../shared/buildex-brain-types'
import { listChangedDocumentIds } from './company-brain-changed-docs'
import { resolveDocumentLinks } from './company-brain-links'
import {
  countHeadings,
  countWords,
  listBrainDocumentPaths,
  readDocumentText
} from './company-brain-scan'

// Assembles the company brain: documents, the link graph between them, and
// which are unsaved. Deterministic — every collection is sorted, so re-scanning
// an unchanged repo returns identical data (BuildEx invariant 9: trust surfaces
// are rendered from repo state with zero LLM).

function documentName(id: string): string {
  return path.posix.basename(id).replace(/\.md$/i, '')
}

function documentFolder(id: string): string {
  const dir = path.posix.dirname(id)
  return dir === '.' ? '' : dir
}

export async function scanCompanyBrain(repoPath: string, now: number): Promise<BrainScan> {
  const ids = listBrainDocumentPaths(repoPath)
  const knownIds = new Set(ids)

  // Why: last-write-wins on a duplicate basename would be order-dependent. ids
  // is already sorted, so first-write-wins makes collisions resolve the same
  // way on every scan.
  const byName = new Map<string, string>()
  for (const id of ids) {
    const key = documentName(id).toLowerCase()
    if (!byName.has(key)) {
      byName.set(key, id)
    }
  }

  const texts = new Map<string, string>()
  const linksTo = new Map<string, string[]>()
  for (const id of ids) {
    const text = readDocumentText(repoPath, id)
    texts.set(id, text)
    linksTo.set(id, resolveDocumentLinks({ text, documentId: id, knownIds, byName }))
  }

  const linkedFrom = new Map<string, Set<string>>()
  for (const id of ids) {
    for (const target of linksTo.get(id) ?? []) {
      const set = linkedFrom.get(target) ?? new Set<string>()
      set.add(id)
      linkedFrom.set(target, set)
    }
  }

  const changed = new Set(await listChangedDocumentIds(repoPath))

  const documents: BrainDocument[] = ids.map((id) => {
    const text = texts.get(id) ?? ''
    const outbound = linksTo.get(id) ?? []
    return {
      id,
      name: documentName(id),
      folder: documentFolder(id),
      linksTo: outbound,
      linkedFrom: [...(linkedFrom.get(id) ?? [])].sort(),
      changed: changed.has(id),
      headingCount: countHeadings(text),
      wordCount: countWords(text)
    }
  })

  const folderCounts = new Map<string, number>()
  for (const doc of documents) {
    folderCounts.set(doc.folder, (folderCounts.get(doc.folder) ?? 0) + 1)
  }
  const folders: BrainFolder[] = [...folderCounts.entries()]
    .map(([folderPath, documentCount]) => ({ path: folderPath, documentCount }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const orphanIds = documents
    .filter((doc) => doc.linksTo.length === 0 && doc.linkedFrom.length === 0)
    .map((doc) => doc.id)

  const totalLinks = documents.reduce((sum, doc) => sum + doc.linksTo.length, 0)

  return { repoPath, documents, folders, orphanIds, totalLinks, scannedAt: now }
}
