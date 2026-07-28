import React from 'react'
import { translate } from '@/i18n/i18n'

// What the Store says about the workspace before it says anything about a
// plugin. Each line is a fact the operator would otherwise learn from a failed
// install or a diff in a repo they never opened.

function Notice({
  children,
  tone = 'muted'
}: {
  children: React.ReactNode
  tone?: 'muted' | 'destructive'
}): React.JSX.Element {
  return (
    <div
      className={`shrink-0 border-b border-border px-4 py-2 text-[12px] ${
        tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
      }`}
    >
      {children}
    </div>
  )
}

export default function StoreNotices({
  error,
  notice,
  repoPath,
  sharedBrain,
  unsupportedAgent
}: {
  error: string | null
  notice: string | null
  repoPath: string | null
  sharedBrain: boolean
  unsupportedAgent: string | null
}): React.JSX.Element | null {
  return (
    <>
      {error ? <Notice tone="destructive">{error}</Notice> : null}
      {notice ? <Notice>{notice}</Notice> : null}

      {/* Why: browsing still works without a project, but nothing installs — the
          agent installs into a workspace, not into the app. */}
      {!repoPath ? (
        <Notice>
          {translate(
            'buildex.store.page.noWorkspace',
            'Open a project to install apps — your agent installs them for that workspace.'
          )}
        </Notice>
      ) : null}

      {repoPath && unsupportedAgent ? (
        <Notice>
          {translate(
            'buildex.store.page.unsupportedAgent',
            'This workspace runs {{value0}}. You can browse here, but BuildEx cannot drive its plugin system, so installing is off.',
            { value0: unsupportedAgent }
          )}
        </Notice>
      ) : null}

      {repoPath && sharedBrain ? (
        <Notice>
          {translate(
            'buildex.store.page.sharedBrainReach',
            'This company shares one brain, so the context and keys an app contributes reach every repo that uses it.'
          )}
        </Notice>
      ) : null}
    </>
  )
}
