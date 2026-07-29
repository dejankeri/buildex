import { test, expect } from './helpers/orca-app'
import {
  applyDarkTheme,
  hideTransientChrome,
  relabelDemoRepo,
  resizeDemoWindow,
  stageDemoConsole,
  writeNorthwindBrain
} from './helpers/northwind-studio-demo'
import path from 'node:path'

// The live demo: the same Northwind Studio the screenshots show, but left open
// so a person can click around it. Run it explicitly:
//
//   BUILDEX_DEMO=1 npx playwright test tests/e2e/buildex-demo-live.spec.ts \
//     --config tests/playwright.config.ts --project electron-headful --workers=1
//
// Ctrl-C closes the window and deletes everything it made.
//
// Why through the e2e harness rather than the installed app: the harness
// overrides HOME, so the demo never writes to the real ~/.claude or ~/.orca and
// cannot take hook traffic from the Orca you actually use. The repo it opens is
// a throwaway git repo in a temp dir.

// @headful — this one has to be visible; that is the whole point.
test.describe.configure({ mode: 'serial' })

// Real marketplace indexes, not the 9-plugin test fixture: a demo showing the
// fixture's shelf is showing a product that does not exist. Needs network.
test.use({ seedMarketplaceIndexes: false })

test.skip(!process.env.BUILDEX_DEMO, 'live demo — set BUILDEX_DEMO=1 to run it')

test('the live demo @headful', async ({ orcaPage, electronApp, testRepoPath }) => {
  // No deadline: this one is meant to sit open until a person closes it.
  test.setTimeout(0)

  await resizeDemoWindow(electronApp)
  await applyDarkTheme(orcaPage)

  // Brain first, so every surface is populated by the time it is handed over.
  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Set up your company brain' })).toBeVisible()
  await orcaPage
    .getByRole('textbox', { name: 'What does this company do?' })
    .fill('We are a six-person product design studio for mid-market SaaS teams.')
  await orcaPage.getByRole('button', { name: 'Create the brain' }).click()
  await expect(orcaPage.getByText('documents', { exact: true })).toBeVisible()
  writeNorthwindBrain(testRepoPath)

  // Hand it over on the console; Brain and Store are one sidebar click away.
  await stageDemoConsole(orcaPage)
  await relabelDemoRepo(orcaPage, path.basename(testRepoPath))
  await hideTransientChrome(orcaPage)

  console.log(
    [
      '',
      '  BuildEx live demo is up — Northwind Studio, an invented design studio.',
      '',
      `    Brain / Store    the sidebar buttons, both populated`,
      `    Repo             ${testRepoPath}  (throwaway)`,
      '',
      '  HOME is isolated: nothing here touches your real ~/.claude or ~/.orca.',
      '  Ctrl-C to close it and clean up.',
      ''
    ].join('\n')
  )

  // Hold the window open. The fixture tears the app down when this resolves, so
  // it deliberately never does.
  await new Promise<never>(() => {})
})
