// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render as renderBare, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortfolioCompany } from './portfolio-row'
import type { PortfolioState } from './use-portfolio'

// The three states an operator actually meets: nothing set up yet, one
// business, and a business whose brain BuildEx could not read. The last one is
// the point of the screen — a dashboard that blanks because one company's host
// is asleep is worse than no dashboard.

const portfolio = vi.fn<() => PortfolioState>()
vi.mock('./use-portfolio', () => ({ usePortfolio: () => portfolio() }))

const openBrainPage = vi.fn()
const openStorePage = vi.fn()
const openAutomationsPage = vi.fn()
const activate = vi.fn()
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openBrainPage, openStorePage, openAutomationsPage }) }
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: activate }))

const { default: PortfolioPage } = await import('./PortfolioPage')
const { TooltipProvider } = await import('@/components/ui/tooltip')

/** The provider lives at the App root, so a page rendered alone needs its own. */
function render(): ReturnType<typeof renderBare> {
  return renderBare(<PortfolioPage />, { wrapper: TooltipProvider })
}

function company(overrides: Partial<PortfolioCompany> = {}): PortfolioCompany {
  return {
    repoId: 'repo-1',
    name: 'Acme',
    badgeColor: '#888888',
    worktreeId: 'repo-1::/repos/acme',
    loaded: true,
    degraded: null,
    initialized: true,
    brain: { documentCount: 12, sectionsFilled: 6, sectionsTotal: 10 },
    unsavedCount: 3,
    lastRun: { at: Date.now() - 3_600_000, status: 'completed', automationName: 'Weekly' },
    rosterGaps: 2,
    placement: 'in-repo',
    ...overrides
  }
}

function state(companies: PortfolioCompany[], loading = false): PortfolioState {
  return { companies, loading, refresh: vi.fn() }
}

beforeEach(() => {
  portfolio.mockReset()
  openBrainPage.mockReset()
  openStorePage.mockReset()
  openAutomationsPage.mockReset()
  activate.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('PortfolioPage', () => {
  it('reads as intentional with no businesses rather than as a broken table', () => {
    portfolio.mockReturnValue(state([]))
    render()

    expect(screen.getByText('No businesses yet')).toBeInTheDocument()
    expect(screen.getByText(/set up its company brain/i)).toBeInTheDocument()
    expect(screen.queryByText('Business')).not.toBeInTheDocument()
  })

  it('shows one business with all five columns filled', () => {
    portfolio.mockReturnValue(state([company()]))
    render()

    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('12 docs · 6/10 sections')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('In repo')).toBeInTheDocument()
    expect(screen.getByText(/One business/)).toBeInTheDocument()
  })

  it('keeps a business whose brain could not be read, and says so in its row', () => {
    portfolio.mockReturnValue(
      state([
        company(),
        company({
          repoId: 'repo-2',
          name: 'Remote Co',
          degraded: 'remote-host',
          brain: null,
          unsavedCount: null,
          rosterGaps: null,
          placement: null
        })
      ])
    )
    render()

    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Remote Co')).toBeInTheDocument()
    expect(screen.getByText(/open this business to read its brain there/i)).toBeInTheDocument()
    // The healthy row is untouched by its neighbour's failure.
    expect(screen.getByText('12 docs · 6/10 sections')).toBeInTheDocument()
  })

  it('sends every cell into the per-repo surface it summarises', async () => {
    portfolio.mockReturnValue(state([company()]))
    render()

    await userEvent.click(screen.getByRole('button', { name: 'Acme automations' }))
    expect(activate).toHaveBeenCalledWith('repo-1::/repos/acme')
    expect(openAutomationsPage).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Acme apps' }))
    expect(openStorePage).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Acme brain' }))
    expect(openBrainPage).toHaveBeenCalledTimes(1)
  })
})
