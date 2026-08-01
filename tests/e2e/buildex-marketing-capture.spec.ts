import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  applyDarkTheme,
  hideScaffoldWorktreeRow,
  hideTransientChrome,
  NORTHWIND_LAST_SAVE,
  NORTHWIND_SAVE_TO_OPEN,
  relabelDemoRepo,
  resizeDemoWindow,
  showWorkspace,
  stageDemoConsole,
  writeNorthwindBrain
} from './helpers/northwind-studio-demo'
import { stageDemoPortfolio } from './helpers/demo-portfolio-companies'

// Marketing screenshot capture. NOT a test — it asserts only enough to know the
// surface actually rendered before the shutter fires. Run it explicitly:
//
//   BUILDEX_CAPTURE=1 npx playwright test tests/e2e/buildex-marketing-capture.spec.ts \
//     --config tests/playwright.config.ts --project electron-headless --workers=1
//
// Output: .buildex-marketing/*.png (gitignored), copied into the website repo.
// It runs inside the e2e harness on purpose: that harness overrides HOME, so the
// app never touches the real ~/.claude or ~/.orca while posing for pictures.
//
// The company it stages lives in helpers/northwind-studio-demo.ts, shared with
// buildex-demo-live.spec.ts so the live demo and the pictures cannot drift. The
// two other businesses the Portfolio needs live in demo-portfolio-companies.ts.
//
// Order is deliberate: the Brain must be photographed empty before it can be
// photographed full, and the console goes last so its sidebar shows all three
// businesses rather than the one the harness opened with.

test.describe.configure({ mode: 'serial' })

// Why NOT seedMarketplaceIndexes here: the seed is a 9-plugin fixture standing in
// for a real index of ~276. Deterministic is right for tests and a lie for a
// marketing page — the first capture shipped the fixture's shelf as the product.
// This lets the Store fetch the real indexes, so it needs network.
test.use({ seedMarketplaceIndexes: false })

// Why skipped by default: this is a tool, not a test. It proves nothing about the
// product and only costs CI a minute. Set BUILDEX_CAPTURE=1 to run it.
test.skip(
  !process.env.BUILDEX_CAPTURE,
  'marketing capture — set BUILDEX_CAPTURE=1 to regenerate the screenshots'
)

const SHOT_DIR = path.resolve(__dirname, '..', '..', '.buildex-marketing')

function shotPath(name: string): string {
  mkdirSync(SHOT_DIR, { recursive: true })
  return path.join(SHOT_DIR, name)
}

// Why clipped to the main panel: the e2e harness names its repo
// "orca-e2e-repo-<random>" in the sidebar, which reads as test scaffolding on a
// marketing page. The panel is the product surface anyway.
// 1163x727 is 16:10, matching the .shot aspect-ratio on the site, so the frame
// is not letterboxed when it lands in the rotator.
const PANEL_CLIP = { x: 277, y: 0, width: 1163, height: 727 }

test('capture the Brain, the Store and the Portfolio', async ({
  orcaPage,
  electronApp,
  testRepoPath
}) => {
  test.setTimeout(180_000)
  await resizeDemoWindow(electronApp)
  // The site is a dark instrument panel; a light screenshot on it looks like a
  // photo of a different product.
  await applyDarkTheme(orcaPage)

  const stagedRepos: string[] = []

  try {
    // The console is staged first and photographed last. Staging is what
    // activates the primary workspace, and until something has, "Create the
    // brain" scaffolds into whichever workspace the harness left active — the
    // secondary worktree — while writeNorthwindBrain writes to the primary. The
    // Brain page then shows a scaffold with nothing in it.
    await stageDemoConsole(orcaPage)

    // ── Brain, before there is one ─────────────────────────────────────────
    await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Set up your company brain' })).toBeVisible()
    // Filled in before the shutter: an empty field photographs as a form nobody
    // has decided anything in, and the decision is what this frame is about.
    await orcaPage
      .getByRole('textbox', { name: 'What does this company do?' })
      .fill('We are a six-person product design studio for mid-market SaaS teams.')
    await hideTransientChrome(orcaPage)
    await orcaPage.screenshot({ path: shotPath('demo-brain-setup.png'), clip: PANEL_CLIP })

    // ── Brain, filled with a company worth looking at ──────────────────────
    await orcaPage.getByRole('button', { name: 'Create the brain' }).click()
    await expect(orcaPage.getByText('documents', { exact: true })).toBeVisible()

    writeNorthwindBrain(testRepoPath)

    // Rescan, not a wait. These documents were written to disk from outside the
    // app, and the page keeps showing the scan it ran when the brain was created
    // — 2.5s of waiting photographed a seven-document scaffold with everything
    // unsaved while the repo on disk was a committed thirteen.
    await orcaPage.getByRole('button', { name: 'Rescan', exact: true }).click()
    await expect(orcaPage.getByText(NORTHWIND_LAST_SAVE, { exact: false }).first()).toBeVisible({
      timeout: 30_000
    })
    await orcaPage.waitForTimeout(1000)
    await hideTransientChrome(orcaPage)
    await orcaPage.screenshot({ path: shotPath('demo-brain.png'), clip: PANEL_CLIP })

    // ── Brain history: the claim that every save is a commit, shown ─────────
    await orcaPage.getByRole('button', { name: 'History', exact: true }).click()
    // Opened, not just listed: a closed list of subjects is a git log, and the
    // diff underneath is the part that says a save can be walked back.
    await orcaPage.getByRole('button', { name: NORTHWIND_SAVE_TO_OPEN }).click()
    await orcaPage.waitForTimeout(2500)
    await hideTransientChrome(orcaPage)
    await orcaPage.screenshot({ path: shotPath('demo-brain-history.png'), clip: PANEL_CLIP })

    // ── Store ──────────────────────────────────────────────────────────────
    await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()
    // Let the "Workspace board moved to the bottom bar" toast expire before the
    // shutter — it is a one-time hint, not part of the product.
    await orcaPage.waitForTimeout(1500)
    await hideTransientChrome(orcaPage)
    await orcaPage.screenshot({ path: shotPath('demo-store.png'), clip: PANEL_CLIP })

    // ── Portfolio: the surface that needs more than one business to exist ───
    // Staged before the page is opened: it probes the repos it can see when it
    // mounts, and a business added afterwards does not join the table.
    stagedRepos.push(...(await stageDemoPortfolio(orcaPage)))
    await orcaPage.getByRole('button', { name: 'Portfolio', exact: true }).click()
    // The count, not a name: every business is also a sidebar entry, so matching
    // on the name passes while the table is still missing a row.
    await expect(orcaPage.getByText('6 businesses.', { exact: false })).toBeVisible({
      timeout: 30_000
    })
    // Every row has to have finished probing; a spinner in the frame is a frame
    // that says the product is slow.
    await orcaPage.waitForTimeout(4000)
    await relabelDemoRepo(orcaPage, path.basename(testRepoPath))
    await hideTransientChrome(orcaPage)
    await orcaPage.screenshot({ path: shotPath('demo-portfolio.png'), clip: PANEL_CLIP })

    // ── The console, last: its sidebar now lists all three businesses ───────
    // Full window on purpose. This frame replaces an illustration that showed a
    // right-hand "brain rail" the product does not have.
    await showWorkspace(orcaPage)
    await orcaPage.waitForTimeout(1500)
    await relabelDemoRepo(orcaPage, path.basename(testRepoPath))
    await hideScaffoldWorktreeRow(orcaPage, 'e2e-secondary')
    await hideTransientChrome(orcaPage)
    await orcaPage.screenshot({ path: shotPath('demo-console.png') })
  } finally {
    for (const repoPath of stagedRepos) {
      rmSync(path.dirname(repoPath), { recursive: true, force: true })
    }
  }
})
