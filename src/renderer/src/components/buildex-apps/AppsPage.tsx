import React from 'react'
import { ExternalLink, LayoutGrid, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { usePackCatalog } from '../buildex-store/use-pack-catalog'

// Apps: the installed capability packs that expose an external surface the
// operator works in. Derived from the same repo catalog the Store reads, so
// installing a pack in the Store makes its app appear here with no extra state.

export default function AppsPage(): React.JSX.Element {
  useTranslation()
  const { catalog, loading } = usePackCatalog()
  const apps = catalog.packs.filter((pack) => pack.installed && pack.app?.url)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <LayoutGrid size={16} className="text-muted-foreground" />
        <h1 className="flex-1 text-[14px] font-semibold tracking-tight">
          {translate('buildex.apps.page.title', 'Apps')}
        </h1>
        {loading ? <Loader2 size={13} className="animate-spin text-muted-foreground" /> : null}
      </div>

      {apps.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <LayoutGrid size={22} className="text-muted-foreground/40" />
          <p className="text-[13px] text-muted-foreground">
            {translate('buildex.apps.page.emptyTitle', 'No apps installed')}
          </p>
          <p className="max-w-sm text-[12px] text-muted-foreground/70">
            {translate('buildex.apps.page.emptyHint', 'Install a pack from the Store to add apps.')}
          </p>
        </div>
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {apps.map((pack) => (
              <button
                key={pack.id}
                type="button"
                onClick={() => void window.api.shell.openUrl(pack.app!.url)}
                className="flex items-center gap-2 rounded-xl border border-border bg-card p-3 text-left shadow-xs transition-colors hover:bg-accent"
              >
                <span className="text-[18px] leading-none">{pack.icon}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{pack.name}</span>
                <ExternalLink size={12} className="shrink-0 text-muted-foreground/50" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
