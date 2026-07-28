import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Keep the GENERATED files out of the operator's git — and only those.
//
// `.buildex/` is deliberately NOT excluded. It holds what the company knows and
// what it expects installed: decisions, rules, skills, the gate preset, and the
// app roster. That is content, it belongs in the repo's history, and pushing the
// repo is how it reaches the rest of the team. There is no sync service behind
// BuildEx and there does not need to be one.
//
// `.claude/` is the opposite: every file in it is derived from `.buildex/` and
// regenerated whenever a BuildEx surface opens the repo — skill links, the
// permissions block, the context import. Committing it would put
// machine-specific paths and generated noise into a diff a teammate reads.
//
// `.mcp.json` used to be here, back when BuildEx generated one server per
// installed pack. Plugins carry their own server config now, so that file is
// the operator's if it exists at all — hiding it would be hiding their work.
//
// `.git/info/exclude` rather than `.gitignore`: .gitignore is a tracked file
// belonging to the project, and editing it would commit BuildEx's opinions into
// someone else's repo. info/exclude is per-clone and untracked.

const BEGIN_MARKER = '# buildex:begin — machine state, not company work'
const END_MARKER = '# buildex:end'

/** Generated paths only — see the note above on why `.buildex/` is not here. */
export const BUILDEX_EXCLUDED_PATHS = ['.claude/']

function renderBlock(paths: string[]): string {
  return [BEGIN_MARKER, ...paths, END_MARKER].join('\n')
}

/**
 * Replace only the span between our markers, so anything the operator excluded
 * by hand survives untouched.
 */
export function applyExcludeBlock(current: string, paths: string[]): string {
  const block = renderBlock(paths)
  const beginIndex = current.indexOf(BEGIN_MARKER)
  const endIndex = current.indexOf(END_MARKER)
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    return `${current}${separator}${current.length > 0 ? '\n' : ''}${block}\n`
  }
  const before = current.slice(0, beginIndex)
  const after = current.slice(endIndex + END_MARKER.length)
  return `${before}${block}${after}`
}

/**
 * Make sure this clone ignores BuildEx's files. Returns true when the exclude
 * file changed.
 *
 * A repo with no .git (a plain folder someone pointed BuildEx at) is not an
 * error — there is simply no git to keep clean.
 */
export function ensureBuildExGitExclude(repoPath: string): boolean {
  const gitDir = path.join(repoPath, '.git')
  if (!existsSync(gitDir)) {
    return false
  }
  // A worktree's .git is a file pointing at the real git dir; excludes belong to
  // that shared dir, so resolve it rather than writing beside the pointer.
  let resolvedGitDir = gitDir
  try {
    const stats = readFileSync(gitDir, 'utf8')
    const match = stats.match(/^gitdir:\s*(.+)$/m)
    if (match) {
      resolvedGitDir = path.resolve(repoPath, match[1].trim())
    }
  } catch {
    // .git is a directory, which is the ordinary case — keep it.
  }

  const excludePath = path.join(resolvedGitDir, 'info', 'exclude')
  let current = ''
  try {
    current = readFileSync(excludePath, 'utf8')
  } catch {
    current = ''
  }
  const next = applyExcludeBlock(current, BUILDEX_EXCLUDED_PATHS)
  if (next === current) {
    return false
  }
  try {
    mkdirSync(path.dirname(excludePath), { recursive: true })
    writeFileSync(excludePath, next, 'utf8')
    return true
  } catch {
    return false
  }
}
