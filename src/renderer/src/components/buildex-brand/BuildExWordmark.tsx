import type React from 'react'
import { translate } from '@/i18n/i18n'

/**
 * The launch-screen lockup. The fork credit sits here rather than only in
 * Settings so the most-seen surface states what BuildEx is built on.
 */
export function BuildExWordmark(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1">
      <h1 className="text-4xl font-bold text-foreground tracking-tight">
        {translate('buildex.wordmark.name', 'BUILDEX')}
      </h1>
      <p className="text-xs text-muted-foreground">
        {translate('buildex.wordmark.builtOn', 'built on Orca')}
      </p>
    </div>
  )
}
