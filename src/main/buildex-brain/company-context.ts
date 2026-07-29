import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrainLocation, BrainNode, BrainScan } from '../../shared/buildex-brain-types'

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
 * The brain's shape, as lines the agent can act on.
 *
 * An entity is named and summarised; the documents inside it are not listed.
 * That is what keeps this bounded as a company grows — a hundred clients is a
 * hundred lines the agent can read, rather than four hundred filenames it
 * cannot. An agent that needs what is inside one opens the folder.
 */
function renderTree(nodes: BrainNode[], depth = 0): string[] {
  const lines: string[] = []
  const indent = '  '.repeat(depth)
  for (const node of nodes) {
    if (node.kind === 'entity') {
      const summary = node.main?.summary
      lines.push(`${indent}- **${node.title}** \`${node.path}/\`${summary ? ` — ${summary}` : ''}`)
      continue
    }
    const names = node.documents.map((document) => document.name)
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
  // around. Surfacing them tells the agent where to look first.
  const hubs = scan.documents
    .map((doc) => ({
      name: doc.name,
      id: doc.id,
      degree: doc.linksTo.length + doc.linkedFrom.length
    }))
    .filter((entry) => entry.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, 10)

  if (hubs.length > 0) {
    lines.push('## Most connected', '')
    for (const hub of hubs) {
      lines.push(`- \`${hub.id}\` (${hub.degree} ${hub.degree === 1 ? 'link' : 'links'})`)
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
