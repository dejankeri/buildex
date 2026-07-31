import React, { useState } from 'react'
import { Check, ExternalLink, KeyRound, Loader2, LogIn } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import type { StoreEntry } from '../../../../shared/buildex-store-types'
import { launchMcpConnect, resolveMcpConnectAgent } from './connect-plugin-via-mcp'

// Connecting a curated plugin, two ways, decided by its overlay rather than by
// us.
//
// Most MCP servers speak OAuth, and the agent runtime already runs that flow —
// browser login, token storage, refresh. For those, Connect opens a session and
// runs the agent's own `/mcp`; BuildEx never sees a token.
//
// A few servers take a static key instead (no OAuth to run). For those the
// operator pastes it, and it goes straight to main to be encrypted — never held
// in the renderer beyond the keystroke, never read back, never in the repo.
//
// The key belongs to the business it was pasted for, so every call names the
// workspace — read from the same selector the catalog is keyed on, so "Connected"
// and "Disconnect" can never mean two different companies.

export default function StoreConnectRow({
  entry,
  worktreeId,
  onChanged
}: {
  entry: StoreEntry
  worktreeId: string | null
  onChanged: () => void | Promise<void>
}): React.JSX.Element | null {
  const repoPath = useActiveWorktree()?.path ?? ''
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds } = useDetectedAgents(detectionTarget)
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const overlay = entry.overlay
  const apiKey = overlay?.apiKey
  const pluginName = entry.plugin.name

  // An uncurated plugin has no credential BuildEx provisions — it brought
  // whatever auth it ships with, and connecting it stays the agent's business.
  if (!overlay) {
    return null
  }

  // A curated plugin with no key face signs in through the agent's own OAuth
  // flow — but only if it ships a server to sign in to. Offering it for a
  // skills-only plugin would be a button that leads nowhere.
  if (!apiKey) {
    if (!overlay.mcp) {
      return null
    }
    const agent = resolveMcpConnectAgent(detectedIds ?? null, defaultAgent)
    if (!agent || !worktreeId) {
      return (
        <p className="text-[11px] text-muted-foreground/70">
          {translate('buildex.store.connect.mcpManual', 'Sign in with /mcp in a Claude session.')}
        </p>
      )
    }
    return (
      <button
        type="button"
        onClick={() => launchMcpConnect({ agent, worktreeId })}
        className="inline-flex h-6 items-center gap-1 self-start rounded-md border border-input px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50"
        title={translate(
          'buildex.store.connect.mcpHint',
          'Opens a session and runs /mcp, where the provider signs you in.'
        )}
      >
        <LogIn size={11} />
        {translate('buildex.store.connect.signIn', 'Sign in')}
      </button>
    )
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.buildexStore.saveCredential({
        pluginName,
        apiKey: value,
        repoPath
      })
      if (!result.ok) {
        setError(result.error ?? 'Could not save the key')
        return
      }
      // Why: an ok result can still carry a warning — a machine with no keychain
      // stored the key unencrypted, and the operator should be told.
      setError(result.error ?? null)
      setValue('')
      setOpen(false)
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.buildexStore.clearCredential({ pluginName, repoPath })
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (entry.credentialConnected && !open) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Check size={11} className="text-emerald-600 dark:text-emerald-500" />
        <span className="flex-1">{translate('buildex.store.connect.connected', 'Connected')}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void disconnect()}
          className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
        >
          {translate('buildex.store.connect.disconnect', 'Disconnect')}
        </button>
      </div>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-6 items-center gap-1 self-start rounded-md border border-input px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50"
      >
        <KeyRound size={11} />
        {translate('buildex.store.connect.connect', 'Connect')}
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        type="password"
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && value.trim()) {
            void save()
          }
          if (event.key === 'Escape') {
            setOpen(false)
          }
        }}
        placeholder={apiKey.hint ?? translate('buildex.store.connect.placeholder', 'Paste the key')}
        className="h-7 w-full rounded-md border border-input bg-background px-2 text-[12px] focus:border-ring focus:ring-[3px] focus:ring-ring/50 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => void save()}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground',
            'hover:opacity-90 disabled:opacity-50'
          )}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : null}
          {translate('buildex.store.connect.save', 'Save')}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-muted-foreground underline underline-offset-2"
        >
          {translate('buildex.store.connect.later', 'Later')}
        </button>
        {apiKey.docsUrl ? (
          <button
            type="button"
            onClick={() => void window.api.shell.openUrl(apiKey.docsUrl!)}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground underline underline-offset-2"
          >
            {translate('buildex.store.connect.where', 'Where do I find this?')}
            <ExternalLink size={10} />
          </button>
        ) : null}
      </div>
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}
