import type { BrainNode } from '../../../../shared/buildex-brain-types'

// Narrowing the brain to what somebody is looking for.
//
// Pure, and separate from the components, because the interesting behaviour is
// what survives a match rather than how it is drawn: a matched entity keeps its
// documents, a matched document keeps only itself, and a section with nothing
// left disappears instead of rendering an empty header.

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle)
}

function filterNode(node: BrainNode, needle: string): BrainNode | null {
  // A node that matches on its own name keeps everything under it — having found
  // "Acme", you want Acme's documents, not the ones that also say "acme".
  const selfMatches =
    matches(node.title, needle) ||
    matches(node.path, needle) ||
    matches(node.main?.summary ?? '', needle)
  if (selfMatches) {
    return node
  }

  const documents = node.documents.filter(
    (document) =>
      // Title as well as name: on screen a document is its heading, and a filter
      // that does not match what is written on the row reads as broken.
      matches(document.title, needle) ||
      matches(document.name, needle) ||
      matches(document.id, needle)
  )
  const attachments = node.attachments.filter((attachment) => matches(attachment.name, needle))
  const children = node.children
    .map((child) => filterNode(child, needle))
    .filter((child): child is BrainNode => child !== null)

  if (documents.length === 0 && attachments.length === 0 && children.length === 0) {
    return null
  }

  return {
    ...node,
    documents,
    attachments,
    children,
    documentCount: documents.length + children.reduce((sum, child) => sum + child.documentCount, 0),
    entityCount:
      (node.kind === 'entity' ? 1 : 0) + children.reduce((sum, child) => sum + child.entityCount, 0)
  }
}

/** The tree narrowed to `query`. An empty query returns the tree untouched. */
export function filterBrainTree(tree: BrainNode[], query: string): BrainNode[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return tree
  }
  return tree
    .map((node) => filterNode(node, needle))
    .filter((node): node is BrainNode => node !== null)
}
