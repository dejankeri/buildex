import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { getStoreState } from './helpers/store'

// Proof that BuildEx's three surfaces register in a real Electron launch: the
// Company Brain right-sidebar tab, and the Apps / Store top-level views. Also
// asserts the Orca surfaces they sit beside still work, since this fork adds
// to Orca rather than replacing it.

const PROOF_DIR = path.resolve(__dirname, '..', '..', '.buildex-proofs', 'phase-0.5')

function proofPath(name: string): string {
  mkdirSync(PROOF_DIR, { recursive: true })
  return path.join(PROOF_DIR, name)
}

test('company brain maps the active repo', async ({ orcaPage }) => {
  const brainTab = orcaPage.getByRole('button', { name: 'Company Brain' })
  await expect(brainTab).toBeVisible()
  await brainTab.click()

  // The seeded e2e repo ships CLAUDE.md and README.md at its root, so the brain
  // must find real documents rather than falling through to an empty state.
  // Not `exact`: the folder row's text is the label plus its count badge.
  await expect(orcaPage.getByText('Root').first()).toBeVisible()
  await expect(orcaPage.getByText('README', { exact: true })).toBeVisible()
  await expect(orcaPage.getByPlaceholder('Filter documents')).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('brain-tab.png') })
})

test('brain feeds company context to the agent', async ({ orcaPage, testRepoPath }) => {
  const contextPath = path.join(testRepoPath, '.buildex', 'company-context.md')
  const claudeMdPath = path.join(testRepoPath, 'CLAUDE.md')
  const originalClaudeMd = readFileSync(claudeMdPath, 'utf8')

  try {
    await orcaPage.getByRole('button', { name: 'Company Brain' }).click()
    await orcaPage.getByRole('button', { name: 'Feed context to agent' }).click()
    await expect(orcaPage.getByText(/Company context (updated|already current)/)).toBeVisible()

    // The agent reads CLAUDE.md at session start, so the import is what makes
    // the company context reach it — assert both files, not just the message.
    expect(existsSync(contextPath)).toBe(true)
    expect(readFileSync(contextPath, 'utf8')).toContain('# Company context')
    expect(readFileSync(claudeMdPath, 'utf8')).toContain('@.buildex/company-context.md')

    // The operator's own CLAUDE.md content must survive.
    expect(readFileSync(claudeMdPath, 'utf8')).toContain(originalClaudeMd.trim().split('\n')[0]!)
  } finally {
    writeFileSync(claudeMdPath, originalClaudeMd, 'utf8')
    rmSync(path.join(testRepoPath, '.buildex'), { recursive: true, force: true })
  }
})

test('company brain filter narrows the document list', async ({ orcaPage }) => {
  await orcaPage.getByRole('button', { name: 'Company Brain' }).click()
  await expect(orcaPage.getByText('README', { exact: true })).toBeVisible()

  await orcaPage.getByPlaceholder('Filter documents').fill('readme')

  await expect(orcaPage.getByText('README', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('CLAUDE', { exact: true })).toHaveCount(0)
})

test('store installs a pack into the company repo', async ({ orcaPage, testRepoPath }) => {
  // Seed a catalog pack in the repo the app has open, carrying a real skill
  // file. Installing copies files out of a catalog, so a pack with no files to
  // copy would prove nothing.
  const packDir = path.join(testRepoPath, 'catalog', 'acme')
  const skillManifest = path.join(testRepoPath, 'skills', 'acme-search', 'SKILL.md')
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
    await expect(orcaPage.getByRole('button', { name: 'Installed Acme' })).toBeVisible()

    // Git is the record: the install must exist as a real file in the repo, and
    // it must be the catalog's content rather than a placeholder.
    expect(existsSync(skillManifest)).toBe(true)
    expect(readFileSync(skillManifest, 'utf8')).toContain('Seeded by the e2e fixture.')

    // An installed pack with an app face now shows up under Apps.
    await orcaPage.getByRole('button', { name: 'Apps', exact: true }).click()
    await expect(orcaPage.getByText('Acme', { exact: true })).toBeVisible()
    await orcaPage.screenshot({ path: proofPath('store-installed.png') })
  } finally {
    rmSync(path.join(testRepoPath, 'catalog'), { recursive: true, force: true })
    rmSync(path.join(testRepoPath, 'skills'), { recursive: true, force: true })
    rmSync(path.join(testRepoPath, '.buildex'), { recursive: true, force: true })
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
    rmSync(path.join(testRepoPath, '.buildex'), { recursive: true, force: true })
  }
})

test('apps and store open from the sidebar', async ({ orcaPage }) => {
  const appsNav = orcaPage.getByRole('button', { name: 'Apps', exact: true })
  await expect(appsNav).toBeVisible()
  await appsNav.click()
  await expect(orcaPage.getByText('No apps installed')).toBeVisible()
  await orcaPage.screenshot({ path: proofPath('apps-page.png') })

  const storeNav = orcaPage.getByRole('button', { name: 'Store', exact: true })
  await expect(storeNav).toBeVisible()
  await storeNav.click()
  await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()
  await orcaPage.screenshot({ path: proofPath('store-page.png') })
})

test('explorer stays the default right-sidebar tab', async ({ orcaPage }) => {
  // Why: BuildEx registers Brain after Explorer on purpose — visibleItems[0] is
  // the fallback tab, so leading with Brain would displace the developer default.
  await expect(orcaPage.getByRole('button', { name: /^Explorer/ })).toBeVisible()

  const activeTab = await getStoreState<string>(orcaPage, 'rightSidebarTab')
  expect(activeTab).not.toBe('brain')
})
