import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request?: unknown) => unknown>(),
  prepareCompanyWorktreeForAutomationRun: vi.fn(async () => {})
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, request?: unknown) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

vi.mock('../buildex-worktree-init', () => ({
  prepareCompanyWorktreeForAutomationRun: mocks.prepareCompanyWorktreeForAutomationRun
}))

const { registerBuildExAutomationContextHandlers } = await import('./buildex-automation-context')

const store = { getRepo: vi.fn() } as unknown as Store

function invoke(request?: unknown): Promise<unknown> {
  registerBuildExAutomationContextHandlers(store)
  const handler = mocks.handlers.get('buildex-automation-context:prepareWorkspace')
  if (!handler) {
    throw new Error('handler was not registered')
  }
  return Promise.resolve(handler({}, request))
}

describe('buildex-automation-context:prepareWorkspace', () => {
  it('hands the renderer path to the same preparation the headless path calls', async () => {
    const request = { workspaceMode: 'existing', workspaceId: 'repo-1::/repos/acme' }

    await invoke(request)

    // The store goes with it: the host a workspace is on is main's to decide.
    expect(mocks.prepareCompanyWorktreeForAutomationRun).toHaveBeenCalledWith(request, store)
  })

  it('does nothing for a request that names no workspace', async () => {
    mocks.prepareCompanyWorktreeForAutomationRun.mockClear()

    await invoke(undefined)

    expect(mocks.prepareCompanyWorktreeForAutomationRun).not.toHaveBeenCalled()
  })
})
