import React from 'react'
import { Brain } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from './right-sidebar-titlebar-drag-regions'

// The company brain: a deterministic view of the company repo — map, history,
// and decisions rendered from files on disk with no model in the loop.
// This is the Phase 0.5 seam stub; the derived views land in Phase 2.
export default function BrainPanel(): React.JSX.Element {
  // Why: this panel renders outside the parent's translation subscription, so it
  // needs its own to re-render on language change.
  useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className={`flex h-[36px] shrink-0 items-center gap-2 border-b border-border px-3 ${RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME}`}
      >
        <Brain size={14} className="text-muted-foreground" />
        <span className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {translate('buildex.brain.panel.title', 'Company Brain')}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Brain size={20} className="text-muted-foreground/40" />
        <p className="text-[13px] text-muted-foreground">
          {translate('buildex.brain.panel.emptyTitle', 'No company repo connected')}
        </p>
        <p className="text-[12px] text-muted-foreground/70">
          {translate(
            'buildex.brain.panel.emptyHint',
            'Open a company repo to see its map, history, and decisions.'
          )}
        </p>
      </div>
    </div>
  )
}
