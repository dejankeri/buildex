import path from 'node:path'

// Link extraction for the company brain. Two forms are supported, matching how
// operators actually write in a markdown repo:
//   [[wikilink]]            — resolved by filename, the convention across packs
//   [label](relative.md)    — resolved relative to the containing file
//
// A relative link resolving outside the repo, or onto a file that does not
// exist, is dropped rather than producing a dangling node — a path is a claim
// about the filesystem, and a wrong one is nothing more than a typo.
//
// An unresolved `[[wikilink]]` is the opposite and is collected. A name is not a
// path: writing `[[acme-renewal-terms]]` while writing something else is how an
// operator says the company should know that and does not yet. Dropping those
// threw away the brain's own backlog, one intention at a time.

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g
const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)]+?\.md)\)/g

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/** Strips fenced code blocks so links inside examples do not become edges. */
export function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

export function extractWikilinkNames(text: string): string[] {
  const names = new Set<string>()
  for (const match of stripCodeFences(text).matchAll(WIKILINK_RE)) {
    const raw = match[1]?.trim()
    if (!raw) {
      continue
    }
    // Why: `[[doc|Label]]` and `[[doc#heading]]` both target `doc`.
    const target = raw.split('|')[0]!.split('#')[0]!.trim().replace(/\.md$/i, '')
    if (target) {
      names.add(target)
    }
  }
  return [...names].sort()
}

export function extractRelativeLinkPaths(text: string): string[] {
  const hrefs = new Set<string>()
  for (const match of stripCodeFences(text).matchAll(MARKDOWN_LINK_RE)) {
    const href = match[1]?.trim()
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) {
      continue
    }
    hrefs.add(href.split('#')[0]!)
  }
  return [...hrefs].sort()
}

/**
 * Longest a name gets before it stops reading as a page somebody meant to
 * write. `[[…]]` accepts anything up to the closing bracket, and an accidental
 * sentence inside one used to cost nothing because the name was only ever a
 * lookup key. Now it renders, so it needs a bound.
 */
const WANTED_NAME_LIMIT = 80

export type DocumentLinks = {
  /** Documents this one reaches, by id, sorted. */
  linksTo: string[]
  /** Wikilink names that reach nothing — pages this document wants, sorted. */
  wanted: string[]
}

/**
 * Resolve one document's outbound links to document ids, and collect the names
 * that resolve to nothing. `byName` maps a lowercased filename (no extension)
 * to its id.
 */
export function resolveDocumentLinks(args: {
  text: string
  documentId: string
  knownIds: ReadonlySet<string>
  byName: ReadonlyMap<string, string>
}): DocumentLinks {
  const { text, documentId, knownIds, byName } = args
  const targets = new Set<string>()
  const wanted = new Set<string>()

  for (const name of extractWikilinkNames(text)) {
    const target = byName.get(name.toLowerCase())
    if (!target) {
      if (name.length <= WANTED_NAME_LIMIT) {
        wanted.add(name)
      }
      continue
    }
    if (target !== documentId) {
      targets.add(target)
    }
  }

  const fromDir = path.posix.dirname(documentId)
  for (const href of extractRelativeLinkPaths(text)) {
    const joined = path.posix.normalize(
      path.posix.join(fromDir === '.' ? '' : fromDir, toPosix(href))
    )
    // Why: normalize can climb out of the repo with enough `../` segments.
    if (joined.startsWith('..')) {
      continue
    }
    if (knownIds.has(joined) && joined !== documentId) {
      targets.add(joined)
    }
  }

  return { linksTo: [...targets].sort(), wanted: [...wanted].sort() }
}
