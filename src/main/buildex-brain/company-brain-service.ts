import { existsSync } from 'node:fs'
import path from 'node:path'
import type {
  BrainDocument,
  BrainFolder,
  BrainLocation,
  BrainResolution,
  BrainScan,
  BrainWantedPage
} from '../../shared/buildex-brain-types'
import { listChangedDocumentIds } from './company-brain-changed-docs'
import { embeddedLocation } from './brain-location'
import { readDocumentFrontmatter } from './brain-document-frontmatter'
import { listRecentlyChangedDocuments } from './brain-recent-documents'
import { resolveDocumentLinks } from './company-brain-links'
import {
  countHeadings,
  countWords,
  isBrainInitialized,
  listBrainAttachments,
  listBrainDocumentPaths,
  readDocumentText
} from './company-brain-scan'
import { buildBrainTree, firstHeading } from './brain-tree'
import { BRAIN_SECTIONS } from './brain-scaffold'

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

/** A cue to open something, not an index — an index would grow with the brain. */
const RECENT_DOCUMENT_LIMIT = 10

export async function scanCompanyBrain(
  repoPath: string,
  location: BrainLocation,
  resolution: BrainResolution,
  now: number
): Promise<BrainScan> {
  const ids = listBrainDocumentPaths(location)
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
  const descriptions = new Map<string, string>()
  const linksTo = new Map<string, string[]>()
  // Insertion order follows `ids`, which is sorted — so every wanted page's
  // requesters come out in the same order on every scan.
  const wantedBy = new Map<string, string[]>()
  for (const id of ids) {
    const text = readDocumentText(location, id)
    texts.set(id, text)
    // Parsed from text already in hand for the link graph: no extra file read,
    // and nothing about how the walk orders itself changes.
    const { description } = readDocumentFrontmatter(text)
    if (description) {
      descriptions.set(id, description)
    }
    const links = resolveDocumentLinks({ text, documentId: id, knownIds, byName })
    linksTo.set(id, links.linksTo)
    for (const name of links.wanted) {
      const asking = wantedBy.get(name)
      if (asking) {
        asking.push(id)
      } else {
        wantedBy.set(name, [id])
      }
    }
  }

  const linkedFrom = new Map<string, Set<string>>()
  for (const id of ids) {
    for (const target of linksTo.get(id) ?? []) {
      const set = linkedFrom.get(target) ?? new Set<string>()
      set.add(id)
      linkedFrom.set(target, set)
    }
  }

  // Together: both read git, neither needs the other, and this one call sits on
  // the critical path of creating a worktree.
  const [changedIds, recentDocumentIds] = await Promise.all([
    listChangedDocumentIds(location),
    listRecentlyChangedDocuments(location, knownIds, RECENT_DOCUMENT_LIMIT)
  ])
  const changed = new Set(changedIds)

  const documents: BrainDocument[] = ids.map((id) => {
    const text = texts.get(id) ?? ''
    const outbound = linksTo.get(id) ?? []
    const description = descriptions.get(id)
    return {
      id,
      name: documentName(id),
      // Why: the heading is what somebody wrote; the name is what the filesystem
      // allows. They differ most where it matters — a dated decision slug.
      title: firstHeading(text) ?? documentName(id),
      folder: documentFolder(id),
      // Omitted rather than empty: a brain that never wrote one must serialise
      // exactly as it did before descriptions existed.
      ...(description ? { description } : {}),
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

  // Why: `texts` is already read for the link graph, so the tree costs no extra
  // file reads — it only needs the main file of each entity, which is in there.
  const tree = buildBrainTree({
    documents,
    attachments: listBrainAttachments(location),
    sections: BRAIN_SECTIONS.map(({ folder, title, purpose }) => ({ folder, title, purpose })),
    readText: (id) => texts.get(id) ?? ''
  })

  const orphanIds = documents
    .filter((doc) => doc.linksTo.length === 0 && doc.linkedFrom.length === 0)
    .map((doc) => doc.id)

  const totalLinks = documents.reduce((sum, doc) => sum + doc.linksTo.length, 0)

  // Most-asked-for first: a name three documents reached for is a bigger hole in
  // the brain than one a single note mentioned once.
  const wantedPages: BrainWantedPage[] = [...wantedBy.entries()]
    .map(([name, requestedBy]) => ({ name, requestedBy }))
    .sort((a, b) => b.requestedBy.length - a.requestedBy.length || a.name.localeCompare(b.name))

  return {
    repoPath,
    initialized: isBrainInitialized(location),
    resolution,
    // Why: independent of which location this resolved to — the renderer
    // cannot stat the filesystem itself, and needs this to choose migrate
    // (something embedded to move) over bind (nothing to move) at setup time.
    embeddedBrainPresent: existsSync(embeddedLocation(repoPath).root),
    documents,
    folders,
    tree,
    orphanIds,
    wantedPages,
    recentDocumentIds,
    totalLinks,
    scannedAt: now
  }
}
