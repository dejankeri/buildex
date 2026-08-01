import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import path from 'node:path'
import type { BrainLocation } from '../../shared/buildex-brain-types'

// Skills live in the brain's `skills/` folder — wherever the brain is — and are
// linked into .claude/skills/, which is always per-repo.
//
// Two reasons for the indirection. The agent runtime only discovers skills under
// .claude/skills (or .agents/skills) — anywhere else and an installed pack is
// inert. And BuildEx's own files belong in one place the operator can point at,
// delete, or exclude wholesale, rather than scattered through a directory the
// agent runtime also owns.
//
// A symlink keeps one copy of the truth. Where symlinks are not available —
// Windows without developer mode, where an unprivileged process gets EPERM from
// every symlink call — `relinkBrainSkills` falls back to copying, which costs a
// duplicate but never costs the operator a working skill. Nothing here reads
// `process.platform`: the fallback triggers on the symlink actually failing, so
// a locked-down account on any OS gets the same treatment.
//
// Known gap of the copy: a copy is an ordinary directory, so it is not refreshed
// when the brain's skill changes, and neither pruning nor disconnecting removes
// it — both only ever touch a symlink they can prove is ours. Telling a copy of
// ours from a skill the operator wrote by hand needs a receipt this deliberately
// does not keep.

export const AGENT_SKILLS_DIR = path.join('.claude', 'skills')

export type LinkOutcome = 'linked' | 'already-linked' | 'needs-copy'

export function skillsRoot(location: BrainLocation): string {
  return path.join(location.root, 'skills')
}

/**
 * What is sitting at a link path.
 *
 * `dangling` is its own answer because a symlink that resolves nowhere is never
 * the operator's work — moving the brain leaves every one of ours behind like
 * that — and it is invisible to `existsSync`, which follows the link.
 */
type LinkState = 'absent' | 'ours' | 'dangling' | 'theirs'

function inspectLink(linkPath: string, targetPath: string): LinkState {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      return 'theirs'
    }
  } catch {
    return 'absent'
  }
  try {
    realpathSync(linkPath)
    const actual = path.resolve(path.dirname(linkPath), readlinkSync(linkPath))
    return actual === path.resolve(targetPath) ? 'ours' : 'theirs'
  } catch {
    return 'dangling'
  }
}

/**
 * Point `.claude/skills/<name>` at the pack's files.
 *
 * Never replaces a real directory: if something other than our link is sitting
 * there, it is the operator's and the caller is told to leave it alone.
 */
export function linkSkillIntoAgentDir(
  repoPath: string,
  location: BrainLocation,
  skillName: string
): LinkOutcome {
  const target = path.join(skillsRoot(location), skillName)
  const linkPath = path.join(repoPath, AGENT_SKILLS_DIR, skillName)

  const state = inspectLink(linkPath, target)
  if (state === 'ours') {
    return 'already-linked'
  }
  if (state === 'theirs') {
    // Something real is there — a hand-written skill, or a copy from a machine
    // that could not symlink. Not ours to remove.
    return 'needs-copy'
  }
  if (state === 'dangling') {
    try {
      // unlink, not rm: rmSync no-ops on a symlink that resolves nowhere, which
      // would leave the path occupied and the symlink below failing EEXIST.
      unlinkSync(linkPath)
    } catch {
      return 'needs-copy'
    }
  }

  try {
    mkdirSync(path.dirname(linkPath), { recursive: true })
    // Relative inside the repo so a clone or a move keeps working; absolute when
    // the brain is elsewhere, because nothing relative can reach it reliably.
    const relative = path.relative(path.dirname(linkPath), target)
    symlinkSync(location.mode === 'embedded' ? relative : target, linkPath, 'dir')
    return 'linked'
  } catch {
    return 'needs-copy'
  }
}

export type CopyOutcome = 'copied' | 'occupied' | 'failed'

/**
 * Put the pack's files where a symlink could not go.
 *
 * Only ever writes into a free path. A directory already at that name is either
 * the operator's own skill or a copy an earlier sync made — in both cases the
 * agent already loads something there, and replacing it would either destroy
 * their work or silently rewrite files they may have edited.
 */
export function copySkillIntoAgentDir(
  repoPath: string,
  location: BrainLocation,
  skillName: string
): CopyOutcome {
  const source = path.join(skillsRoot(location), skillName)
  const destination = path.join(repoPath, AGENT_SKILLS_DIR, skillName)

  try {
    const existing = lstatSync(destination)
    // A symlink here is one we could neither reuse nor remove; copying onto it
    // writes through to whatever it points at, which may be the brain itself.
    return existing.isSymbolicLink() ? 'failed' : 'occupied'
  } catch {
    // Nothing there — the only case this may write.
  }

  try {
    mkdirSync(path.dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true })
    return 'copied'
  } catch {
    return 'failed'
  }
}

export type ServeOutcome = LinkOutcome | 'copied' | 'unavailable'

/**
 * Make a skill loadable, whatever this machine can do.
 *
 * The single place the fallback policy lives, because both callers — the sync
 * that walks the brain and the one that has just written a new skill — fail the
 * same silent way without it.
 */
export function serveSkillInAgentDir(
  repoPath: string,
  location: BrainLocation,
  skillName: string
): ServeOutcome {
  const outcome = linkSkillIntoAgentDir(repoPath, location, skillName)
  if (outcome !== 'needs-copy') {
    return outcome
  }
  return copySkillIntoAgentDir(repoPath, location, skillName) === 'copied'
    ? 'copied'
    : 'unavailable'
}

/** Drop our link (never a real directory) when a pack goes away. */
export function unlinkSkillFromAgentDir(repoPath: string, skillName: string): void {
  const linkPath = path.join(repoPath, AGENT_SKILLS_DIR, skillName)
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      // rmSync refuses a symlink to a directory outright (EISDIR); unlink is
      // what removes the link and never what it points at.
      unlinkSync(linkPath)
    }
  } catch {
    // Nothing there, or not ours.
  }
}

function agentSkillEntries(repoPath: string): string[] {
  try {
    return readdirSync(path.join(repoPath, AGENT_SKILLS_DIR)).sort()
  } catch {
    return []
  }
}

/**
 * Drop `.claude/skills/` links that now point at nothing.
 *
 * Without this the agent is left holding symlinks into a folder that no longer
 * exists, which reads to it as a set of broken skills. Only ever removes a
 * symlink, and only one whose target is gone — a real directory somebody put
 * there by hand is untouched.
 */
export function pruneDanglingSkillLinks(repoPath: string): string[] {
  const root = path.join(repoPath, AGENT_SKILLS_DIR)
  const pruned: string[] = []
  for (const entry of agentSkillEntries(repoPath)) {
    const linkPath = path.join(root, entry)
    try {
      if (!lstatSync(linkPath).isSymbolicLink()) {
        continue
      }
      realpathSync(linkPath)
    } catch {
      // Either it stopped being readable or it resolves nowhere; both mean the
      // link is no longer usable by the agent.
      try {
        unlinkSync(linkPath)
        pruned.push(entry)
      } catch {
        // Nothing to do about a link we cannot remove.
      }
    }
  }
  return pruned
}

/**
 * Drop every link that leads into this brain, target and all.
 *
 * Pruning cannot do this job: a healthy brain a repo is disconnecting from
 * still resolves, so every link would survive and the agent would keep loading
 * the skills of a company this repo no longer belongs to.
 */
export function unlinkBrainSkills(repoPath: string, location: BrainLocation): string[] {
  const root = path.join(repoPath, AGENT_SKILLS_DIR)
  const brainSkills = path.resolve(skillsRoot(location))
  const unlinked: string[] = []
  for (const entry of agentSkillEntries(repoPath)) {
    const linkPath = path.join(root, entry)
    if (inspectLink(linkPath, path.join(brainSkills, entry)) !== 'ours') {
      continue
    }
    try {
      unlinkSync(linkPath)
      unlinked.push(entry)
    } catch {
      // A link we cannot remove stays; nothing else here depends on it.
    }
  }
  return unlinked
}

export type RelinkResult = {
  linked: string[]
  /** Skills a symlink could not serve and a copy did. */
  copied: string[]
  /** Skills neither could serve: the name is taken by something not ours, or the copy failed. */
  unavailable: string[]
  pruned: string[]
}

/**
 * Point `.claude/skills/` at whatever the brain holds now.
 *
 * The brain moving is what makes this necessary: every link into the old root
 * is left dangling, and a dangling link is invisible to the agent and to any
 * later install. Runs over every skill in the brain rather than a pack's list,
 * because a company's own skills need the same link and nothing else builds it.
 */
export function relinkBrainSkills(repoPath: string, location: BrainLocation): RelinkResult {
  const pruned = pruneDanglingSkillLinks(repoPath)
  const root = skillsRoot(location)
  let entries: string[]
  try {
    entries = readdirSync(root).sort()
  } catch {
    return { linked: [], copied: [], unavailable: [], pruned }
  }
  const linked: string[] = []
  const copied: string[] = []
  const unavailable: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue
    }
    try {
      if (!statSync(path.join(root, entry)).isDirectory()) {
        continue
      }
    } catch {
      continue
    }
    // Why the fallback runs here rather than being reported to a caller: no
    // caller had one, so on Windows without developer mode every company skill
    // was silently absent — no error, no empty state, just an agent that had
    // never heard of the company's packs.
    const outcome = serveSkillInAgentDir(repoPath, location, entry)
    if (outcome === 'copied') {
      copied.push(entry)
    } else if (outcome === 'unavailable') {
      unavailable.push(entry)
    } else {
      linked.push(entry)
    }
  }
  return { linked, copied, unavailable, pruned }
}
