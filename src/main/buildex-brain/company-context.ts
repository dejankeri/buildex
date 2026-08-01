import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * What the apps section may spend. It used to spend whatever the shelf held: the
 * app count, each summary and each skill list printed verbatim, and every ceiling
 * test measured a brain with no apps in it at all.
 */
const MAP_APPS_LIMIT = 12
const MAP_SKILLS_PER_APP = 12
const MAP_APP_SUMMARY_BUDGET = 120

/**
 * The apps section: what this company has connected. Deliberately short — the
 * skills carry the instructions, so this only has to make the agent aware they
 * exist and reach for them.
 *
 * It names no paths, on purpose. A plugin's skills and its MCP server live
 * inside the plugin the agent installed and load from there with nothing linked
 * and nothing for the agent to open; the earlier copy sent it to
 * `.buildex/skills/` and `.mcp.json`, neither of which holds an app's anything.
 * Saying less is the honest answer, and this text is re-read at every session
 * start, so a line that buys nothing is a line charged to the operator forever.
 */
function renderApps(apps: InstalledAppSummary[]): string[] {
  if (apps.length === 0) {
    return []
  }
  const shown = apps.slice(0, MAP_APPS_LIMIT)
  const lines = [
    `## Apps (${apps.length})`,
    '',
    'Installed apps. Each one ships skills that load with this session and say how to',
    'use it well — read the skill before improvising.',
    ''
  ]
  for (const app of shown) {
    lines.push(`### ${app.name}`, '')
    if (app.summary) {
      lines.push(truncateAtWord(app.summary, MAP_APP_SUMMARY_BUDGET), '')
    }
    if (app.skills.length > 0) {
      const names = app.skills.slice(0, MAP_SKILLS_PER_APP).map((skill) => `\`${skill}\``)
      const hidden = app.skills.length - names.length
      if (hidden > 0) {
        names.push(`+${hidden} more`)
      }
      lines.push(`- Skills: ${names.join(', ')}`)
    }
    if (app.hasMcp) {
      lines.push(
        app.connected === false
          ? '- MCP: brings its own tools, but no key is stored on this machine yet — they will not connect until one is added from the Store.'
          : '- MCP: brings its own tools; prefer them over shell or HTTP calls.'
      )
    }
    if (app.envKey) {
      lines.push(
        `- API key: read from the \`${app.envKey}\` environment variable. Never ask the operator to paste it into a file, and never write it into the repo.`
      )
    }
    lines.push('')
  }
  if (apps.length > shown.length) {
    lines.push(`+${apps.length - shown.length} more installed — open the Store to see them.`, '')
  }
  return lines
}

/**
 * What this file is allowed to spend, enforced here rather than trusted to the
 * data. `DESCRIPTION_LIMIT` is 160 because that is what a Brain tree row can
 * afford; this file is read *in full* at the start of every agent session, so
 * it takes half. A brain of two hundred entities is the difference between
 * 25 kB of prompt and 12 kB.
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
 * the map's remaining unbounded terms — O(entities + folders) — which is why
 * `fitTree` measures the result rather than trusting the per-line budgets.
 *
 * `descriptionBudget` is how it gives way: narrowed, then 0, before any path is
 * dropped.
 */
function renderTree(nodes: BrainNode[], descriptionBudget: number, depth = 0): string[] {
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
      const summary =
        descriptionBudget > 0 ? truncateAtWord(node.main?.summary ?? '', descriptionBudget) : ''
      lines.push(`${indent}- **${node.title}** \`${node.path}/\`${summary ? ` — ${summary}` : ''}`)
      continue
    }
    // Why the tail rather than the head: documents arrive sorted ascending by id,
    // so a dated stream — `inbox/<date>.md`, dated `decisions/` slugs — sorts
    // oldest first. Taking the first twelve of a capture folder shows the twelve
    // the operator has moved furthest past and hides this week's.
    const hidden = Math.max(node.documents.length - MAP_DOCUMENTS_PER_FOLDER, 0)
    const names = node.documents
      .slice(hidden)
      .map((document) =>
        descriptionBudget > 0 && document.description
          ? `${document.name} (${truncateAtWord(document.description, descriptionBudget)})`
          : document.name
      )
    if (hidden > 0) {
      // Said out loud, and first because that is where the omitted ones sort: an
      // agent that knows there are more will open the folder, where a silently
      // cut list would have it believe it had seen everything.
      names.unshift(`+${hidden} more`)
    }
    lines.push(
      `${indent}- **${node.path === '' ? 'root' : node.path}**${
        names.length > 0 ? ` — ${names.join(', ')}` : ''
      }`
    )
    lines.push(...renderTree(node.children, descriptionBudget, depth + 1))
  }
  return lines
}

/**
 * What this whole file may cost, in the unit that is actually spent.
 *
 * The per-line budgets above bound a *line*; the tree has one term per entity and
 * one per folder, and nothing bounded their number. 120 clients with the ten
 * scaffolded sections all holding described documents rendered 26 524 characters
 * against this number — 33% over — while every ceiling test passed, because each
 * fixture only ever grew one term.
 */
const MAP_CHARACTER_CEILING = 20_000

/** Room kept for the truncation line, whatever count it ends up naming. */
const TRUNCATION_NOTICE_RESERVE = 200

/**
 * Description budgets to try, widest first; `0` renders names and paths alone.
 *
 * Graduated rather than all-or-nothing because the drop is steep: the fixture
 * that broke the ceiling renders 26 524 characters described and 6 713 bare, so
 * a single fallback throws away three times more context than it had to.
 */
const MAP_DESCRIPTION_FALLBACKS = [MAP_DESCRIPTION_BUDGET, 40, 0]

const WITHIN_BUDGET = 'to keep this file within its size budget'

function shortenedNotice(descriptionBudget: number): string {
  return descriptionBudget === 0
    ? `Descriptions are omitted below ${WITHIN_BUDGET} — open a document for what it says.`
    : `Descriptions below are cut to ${descriptionBudget} characters ${WITHIN_BUDGET} — open a document for the rest.`
}

/** What these lines add to the joined output, one newline each. */
function joinedLength(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0)
}

/**
 * The tree, fitted to what is left of the ceiling.
 *
 * Descriptions give way before paths do. Prose is the term that grows fastest
 * and the one the agent can recover by opening the document; a path it was never
 * shown names something it does not know exists. Truncation is therefore last,
 * and it is announced — a map that quietly stopped is a map that lies about the
 * shape of the company.
 */
function fitTree(nodes: BrainNode[], budget: number): string[] {
  let narrowest: string[] = []
  for (const [index, descriptionBudget] of MAP_DESCRIPTION_FALLBACKS.entries()) {
    const preamble = index === 0 ? [] : [shortenedNotice(descriptionBudget), '']
    narrowest = renderTree(nodes, descriptionBudget)
    if (joinedLength(preamble) + joinedLength(narrowest) <= budget) {
      return [...preamble, ...narrowest]
    }
  }
  const preamble = [shortenedNotice(0), '']
  let spent = joinedLength(preamble)
  const kept: string[] = []
  for (const line of narrowest) {
    if (spent + line.length + 1 + TRUNCATION_NOTICE_RESERVE > budget) {
      break
    }
    kept.push(line)
    spent += line.length + 1
  }
  return [
    ...preamble,
    ...kept,
    `- _${narrowest.length - kept.length} more folders and entities are not listed: this map reached its size budget. Open the brain folder to see them._`
  ]
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
  const head: string[] =
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

  head.push(...renderApps(apps), `## Documents (${scan.documents.length})`, '')

  // The trailing lists are built before the tree because the tree is what gives
  // way: they are already capped at ten entries each, and the tree is the term
  // that grows with the company.
  const lines: string[] = []

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
  const budget = MAP_CHARACTER_CEILING - joinedLength(head) - joinedLength(lines)
  return [...head, ...fitTree(scan.tree, Math.max(budget, 0)), '', ...lines].join('\n')
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
    claudeMdChanged
  }
}
