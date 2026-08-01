import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  AgentContextFile,
  AgentContextImport,
  AgentReachableItem,
  AgentView,
  BrainLocation,
  BrainScan
} from '../../shared/buildex-brain-types'
import { listBrainSkills } from './brain-skills'

// What the agent is actually looking at when a chat starts.
//
// The honest answer has two halves that feel identical to an operator and are
// not: project memory is in the conversation before they type, while a skill, a
// connected app or a document is only NAMED — its contents arrive only if the
// agent decides to open it.
//
// Memory files are listed verbatim and their `@` lines are listed as written.
// Nothing here *follows* an import: a line is resolved far enough to offer a
// link and never far enough to say what is on the other end. Claude Code owns
// those semantics — depth, cycles, home-relative paths — and a second
// implementation of them in the one dialog whose entire value is being true
// would sooner or later state something false. Rendered from files on disk with
// no model in the loop (invariant 9).

/** Project memory, in the order the agent picks it up. */
const MEMORY_FILES = ['CLAUDE.md', '.claude/CLAUDE.md']

const MCP_CONFIG_FILE = '.mcp.json'

/**
 * The `@path` lines in a memory file.
 *
 * Only a line that is nothing but `@target`, and never inside a fenced code
 * block — a document quoting an import as an example is not writing one.
 */
export function findImports(body: string): string[] {
  const found: string[] = []
  let fenced = false
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      continue
    }
    const match = line.match(/^\s*@(\S+)\s*$/)
    if (match) {
      found.push(match[1])
    }
  }
  return found
}

function readFileIfPresent(absolute: string): string | null {
  try {
    return statSync(absolute).isFile() ? readFileSync(absolute, 'utf8') : null
  } catch {
    return null
  }
}

/**
 * Where an `@` line points, when this machine can open it.
 *
 * The plain reading of the text — a path relative to the file holding the line —
 * and only when it turns out to be a file, so the dialog never offers a link
 * that opens nothing or launches an application bundle. Absent is a fine answer:
 * the line is still shown, just not as a link.
 */
function resolveImportTarget(fromFile: string, target: string): string | undefined {
  const expanded = /^~[/\\]/.test(target) ? path.join(homedir(), target.slice(2)) : target
  const absolute = path.resolve(path.dirname(fromFile), expanded)
  try {
    return statSync(absolute).isFile() ? absolute : undefined
  } catch {
    return undefined
  }
}

function collectMemory(repoPath: string): AgentContextFile[] {
  const files: AgentContextFile[] = []
  for (const relative of MEMORY_FILES) {
    const absolute = path.join(repoPath, ...relative.split('/'))
    const body = readFileIfPresent(absolute)
    if (body === null) {
      continue
    }
    const imports: AgentContextImport[] = findImports(body).map((target) => {
      const absolutePath = resolveImportTarget(absolute, target)
      return absolutePath ? { target, absolutePath } : { target }
    })
    files.push({ path: relative, body, imports })
  }
  return files
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Servers in `.mcp.json`, sorted, so the dialog reads the same way every time. */
function readMcpServers(repoPath: string): [string, Record<string, unknown>][] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path.join(repoPath, MCP_CONFIG_FILE), 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return []
  }
  return Object.entries(parsed.mcpServers)
    .filter((pair): pair is [string, Record<string, unknown>] => isRecord(pair[1]))
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * How the agent reaches a server, said in the one way that cannot carry a key.
 *
 * `headers`, `env` and `args` are never read at all — a value that is never
 * rendered cannot be imperfectly masked. A URL is cut to scheme and host because
 * hosted MCP services routinely put the operator's secret in the path
 * (`/api/mcp/s/<secret>/mcp`), a query or the userinfo; a command is cut to its
 * program name for the same reason plus one more — an install path carries the
 * operator's home directory into a dialog people screenshot.
 */
function describeMcpServer(entry: Record<string, unknown>): string {
  const url = typeof entry.url === 'string' ? entry.url : ''
  if (url) {
    try {
      const parsed = new URL(url)
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return ''
    }
  }
  const command = typeof entry.command === 'string' ? entry.command : ''
  return command.split(/[/\\]/).at(-1) ?? ''
}

/**
 * Where to show a brain-relative path in the picker: still `.buildex/…` when
 * embedded, since that is literally where it is in this repo; the real
 * absolute path when external, since the id alone resolves to nothing here.
 */
function displayPath(location: BrainLocation, relativeToRoot: string): string {
  return location.mode === 'embedded'
    ? `.buildex/${relativeToRoot}`
    : path.join(location.root, relativeToRoot)
}

function collectReachable(repoPath: string, scan: BrainScan): AgentReachableItem[] {
  const items: AgentReachableItem[] = []
  const location = scan.resolution?.status === 'ready' ? scan.resolution.location : null

  // Only the linked ones: a skill the agent cannot see is not something it can
  // reach, however plainly it sits in the brain's `skills/`.
  if (location) {
    for (const skill of listBrainSkills(repoPath, location).filter((entry) => entry.linked)) {
      items.push({
        kind: 'skill',
        name: skill.name,
        detail: skill.description || skill.title,
        path: displayPath(location, `skills/${skill.name}/SKILL.md`)
      })
    }
  }

  for (const [name, entry] of readMcpServers(repoPath)) {
    items.push({ kind: 'mcp', name, detail: describeMcpServer(entry), path: MCP_CONFIG_FILE })
  }

  for (const document of scan.documents) {
    items.push({
      kind: 'document',
      name: document.id,
      detail: document.folder || 'root',
      path: location ? displayPath(location, document.id) : `.buildex/${document.id}`
    })
  }

  return items
}

/**
 * Assemble the whole picture. Deterministic: same repo in, same view out.
 */
export function buildAgentView(repoPath: string, scan: BrainScan): AgentView {
  const alwaysLoaded = collectMemory(repoPath)
  return {
    repoPath,
    alwaysLoaded,
    reachable: collectReachable(repoPath, scan),
    loadedCharacters: alwaysLoaded.reduce((sum, file) => sum + file.body.length, 0)
  }
}
