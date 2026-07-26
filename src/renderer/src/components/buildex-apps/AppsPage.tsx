import React from 'react'
import { LayoutGrid } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'

// Apps: the company-facing surfaces an operator works in day to day, backed by
// installed skill packs. Rides the existing browser-pane webview stack rather
// than introducing new embedding plumbing. Phase 3 fills this in.
export default function AppsPage(): React.JSX.Element {
  useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <LayoutGrid size={16} className="text-muted-foreground" />
        <h1 className="text-[14px] font-semibold tracking-tight">
          {translate('buildex.apps.page.title', 'Apps')}
        </h1>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <LayoutGrid size={22} className="text-muted-foreground/40" />
        <p className="text-[13px] text-muted-foreground">
          {translate('buildex.apps.page.emptyTitle', 'No apps installed')}
        </p>
        <p className="max-w-sm text-[12px] text-muted-foreground/70">
          {translate('buildex.apps.page.emptyHint', 'Install a pack from the Store to add apps.')}
        </p>
      </div>
    </div>
  )
}
