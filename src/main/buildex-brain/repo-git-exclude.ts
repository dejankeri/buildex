import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Keep the GENERATED files out of the operator's git — and only those.
//
// `.buildex/` is deliberately NOT excluded. It holds what the company knows and
// what it expects installed: decisions, rules, skills, the gate preset, and the
// app roster. That is content, it belongs in the repo's history, and pushing the
// repo is how it reaches the rest of the team. There is no sync service behind
// BuildEx and there does not need to be one.
//
// `.claude/` is where BuildEx writes, but it is not BuildEx's directory. The
// agent runtime owns it too, and any repo that ran an agent before BuildEx
// arrived already keeps the operator's own work in it: hand-written skills and
// the scripts they ship, hooks, subagents, a permission allowlist someone tuned
// by hand. This block used to name the whole directory, and the cost was
// invisible: files already tracked stayed tracked, so nothing appeared to break,
// while every file added afterwards was silently unstageable. A skill written
// into an excluded directory works on the machine that wrote it and exists
// nowhere else. So name what BuildEx generates, and leave the rest alone.
//
// `settings.json` is not here on purpose. BuildEx merges the gate into it, but
// the gate is policy — what the agent may do unattended — and policy belongs in
// a diff somebody reads, not under a machine-state marker.
//
// `.mcp.json` used to be here, back when BuildEx generated one server per
// installed pack. Plugins carry their own server config now, so that file is
// the operator's if it exists at all — hiding it would be hiding their work.
//
// `.git/info/exclude` rather than `.gitignore`: .gitignore is a tracked file
// belonging to the project, and editing it would commit BuildEx's opinions into
// someone else's repo. info/exclude is per-clone and untracked.
//
// Paths are written with `/` on every platform: this is a git pattern file, not
// a filesystem path, and `path.join` would emit `\` on Windows and match nothing.

const BEGIN_MARKER = '# buildex:begin — machine state, not company work'
const END_MARKER = '# buildex:end'

/**
 * What BuildEx writes into `.claude/` under a fixed name.
 *
 * `CLAUDE.md` and `company-context.md` are rendered from the brain on every
 * refresh. `gate-applied.json` is the gate's receipt. `settings.local.json` is
 * the agent runtime's own per-machine permission state — not BuildEx's work, but
 * machine state by definition, and excluded here so narrowing this block does
 * not push someone's local approvals into their index.
 */
export const BUILDEX_GENERATED_PATHS = [
  '.claude/CLAUDE.md',
  '.claude/company-context.md',
  '.claude/gate-applied.json',
  '.claude/settings.local.json'
]

/**
 * The brain-skill links, which have no fixed names.
 *
 * `relinkBrainSkills` makes one per skill in the brain and only ever as a
 * symlink: a real directory under `.claude/skills/` is a skill the operator
 * wrote, which `skill-link.ts` refuses to overwrite for the same reason this
 * refuses to hide it. So "is a symlink" is the whole test.
 *
 * Read from disk rather than from the brain, because this also has to catch the
 * links left by a brain that has since moved. Empty on a checkout whose links do
 * not exist yet, which is why `relinkBrainSkills` calls back here once it has
 * made them.
 */
function brainSkillLinks(repoPath: string): string[] {
  try {
    return readdirSync(path.join(repoPath, '.claude', 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isSymbolicLink())
      .map((entry) => `.claude/skills/${entry.name}`)
      .sort()
  } catch {
    // No `.claude/skills/` is no links — the ordinary state of a fresh checkout.
    return []
  }
}

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
  const next = applyExcludeBlock(current, [
    ...BUILDEX_GENERATED_PATHS,
    ...brainSkillLinks(repoPath)
  ])
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
