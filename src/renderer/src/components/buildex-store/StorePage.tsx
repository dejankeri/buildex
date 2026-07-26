import React from 'react'
import { Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'

// The app store: skill packs a company installs into its own repo. Installing a
// pack writes skills into the company repo, so git stays the record of what a
// company can do. Catalog + install land in Phase 3; this is the seam stub.
export default function StorePage(): React.JSX.Element {
  useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Store size={16} className="text-muted-foreground" />
        <h1 className="text-[14px] font-semibold tracking-tight">
          {translate('buildex.store.page.title', 'Store')}
        </h1>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Store size={22} className="text-muted-foreground/40" />
        <p className="text-[13px] text-muted-foreground">
          {translate('buildex.store.page.emptyTitle', 'No packs available yet')}
        </p>
        <p className="max-w-sm text-[12px] text-muted-foreground/70">
          {translate(
            'buildex.store.page.emptyHint',
            'Skill packs you install are written into your company repo.'
          )}
        </p>
      </div>
    </div>
  )
}
