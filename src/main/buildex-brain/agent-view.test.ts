import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainResolution } from '../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { buildAgentView, findImports } from './agent-view'
import { describeSecret } from './agent-view-mcp'
import { scanCompanyBrain } from './company-brain-service'
import { embeddedLocation } from './brain-location'

let repo = ''

function runScan(now: number) {
  const location = embeddedLocation(repo)
  const resolution: BrainResolution = { status: 'ready', location }
  return scanCompanyBrain(repo, location, resolution, now)
}

function write(relativePath: string, contents: string): void {
  const absolute = path.join(repo, ...relativePath.split('/'))
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-agent-view-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('findImports', () => {
  it('finds an import on its own line', () => {
    expect(findImports('# Rules\n\n@./company-context.md\n')).toEqual(['./company-context.md'])
  })

  it('ignores one quoted inside a code fence', () => {
    // Why: a document explaining how imports work is not importing anything.
    const body = '# How to\n\n```\n@./example.md\n```\n'
    expect(findImports(body)).toEqual([])
  })

  it('ignores an address in the middle of a sentence', () => {
    expect(findImports('Ask sam@example.com about it.\n')).toEqual([])
  })
})

describe('buildAgentView', () => {
  it('reads project instructions and follows their imports', async () => {
    write('.claude/CLAUDE.md', '# House rules\n\n@./company-context.md\n')
    write('.claude/company-context.md', '# Company context\n\nOne document.\n')

    const view = buildAgentView(repo, EMPTY_BRAIN_SCAN)

    expect(view.alwaysLoaded.map((file) => file.path)).toEqual([
      '.claude/CLAUDE.md',
      '.claude/company-context.md'
    ])
    expect(view.alwaysLoaded[1].imported).toBe(true)
    expect(view.alwaysLoaded[1].body).toContain('One document.')
  })

  it('counts what is loaded before the operator types', () => {
    write('.claude/CLAUDE.md', '12345')

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).loadedCharacters).toBe(5)
  })

  it('does not read a file imported from outside the repo', () => {
    // Why: the agent really does load it, so saying nothing would be a lie — but
    // reading somebody's home directory to display it here is not our business.
    write('.claude/CLAUDE.md', '@~/.claude/personal.md\n')

    const outside = buildAgentView(repo, EMPTY_BRAIN_SCAN).alwaysLoaded.at(-1)
    expect(outside?.body).toBe('')
    expect(outside?.reason).toContain('outside this repo')
  })

  it('survives two files that import each other', () => {
    write('.claude/CLAUDE.md', '@./a.md\n')
    write('.claude/a.md', '@./CLAUDE.md\n')

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).alwaysLoaded).toHaveLength(2)
  })

  it('separates documents the agent must open from context it already has', async () => {
    write('.buildex/strategy/overview.md', '# Strategy\n')
    write('.claude/CLAUDE.md', '# Rules\n')

    const view = buildAgentView(repo, await runScan(1))

    expect(view.alwaysLoaded.map((file) => file.path)).toEqual(['.claude/CLAUDE.md'])
    expect(view.reachable).toContainEqual({
      kind: 'document',
      name: 'strategy/overview.md',
      detail: 'strategy',
      path: '.buildex/strategy/overview.md'
    })
  })

  it('lists a connected app by where its key comes from, never its value', () => {
    write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          slack: {
            type: 'http',
            url: 'https://slack.example/mcp',
            headers: { Authorization: 'Bearer ${BUILDEX_SLACK_API_KEY}' }
          }
        }
      })
    )

    const server = buildAgentView(repo, EMPTY_BRAIN_SCAN).reachable.find(
      (item) => item.kind === 'mcp'
    )
    expect(server?.detail).toBe('https://slack.example/mcp · key from $BUILDEX_SLACK_API_KEY')
  })
})

describe('describeSecret', () => {
  it('names the variable a key comes from', () => {
    expect(describeSecret('${BUILDEX_SLACK_API_KEY}')).toBe('$BUILDEX_SLACK_API_KEY')
  })

  it('keeps the scheme word in front of a reference readable', () => {
    expect(describeSecret('Bearer ${TOKEN}')).toBe('$TOKEN')
  })

  it('masks a token somebody pasted in by hand', () => {
    // Why: BuildEx never writes a literal here, but `.mcp.json` is the
    // operator's file too, and this dialog is the kind of thing people
    // screenshot.
    expect(describeSecret('Bearer sk-ant-api03-notarealkey')).toBe('••••')
  })

  it('masks a literal hiding behind a reference', () => {
    expect(describeSecret('${PREFIX}sk-ant-api03-notarealkey')).toBe('••••')
  })
})
