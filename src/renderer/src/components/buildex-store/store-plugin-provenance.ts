import type { StorePluginSource } from '../../../../shared/buildex-store-types'

// Where an uncurated plugin's bytes come from is the only trust signal it
// carries, so the install warning shows it rather than describing it.

/** Repo and pin, in one line, or null when the marketplace hosts it itself. */
export function describePluginSource(source: StorePluginSource): string | null {
  if (!source.url) {
    return null
  }
  const location = source.path ? `${source.url} (${source.path})` : source.url
  return source.pin ? `${location} @ ${source.pin.slice(0, 12)}` : location
}

/** An `https://` source is openable; `git@`/`ssh://` spellings are not. */
export function pluginSourceWebUrl(source: StorePluginSource): string | null {
  if (!source.url?.startsWith('https://')) {
    return null
  }
  return source.url.replace(/\.git$/, '')
}
