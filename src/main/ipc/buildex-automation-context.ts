import { ipcMain } from 'electron'
import type { AutomationWorkspaceContextRequest } from '../../shared/buildex-automation-context-types'
import { prepareCompanyWorktreeForAutomationRun } from '../buildex-worktree-init'
import type { Store } from '../persistence'

// The renderer-present dispatch path's way into the same preparation the headless
// one calls directly. Nothing about the work lives here: the deadline, the host
// rule and the no-throw discipline are all `buildex-worktree-init.ts`'s, so the
// two paths cannot diverge.

export function registerBuildExAutomationContextHandlers(store: Store): void {
  ipcMain.handle(
    'buildex-automation-context:prepareWorkspace',
    async (_event, request?: AutomationWorkspaceContextRequest): Promise<void> => {
      if (!request) {
        return
      }
      // The store, not the request, says which host the workspace is on.
      await prepareCompanyWorktreeForAutomationRun(request, store)
    }
  )
}
