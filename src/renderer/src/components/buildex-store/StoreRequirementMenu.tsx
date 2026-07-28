import React from 'react'
import { MoreHorizontal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { StoreEntry, StoreRequirement } from '../../../../shared/buildex-store-types'
import { storeEntryDisplayName } from './store-entry-search'

// Putting an app on the company's list.
//
// Three mutually exclusive states, so it is a radio group rather than three
// commands — the menu shows what the app is now, not only what it could become.

const NOT_EXPECTED = 'none'

export default function StoreRequirementMenu({
  entry,
  disabled,
  onSet
}: {
  entry: StoreEntry
  disabled: boolean
  onSet: (entry: StoreEntry, requirement: StoreRequirement | null) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={translate(
            'buildex.store.roster.menuLabel',
            'Company app list options for {{value0}}',
            { value0: storeEntryDisplayName(entry) }
          )}
          className="-mt-0.5 -mr-1 shrink-0 text-muted-foreground"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          {translate('buildex.store.roster.menuTitle', 'Company app list')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={entry.requirement ?? NOT_EXPECTED}
          onValueChange={(next) =>
            onSet(entry, next === NOT_EXPECTED ? null : (next as StoreRequirement))
          }
        >
          <DropdownMenuRadioItem value="required">
            {translate('buildex.store.roster.setRequired', 'Required')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="suggested">
            {translate('buildex.store.roster.setSuggested', 'Suggested')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value={NOT_EXPECTED}>
            {translate('buildex.store.roster.setNone', 'Not expected')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
