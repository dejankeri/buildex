import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  applyDarkTheme,
  hideTransientChrome,
  relabelDemoRepo,
  resizeDemoWindow,
  stageDemoConsole,
  writeNorthwindBrain
} from './helpers/northwind-studio-demo'

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
// buildex-demo-live.spec.ts so the live demo and the pictures cannot drift.

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

test('capture the Brain and the Store', async ({ orcaPage, electronApp, testRepoPath }) => {
  await resizeDemoWindow(electronApp)
  // The site is a dark instrument panel; a light screenshot on it looks like a
  // photo of a different product.
  await applyDarkTheme(orcaPage)

  // ── The console: a chat answering from the company's own files ──────────
  // Full window on purpose. This frame replaces an illustration that showed a
  // right-hand "brain rail" the product does not have.
  await stageDemoConsole(orcaPage)
  await orcaPage.waitForTimeout(1200)
  await relabelDemoRepo(orcaPage, path.basename(testRepoPath))
  await hideTransientChrome(orcaPage)
  await orcaPage.screenshot({ path: shotPath('demo-console.png') })

  // ── Store ───────────────────────────────────────────────────────────────
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()
  // Let the "Workspace board moved to the bottom bar" toast expire before the
  // shutter — it is a one-time hint, not part of the product.
  await orcaPage.waitForTimeout(1500)
  await hideTransientChrome(orcaPage)
  await orcaPage.screenshot({ path: shotPath('demo-store.png'), clip: PANEL_CLIP })

  // ── Brain: set it up, then fill it with a company worth looking at ───────
  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Set up your company brain' })).toBeVisible()
  await hideTransientChrome(orcaPage)
  await orcaPage.screenshot({ path: shotPath('demo-brain-setup.png'), clip: PANEL_CLIP })

  await orcaPage
    .getByRole('textbox', { name: 'What does this company do?' })
    .fill('We are a six-person product design studio for mid-market SaaS teams.')
  await orcaPage.getByRole('button', { name: 'Create the brain' }).click()
  await expect(orcaPage.getByText('documents', { exact: true })).toBeVisible()

  writeNorthwindBrain(testRepoPath)

  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await orcaPage.waitForTimeout(2500)
  await hideTransientChrome(orcaPage)
  await orcaPage.screenshot({ path: shotPath('demo-brain.png'), clip: PANEL_CLIP })
})
