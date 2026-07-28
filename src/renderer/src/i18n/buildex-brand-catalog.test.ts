import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import { applyBuildExBrand, isBuildExAuthoredKey } from '../../../shared/buildex-brand'

// Why this snapshot exists: en.json is generated from upstream call sites, so
// upstream copy changes would otherwise land silently. Pinning every branded
// string turns ~400 potential merge conflicts into one reviewable diff during
// the weekly rebase. Regenerate deliberately, reading each change.
describe('branded catalog', () => {
  it('matches the recorded rebrand of every Orca string in en.json', () => {
    const branded: Record<string, string> = {}

    const walk = (node: unknown, path: string[]): void => {
      if (typeof node === 'string') {
        const key = path.join('.')
        // Mirror brandedTranslate: BuildEx-authored copy is never rewritten, so
        // our own "built on Orca" credit must not appear here as rebranded.
        if (/orca/i.test(node) && !isBuildExAuthoredKey(key)) {
          branded[key] = applyBuildExBrand(node)
        }
        return
      }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          walk(value, [...path, key])
        }
      }
    }

    walk(en, [])
    expect(branded).toMatchSnapshot()
  })
})
