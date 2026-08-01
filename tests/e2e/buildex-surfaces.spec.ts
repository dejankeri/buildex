import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'

// Proof that BuildEx's surfaces register in a real Electron launch: the Company
// Brain and the Store, the files each one writes, and the gate that reaches the
// agent. Also asserts the Orca surfaces they sit beside still work, since this
// fork adds to Orca rather than replacing it.
//
// Removing the brain is covered by unit tests rather than here: it would wipe
// the repo these tests share, and its two branches (commit vs back up) need a
// git history this fixture does not have.

// Why: the test repo is worker-scoped but these tests write into it and clean up
// after themselves. Run in parallel and one test's teardown lands in the middle
// of another's assertions — the gate file disappearing between the badge and the
// read of the settings it came from.
test.describe.configure({ mode: 'serial' })

// Why: the Store fetches its marketplace indexes and caches them. Seeding that
// cache keeps the shelf deterministic and the suite offline — without it these
// tests would either find an empty Store or reach the network.
test.use({ seedMarketplaceIndexes: true })

const PROOF_DIR = path.resolve(__dirname, '..', '..', '.buildex-proofs', 'phase-0.5')

function proofPath(name: string): string {
  mkdirSync(PROOF_DIR, { recursive: true })
  return path.join(PROOF_DIR, name)
}

// Declared first on purpose: it is the only test that needs a repo with no brain
// in it, and the file runs serially against one shared repo.
test('a repo with no brain is offered setup rather than given one', async ({
  orcaPage,
  testRepoPath
}) => {
  // Why: BuildEx used to write nine folders and three documents into a repo the
  // moment any of its surfaces was touched — including the Store, which has
  // nothing to do with the brain. Browsing must leave the repo alone.
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()
  expect(existsSync(path.join(testRepoPath, '.buildex'))).toBe(false)

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Set up your company brain' })).toBeVisible()
  // Opening the Brain offers; it still does not act.
  expect(existsSync(path.join(testRepoPath, '.buildex'))).toBe(false)

  await orcaPage
    .getByRole('textbox', { name: 'What does this company do?' })
    .fill('We help fitness coaches run their business.')
  // Turn one section off, so "you can change this later" is literally true.
  await orcaPage.getByRole('checkbox', { name: /Finance/ }).click()
  await orcaPage.getByRole('button', { name: 'Create the brain' }).click()

  await expect(orcaPage.getByText('documents', { exact: true })).toBeVisible()
  expect(
    readFileSync(path.join(testRepoPath, '.buildex', 'strategy', 'overview.md'), 'utf8')
  ).toContain('We help fitness coaches run their business.')
  expect(existsSync(path.join(testRepoPath, '.buildex', 'finance'))).toBe(false)

  // The capture convention arrives with the brain, and reaches the agent: a
  // skill nobody linked by hand is a skill the agent never sees.
  expect(
    readFileSync(
      path.join(testRepoPath, '.buildex', 'skills', 'record-decision', 'SKILL.md'),
      'utf8'
    )
  ).toContain('# Record a decision')
  expect(existsSync(path.join(testRepoPath, '.claude', 'skills', 'record-decision'))).toBe(true)

  await orcaPage.screenshot({ path: proofPath('brain-setup.png') })
})

test('company brain maps the active repo', async ({ orcaPage, testRepoPath }) => {
  mkdirSync(path.join(testRepoPath, '.buildex'), { recursive: true })
  writeFileSync(path.join(testRepoPath, '.buildex', 'handbook.md'), '# Handbook\n', 'utf8')
  writeFileSync(path.join(testRepoPath, '.buildex', 'pricing.md'), '# Pricing\n', 'utf8')

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()

  // The brain is `.buildex/`, not the repo — a project's own README is code, not
  // company knowledge. Sections is the landing tab, so no navigation first.
  // A document reads by its `# H1`, not its filename — `handbook.md` shows as
  // "Handbook", which is what keeps a folder of dated slugs legible.
  await expect(orcaPage.getByText('Handbook', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('documents', { exact: true })).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('brain-tab.png') })
})

test('brain feeds company context to the agent with nothing to press', async ({
  orcaPage,
  testRepoPath
}) => {
  mkdirSync(path.join(testRepoPath, '.buildex'), { recursive: true })
  writeFileSync(path.join(testRepoPath, '.buildex', 'handbook.md'), '# Handbook\n', 'utf8')
  const contextPath = path.join(testRepoPath, '.claude', 'company-context.md')
  const claudeMdPath = path.join(testRepoPath, '.claude', 'CLAUDE.md')

  try {
    // No button: opening the Brain is enough. A context the operator has to
    // remember to refresh is a context that is usually wrong.
    await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Company Brain' })).toBeVisible()
    await expect(async () => {
      expect(existsSync(contextPath)).toBe(true)
    }).toPass({ timeout: 10_000 })

    // The agent reads CLAUDE.md at session start, so the import is what makes
    // the company context reach it — assert both files, not just one.
    expect(readFileSync(contextPath, 'utf8')).toContain('# Company context')
    expect(readFileSync(claudeMdPath, 'utf8')).toContain('@./company-context.md')

    // Why: BuildEx must not touch the project's own tracked CLAUDE.md, and must
    // put nothing generated into the tracked brain folder.
    expect(readFileSync(path.join(testRepoPath, 'CLAUDE.md'), 'utf8')).not.toContain('buildex')
    expect(existsSync(path.join(testRepoPath, '.buildex', 'company-context.md'))).toBe(false)
  } finally {
    // Why: the repo fixture is shared across tests in this file. Remove only what
    // this test generated, never the brain documents another test seeded.
    rmSync(path.join(testRepoPath, '.claude'), { recursive: true, force: true })
  }
})

test('a brain document is edited in place and written to disk', async ({
  orcaPage,
  testRepoPath
}) => {
  // Why: the whole point of editing here is that the operator never leaves the
  // Brain — and that what they typed reaches the file, since the file is the
  // artifact. Asserting the textarea alone would pass on a screen that saves
  // nothing.
  const documentPath = path.join(testRepoPath, '.buildex', 'handbook.md')
  mkdirSync(path.join(testRepoPath, '.buildex'), { recursive: true })
  writeFileSync(documentPath, '# Handbook\n', 'utf8')

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  // Why: one Electron launch serves the whole file, so the Brain may already be
  // holding a scan taken before this test seeded its document.
  await orcaPage.getByRole('button', { name: 'Rescan' }).click()
  await orcaPage.getByRole('button', { name: 'handbook' }).click()

  // The app's own rich markdown editor, the same one the issue surfaces use.
  const editor = orcaPage.locator('.rich-markdown-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toContainText('Handbook')

  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+a')
  await orcaPage.keyboard.type('We answer within a day.')
  await orcaPage.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(orcaPage.getByText('Saved', { exact: true })).toBeVisible()
  expect(readFileSync(documentPath, 'utf8')).toContain('We answer within a day.')

  await orcaPage.screenshot({ path: proofPath('brain-document.png') })

  // Back returns to the sections it came from, still inside the Brain.
  await orcaPage.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Company Brain' })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'handbook' })).toBeVisible()
})

test('the brain shows what the agent will actually see', async ({ orcaPage, testRepoPath }) => {
  // Why: the company context is generated into `.claude/`, which is excluded
  // from the operator's git — so this dialog is the only way to see what the
  // agent was told. It also has to keep the two halves apart: project memory is
  // loaded in full, a document is only named.
  mkdirSync(path.join(testRepoPath, '.buildex'), { recursive: true })
  writeFileSync(path.join(testRepoPath, '.buildex', 'handbook.md'), '# Handbook\n', 'utf8')

  try {
    await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
    await orcaPage.getByRole('button', { name: 'More' }).click()
    await orcaPage.getByRole('menuitem', { name: 'What the agent sees' }).click()

    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog.getByText('Loaded before you type')).toBeVisible()
    await expect(dialog.getByText('.claude/CLAUDE.md', { exact: true })).toBeVisible()
    // The context file is reached through the import line the memory file
    // writes, listed as written and openable — not restated as loaded content.
    await expect(
      dialog.getByRole('button', { name: '@./company-context.md', exact: true })
    ).toBeVisible()
    await expect(dialog.getByText('Named, and opened only if needed')).toBeVisible()
    await expect(dialog.getByText('handbook.md', { exact: true })).toBeVisible()

    await orcaPage.screenshot({ path: proofPath('brain-agent-view.png') })
  } finally {
    rmSync(path.join(testRepoPath, '.claude'), { recursive: true, force: true })
  }
})

// Installing is not exercised here on purpose: it delegates to `claude plugin
// install`, which would reach the network and change the plugins on whatever
// machine runs the suite. The driver's own unit tests cover the command it
// builds; these cover the shelf the operator actually sees.

test('the store fills from the marketplace indexes this machine has fetched', async ({
  orcaPage
}) => {
  // Why: indexes are cached, not bundled, and the shelf is drawn from all three
  // marketplaces at once — BuildEx's, Protocol's, and Anthropic's.
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()

  // BuildEx's own operator packs lead, because they are what was curated.
  await expect(orcaPage.getByText('Protocol', { exact: true }).first()).toBeVisible()
  await expect(orcaPage.getByText('Stripe', { exact: true }).first()).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('store-shelf.png') })
})

test('one shelf, and the badge is what separates vetted from not', async ({ orcaPage }) => {
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()

  // No tabs to choose between: searching one name reaches every marketplace at
  // once. Our Stripe is the operator's and stripe/ai's is the developer's, and
  // both are on the same shelf.
  await orcaPage.getByRole('textbox', { name: 'Search apps' }).fill('stripe')

  // Ours leads, named the way an operator says it and marked as vetted. It
  // gates nothing, so `Curated` is the badge that has to carry that — the whole
  // reason a curated app needed one once the shelves merged.
  await expect(orcaPage.getByText('Stripe', { exact: true }).first()).toBeVisible()
  await expect(orcaPage.getByText('Curated').first()).toBeVisible()
  // Upstream's sits below it, on the same shelf, saying it is not.
  await expect(orcaPage.getByText('Unverified').first()).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('store-shelf-badges.png') })
})

test('a plugin nobody vetted says so before it is installed', async ({ orcaPage }) => {
  // Why: uncurated plugins install ungated, and that is a deliberate decision.
  // It has to be visible on the card rather than discovered afterwards.
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'Search apps' }).fill('clickhouse')

  await expect(orcaPage.getByText('Unverified').first()).toBeVisible()
  await expect(orcaPage.getByText(/Installs ungated/).first()).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('store-unverified.png') })
})

test('a teammate sees what this company runs on, first', async ({ orcaPage, testRepoPath }) => {
  // Why: this is the whole point of the roster. Installs are per-operator now, so
  // without a file in the brain a new teammate has no way to learn that this
  // company runs on Protocol.
  mkdirSync(path.join(testRepoPath, '.buildex'), { recursive: true })
  const rosterPath = path.join(testRepoPath, '.buildex', 'apps.json')
  writeFileSync(
    rosterPath,
    JSON.stringify({
      apps: [
        {
          pluginName: 'protocol-crm',
          marketplaceId: 'protocol',
          requirement: 'required',
          reason: 'Every client lives here.'
        },
        { pluginName: 'stripe', marketplaceId: 'buildex-packs', requirement: 'suggested' }
      ]
    }),
    'utf8'
  )

  try {
    await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()

    await expect(orcaPage.getByText('What your company runs on')).toBeVisible()
    await expect(orcaPage.getByText('Required').first()).toBeVisible()
    await expect(orcaPage.getByText('Every client lives here.')).toBeVisible()

    // Why: a cloned company repo's first action is getting its apps, not
    // browsing. The bulk install sits above the search rather than inside the
    // shelf, and it is the page's only default-weight button.
    const installAll = orcaPage.getByRole('button', { name: /Install all/ })
    await expect(installAll).toBeVisible()
    // Not clicked: installing shells out to `claude plugin install`, which would
    // reach the network and change the plugins on whatever machine runs this.

    await orcaPage.screenshot({ path: proofPath('store-company-roster.png') })
  } finally {
    rmSync(rosterPath, { force: true })
  }
})

test('search is how hundreds of plugins become findable', async ({ orcaPage }) => {
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  const search = orcaPage.getByRole('textbox', { name: 'Search apps' })

  await search.fill('protocol')
  await expect(orcaPage.getByText('Protocol', { exact: true }).first()).toBeVisible()

  await search.fill('zzzz-nothing-matches-this')
  await expect(orcaPage.getByText('Protocol', { exact: true })).toHaveCount(0)

  await orcaPage.getByRole('button', { name: 'Clear search' }).click()
  await expect(search).toHaveValue('')
})

test('the gate lands in the settings the agent enforces', async ({ orcaPage, testRepoPath }) => {
  // Why: the gate is only real if it reaches .claude/settings.json — that is the
  // file the agent runtime reads. Asserting the UI badge alone would pass even
  // if nothing were written.
  const settingsPath = path.join(testRepoPath, '.claude', 'settings.json')

  try {
    await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
    await expect(orcaPage.getByText(/actions ask first/)).toBeVisible()

    const permissions = JSON.parse(readFileSync(settingsPath, 'utf8')).permissions
    expect(permissions.ask).toContain('Bash(rm -rf:*)')
    expect(permissions.ask).toContain('Bash(git push --force:*)')
    // Wide autonomy: ordinary work is not gated.
    expect(permissions.allow).toContain('Bash')
    expect(permissions.allow).toContain('Edit')
    await orcaPage.screenshot({ path: proofPath('store-gate.png') })
  } finally {
    rmSync(path.join(testRepoPath, '.claude'), { recursive: true, force: true })
  }
})

test('the store opens from the sidebar and apps do not', async ({ orcaPage }) => {
  // Why: apps moved to the composer, under the agent picker. A sidebar entry for
  // them would be a second place to look for the same thing.
  await expect(orcaPage.getByRole('button', { name: 'Apps', exact: true })).toHaveCount(0)

  const storeNav = orcaPage.getByRole('button', { name: 'Store', exact: true })
  await expect(storeNav).toBeVisible()
  await storeNav.click()
  await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()
  await orcaPage.screenshot({ path: proofPath('store-page.png') })
})

test('the portfolio lists a business the operator is not standing in', async ({
  orcaPage,
  testRepoPath
}) => {
  // Why: this is Trap 1 in BUILDEX-PATCHES.md. A new TopLevelView compiles,
  // renders its button, and does nothing when a registration is missed — only a
  // real launch catches it. It also proves the whole point of the page: the
  // brain's numbers reach it without the Brain page ever being opened.
  mkdirSync(path.join(testRepoPath, '.buildex', 'strategy'), { recursive: true })
  writeFileSync(
    path.join(testRepoPath, '.buildex', 'strategy', 'overview.md'),
    '# Overview\n',
    'utf8'
  )

  await orcaPage.getByRole('button', { name: 'Portfolio', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  // Read-only: the columns are a reading of the repo, and the row links back
  // into the per-repo surfaces rather than acting on them here.
  await expect(orcaPage.getByText('Business', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Last run', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText(/sections/).first()).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('portfolio-page.png') })
})

test('a portfolio cell opens the per-repo surface it summarises', async ({ orcaPage }) => {
  await orcaPage.getByRole('button', { name: 'Portfolio', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Portfolio' })).toBeVisible()

  await orcaPage
    .getByRole('button', { name: /brain$/ })
    .first()
    .click()
  await expect(orcaPage.getByRole('heading', { name: 'Company Brain' })).toBeVisible()
})

test('the brain is a full-screen surface beside the store', async ({ orcaPage }) => {
  // Why: the Brain lives on the left rail next to the Store, not in the right
  // panel — and Orca's own right-sidebar tabs are left exactly as they were.
  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Company Brain' })).toBeVisible()

  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()
})
