import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { DEMO_PORTFOLIO_BUSINESSES } from './demo-portfolio-business-brains'

// Standing up the businesses the Portfolio needs. Their prose lives in
// demo-portfolio-business-brains.ts.
//
// The Portfolio is the only BuildEx surface that needs more than one company to
// mean anything, so it is the only one with a fixture this size. Every business
// here is set up through the product's own IPC — `repos.add`, `buildexBrain
// .setUp`, `buildexBrain.bind` — and then written to on disk, which is what an
// operator does too. Nothing is injected into the renderer's store.

/** A throwaway git repo whose directory name is the business's name. */
function createRepo(slug: string): string {
  // Real path, not the one mkdtemp hands back: on macOS that is /var/... while
  // the app resolves the same directory to /private/var/.... A brain binding
  // filed under one spelling is not found under the other, and the business
  // silently drops off the Portfolio.
  const parent = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'buildex-demo-company-')))
  const repoPath = path.join(parent, slug)
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.email', 'demo@buildex.invalid'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.name', 'BuildEx Demo'], { cwd: repoPath })
  writeFileSync(path.join(repoPath, 'README.md'), `# ${slug}\n`, 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: repoPath })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath })
  return repoPath
}

function writeDocs(brainRoot: string, docs: Record<string, string>): void {
  for (const [relative, body] of Object.entries(docs)) {
    const full = path.join(brainRoot, relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
}

function commitAll(gitRoot: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: gitRoot })
  execFileSync('git', ['commit', '-m', message], { cwd: gitRoot })
}

/**
 * Stand up the two other businesses and leave them in the app.
 *
 * Call this before the Portfolio is opened: the page probes the repos it can
 * see when it mounts.
 *
 * Returns their repo paths so a caller can clean them up; the harness's temp
 * directory is outside the repo it manages, so nothing here is deleted for us.
 */
export async function stageDemoPortfolio(page: Page): Promise<string[]> {
  const created: string[] = []

  // Every git write happens before `repos.add`. The moment a repo is a project
  // the app polls git in it, and a poll holding index.lock fails the commit —
  // there is no lock to take here, only an order that never contends for one.
  for (const business of DEMO_PORTFOLIO_BUSINESSES) {
    const repoPath = createRepo(business.slug)
    created.push(repoPath)

    if (business.separateBrainRepo) {
      // A brain repo of its own: a real placement the product supports, and the
      // only way the "Brain repo" column shows anything but one value.
      const brainPath = createRepo(`${business.slug}-brain`)
      created.push(brainPath)
      writeDocs(brainPath, business.saved)
      commitAll(brainPath, `${business.slug} company brain`)

      await page.evaluate(async (target) => {
        const result = await window.api.repos.add({ path: target })
        if ('error' in result) {
          throw new Error(result.error)
        }
      }, repoPath)
      await page.evaluate(
        async ({ repo, brain }) => {
          const result = await window.api.buildexBrain.bind({
            repoPath: repo,
            brainPath: brain,
            writePointer: false
          })
          if (!result.ok) {
            throw new Error(result.error ?? 'bind failed')
          }
        },
        { repo: repoPath, brain: brainPath }
      )
      continue
    }

    // setUp is a main-process call against a path; the repo does not have to be
    // a project yet, which is what lets the whole brain be built before the app
    // starts watching the directory.
    await page.evaluate(
      async ({ repo, folders, summary }) => {
        const result = await window.api.buildexBrain.setUp({
          repoPath: repo,
          folders,
          summary
        })
        if (!result.ok) {
          throw new Error(result.error ?? 'brain setup failed')
        }
      },
      { repo: repoPath, folders: business.folders, summary: business.summary }
    )

    writeDocs(path.join(repoPath, '.buildex'), business.saved)
    commitAll(repoPath, `${business.slug} company brain`)
    if (business.unsaved) {
      writeDocs(path.join(repoPath, '.buildex'), business.unsaved)
    }

    await page.evaluate(async (target) => {
      const result = await window.api.repos.add({ path: target })
      if ('error' in result) {
        throw new Error(result.error)
      }
    }, repoPath)
  }

  return created
}
