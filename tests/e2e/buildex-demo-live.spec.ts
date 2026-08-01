import { test, expect } from './helpers/orca-app'
import {
  applyDarkTheme,
  hideScaffoldWorktreeRow,
  hideTransientChrome,
  NORTHWIND_LAST_SAVE,
  relabelDemoRepo,
  resizeDemoWindow,
  stageDemoConsole,
  writeNorthwindBrain
} from './helpers/northwind-studio-demo'
import { stageDemoPortfolio } from './helpers/demo-portfolio-companies'
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

  // The console is staged before the Brain is opened, even though the Brain is
  // set up first: staging is what activates the primary workspace, and without
  // it "Create the brain" scaffolds into whichever workspace the harness left
  // active while writeNorthwindBrain writes to the primary.
  await stageDemoConsole(orcaPage)

  // Brain next, so every surface is populated by the time it is handed over.
  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Set up your company brain' })).toBeVisible()
  await orcaPage
    .getByRole('textbox', { name: 'What does this company do?' })
    .fill('We are a six-person product design studio for mid-market SaaS teams.')
  await orcaPage.getByRole('button', { name: 'Create the brain' }).click()
  await expect(orcaPage.getByText('documents', { exact: true })).toBeVisible()
  writeNorthwindBrain(testRepoPath)

  // Written to disk from outside the app, so the open page is still showing the
  // scan it ran when the brain was created. Rescan before handing it over.
  await orcaPage.getByRole('button', { name: 'Rescan', exact: true }).click()
  await expect(orcaPage.getByText(NORTHWIND_LAST_SAVE, { exact: false }).first()).toBeVisible({
    timeout: 30_000
  })

  // The other five businesses, so the Portfolio has something to be about.
  const stagedRepos = await stageDemoPortfolio(orcaPage)

  // Hand it over on the console; Portfolio, Brain and Store are one click away.
  await orcaPage.getByRole('button', { name: 'Portfolio', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await stageDemoConsole(orcaPage)
  await relabelDemoRepo(orcaPage, path.basename(testRepoPath))
  await hideScaffoldWorktreeRow(orcaPage, 'e2e-secondary')
  await hideTransientChrome(orcaPage)

  console.log(
    [
      '',
      '  BuildEx live demo is up — six invented businesses, Northwind Studio open.',
      '',
      `    Portfolio        all six, read-only`,
      `    Brain / Store    the sidebar buttons, both populated`,
      `    Repo             ${testRepoPath}  (throwaway)`,
      `    Others           ${stagedRepos.length} more throwaway repos under the temp dir`,
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
