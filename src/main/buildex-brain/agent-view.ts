import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  AgentContextFile,
  AgentReachableItem,
  AgentView,
  BrainScan
} from '../../shared/buildex-brain-types'
import { listBrainSkills } from './brain-skills'
import { readMcpServers, describeMcpServer } from './agent-view-mcp'

// What the agent is actually looking at when a chat starts.
//
// This exists because the honest answer is not one file. The agent reads its
// project memory in full, follows the `@` imports in it, and is separately told
// the NAMES of skills, MCP servers and documents it may choose to open. Those
// two halves feel the same to an operator and are not: a skill's instructions
// are not in the conversation until the agent decides to read them.
//
// Rendered from files on disk with no model in the loop (invariant 9), and it
// never reads a credential — an MCP entry's key is a variable reference here and
// stays one (invariant 4).

/** Project memory, in the order the agent picks it up. */
const MEMORY_FILES = ['CLAUDE.md', '.claude/CLAUDE.md']

// Deep enough for anything real; a cap at all is what stops a pair of files that
// import each other from hanging the dialog.
const MAX_IMPORT_DEPTH = 3

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * The `@path` imports in a memory file.
 *
 * Only at the start of a line, and never inside a fenced code block — a document
 * quoting an import as an example is not an import.
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

function readIfPresent(absolute: string): string | null {
  try {
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null
  } catch {
    return null
  }
}

function collectMemory(repoPath: string): AgentContextFile[] {
  const files: AgentContextFile[] = []
  const seen = new Set<string>()

  const visit = (target: string, depth: number, importedBy: string | null): void => {
    // `~/…` is a home-relative import. Resolving it as a path would quietly turn
    // it into a folder literally named `~` inside the repo, and the import would
    // disappear from this view rather than be reported as external.
    const external = target.startsWith('~')
    const absolute = external ? target : path.resolve(target)
    const relative = external ? target : toPosix(path.relative(repoPath, absolute))
    if (seen.has(relative) || depth > MAX_IMPORT_DEPTH) {
      return
    }
    // Why: an import that leaves the repo is real — the agent does load it — but
    // it is not this company's file, and reading someone's home directory to
    // show it here is not BuildEx's business.
    if (external || relative.startsWith('..') || path.isAbsolute(relative)) {
      seen.add(relative)
      files.push({
        path: relative,
        reason: 'Imported from outside this repo — BuildEx does not read it.',
        body: '',
        imported: true
      })
      return
    }
    const body = readIfPresent(absolute)
    if (body === null) {
      return
    }
    seen.add(relative)
    files.push({
      path: relative,
      reason: importedBy
        ? `Imported by ${importedBy}, so it loads with it.`
        : 'Project instructions, read in full at the start of every session.',
      body,
      imported: Boolean(importedBy)
    })
    for (const target of findImports(body)) {
      // Per the import rules, relative to the file holding the line.
      visit(
        target.startsWith('~') ? target : path.resolve(path.dirname(absolute), target),
        depth + 1,
        relative
      )
    }
  }

  for (const relative of MEMORY_FILES) {
    visit(path.join(repoPath, ...relative.split('/')), 0, null)
  }
  return files
}

function collectReachable(repoPath: string, scan: BrainScan): AgentReachableItem[] {
  const items: AgentReachableItem[] = []
  const location = scan.resolution?.status === 'ready' ? scan.resolution.location : null

  // Only the linked ones: a skill the agent cannot see is not something it can
  // reach, however plainly it sits in the brain's `skills/`.
  for (const skill of location
    ? listBrainSkills(repoPath, location).filter((entry) => entry.linked)
    : []) {
    items.push({
      kind: 'skill',
      name: skill.name,
      detail: skill.description || skill.title,
      path: `.buildex/skills/${skill.name}/SKILL.md`
    })
  }

  for (const [name, entry] of readMcpServers(repoPath)) {
    items.push({ kind: 'mcp', name, detail: describeMcpServer(entry), path: '.mcp.json' })
  }

  for (const document of scan.documents) {
    items.push({
      kind: 'document',
      name: document.id,
      detail: document.folder || 'root',
      path: `.buildex/${document.id}`
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
