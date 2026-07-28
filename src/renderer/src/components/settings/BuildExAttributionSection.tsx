import type React from 'react'
import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

const ORCA_GITHUB_URL = 'https://github.com/stablyai/orca'

type BuildExAttributionSectionProps = {
  hasPrecedingSections: boolean
}

/**
 * Replaces upstream's "Support Orca" star prompt.
 *
 * Why: that section starred stablyai/orca from BuildEx's own settings, which
 * asks the operator to support a different product than the one they launched.
 * The fork credit belongs here, but as attribution rather than a call to action.
 */
export function BuildExAttributionSection({
  hasPrecedingSections
}: BuildExAttributionSectionProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    void window.api.updater.getVersion().then((value) => {
      if (mountedRef.current) {
        setVersion(value)
      }
    })
  }, [mountedRef])

  return (
    <section>
      <div className="space-y-8">
        {hasPrecedingSections ? <Separator /> : null}
        <div className="space-y-4">
          <SettingsSubsectionHeader title={translate('buildex.about.title', 'About')} />
          <SearchableSetting
            title={translate('buildex.about.builtOn.title', 'Built on Orca')}
            description={translate(
              'buildex.about.builtOn.description',
              'BuildEx is a fork of Orca by Stably, used under the MIT license.'
            )}
            keywords={['about', 'version', 'orca', 'license', 'credit', 'upstream']}
            className="flex items-center justify-between gap-4 py-2"
          >
            <div className="min-w-0 space-y-0.5">
              <Label>
                {version === null
                  ? translate('buildex.about.builtOn.title', 'Built on Orca')
                  : translate('buildex.about.version', 'BuildEx {{version}} — built on Orca', {
                      version
                    })}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'buildex.about.builtOn.description',
                  'BuildEx is a fork of Orca by Stably, used under the MIT license.'
                )}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void window.api.shell.openUrl(ORCA_GITHUB_URL)}
              className="shrink-0 gap-1.5"
            >
              <ExternalLink className="size-3.5" />
              {translate('buildex.about.viewUpstream', 'View Orca')}
            </Button>
          </SearchableSetting>
        </div>
      </div>
    </section>
  )
}
