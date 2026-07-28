import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installClaudePlugin,
  readInstalledPlugins,
  uninstallClaudePlugin,
  type PluginCommandResult
} from './claude-plugin-install'

const homes: string[] = []

function home(installed?: unknown): string {
  const created = mkdtempSync(path.join(tmpdir(), 'buildex-claude-home-'))
  homes.push(created)
  if (installed !== undefined) {
    const dir = path.join(created, '.claude', 'plugins')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify(installed))
  }
  return created
}

/** Records what was run, and answers from a queue of scripted results. */
function runner(results: PluginCommandResult[]): {
  run: (args: string[]) => PluginCommandResult
  calls: string[][]
} {
  const calls: string[][] = []
  const queue = [...results]
  return {
    calls,
    run: (args) => {
      calls.push(args)
      return queue.shift() ?? { ok: true, output: '' }
    }
  }
}

afterEach(() => {
  for (const created of homes.splice(0)) {
    rmSync(created, { recursive: true, force: true })
  }
})

describe('readInstalledPlugins', () => {
  it('reads the agent’s own record, keyed plugin@marketplace', () => {
    const homeDir = home({
      version: 2,
      plugins: {
        'stripe@claude-plugins-official': [{ scope: 'user', installPath: '/x' }],
        'protocol-crm@protocol': [{ scope: 'user', installPath: '/y' }]
      }
    })

    expect([...readInstalledPlugins(homeDir)].sort()).toEqual([
      'protocol-crm@protocol',
      'stripe@claude-plugins-official'
    ])
  })

  it('does not count a key left behind with no installs under it', () => {
    const homeDir = home({ version: 2, plugins: { 'removed@official': [] } })

    expect(readInstalledPlugins(homeDir).size).toBe(0)
  })

  it('reports nothing installed rather than failing on a machine with no plugins', () => {
    expect(readInstalledPlugins(home()).size).toBe(0)
    expect(readInstalledPlugins(home('not an object')).size).toBe(0)
  })
})

describe('installClaudePlugin', () => {
  const target = {
    pluginName: 'protocol-crm',
    marketplaceId: 'protocol',
    marketplaceRepo: 'dejankeri/protocol-claude-plugin'
  }

  it('adds the marketplace, then installs into the operator’s own scope', () => {
    const { run, calls } = runner([
      { ok: true, output: '' },
      { ok: true, output: 'installed' }
    ])

    expect(installClaudePlugin({ homeDir: '/home', run }, target).ok).toBe(true)
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', 'dejankeri/protocol-claude-plugin'],
      // Scope is user: a plugin is installed by the person who wants it, not
      // imposed on everyone who clones the repo.
      ['plugin', 'install', 'protocol-crm@protocol', '--scope', 'user']
    ])
  })

  it('treats an already-configured marketplace as configured', () => {
    // Why: the CLI fails on a second `marketplace add`, which is every install
    // after the first. Reporting that as a failure breaks the common case.
    const { run, calls } = runner([
      { ok: false, output: 'Error: marketplace "protocol" already exists' },
      { ok: true, output: 'installed' }
    ])

    expect(installClaudePlugin({ homeDir: '/home', run }, target).ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('does not attempt the install when the marketplace could not be added', () => {
    const { run, calls } = runner([{ ok: false, output: 'network unreachable' }])

    const result = installClaudePlugin({ homeDir: '/home', run }, target)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('dejankeri/protocol-claude-plugin')
    // The CLI's own words are kept — "network unreachable" is the useful part.
    expect(result.output).toContain('network unreachable')
    expect(calls).toHaveLength(1)
  })

  it('reports a failed install with what the CLI said', () => {
    const { run } = runner([
      { ok: true, output: '' },
      { ok: false, output: 'plugin not found in marketplace' }
    ])

    const result = installClaudePlugin({ homeDir: '/home', run }, target)

    expect(result.ok).toBe(false)
    expect(result.output).toBe('plugin not found in marketplace')
  })
})

describe('uninstallClaudePlugin', () => {
  it('removes by the same plugin@marketplace id it installed by', () => {
    const { run, calls } = runner([{ ok: true, output: 'removed' }])

    expect(
      uninstallClaudePlugin(
        { homeDir: '/home', run },
        { pluginName: 'stripe', marketplaceId: 'buildex-packs' }
      ).ok
    ).toBe(true)
    expect(calls).toEqual([['plugin', 'uninstall', 'stripe@buildex-packs']])
  })

  it('reports a failure rather than reading as removed', () => {
    const { run } = runner([{ ok: false, output: 'not installed' }])

    const result = uninstallClaudePlugin(
      { homeDir: '/home', run },
      { pluginName: 'stripe', marketplaceId: 'buildex-packs' }
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('stripe')
  })
})
