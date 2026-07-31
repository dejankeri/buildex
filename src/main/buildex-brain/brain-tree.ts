import type {
  BrainAttachment,
  BrainDocument,
  BrainNode,
  BrainNodeKind,
  BrainSectionInfo
} from '../../shared/buildex-brain-types'
import { readDocumentFrontmatter } from './brain-document-frontmatter'

// The brain as the company arranged it, rather than as a flat list of paths.
//
// Two things the flat list cannot express. Nesting: `clients/acme` is inside
// Clients, not beside it. And entities: a folder that IS one thing — a client, a
// person — with a main file that stands for it and material kept alongside.
//
// Pure. Takes the scan's lists and a way to read a document's text, returns the
// tree. No filesystem, no git, no Electron — which is what makes the rules below
// testable against a fixture instead of a real repo.
//
// An entity's line is the unit the whole design is bounded by: a hundred clients
// must cost a hundred lines, not four hundred. So a `description:` replaces the
// summary on that line rather than joining it.

/** Longest a summary gets before it is cut at a word boundary. */
const SUMMARY_LIMIT = 140

/**
 * Ordered: `index.md` wins over `README.md` wins over `<foldername>.md`.
 *
 * Ordered rather than first-found because a folder may hold more than one, and a
 * choice that depends on directory order is a choice that changes between scans.
 */
function mainDocumentId(folderPath: string, documents: BrainDocument[]): string | null {
  const folderName = folderPath.split('/').at(-1)?.toLowerCase() ?? ''
  const candidates = ['index.md', 'readme.md', `${folderName}.md`]
  for (const candidate of candidates) {
    const found = documents.find(
      (document) => document.name.toLowerCase() === candidate.slice(0, -3)
    )
    if (found) {
      return found.id
    }
  }
  return null
}

/** `acme-corp` -> `Acme Corp`. What to call a folder nobody titled. */
export function humanizeFolderName(folderPath: string): string {
  const name = folderPath.split('/').at(-1) ?? folderPath
  return name
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function firstHeading(text: string): string | null {
  for (const line of text.split('\n')) {
    const match = /^#\s+(\S.*?)\s*$/.exec(line)
    if (match) {
      return match[1] ?? null
    }
  }
  return null
}

/**
 * The line that stands for a document.
 *
 * Headings are skipped because the H1 is already the title. HTML comments are
 * skipped because every scaffold seed opens with one — `<!-- One paragraph a
 * stranger would understand. -->` — and without this every freshly seeded entity
 * would summarise itself as the instruction written for whoever fills it in.
 */
export function summarize(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('<!--')) {
      continue
    }
    if (line.length <= SUMMARY_LIMIT) {
      return line
    }
    const cut = line.slice(0, SUMMARY_LIMIT)
    const lastSpace = cut.lastIndexOf(' ')
    return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`
  }
  return ''
}

function parentPath(childPath: string): string {
  const index = childPath.lastIndexOf('/')
  return index < 0 ? '' : childPath.slice(0, index)
}

type Draft = {
  path: string
  documents: BrainDocument[]
  attachments: BrainAttachment[]
  childPaths: Set<string>
}

/** Every folder that holds something, plus every folder on the way to one. */
function collectFolders(
  documents: BrainDocument[],
  attachments: BrainAttachment[]
): Map<string, Draft> {
  const drafts = new Map<string, Draft>()

  const ensure = (folderPath: string): Draft => {
    const existing = drafts.get(folderPath)
    if (existing) {
      return existing
    }
    const draft: Draft = { path: folderPath, documents: [], attachments: [], childPaths: new Set() }
    drafts.set(folderPath, draft)
    if (folderPath !== '') {
      // Why: a folder holding nothing but a nested one still has to exist, or the
      // chain from a section down to `clients/enterprise/acme` breaks in the middle.
      ensure(parentPath(folderPath)).childPaths.add(folderPath)
    }
    return draft
  }

  ensure('')
  for (const document of documents) {
    ensure(document.folder).documents.push(document)
  }
  for (const attachment of attachments) {
    ensure(parentPath(attachment.id)).attachments.push(attachment)
  }
  return drafts
}

type BuildInput = {
  documents: BrainDocument[]
  attachments: BrainAttachment[]
  sections: BrainSectionInfo[]
  readText: (documentId: string) => string
}

export function buildBrainTree(input: BuildInput): BrainNode[] {
  const drafts = collectFolders(input.documents, input.attachments)
  const declaredTitles = new Map(input.sections.map((section) => [section.folder, section.title]))

  const build = (folderPath: string, depth: number): BrainNode => {
    const draft = drafts.get(folderPath)
    const documents = [...(draft?.documents ?? [])].sort((a, b) => a.id.localeCompare(b.id))
    const attachments = [...(draft?.attachments ?? [])].sort((a, b) => a.id.localeCompare(b.id))
    const children = [...(draft?.childPaths ?? [])]
      .sort((a, b) => a.localeCompare(b))
      .map((childPath) => build(childPath, depth + 1))

    // Depth 0 is a company area, never one thing: a `clients/index.md` overview
    // must not turn Clients itself into a client.
    const mainId = depth === 0 ? null : mainDocumentId(folderPath, documents)
    const kind: BrainNodeKind = depth === 0 ? 'section' : mainId ? 'entity' : 'subsection'

    const mainText = mainId ? input.readText(mainId) : ''
    // Why `body`: without stripping the block, the first line a summary finds in
    // a document with front matter is the opening `---`.
    const { description, body } = readDocumentFrontmatter(mainText)
    const title =
      declaredTitles.get(folderPath) ??
      (mainId
        ? (firstHeading(mainText) ?? humanizeFolderName(folderPath))
        : humanizeFolderName(folderPath))

    const ownDocuments = mainId ? documents.filter((document) => document.id !== mainId) : documents

    return {
      path: folderPath,
      title,
      kind,
      ...(mainId ? { main: { documentId: mainId, summary: description || summarize(body) } } : {}),
      documents: ownDocuments,
      attachments,
      children,
      documentCount:
        documents.length + children.reduce((sum, child) => sum + child.documentCount, 0),
      entityCount:
        (kind === 'entity' ? 1 : 0) + children.reduce((sum, child) => sum + child.entityCount, 0),
      changed:
        documents.some((document) => document.changed) || children.some((child) => child.changed)
    }
  }

  const root = drafts.get('')
  const topLevel = [...(root?.childPaths ?? [])]
  const declaredOrder = input.sections.map((section) => section.folder)
  const declared = declaredOrder.filter((folder) => folder !== '')
  const undeclared = topLevel
    .filter((folder) => !declaredOrder.includes(folder))
    .sort((a, b) => a.localeCompare(b))

  const nodes = [...declared, ...undeclared].map((folder) => build(folder, 0))

  // Why: root-level documents are real and must not vanish, but a company that
  // keeps none should not be shown an empty section for the concept. Last,
  // because the root is a leftover rather than an area anyone chose.
  const rootNode = build('', 0)
  if (rootNode.documents.length > 0 || rootNode.attachments.length > 0) {
    nodes.push({
      ...rootNode,
      children: [],
      title: 'Root',
      documentCount: rootNode.documents.length
    })
  }
  return nodes
}
