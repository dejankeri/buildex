import React from 'react'
import { Brain, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

// BuildEx's company surfaces in the worktree sidebar. Kept in its own file so
// the upstream SidebarNav takes a single-line addition — see BUILDEX-PATCHES.md.

function BuildExNavButton({
  active,
  onClick,
  icon: Icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Icon
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

export function BuildExNavEntries(): React.JSX.Element {
  // Why: this subtree renders under SidebarNav's memo boundary, so it needs its
  // own language subscription to re-render when the locale changes.
  useTranslation()
  const activeView = useAppStore((s) => s.activeView)
  const openBrainPage = useAppStore((s) => s.openBrainPage)
  const openStorePage = useAppStore((s) => s.openStorePage)

  // The company's two surfaces: what it knows, and what it can do.
  return (
    <>
      <BuildExNavButton
        active={activeView === 'brain'}
        onClick={openBrainPage}
        icon={Brain}
        label={translate('buildex.sidebar.nav.brain', 'Brain')}
      />
      <BuildExNavButton
        active={activeView === 'store'}
        onClick={openStorePage}
        icon={Store}
        label={translate('buildex.sidebar.nav.store', 'Store')}
      />
    </>
  )
}
