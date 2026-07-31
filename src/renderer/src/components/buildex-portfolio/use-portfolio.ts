import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { Repo, Worktree } from '../../../../shared/types'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { BrainResolution, BrainSectionInfo } from '../../../../shared/buildex-brain-types'
import { resolveRosterStatus } from '../buildex-store/store-roster-status'
import {
  brainPlacement,
  countFilledSections,
  latestRunForRepo,
  type PortfolioCompany
} from './portfolio-row'

// Everything the Portfolio reads, in one place.
//
// It calls the per-repo IPC every other BuildEx surface already calls, once per
// business instead of once per visit — there is no portfolio-shaped data source
// behind this and there must not be one. What the hook owns is the order of the
// calls, the bounds on them, and what a business looks like when one of them
// cannot answer.

/** A slow brain must cost its own row and nothing else. */
const COMPANY_DEADLINE_MS = 12_000

export type PortfolioState = {
  companies: PortfolioCompany[]
  /** True until every business has been probed; rows fill in behind it. */
  loading: boolean
  /** Re-read every business. Reading is all it does — nothing here writes. */
  refresh: () => void
}

/**
 * The repo whose path a per-repo surface would be opened against.
 *
 * The main working tree, because that is the checkout the brain resolves from
 * (worktree-primary-checkout.ts) — activating a feature branch's worktree would
 * show the same brain under a name the operator did not ask for.
 */
function mainWorkspaceFor(worktrees: Worktree[] | undefined, repoPath: string): string | null {
  const main =
    worktrees?.find((worktree) => worktree.isMainWorktree) ??
    worktrees?.find((worktree) => worktree.path === repoPath) ??
    worktrees?.[0]
  return main?.id ?? null
}

/** The renderer has no `node:path`; a repo path already says which separator it uses. */
function joinRepoPath(repoPath: string, child: string): string {
  const separator = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/'
  return `${repoPath.replace(/[/\\]$/, '')}${separator}${child}`
}

/**
 * Whether a missing directory is the answer or the failure.
 *
 * "Not there" means this repo is not a business, and dropping it is correct.
 * Anything else — a permission, an SSH host that is down — means BuildEx could
 * not look, and a business that disappears because its host is asleep is worse
 * than a row that says so.
 */
function isMissingDirectory(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /enoent|no such file|not found|cannot find/i.test(message)
}

function withDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((settle) => {
      timer = setTimeout(() => settle(fallback), COMPANY_DEADLINE_MS)
    })
  ]).finally(() => clearTimeout(timer))
}

function baseCompany(repo: Repo, worktreeId: string | null): PortfolioCompany {
  return {
    repoId: repo.id,
    name: repo.displayName,
    badgeColor: repo.badgeColor,
    worktreeId,
    loaded: false,
    degraded: null,
    initialized: false,
    brain: null,
    unsavedCount: null,
    lastRun: null,
    rosterGaps: null,
    placement: null
  }
}

/**
 * Is this repo a business, and can this machine read it?
 *
 * Deliberately before the scan rather than instead of it: `buildex-brain:scan`
 * puts the gate, the skill links and the company context in order, which is
 * right for a repo somebody runs a business out of and wrong for the other
 * eleven repos in their sidebar. Opening a dashboard must not gate every repo
 * the operator has ever added.
 */
async function probeCompany(
  repo: Repo
): Promise<{ company: boolean; resolution: BrainResolution | null; remote: boolean }> {
  // A path cannot say which machine it names. Resolving an SSH repo locally
  // would answer about a local directory that merely shares its path, so the
  // brain IPC is never asked about one — see BUILDEX-PATCHES.md.
  if (repo.connectionId) {
    try {
      await window.api.fs.readDir({
        dirPath: joinRepoPath(repo.path, '.buildex'),
        connectionId: repo.connectionId
      })
      return { company: true, resolution: null, remote: true }
    } catch (error) {
      return { company: !isMissingDirectory(error), resolution: null, remote: true }
    }
  }

  const resolution = await window.api.buildexBrain.resolve({ repoPath: repo.path })
  if (!resolution) {
    return { company: false, resolution: null, remote: false }
  }
  // A pointer naming a brain this machine has not cloned, or a binding whose
  // path is gone: the company is real, its brain is not readable from here.
  if (resolution.status !== 'ready') {
    return { company: true, resolution, remote: false }
  }
  try {
    const entries = await window.api.fs.readDir({ dirPath: resolution.location.root })
    return { company: entries.length > 0, resolution, remote: false }
  } catch (error) {
    return { company: !isMissingDirectory(error), resolution, remote: false }
  }
}

async function readCompany(
  repo: Repo,
  sections: BrainSectionInfo[],
  seed: PortfolioCompany
): Promise<PortfolioCompany> {
  const scan = await window.api.buildexBrain.scan({ repoPath: repo.path })
  const catalog = await window.api.buildexStore.catalog({ repoPath: repo.path }).catch(() => null)
  const roster = catalog ? resolveRosterStatus(catalog) : null
  return {
    ...seed,
    loaded: true,
    degraded: null,
    initialized: scan.initialized,
    brain: {
      documentCount: scan.documents.length,
      sectionsFilled: countFilledSections(scan.folders, sections),
      sectionsTotal: sections.length
    },
    unsavedCount: scan.documents.filter((document) => document.changed).length,
    rosterGaps: roster ? roster.missing.length : null,
    placement: brainPlacement(scan.resolution)
  }
}

export function usePortfolio(): PortfolioState {
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const [companies, setCompanies] = useState<PortfolioCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  // Read at fetch time rather than subscribed to: a workspace appearing while
  // rows are filling must not restart the sweep it is halfway through.
  const worktreesRef = useRef(worktreesByRepo)
  worktreesRef.current = worktreesByRepo

  const refresh = useCallback((): void => setNonce((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    void (async () => {
      const [sections, automations, runs] = await Promise.all([
        window.api.buildexBrainSections
          .list()
          .then((result) => result.sections)
          .catch((): BrainSectionInfo[] => []),
        window.api.automations.list().catch((): Automation[] => []),
        window.api.automations.listRuns().catch((): AutomationRun[] => [])
      ])
      if (cancelled) {
        return
      }

      const probes = await Promise.all(
        repos.map(async (repo) => ({ repo, probe: await probeCompany(repo).catch(() => null) }))
      )
      if (cancelled) {
        return
      }

      const found = probes.filter((entry) => entry.probe?.company)
      // Seeded before the per-repo reads so the screen has its shape — and its
      // company names — while the slow columns are still arriving.
      const seeded = found.map(({ repo, probe }) => {
        const base = {
          ...baseCompany(repo, mainWorkspaceFor(worktreesRef.current[repo.id], repo.path)),
          lastRun: latestRunForRepo(repo.id, automations, runs)
        }
        if (probe?.remote) {
          return { ...base, loaded: true, degraded: 'remote-host' as const }
        }
        if (probe?.resolution && probe.resolution.status !== 'ready') {
          return {
            ...base,
            loaded: true,
            degraded: 'unreadable' as const,
            placement: brainPlacement(probe.resolution)
          }
        }
        return base
      })
      setCompanies(seeded)

      // One business at a time: each read spawns git, and a fan-out over every
      // repo in the sidebar would make the dashboard the most expensive screen
      // in the app. Rows land as they finish.
      for (const [index, seed] of seeded.entries()) {
        if (cancelled) {
          return
        }
        if (seed.degraded) {
          continue
        }
        const filled = await withDeadline(readCompany(found[index].repo, sections, seed), {
          ...seed,
          loaded: true,
          degraded: 'unreadable' as const
        })
        if (cancelled) {
          return
        }
        setCompanies((current) =>
          current.map((entry) => (entry.repoId === filled.repoId ? filled : entry))
        )
      }
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [nonce, repos])

  return { companies, loading, refresh }
}
