import { useCallback, useEffect, useState } from 'react'
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

/**
 * Tighter, because a probe reads one directory and a scan reads a brain.
 *
 * Its real job is the host that never answers: a refused connection fails at
 * once, a blackholed one hangs until TCP gives up, and the screen must not.
 */
const PROBE_DEADLINE_MS = 6_000

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

function withDeadline<T>(work: Promise<T>, fallback: T, afterMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((settle) => {
      timer = setTimeout(() => settle(fallback), afterMs)
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * Load a business's workspaces so its row has something to activate.
 *
 * `App.tsx` hydrates worktrees only for the repos in the persisted session, so
 * on a fresh launch every company the operator has *not* opened has none — and
 * those are exactly the rows this page exists to reach. `fetchWorktrees` is the
 * store's own action; nothing new is added for this.
 */
async function hydrateWorkspace(repo: Repo): Promise<string | null> {
  try {
    await useAppStore.getState().fetchWorktrees(repo.id)
  } catch {
    // A repo whose workspaces cannot be listed still shows its numbers.
  }
  return mainWorkspaceFor(useAppStore.getState().worktreesByRepo[repo.id], repo.path)
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
 * What the probe decided about one repo.
 *
 * `unreadable` is not `unlisted`: BuildEx knowing it cannot look is a different
 * answer from BuildEx knowing there is nothing to look at, and only the second
 * one may drop a business off the screen.
 */
type CompanyProbe =
  | { listed: false }
  | { listed: true; kind: 'ready'; resolution: BrainResolution }
  | { listed: true; kind: 'remote' }
  | { listed: true; kind: 'unreadable'; resolution: BrainResolution | null }

/** What an unanswered probe means: listed, and honest about not knowing. */
function unknownProbe(repo: Repo): CompanyProbe {
  return repo.connectionId
    ? { listed: true, kind: 'remote' }
    : { listed: true, kind: 'unreadable', resolution: null }
}

/**
 * Is this repo a business, and can this machine read it?
 *
 * Deliberately before the scan rather than instead of it: a scan reads the whole
 * brain and a probe reads one directory, and running the expensive one over
 * every repo in the sidebar is what makes a dashboard the slowest screen in the
 * app.
 */
async function probeCompany(repo: Repo): Promise<CompanyProbe> {
  // A path cannot say which machine it names. Resolving an SSH repo locally
  // would answer about a local directory that merely shares its path, so the
  // brain IPC is never asked about one — see BUILDEX-PATCHES.md.
  if (repo.connectionId) {
    try {
      await window.api.fs.readDir({
        dirPath: joinRepoPath(repo.path, '.buildex'),
        connectionId: repo.connectionId
      })
      return { listed: true, kind: 'remote' }
    } catch (error) {
      return isMissingDirectory(error) ? { listed: false } : { listed: true, kind: 'remote' }
    }
  }

  const resolution = await window.api.buildexBrain.resolve({ repoPath: repo.path })
  if (!resolution) {
    return { listed: false }
  }
  // A pointer naming a brain this machine has not cloned, or a binding whose
  // path is gone: the company is real, its brain is not readable from here.
  if (resolution.status !== 'ready') {
    return { listed: true, kind: 'unreadable', resolution }
  }
  try {
    const entries = await window.api.fs.readDir({ dirPath: resolution.location.root })
    return entries.length > 0 ? { listed: true, kind: 'ready', resolution } : { listed: false }
  } catch (error) {
    return isMissingDirectory(error)
      ? { listed: false }
      : { listed: true, kind: 'unreadable', resolution }
  }
}

async function readCompany(
  repo: Repo,
  sections: BrainSectionInfo[],
  seed: PortfolioCompany
): Promise<PortfolioCompany> {
  // `readOnly`: a dashboard summarising N businesses is not the moment to gate,
  // relink and rewrite the agent context of every one of them.
  const scan = await window.api.buildexBrain.scan({ repoPath: repo.path, readOnly: true })
  const catalog = await window.api.buildexStore
    .catalog({ repoPath: repo.path, readOnly: true })
    .catch(() => null)
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
  const [companies, setCompanies] = useState<PortfolioCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

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

      // Probes run together and each one is bounded, because the SSH case this
      // exists for is a host that never answers rather than one that refuses:
      // a blackholed connection hangs until TCP gives up. Rows are published as
      // each probe lands and the work behind them starts there too, so a dead
      // host costs its own row and never the screen.
      const seeded: (PortfolioCompany | null)[] = repos.map(() => null)
      const publish = (): void => setCompanies(seeded.filter((entry) => entry !== null))
      // Reads queue behind one another rather than fanning out: each one spawns
      // git, and a dashboard should not be the most expensive screen in the app.
      let reads: Promise<void> = Promise.resolve()

      await Promise.all(
        repos.map(async (repo, index) => {
          const probe = await withDeadline(
            probeCompany(repo).catch(() => unknownProbe(repo)),
            unknownProbe(repo),
            PROBE_DEADLINE_MS
          )
          if (cancelled || !probe.listed) {
            return
          }
          const base = {
            ...baseCompany(
              repo,
              mainWorkspaceFor(useAppStore.getState().worktreesByRepo[repo.id], repo.path)
            ),
            lastRun: latestRunForRepo(repo.id, automations, runs)
          }
          seeded[index] =
            probe.kind === 'ready'
              ? base
              : probe.kind === 'remote'
                ? { ...base, loaded: true, degraded: 'remote-host' }
                : {
                    ...base,
                    loaded: true,
                    degraded: 'unreadable',
                    placement: brainPlacement(probe.resolution)
                  }
          publish()

          reads = reads.then(async () => {
            const found = seeded[index]
            if (cancelled || !found) {
              return
            }
            // Why: a business the operator has not opened this session has no
            // workspaces hydrated, and without one there is nothing for a cell
            // to activate — the rows that most need a link are precisely the
            // ones that would lose it. Degraded rows included: "open it on its
            // host" is only advice if the row can be opened.
            const routed = found.worktreeId
              ? found
              : {
                  ...found,
                  worktreeId: await withDeadline(hydrateWorkspace(repo), null, PROBE_DEADLINE_MS)
                }
            if (cancelled) {
              return
            }
            seeded[index] = routed
            publish()
            if (probe.kind !== 'ready') {
              return
            }
            const filled = await withDeadline(
              readCompany(repo, sections, routed),
              { ...routed, loaded: true, degraded: 'unreadable' as const },
              COMPANY_DEADLINE_MS
            )
            if (cancelled) {
              return
            }
            seeded[index] = filled
            publish()
          })
        })
      )
      await reads
      if (cancelled) {
        return
      }
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [nonce, repos])

  return { companies, loading, refresh }
}
