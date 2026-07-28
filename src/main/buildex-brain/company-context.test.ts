import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainResolution, BrainScan } from '../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { renderCompanyContext, syncCompanyContext } from './company-context'
import { scanCompanyBrain } from './company-brain-service'
import { embeddedLocation } from './brain-location'

let repo = ''

// Brain documents live under `.buildex/`; the generated outputs do not, so they
// are written and read with explicit paths below.
function write(relativePath: string, contents: string): void {
  const absolute = path.join(repo, '.buildex', relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

function writeRaw(relativePath: string, contents: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

function read(relativePath: string): string {
  return readFileSync(path.join(repo, relativePath), 'utf8')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-context-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

async function scan(): Promise<BrainScan> {
  const location = embeddedLocation(repo)
  const resolution: BrainResolution = { status: 'ready', location }
  return scanCompanyBrain(repo, location, resolution, 1)
}

describe('renderCompanyContext', () => {
  it('is byte-identical for an unchanged brain', async () => {
    write('a.md', '[[b]]')
    write('b.md', '# B')

    const first = renderCompanyContext(await scan(), [], embeddedLocation(repo))
    const second = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(second).toBe(first)
  })

  it('lists documents by folder and ranks the most connected', async () => {
    write('hub.md', '[[a]] [[b]]')
    write('a.md', '[[hub]]')
    write('b.md', '# B')
    write('notes/side.md', '# Side')

    const rendered = renderCompanyContext(await scan(), [], embeddedLocation(repo))

    expect(rendered).toContain('**root** — a, b, hub')
    expect(rendered).toContain('**notes** — side')
    expect(rendered.indexOf('`hub.md`')).toBeLessThan(rendered.indexOf('`a.md`'))
  })
})

describe('syncCompanyContext', () => {
  it('writes the context file and adds the CLAUDE.md import', async () => {
    write('a.md', '# A')

    const result = syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(result.contextChanged).toBe(true)
    expect(result.claudeMdChanged).toBe(true)
    expect(read('.claude/company-context.md')).toContain('# Company context')
    expect(read('.claude/CLAUDE.md')).toContain('@./company-context.md')
  })

  it('writes nothing when re-run against the same scan', async () => {
    write('a.md', '# A')
    const snapshot = await scan()
    syncCompanyContext(repo, snapshot, [], embeddedLocation(repo))

    const second = syncCompanyContext(repo, snapshot, [], embeddedLocation(repo))

    expect(second.contextChanged).toBe(false)
    expect(second.claudeMdChanged).toBe(false)
  })

  it('is genuinely idempotent now that nothing it writes is a brain document', async () => {
    write('a.md', '# A')

    // Why: both outputs live under `.claude/`, which the scanner skips and git
    // ignores — so re-syncing writes nothing and shows up in no history.
    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))
    const second = syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(second.contextChanged).toBe(false)
    expect(second.claudeMdChanged).toBe(false)
  })

  it("preserves the operator's own project instructions", async () => {
    writeRaw('.claude/CLAUDE.md', '# House rules\n\nAlways ask before deploying.\n')
    write('a.md', '# A')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    const claudeMd = read('.claude/CLAUDE.md')
    expect(claudeMd).toContain('Always ask before deploying.')
    expect(claudeMd).toContain('@./company-context.md')
  })

  it('keeps the generated file out of the company history', async () => {
    // Why: this file is derived from `.buildex/` and regenerated constantly. In
    // the tracked brain folder it produced a diff every time anything changed.
    write('a.md', '# A')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(existsSync(path.join(repo, '.buildex', 'company-context.md'))).toBe(false)
    expect(existsSync(path.join(repo, '.claude', 'company-context.md'))).toBe(true)
  })

  it('clears out a tracked context file left by an older BuildEx', async () => {
    write('a.md', '# A')
    write('company-context.md', '# Company context\n\nStale, from the version that tracked it.\n')

    const result = syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(result.legacyRemoved).toBe(true)
    expect(existsSync(path.join(repo, '.buildex', 'company-context.md'))).toBe(false)
  })

  it('never deletes a company document that happens to share the name', async () => {
    // Why: invariant 8. Only a file carrying our generated header is ours to
    // remove; anything else the operator wrote stays exactly where it is.
    write('a.md', '# A')
    write('company-context.md', '# Our own notes on context\n')

    const result = syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    expect(result.legacyRemoved).toBe(false)
    expect(read('.buildex/company-context.md')).toContain('Our own notes')
  })

  it('repoints an import written by an older BuildEx', async () => {
    // Why: existing repos carry the old path between the markers. Left alone the
    // agent would follow it to a file that no longer exists.
    writeRaw(
      '.claude/CLAUDE.md',
      '<!-- buildex:company-context:begin -->\n@../.buildex/company-context.md\n<!-- buildex:company-context:end -->\n'
    )
    write('a.md', '# A')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    const claudeMd = read('.claude/CLAUDE.md')
    expect(claudeMd).toContain('@./company-context.md')
    expect(claudeMd).not.toContain('@../.buildex/company-context.md')
  })

  it('does not duplicate the import block across repeated syncs', async () => {
    writeRaw('.claude/CLAUDE.md', '# Rules\n')
    write('a.md', '# A')

    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))
    write('b.md', '# B')
    syncCompanyContext(repo, await scan(), [], embeddedLocation(repo))

    const occurrences = read('.claude/CLAUDE.md').split('@./company-context.md').length - 1
    expect(occurrences).toBe(1)
  })
})

describe('renderCompanyContext apps section', () => {
  const scan: BrainScan = { ...EMPTY_BRAIN_SCAN, repoPath: '/repo', scannedAt: 1 }
  const location = embeddedLocation('/repo')

  it('says nothing when no app is installed', () => {
    expect(renderCompanyContext(scan, [], location)).not.toContain('## Apps')
  })

  it('names the skills and tells the agent to read them first', () => {
    const rendered = renderCompanyContext(
      scan,
      [
        {
          id: 'slack',
          name: 'Slack',
          summary: 'Team chat.',
          skills: ['slack-search', 'slack-post'],
          hasMcp: true,
          envKey: 'BUILDEX_SLACK_API_KEY',
          connected: true
        }
      ],
      location
    )

    expect(rendered).toContain('## Apps (1)')
    expect(rendered).toContain('`slack-search`, `slack-post`')
    expect(rendered).toContain('read the skill before improvising')
    expect(rendered).toContain('prefer its tools over shell or HTTP calls')
  })

  it('flags an app whose key is missing rather than implying it works', () => {
    const rendered = renderCompanyContext(
      scan,
      [
        {
          id: 'stripe',
          name: 'Stripe',
          summary: '',
          skills: ['stripe-lookup'],
          hasMcp: true,
          envKey: 'BUILDEX_STRIPE_API_KEY',
          connected: false
        }
      ],
      location
    )

    expect(rendered).toContain('no key is stored on this machine yet')
  })

  it('tells the agent where the key comes from and never to write it down', () => {
    const rendered = renderCompanyContext(
      scan,
      [
        { id: 'a', name: 'A', summary: '', skills: ['a-skill'], hasMcp: false, envKey: 'A_API_KEY' }
      ],
      location
    )

    expect(rendered).toContain('`A_API_KEY` environment variable')
    expect(rendered).toContain('never write it into the repo')
  })
})

describe('renderCompanyContext brain location', () => {
  it('tells the agent where an external brain is, since ids alone resolve to nothing', () => {
    const scan = {
      ...EMPTY_BRAIN_SCAN,
      documents: [
        {
          id: 'decisions/pricing.md',
          name: 'pricing',
          folder: 'decisions',
          linksTo: [],
          linkedFrom: [],
          changed: false,
          headingCount: 1,
          wordCount: 3
        }
      ]
    }

    const rendered = renderCompanyContext(scan, [], {
      root: '/brains/acme',
      gitRoot: '/brains/acme',
      pathspec: '.',
      mode: 'external'
    })

    // Without this line the agent is told about `decisions/pricing.md` and, with
    // its cwd in the code repo, finds nothing there.
    expect(rendered).toContain('/brains/acme')
  })

  it('says nothing about paths when the brain is in the repo', () => {
    const rendered = renderCompanyContext(EMPTY_BRAIN_SCAN, [], {
      root: '/code/api/.buildex',
      gitRoot: '/code/api',
      pathspec: '.buildex',
      mode: 'embedded'
    })

    expect(rendered).toContain('`.buildex/`')
    expect(rendered).not.toContain('/code/api/.buildex')
  })
})
