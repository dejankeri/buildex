import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embeddedLocation, externalLocation } from './brain-location'
import { readBrainSaveDiff } from './brain-save-diff'

// Against a real git repo, not a mock: the whole risk here is what `git show`
// actually emits for a rename, a binary file and a root commit — a stubbed
// runner would only prove the parser agrees with itself.

let repo = ''

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo })
}

function write(relative: string, body: string): void {
  const absolute = path.join(repo, relative)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, body, 'utf8')
}

async function headHash(): Promise<string> {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-save-diff-'))
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('readBrainSaveDiff', () => {
  it('shows what the first commit in a brain added, though it has no parent', async () => {
    write('.buildex/decisions/log.md', '# Decision log\n\nfirst\n')
    git('add', '-A')
    git('commit', '-qm', 'root')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    expect(diff.unavailable).toBe(false)
    expect(diff.files).toHaveLength(1)
    expect(diff.files[0].path).toBe('decisions/log.md')
    expect(diff.files[0].status).toBe('added')
    expect(diff.files[0].lines.filter((line) => line.kind === 'add')).toHaveLength(3)
  })

  it('shows the diff of that save, not what the document says now', async () => {
    write('.buildex/decisions/log.md', '# Decision log\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    write('.buildex/decisions/log.md', '# Decision log\n\n## 2026-07-31 — overnight\n')
    git('commit', '-qam', 'agent run')
    const overnight = await headHash()
    write('.buildex/decisions/log.md', '# Decision log\n\n## 2026-08-01 — later\n')
    git('commit', '-qam', 'later')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), overnight)

    const added = diff.files[0].lines.filter((line) => line.kind === 'add').map((l) => l.text)
    expect(added).toContain('## 2026-07-31 — overnight')
    expect(added.join('\n')).not.toContain('2026-08-01')
  })

  it('names both sides of a rename', async () => {
    write('.buildex/rules/operating.md', '# Rules\n\n- one\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    renameSync(
      path.join(repo, '.buildex/rules/operating.md'),
      path.join(repo, '.buildex/rules/how-we-work.md')
    )
    git('add', '-A')
    git('commit', '-qm', 'renamed')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    expect(diff.files).toHaveLength(1)
    expect(diff.files[0].status).toBe('renamed')
    expect(diff.files[0].previousPath).toBe('rules/operating.md')
    expect(diff.files[0].path).toBe('rules/how-we-work.md')
    // A pure rename has no hunks, and inventing lines for it would be a lie.
    expect(diff.files[0].lines).toEqual([])
  })

  it('calls a binary file binary instead of rendering bytes as lines', async () => {
    mkdirSync(path.join(repo, '.buildex'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex/logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    git('add', '-A')
    git('commit', '-qm', 'logo')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    expect(diff.files[0].path).toBe('logo.png')
    expect(diff.files[0].binary).toBe(true)
    expect(diff.files[0].lines).toEqual([])
  })

  it('shows only the brain half of a commit that also touched code', async () => {
    write('.buildex/strategy/overview.md', '# Strategy\n')
    write('src/app.ts', 'export const a = 1\n')
    git('add', '-A')
    git('commit', '-qm', 'mixed')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    expect(diff.files.map((file) => file.path)).toEqual(['strategy/overview.md'])
  })

  it('reads an external brain, where every path is already brain-relative', async () => {
    write('decisions/log.md', '# Decision log\n')
    git('add', '-A')
    git('commit', '-qm', 'first')

    const diff = await readBrainSaveDiff(externalLocation(repo), await headHash())

    expect(diff.files[0].path).toBe('decisions/log.md')
  })

  it('reports a hash git does not know as unavailable rather than throwing', async () => {
    write('.buildex/note.md', '# Note\n')
    git('add', '-A')
    git('commit', '-qm', 'first')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), 'deadbeefdeadbeefdeadbeefdeadbeef')

    expect(diff.unavailable).toBe(true)
    expect(diff.files).toEqual([])
  })

  it('refuses anything that is not a hash, so no revision expression reaches git', async () => {
    write('.buildex/note.md', '# Note\n')
    git('add', '-A')
    git('commit', '-qm', 'first')

    expect((await readBrainSaveDiff(embeddedLocation(repo), 'HEAD')).unavailable).toBe(true)
    expect((await readBrainSaveDiff(embeddedLocation(repo), '--output=/tmp/x')).unavailable).toBe(
      true
    )
  })

  it('reads a merge that changed nothing here as an empty save, not a failure', async () => {
    write('.buildex/note.md', '# Note\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    const base = await headHash()
    git('checkout', '-q', '-b', 'side')
    write('.buildex/side.md', '# Side\n')
    git('add', '-A')
    git('commit', '-qm', 'side')
    git('checkout', '-q', base)
    git('checkout', '-q', '-B', 'main')
    write('.buildex/main.md', '# Main\n')
    git('add', '-A')
    git('commit', '-qm', 'main')
    git('merge', '--no-edit', '-q', 'side')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    expect(diff.unavailable).toBe(false)
    expect(diff.files).toEqual([])
  })

  it('bounds a long diff instead of handing the panel every line', async () => {
    write('.buildex/log.md', '# Log\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    write(
      '.buildex/log.md',
      `# Log\n${Array.from({ length: 900 }, (_, i) => `- ${i}`).join('\n')}\n`
    )
    git('commit', '-qam', 'a long night')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    expect(diff.files[0].truncated).toBe(true)
    expect(diff.files[0].lines.length).toBeLessThanOrEqual(300)
  })

  it('is not derailed by a signature line an operator asked git to print', async (ctx) => {
    // `log.showSignature` puts a verification line ahead of the diff — inside
    // the -z stream, where it fuses onto the first status letter and mislabels
    // the first file. Signing needs ssh-keygen and Git 2.34; where neither is
    // available there is nothing to assert.
    const key = path.join(repo, 'sign-key')
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
      git('config', 'gpg.format', 'ssh')
      git('config', 'user.signingkey', `${key}.pub`)
      git('config', 'commit.gpgsign', 'true')
      git('config', 'log.showSignature', 'true')
      write('.buildex/decisions/log.md', '# Log\n\nfirst\n')
      git('add', '-A')
      git('commit', '-qm', 'signed')
    } catch {
      ctx.skip()
      return
    }

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    expect(diff.files).toHaveLength(1)
    expect(diff.files[0].path).toBe('decisions/log.md')
    // 'changed' is what a signature line fused onto the status letter produces.
    expect(diff.files[0].status).toBe('added')
    expect(diff.files[0].lines.filter((line) => line.kind === 'add')).toHaveLength(3)
    expect(diff.linesUnavailable).toBe(false)
  })

  it('says so when git listed files it could not line the patch up with', async () => {
    write('.buildex/note.md', '# Note\n')
    git('add', '-A')
    git('commit', '-qm', 'first')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    // The healthy case: paths and lines line up, so nothing is claimed missing.
    expect(diff.linesUnavailable).toBe(false)
    expect(diff.files[0].lines.length).toBeGreaterThan(0)
  })

  it('strips the diff prefix so a document line reads as itself', async () => {
    write('.buildex/note.md', '# Note\n\ncontext\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    write('.buildex/note.md', '# Note\n\ncontext\nadded\n')
    git('commit', '-qam', 'second')

    const diff = await readBrainSaveDiff(embeddedLocation(repo), await headHash())

    expect(diff.files[0].lines).toContainEqual({ kind: 'add', text: 'added' })
    expect(diff.files[0].lines).toContainEqual({ kind: 'context', text: 'context' })
    // The header git puts above the first hunk must never read as a deletion.
    expect(diff.files[0].lines.some((line) => line.text.startsWith('a/'))).toBe(false)
  })
})
