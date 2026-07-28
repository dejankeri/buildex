import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getBuildExAttributionSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('buildex.about.builtOn.title', 'Built on Orca'),
    description: translate(
      'buildex.about.builtOn.description',
      'BuildEx is a fork of Orca by Stably, used under the MIT license.'
    ),
    keywords: [
      ...translateSearchKeyword('buildex.about.search.about', 'about'),
      ...translateSearchKeyword('buildex.about.search.version', 'version'),
      ...translateSearchKeyword('buildex.about.search.orca', 'orca'),
      ...translateSearchKeyword('buildex.about.search.license', 'license'),
      ...translateSearchKeyword('buildex.about.search.credit', 'credit')
    ]
  }
])
