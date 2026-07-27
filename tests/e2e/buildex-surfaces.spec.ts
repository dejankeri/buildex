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

  await orcaPage.screenshot({ path: proofPath('brain-setup.png') })
})

test('company brain maps the active repo', async ({ orcaPage, testRepoPath }) => {
  mkdirSync(path.join(testRepoPath, '.buildex'), { recursive: true })
  writeFileSync(path.join(testRepoPath, '.buildex', 'handbook.md'), '# Handbook\n', 'utf8')
  writeFileSync(path.join(testRepoPath, '.buildex', 'pricing.md'), '# Pricing\n', 'utf8')

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()

  // The brain is `.buildex/`, not the repo — a project's own README is code, not
  // company knowledge. Sections is the landing tab, so no navigation first.
  await expect(orcaPage.getByText('handbook', { exact: true })).toBeVisible()
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
    await expect(dialog.getByText('.claude/company-context.md')).toBeVisible()
    await expect(dialog.getByText('Named, and opened only if needed')).toBeVisible()
    await expect(dialog.getByText('handbook.md', { exact: true })).toBeVisible()

    await orcaPage.screenshot({ path: proofPath('brain-agent-view.png') })
  } finally {
    rmSync(path.join(testRepoPath, '.claude'), { recursive: true, force: true })
  }
})

test('store installs a pack into the company repo', async ({ orcaPage, testRepoPath }) => {
  // Seed a catalog pack in the repo the app has open, carrying a real skill
  // file. Installing copies files out of a catalog, so a pack with no files to
  // copy would prove nothing.
  const packDir = path.join(testRepoPath, 'catalog', 'acme')
  const skillManifest = path.join(testRepoPath, '.buildex', 'skills', 'acme-search', 'SKILL.md')
  const agentSkillLink = path.join(testRepoPath, '.claude', 'skills', 'acme-search')
  mkdirSync(path.join(packDir, 'skills', 'acme-search'), { recursive: true })
  writeFileSync(
    path.join(packDir, 'pack.json'),
    JSON.stringify({
      id: 'acme',
      name: 'Acme',
      icon: '🧪',
      summary: 'End-to-end fixture pack.',
      app: { url: 'https://example.com' },
      skills: ['acme-search']
    }),
    'utf8'
  )
  writeFileSync(
    path.join(packDir, 'skills', 'acme-search', 'SKILL.md'),
    '# acme-search\n\nSeeded by the e2e fixture.\n',
    'utf8'
  )

  try {
    await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
    await expect(orcaPage.getByText('Acme', { exact: true })).toBeVisible()

    await orcaPage.getByRole('button', { name: 'Install Acme' }).click()
    await expect(orcaPage.getByRole('button', { name: 'Uninstall Acme' })).toBeVisible()

    // Git is the record: the install must exist as a real file in the repo, and
    // it must be the catalog's content rather than a placeholder.
    expect(existsSync(skillManifest)).toBe(true)
    expect(readFileSync(skillManifest, 'utf8')).toContain('Seeded by the e2e fixture.')

    // Why: files under .buildex are invisible to the agent — the link into
    // .claude/skills is what makes an installed pack actually usable.
    expect(existsSync(agentSkillLink)).toBe(true)
    expect(readFileSync(path.join(agentSkillLink, 'SKILL.md'), 'utf8')).toContain('e2e fixture')

    await orcaPage.screenshot({ path: proofPath('store-installed.png') })

    // Uninstall takes back exactly what it put in: the files and the link.
    await orcaPage.getByRole('button', { name: 'Uninstall Acme' }).click()
    await expect(orcaPage.getByRole('button', { name: 'Install Acme' })).toBeVisible()
    expect(existsSync(skillManifest)).toBe(false)
    expect(existsSync(agentSkillLink)).toBe(false)
  } finally {
    // Why: only what this test seeded. Wiping `.buildex` takes the brain
    // documents other tests wrote with it.
    rmSync(path.join(testRepoPath, 'catalog'), { recursive: true, force: true })
    rmSync(path.join(testRepoPath, '.claude', 'skills'), { recursive: true, force: true })
    rmSync(path.join(testRepoPath, '.buildex', 'skills', 'acme-search'), {
      recursive: true,
      force: true
    })
  }
})

test('the shipped catalog fills the store for a repo with no catalog', async ({ orcaPage }) => {
  // Why: this is the first-run case. A brand-new operator's repo has no catalog
  // of its own, so without the catalog that ships in the app bundle the Store
  // would be permanently empty and the product would have nothing to offer.
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()

  await expect(orcaPage.getByText('Slack', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Stripe', { exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Install Slack' })).toBeEnabled()
  await orcaPage.screenshot({ path: proofPath('store-bundled.png') })
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

test('the brain is a full-screen surface beside the store', async ({ orcaPage }) => {
  // Why: the Brain lives on the left rail next to the Store, not in the right
  // panel — and Orca's own right-sidebar tabs are left exactly as they were.
  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Company Brain' })).toBeVisible()

  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()
})
