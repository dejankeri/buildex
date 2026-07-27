import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
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
// A symlink keeps one copy of the truth. Where symlinks are not available
// (Windows without developer mode), the caller falls back to copying, which
// costs a duplicate but never costs the operator a working skill.

export const AGENT_SKILLS_DIR = path.join('.claude', 'skills')

export type LinkOutcome = 'linked' | 'already-linked' | 'needs-copy'

export function skillsRoot(location: BrainLocation): string {
  return path.join(location.root, 'skills')
}

function isOurLink(linkPath: string, targetPath: string): boolean {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      return false
    }
    const actual = path.resolve(path.dirname(linkPath), readlinkSync(linkPath))
    return actual === path.resolve(targetPath)
  } catch {
    return false
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

  if (isOurLink(linkPath, target)) {
    return 'already-linked'
  }
  if (existsSync(linkPath)) {
    // Something real is there — a hand-written skill, or a copy from a machine
    // that could not symlink. Not ours to remove.
    return 'needs-copy'
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

/** Drop our link (never a real directory) when a pack goes away. */
export function unlinkSkillFromAgentDir(repoPath: string, skillName: string): void {
  const linkPath = path.join(repoPath, AGENT_SKILLS_DIR, skillName)
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      rmSync(linkPath)
    }
  } catch {
    // Nothing there, or not ours.
  }
}
