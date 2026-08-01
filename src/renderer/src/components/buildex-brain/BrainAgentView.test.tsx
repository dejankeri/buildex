// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentView } from '../../../../shared/buildex-brain-types'
import BrainAgentView from './BrainAgentView'

// The dialog's value is that it is true. These cover the two ways it could stop
// being: claiming something about a file it never read, and putting a value on
// screen that belongs in a credential store.

const openPath = vi.fn()

function mountWith(view: AgentView): void {
  Object.assign(window, {
    api: {
      buildexBrain: { agentView: vi.fn().mockResolvedValue(view) },
      shell: { openPath }
    }
  })
  render(<BrainAgentView repoPath="/repo" open onOpenChange={vi.fn()} />)
}

function view(overrides: Partial<AgentView> = {}): AgentView {
  return {
    repoPath: '/repo',
    alwaysLoaded: [],
    reachable: [],
    loadedCharacters: 0,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  openPath.mockReset()
})

describe('BrainAgentView', () => {
  it('keeps loaded context apart from what the agent must go and open', async () => {
    mountWith(
      view({
        alwaysLoaded: [{ path: '.claude/CLAUDE.md', body: '# Rules\n', imports: [] }],
        reachable: [{ kind: 'document', name: 'strategy/pricing.md', detail: 'strategy' }],
        loadedCharacters: 8
      })
    )

    await waitFor(() => expect(screen.getByText('Loaded before you type')).toBeInTheDocument())
    expect(screen.getByText('Named, and opened only if needed')).toBeInTheDocument()
    expect(screen.getByText('.claude/CLAUDE.md')).toBeInTheDocument()
    expect(screen.getByText('strategy/pricing.md')).toBeInTheDocument()
  })

  it('reveals the file an import names, and never says what is in it', async () => {
    mountWith(
      view({
        alwaysLoaded: [
          {
            path: '.claude/CLAUDE.md',
            body: '@./company-context.md\n',
            imports: [
              {
                target: './company-context.md',
                absolutePath: '/repo/.claude/company-context.md'
              }
            ]
          }
        ]
      })
    )

    const link = await screen.findByRole('button', { name: '@./company-context.md' })
    await userEvent.click(link)

    expect(openPath).toHaveBeenCalledWith('/repo/.claude/company-context.md')
  })

  it('shows an import this machine cannot reveal as text, not as a dead link', async () => {
    mountWith(
      view({
        alwaysLoaded: [
          {
            path: '.claude/CLAUDE.md',
            body: '@~/.claude/personal.md\n',
            imports: [{ target: '~/.claude/personal.md' }]
          }
        ]
      })
    )

    // Twice on purpose: once in the verbatim body, once in the import list.
    const listed = await screen.findAllByText('@~/.claude/personal.md')
    expect(listed.some((node) => node.tagName === 'SPAN')).toBe(true)
    expect(screen.queryByRole('button', { name: '@~/.claude/personal.md' })).not.toBeInTheDocument()
  })

  it('renders a connected app as its name and host, the only fields it is given', async () => {
    // The payload is the whole of what this screen can draw, and it carries no
    // header, env value or argument — so there is nothing here left to mask.
    mountWith(
      view({
        reachable: [
          { kind: 'mcp', name: 'slack', detail: 'https://slack.example', path: '.mcp.json' }
        ]
      })
    )

    await waitFor(() => expect(screen.getByText('slack')).toBeInTheDocument())
    expect(screen.getByText('https://slack.example')).toBeInTheDocument()
  })
})
