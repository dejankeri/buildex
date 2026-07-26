import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainScan } from '../../shared/buildex-brain-types'
import { renderCompanyContext, syncCompanyContext } from './company-context'
import { scanCompanyBrain } from './company-brain-service'

let repo = ''

function write(relativePath: string, contents: string): void {
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
  return scanCompanyBrain(repo, 1)
}

describe('renderCompanyContext', () => {
  it('is byte-identical for an unchanged brain', async () => {
    write('a.md', '[[b]]')
    write('b.md', '# B')

    const first = renderCompanyContext(await scan())
    const second = renderCompanyContext(await scan())

    expect(second).toBe(first)
  })

  it('lists documents by folder and ranks the most connected', async () => {
    write('hub.md', '[[a]] [[b]]')
    write('a.md', '[[hub]]')
    write('b.md', '# B')
    write('notes/side.md', '# Side')

    const rendered = renderCompanyContext(await scan())

    expect(rendered).toContain('**root** — a, b, hub')
    expect(rendered).toContain('**notes** — side')
    expect(rendered.indexOf('`hub.md`')).toBeLessThan(rendered.indexOf('`a.md`'))
  })
})

describe('syncCompanyContext', () => {
  it('writes the context file and adds the CLAUDE.md import', async () => {
    write('a.md', '# A')

    const result = syncCompanyContext(repo, await scan())

    expect(result.contextChanged).toBe(true)
    expect(result.claudeMdChanged).toBe(true)
    expect(read('.buildex/company-context.md')).toContain('# Company context')
    expect(read('CLAUDE.md')).toContain('@.buildex/company-context.md')
  })

  it('writes nothing when re-run against the same scan', async () => {
    write('a.md', '# A')
    const snapshot = await scan()
    syncCompanyContext(repo, snapshot)

    const second = syncCompanyContext(repo, snapshot)

    expect(second.contextChanged).toBe(false)
    expect(second.claudeMdChanged).toBe(false)
  })

  it('converges after creating CLAUDE.md, which is itself a brain document', async () => {
    write('a.md', '# A')

    // First sync creates CLAUDE.md, so the next scan legitimately sees one more
    // document and the context changes once more before settling.
    syncCompanyContext(repo, await scan())
    const second = syncCompanyContext(repo, await scan())
    const third = syncCompanyContext(repo, await scan())

    expect(second.contextChanged).toBe(true)
    expect(third.contextChanged).toBe(false)
    expect(third.claudeMdChanged).toBe(false)
  })

  it("preserves the operator's own CLAUDE.md content", async () => {
    write('CLAUDE.md', '# House rules\n\nAlways ask before deploying.\n')
    write('a.md', '# A')

    syncCompanyContext(repo, await scan())

    const claudeMd = read('CLAUDE.md')
    expect(claudeMd).toContain('Always ask before deploying.')
    expect(claudeMd).toContain('@.buildex/company-context.md')
  })

  it('does not duplicate the import block across repeated syncs', async () => {
    write('CLAUDE.md', '# Rules\n')
    write('a.md', '# A')

    syncCompanyContext(repo, await scan())
    write('b.md', '# B')
    syncCompanyContext(repo, await scan())

    const occurrences = read('CLAUDE.md').split('@.buildex/company-context.md').length - 1
    expect(occurrences).toBe(1)
  })
})
