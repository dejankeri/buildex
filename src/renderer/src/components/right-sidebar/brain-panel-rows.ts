import type { BrainDocument, BrainScan } from '../../../../shared/buildex-brain-types'

// Projection from a raw scan to the rows the panel renders: documents grouped
// under their folder, folders in path order, documents by name within a folder.
// Pure so the ordering rules are testable without mounting the panel.

export type BrainRow =
  | { kind: 'folder'; key: string; label: string; documentCount: number }
  | { kind: 'document'; key: string; document: BrainDocument }

export function filterDocuments(documents: BrainDocument[], query: string): BrainDocument[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return documents
  }
  return documents.filter(
    (doc) => doc.name.toLowerCase().includes(needle) || doc.folder.toLowerCase().includes(needle)
  )
}

export function buildBrainRows(documents: BrainDocument[]): BrainRow[] {
  const byFolder = new Map<string, BrainDocument[]>()
  for (const doc of documents) {
    const bucket = byFolder.get(doc.folder) ?? []
    bucket.push(doc)
    byFolder.set(doc.folder, bucket)
  }

  const rows: BrainRow[] = []
  for (const folder of [...byFolder.keys()].sort((a, b) => a.localeCompare(b))) {
    const docs = (byFolder.get(folder) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    rows.push({
      kind: 'folder',
      key: `folder:${folder}`,
      // Why: root-level documents have an empty folder; give them a real label
      // rather than rendering a blank heading.
      label: folder === '' ? 'Root' : folder,
      documentCount: docs.length
    })
    for (const doc of docs) {
      rows.push({ kind: 'document', key: `doc:${doc.id}`, document: doc })
    }
  }
  return rows
}

export type BrainSummary = {
  documentCount: number
  linkCount: number
  changedCount: number
  orphanCount: number
}

export function summarizeScan(scan: BrainScan): BrainSummary {
  return {
    documentCount: scan.documents.length,
    linkCount: scan.totalLinks,
    changedCount: scan.documents.filter((doc) => doc.changed).length,
    orphanCount: scan.orphanIds.length
  }
}
