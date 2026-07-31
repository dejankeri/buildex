import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAutomationWorkspaceContext } from './buildex-automation-workspace-context'

const prepareWorkspace = vi.fn()

describe('prepareAutomationWorkspaceContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prepareWorkspace.mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { buildexAutomationContext: { prepareWorkspace } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks main to prepare the workspace the run is about to start in', async () => {
    await prepareAutomationWorkspaceContext({ workspaceMode: 'existing' }, 'repo-1::/repos/acme')

    expect(prepareWorkspace).toHaveBeenCalledWith({
      workspaceMode: 'existing',
      workspaceId: 'repo-1::/repos/acme'
    })
  })

  it('lets the run proceed when the refresh fails outright', async () => {
    // A run that did not happen is worse than a run with stale context.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    prepareWorkspace.mockRejectedValue(new Error('brain unreadable'))

    await expect(
      prepareAutomationWorkspaceContext({ workspaceMode: 'existing' }, 'repo-1::/repos/acme')
    ).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
