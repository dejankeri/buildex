import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  BrainLocation,
  BrainNode,
  BrainScan,
  BrainWantedPage
} from '../../shared/buildex-brain-types'
import { truncateAtWord } from './brain-text-budget'

// Auto-feeds the company brain to the coding agent.
//
// Why this mechanism: Claude Code already reads CLAUDE.md at session start and
// follows `@path` imports. Writing a generated context file and importing it
// means the agent picks up company context with no new runtime, no injection
// hook, and no per-agent integration.
//
// Both outputs live in `.claude/`, which BuildEx excludes from the operator's
// git. This is machine state, not company knowledge: it is derived from
// `.buildex/` and can be regenerated from any commit, so committing it would put
// churn in the company's history for nothing (invariant 3 — rendered views are
// derived on demand, never committed). An earlier version wrote it into
// `.buildex/`, where every edit to any document produced a diff.

export const CONTEXT_RELATIVE_PATH = '.claude/company-context.md'
/** Where it used to live, back when it was tracked. Removed on sight. */
const LEGACY_CONTEXT_RELATIVE_PATH = '.buildex/company-context.md'
/**
 * Where the import lives. `.claude/CLAUDE.md` is a documented project-instructions
 * location, loaded exactly like a root CLAUDE.md — and it sits inside `.claude/`,
 * which BuildEx excludes from the operator's git. Writing to the root CLAUDE.md
 * instead would edit a file the project tracks and commits, putting BuildEx's
 * machine state into the company's history and every teammate's diff.
 */
export const AGENT_MEMORY_RELATIVE_PATH = '.claude/CLAUDE.md'

// Relative to the file holding it, per the @-import rules — and still inside the
// working directory, so it is not treated as an external import.
const IMPORT_LINE = '@./company-context.md'
const BEGIN_MARKER = '<!-- buildex:company-context:begin -->'
const END_MARKER = '<!-- buildex:company-context:end -->'

/** One installed app, as the agent needs to understand it. */
export type InstalledAppSummary = {
  id: string
  name: string
  summary: string
  skills: string[]
  /** True when this repo has an MCP server configured for the app. */
  hasMcp: boolean
  /** The environment variable carrying its key, when it needs one. */
  envKey?: string
  /** True when a key is present on this machine. */
  connected?: boolean
}

/**
 * The apps section: what this company has connected, and where the agent should
 * look for the detail. Deliberately short — the skills carry the instructions,
 * so this only has to make the agent aware they exist and reach for them.
 */
function renderApps(apps: InstalledAppSummary[], location: BrainLocation): string[] {
  if (apps.length === 0) {
    return []
  }
  // In external mode the brain isn't `.buildex/` in this repo, so the skills
  // path has to be the real one or the agent goes looking in the wrong place.
  const skillsPath =
    location.mode === 'embedded' ? '.buildex/skills/' : `${path.join(location.root, 'skills')}/`
  const lines = [
    `## Apps (${apps.length})`,
    '',
    'Installed capability packs. Each one ships skills that tell you how to use it',
    `well — read the skill before improvising. Skills live in \`${skillsPath}\``,
    'and are linked into `.claude/skills/`, so they load like any other skill.',
    ''
  ]
  for (const app of apps) {
    lines.push(`### ${app.name}`, '')
    if (app.summary) {
      lines.push(app.summary, '')
    }
    lines.push(`- Skills: ${app.skills.map((skill) => `\`${skill}\``).join(', ')}`)
    if (app.hasMcp) {
      lines.push(
        app.connected === false
          ? `- MCP: configured in \`.claude/mcp.json\`, but no key is stored on this machine yet — its tools will not connect until one is added from the Store.`
          : '- MCP: configured in `.mcp.json`; prefer its tools over shell or HTTP calls.'
      )
    }
    if (app.envKey) {
      lines.push(
        `- API key: read from the \`${app.envKey}\` environment variable. Never ask the operator to paste it into a file, and never write it into the repo.`
      )
    }
    lines.push('')
  }
  return lines
}

/**
 * What this file is allowed to spend, enforced here rather than trusted to the
 * data. `DESCRIPTION_LIMIT` is 160 because that is what a Brain tree row and an
 * entity card can afford; this file is read *in full* at the start of every
 * agent session, so it takes half. A brain of two hundred entities is the
 * difference between 25 kB of prompt and 12 kB.
 *
 * The per-folder slice is the other half of the same guard. A line is not
 * bounded just because it is one line: a flat `decisions/` of five hundred
 * described documents rendered as a single line of ~87 kB, which passed a line
 * ceiling and blew a character one fourfold.
 */
const MAP_DESCRIPTION_BUDGET = 80
const MAP_DOCUMENTS_PER_FOLDER = 12

/**
 * A folder named `archive`, and everything below it.
 *
 * Case-insensitive on purpose. `Archive/` and `archive/` are the *same
 * directory* on macOS and Windows, so a case-sensitive match would render one
 * commit two ways depending on which machine scanned it — and the machine that
 * enumerated the folder is the one that blew the budget this exists to hold.
 * The lowercase spelling is what the scaffold seeds and what the guidance says;
 * this only refuses to be surprised by the other one.
 */
const ARCHIVE_SEGMENT_RE = /(^|\/)archive(\/|$)/i

/** True for `clients/archive` and `clients/archive/acme.md`, false for `notes/archive.md`. */
function isArchivedBrainPath(pathOrId: string): boolean {
  return ARCHIVE_SEGMENT_RE.test(pathOrId)
}

/**
 * The brain's shape, as lines the agent can act on.
 *
 * An entity is named and summarised; the documents inside it are not listed.
 * That is what keeps this bounded as a company grows — a hundred clients is a
 * hundred lines the agent can read, rather than four hundred filenames it
 * cannot. An agent that needs what is inside one opens the folder.
 *
 * A document's `description:` rides the line its name was already on, in
 * parentheses. It has to: the growth law here is one line per entity and one per
 * folder, and a description that claimed a line of its own would rewrite that
 * law into one line per file — the exact shape this render replaced.
 *
 * What is *not* cut: names and paths. A truncated title still opens, because the
 * path beside it is the real identifier — but a truncated path or filename names
 * something the agent cannot open, which is worse than a long line. Those are
 * the map's remaining unbounded terms, and the filesystem is what bounds them.
 */
function renderTree(nodes: BrainNode[], depth = 0): string[] {
  const lines: string[] = []
  const indent = '  '.repeat(depth)
  for (const node of nodes) {
    if (isArchivedBrainPath(node.path)) {
      // De-emphasis, exactly: an archive costs one line carrying its path and
      // how much is in it, and never a name, a description or a nested folder.
      // Both halves are load-bearing. Dropping it entirely would be cheaper and
      // wrong — an agent that cannot see history exists re-derives what a dead
      // client already taught the business — but a folder of superseded work
      // must not be enumerated the way live work is, because it only grows.
      const count = node.documentCount
      lines.push(
        `${indent}- **${node.path}** — ${count} superseded ${
          count === 1 ? 'document' : 'documents'
        }, kept for history and not listed here.`
      )
      continue
    }
    if (node.kind === 'entity') {
      const summary = truncateAtWord(node.main?.summary ?? '', MAP_DESCRIPTION_BUDGET)
      lines.push(`${indent}- **${node.title}** \`${node.path}/\`${summary ? ` — ${summary}` : ''}`)
      continue
    }
    const shown = node.documents.slice(0, MAP_DOCUMENTS_PER_FOLDER)
    const names = shown.map((document) =>
      document.description
        ? `${document.name} (${truncateAtWord(document.description, MAP_DESCRIPTION_BUDGET)})`
        : document.name
    )
    const hidden = node.documents.length - shown.length
    if (hidden > 0) {
      // Said out loud: an agent that knows there are more will open the folder,
      // where a silently cut list would have it believe it had seen everything.
      names.push(`+${hidden} more`)
    }
    lines.push(
      `${indent}- **${node.path === '' ? 'root' : node.path}**${
        names.length > 0 ? ` — ${names.join(', ')}` : ''
      }`
    )
    lines.push(...renderTree(node.children, depth + 1))
  }
  return lines
}

/**
 * Caps on the three trailing lists, and the whole reason they are lists rather
 * than sections: this file is read in full at the start of every agent session,
 * so anything here that grew with the brain would spend the operator's context
 * window on a table of contents.
 */
const RECENT_LIMIT = 10
const WANTED_LIMIT = 10
const REQUESTERS_PER_WANTED_PAGE = 3

function renderRequesters(page: BrainWantedPage): string {
  const shown = page.requestedBy.slice(0, REQUESTERS_PER_WANTED_PAGE)
  // Against the true count, not the length of the list that arrived: the scan
  // already capped `requestedBy`, so subtracting from it would under-report by
  // exactly as much as that cap dropped.
  const rest = page.requestedByCount - shown.length
  return `${shown.map((id) => `\`${id}\``).join(', ')}${rest > 0 ? `, +${rest} more` : ''}`
}

/**
 * Render the agent-facing context. Deterministic: identical scan in, identical
 * bytes out, so re-syncing an unchanged brain produces no diff.
 */
export function renderCompanyContext(
  scan: BrainScan,
  apps: InstalledAppSummary[] = [],
  location: BrainLocation
): string {
  // Document ids below stay brain-relative in both modes. Embedded, the agent's
  // cwd already resolves them. External, they resolve to nothing unless it also
  // knows the folder to join them onto — so only that case names it.
  const lines: string[] =
    location.mode === 'external'
      ? [
          '# Company context',
          '',
          `Generated by BuildEx from the company brain at \`${location.root}\`, and rewritten`,
          'whenever it changes. Do not edit — edits are overwritten. Document paths below are',
          'relative to that folder, which is outside this repo: join them onto it to open one.',
          ''
        ]
      : [
          '# Company context',
          '',
          'Generated by BuildEx from `.buildex/` in this repo, and rewritten whenever it',
          'changes. Do not edit — edits are overwritten. Every entry below is a real file',
          'here; open it when you need what is in it.',
          ''
        ]

  lines.push(...renderApps(apps, location))

  lines.push(`## Documents (${scan.documents.length})`, '')
  lines.push(...renderTree(scan.tree))
  lines.push('')

  // Why: the most-linked documents are the ones the company actually organises
  // around. Surfacing them tells the agent where to look first — which is why
  // an archived document may not hold one of the ten slots: a superseded
  // document keeps every backlink it ever earned, so the most-connected list is
  // exactly where a dead engagement would outrank the live one that replaced it.
  const hubs = scan.documents
    .map((doc) => ({
      name: doc.name,
      id: doc.id,
      degree: doc.linksTo.length + doc.linkedFrom.length
    }))
    .filter((entry) => entry.degree > 0 && !isArchivedBrainPath(entry.id))
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, 10)

  if (hubs.length > 0) {
    lines.push('## Most connected', '')
    for (const hub of hubs) {
      lines.push(`- \`${hub.id}\` (${hub.degree} ${hub.degree === 1 ? 'link' : 'links'})`)
    }
    lines.push('')
  }

  // Why: link degree says what the company organises around; this says what it
  // has been doing. Coming back to a business after three weeks, the second
  // question is the better one — and it is a cue to open something, so it is
  // capped rather than allowed to become a second index of the brain.
  //
  // Archived ids are dropped *before* the cap, not after. Archiving is a git
  // change, so the week the operator retires a dead client is the week this
  // list would be nothing but the ten documents they just declared finished —
  // the loudest possible answer to "what is this business doing", pointing at
  // the one place the answer is not.
  const recent = scan.recentDocumentIds
    .filter((id) => !isArchivedBrainPath(id))
    .slice(0, RECENT_LIMIT)
  if (recent.length > 0) {
    lines.push('## Recently changed', '')
    for (const id of recent) {
      lines.push(`- \`${id}\``)
    }
    lines.push('')
  }

  // Why: a `[[link]]` pointing at nothing is not a broken link, it is the
  // company saying it should know something and does not. Capped for the same
  // reason as the list above, and each entry names at most three askers so one
  // popular gap cannot take ten lines.
  const wanted = scan.wantedPages.slice(0, WANTED_LIMIT)
  if (wanted.length > 0) {
    lines.push(
      '## Wanted pages',
      '',
      'Named by a `[[link]]` in the brain and not written yet. If work turns up what',
      'one of these should say, write it — that is what the link was for.',
      ''
    )
    for (const page of wanted) {
      lines.push(`- \`${page.name}\` — wanted by ${renderRequesters(page)}`)
    }
    lines.push('')
  }

  // Why: no "uncommitted right now" list. It was stale the moment it was written,
  // it changed on every keystroke-turned-save, and git already knows.
  return lines.join('\n')
}

function withImportBlock(existing: string): string {
  const block = `${BEGIN_MARKER}\n${IMPORT_LINE}\n${END_MARKER}`
  const beginIndex = existing.indexOf(BEGIN_MARKER)
  const endIndex = existing.indexOf(END_MARKER)
  if (beginIndex !== -1 && endIndex > beginIndex) {
    // Why: replace only between the markers so an operator's own CLAUDE.md
    // content around them is never touched.
    return existing.slice(0, beginIndex) + block + existing.slice(endIndex + END_MARKER.length)
  }
  const separator = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n` : ''
  return `${separator}${block}\n`
}

export type ContextSyncResult = {
  contextPath: string
  claudeMdPath: string
  contextChanged: boolean
  claudeMdChanged: boolean
  /** True when a tracked context file from an older BuildEx was cleaned up. */
  legacyRemoved: boolean
}

/**
 * A repo written by an older BuildEx carries `.buildex/company-context.md`, which
 * nothing updates any more. Remove it — but only if it is unmistakably ours, by
 * its generated header. Anything else is the operator's file and stays put
 * (invariant 8).
 */
function removeLegacyContext(repoPath: string): boolean {
  const legacy = path.join(repoPath, ...LEGACY_CONTEXT_RELATIVE_PATH.split('/'))
  if (!existsSync(legacy)) {
    return false
  }
  try {
    if (!readFileSync(legacy, 'utf8').startsWith('# Company context')) {
      return false
    }
    rmSync(legacy, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Write the context file and ensure the agent's project memory imports it.
 *
 * Both files live in `.claude/`, which the brain scanner skips and git ignores,
 * so this is genuinely idempotent: syncing twice writes nothing the second time,
 * the context never feeds back into itself, and no amount of re-syncing shows up
 * in the company's history.
 */
export function syncCompanyContext(
  repoPath: string,
  scan: BrainScan,
  apps: InstalledAppSummary[] = [],
  location: BrainLocation
): ContextSyncResult {
  const contextAbsolute = path.join(repoPath, ...CONTEXT_RELATIVE_PATH.split('/'))
  const claudeMdAbsolute = path.join(repoPath, ...AGENT_MEMORY_RELATIVE_PATH.split('/'))

  const nextContext = renderCompanyContext(scan, apps, location)
  const currentContext = existsSync(contextAbsolute) ? readFileSync(contextAbsolute, 'utf8') : null
  const contextChanged = currentContext !== nextContext
  if (contextChanged) {
    mkdirSync(path.dirname(contextAbsolute), { recursive: true })
    writeFileSync(contextAbsolute, nextContext, 'utf8')
  }

  const currentClaudeMd = existsSync(claudeMdAbsolute) ? readFileSync(claudeMdAbsolute, 'utf8') : ''
  const nextClaudeMd = withImportBlock(currentClaudeMd)
  const claudeMdChanged = currentClaudeMd !== nextClaudeMd
  if (claudeMdChanged) {
    mkdirSync(path.dirname(claudeMdAbsolute), { recursive: true })
    writeFileSync(claudeMdAbsolute, nextClaudeMd, 'utf8')
  }

  return {
    contextPath: CONTEXT_RELATIVE_PATH,
    claudeMdPath: AGENT_MEMORY_RELATIVE_PATH,
    contextChanged,
    claudeMdChanged,
    legacyRemoved: removeLegacyContext(repoPath)
  }
}
