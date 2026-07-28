import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { embeddedLocation, externalLocation } from '../buildex-brain/brain-location'
import { resolveReceiptPath } from './pack-state'

const REPO = path.join(path.sep, 'code', 'api')
const BRAIN = path.join(path.sep, 'brains', 'acme')

describe('resolveReceiptPath', () => {
  it('reads a pre-migration key as repo-relative while the brain is still embedded', () => {
    expect(
      resolveReceiptPath(REPO, embeddedLocation(REPO), '.buildex/skills/slack-search/SKILL.md')
    ).toBe(path.join(REPO, '.buildex', 'skills', 'slack-search', 'SKILL.md'))
  })

  it('follows a pre-migration key to the brain once the brain has moved', () => {
    // The failure this exists for: `<repo>/.buildex` holds only the pointer
    // after a migration, so resolving there names a file that is not on disk —
    // and uninstall reads a missing file as "already gone", drops the receipt,
    // and leaves the pack's files in the shared brain reporting installed.
    expect(
      resolveReceiptPath(REPO, externalLocation(BRAIN), '.buildex/skills/slack-search/SKILL.md')
    ).toBe(path.join(BRAIN, 'skills', 'slack-search', 'SKILL.md'))
  })

  it('keeps `.claude/` keys in the repo in both modes, where the agent reads them', () => {
    for (const location of [embeddedLocation(REPO), externalLocation(BRAIN)]) {
      expect(resolveReceiptPath(REPO, location, '.claude/skills/slack-search/SKILL.md')).toBe(
        path.join(REPO, '.claude', 'skills', 'slack-search', 'SKILL.md')
      )
    }
  })

  it('resolves a current-shape key against the brain root', () => {
    expect(resolveReceiptPath(REPO, externalLocation(BRAIN), 'skills/slack-search/SKILL.md')).toBe(
      path.join(BRAIN, 'skills', 'slack-search', 'SKILL.md')
    )
  })
})
