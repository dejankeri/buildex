import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainResolution } from '../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { buildAgentView, findImports } from './agent-view'
import { scanCompanyBrain } from './company-brain-service'
import { embeddedLocation, externalLocation } from './brain-location'

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
  it('shows project instructions verbatim and does not follow their imports', () => {
    // Why: what an import resolves to is Claude Code's business. This view says
    // what the file says, and offers to open it — nothing about its contents.
    write('.claude/CLAUDE.md', '# House rules\n\n@./company-context.md\n')
    write('.claude/company-context.md', '# Company context\n\nOne document.\n')

    const view = buildAgentView(repo, EMPTY_BRAIN_SCAN)

    expect(view.alwaysLoaded.map((file) => file.path)).toEqual(['.claude/CLAUDE.md'])
    expect(view.alwaysLoaded[0].body).toBe('# House rules\n\n@./company-context.md\n')
    expect(view.alwaysLoaded[0].imports).toEqual([
      {
        target: './company-context.md',
        absolutePath: path.join(repo, '.claude', 'company-context.md')
      }
    ])
    expect(JSON.stringify(view)).not.toContain('One document.')
  })

  it('lists both memory files when the repo has both', () => {
    write('CLAUDE.md', '# Repo rules\n')
    write('.claude/CLAUDE.md', '# Agent rules\n')

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).alwaysLoaded.map((file) => file.path)).toEqual([
      'CLAUDE.md',
      '.claude/CLAUDE.md'
    ])
  })

  it('opens a nested import from the file that wrote the line', () => {
    write('.claude/CLAUDE.md', '@./context/inbox/today.md\n')
    write('.claude/context/inbox/today.md', '# Today\n')

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).alwaysLoaded[0].imports[0]).toEqual({
      target: './context/inbox/today.md',
      absolutePath: path.join(repo, '.claude', 'context', 'inbox', 'today.md')
    })
  })

  it('opens an import that walks back out of the folder it was written in', () => {
    write('.claude/CLAUDE.md', '@../docs/handbook.md\n')
    write('docs/handbook.md', '# Handbook\n')

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).alwaysLoaded[0].imports[0]).toEqual({
      target: '../docs/handbook.md',
      absolutePath: path.join(repo, 'docs', 'handbook.md')
    })
  })

  it('still lists an import it cannot open here, exactly as written', () => {
    // Why: the line is in the file whether or not this machine has the target.
    // Saying nothing would hide it; inventing a link would be worse.
    write('.claude/CLAUDE.md', '@~/.buildex-no-such-dir-9d1f/personal.md\n')

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).alwaysLoaded[0].imports).toEqual([
      { target: '~/.buildex-no-such-dir-9d1f/personal.md' }
    ])
  })

  it('does not offer to open something that is not a file', () => {
    // Why: on macOS an application is a directory, and a one-click launcher is
    // not what "open the import" should ever mean.
    write('.claude/CLAUDE.md', '@./Thing.app\n')
    mkdirSync(path.join(repo, '.claude', 'Thing.app'), { recursive: true })

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).alwaysLoaded[0].imports).toEqual([
      { target: './Thing.app' }
    ])
  })

  it('counts what is loaded before the operator types', () => {
    write('.claude/CLAUDE.md', '12345')

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).loadedCharacters).toBe(5)
  })

  it('cannot be made to recurse by two files that import each other', () => {
    write('.claude/CLAUDE.md', '@./a.md\n')
    write('.claude/a.md', '@./CLAUDE.md\n')

    expect(buildAgentView(repo, EMPTY_BRAIN_SCAN).alwaysLoaded).toHaveLength(1)
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

  it('lists a connected app by the host it reaches, never by its address', () => {
    write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          slack: { type: 'http', url: 'https://slack.example:8443/mcp/s/abc/mcp' }
        }
      })
    )

    const server = buildAgentView(repo, EMPTY_BRAIN_SCAN).reachable.find(
      (item) => item.kind === 'mcp'
    )
    expect(server?.name).toBe('slack')
    expect(server?.detail).toBe('https://slack.example:8443')
  })

  it('lists a local connected app by its program, not its install path', () => {
    // Why: an install path carries the operator's home directory into a dialog
    // people screenshot, and answers nothing the program name does not.
    write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: { notes: { command: '/Users/someone/.local/bin/notes-mcp' } }
      })
    )

    expect(
      buildAgentView(repo, EMPTY_BRAIN_SCAN).reachable.find((item) => item.kind === 'mcp')?.detail
    ).toBe('notes-mcp')
  })

  it('cannot put a secret on screen, wherever the operator put it', () => {
    // The whole point of the rewrite: `headers`, `env` and `args` are never read,
    // and a URL is cut to scheme and host — hosted MCP services put the key in
    // the path, the query or the userinfo. A value that never reaches the view
    // cannot be imperfectly masked. This must fail if anyone re-adds one.
    const token = 'sk-ant-api03-notarealkey'
    write(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          headerLeak: {
            url: 'https://a.example/mcp',
            headers: { Authorization: `Bearer ${token}` }
          },
          envLeak: { command: 'npx', args: ['--token', token], env: { API_KEY: token } },
          pathLeak: { url: `https://b.example/api/mcp/s/${token}/mcp?key=${token}` },
          userInfoLeak: { url: `https://operator:${token}@c.example/mcp` }
        }
      })
    )

    const view = buildAgentView(repo, EMPTY_BRAIN_SCAN)

    expect(JSON.stringify(view)).not.toContain(token)
    // Sorted by server name: envLeak, headerLeak, pathLeak, userInfoLeak.
    expect(view.reachable.filter((item) => item.kind === 'mcp').map((item) => item.detail)).toEqual(
      ['npx', 'https://a.example', 'https://b.example', 'https://c.example']
    )
  })
})

describe('buildAgentView with an external brain', () => {
  let brain = ''

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: brain })
  }

  beforeEach(() => {
    brain = mkdtempSync(path.join(tmpdir(), 'buildex-agent-view-brain-'))
    git('init', '--quiet')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
  })

  afterEach(() => {
    rmSync(brain, { recursive: true, force: true })
  })

  it('shows paths into the brain root, not into <repo>/.buildex/', async () => {
    mkdirSync(path.join(brain, 'decisions'), { recursive: true })
    writeFileSync(path.join(brain, 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')
    mkdirSync(path.join(brain, 'skills', 'my-skill'), { recursive: true })
    writeFileSync(
      path.join(brain, 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: Use when testing.\n---\n\n# My skill\n',
      'utf8'
    )
    // The agent only sees a skill through this link — same as a pack-installed one.
    mkdirSync(path.join(repo, '.claude', 'skills', 'my-skill'), { recursive: true })

    const location = externalLocation(brain)
    const resolution: BrainResolution = { status: 'ready', location }
    const scan = await scanCompanyBrain(repo, location, resolution, 1)

    const view = buildAgentView(repo, scan)

    expect(view.reachable).toContainEqual({
      kind: 'document',
      name: 'decisions/pricing.md',
      detail: 'decisions',
      path: path.join(brain, 'decisions', 'pricing.md')
    })
    expect(view.reachable).toContainEqual({
      kind: 'skill',
      name: 'my-skill',
      detail: 'Use when testing.',
      path: path.join(brain, 'skills', 'my-skill', 'SKILL.md')
    })
    for (const item of view.reachable) {
      if (item.path) {
        expect(item.path).not.toContain(path.join(repo, '.buildex'))
      }
    }
  })
})
