import path from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'

// The Brain at the scale it is meant to survive: a company with sections,
// subsections, entity folders, and files that are not markdown.
//
// The card grid this replaced gave a company's nine areas and its twenty clients
// the same weight and the same size, so this asserts the two now read
// differently — an entity is a card with a summary, a section is a full-width
// block, and a subsection is nested inside one rather than beside it.

test.describe.configure({ mode: 'serial' })

const PROOF_DIR = path.resolve(__dirname, '..', '..', '.buildex-proofs', 'brain-entities')

function proofPath(name: string): string {
  mkdirSync(PROOF_DIR, { recursive: true })
  return path.join(PROOF_DIR, name)
}

function seedBrain(repoPath: string): void {
  // The e2e repo is worker-scoped and shared; start from a known brain.
  rmSync(path.join(repoPath, '.buildex'), { recursive: true, force: true })
  const write = (relative: string, contents: string): void => {
    const absolute = path.join(repoPath, '.buildex', ...relative.split('/'))
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents, 'utf8')
  }

  write('strategy/overview.md', '# Strategy\n\nWe help fitness coaches run their business.\n')
  write('strategy/positioning.md', '# Positioning\n')

  write(
    'clients/acme-corp/index.md',
    '# Acme Corp\n\n<!-- One paragraph a stranger would understand. -->\n\nRenewal is Q3. Champion left in Feb; new sponsor is Dana in Ops.\n'
  )
  write('clients/acme-corp/pricing.md', '# Pricing\n')
  write('clients/acme-corp/calls/2026-03-11.md', '# Call, 11 March\n')
  write('clients/acme-corp/calls/2026-01-08.md', '# Call, 8 January\n')
  writeFileSync(
    path.join(repoPath, '.buildex', 'clients', 'acme-corp', 'contract-2026.pdf'),
    '%PDF-1.4 not really a pdf\n',
    'utf8'
  )

  write('clients/globex/README.md', '# Globex\n\nPaused until spring. Budget froze in November.\n')
  write('clients/initech/initech.md', '# Initech\n\nMigrating off the legacy plan.\n')

  // No main file, so this must read as a subsection rather than an entity.
  write('product/pricing/tiers.md', '# Tiers\n')
  write('product/pricing/discounts.md', '# Discounts\n')
  write('product/roadmap.md', '# Roadmap\n')
}

test('sections stack, entities read as cards, and a subsection nests', async ({
  orcaPage,
  testRepoPath
}) => {
  seedBrain(testRepoPath)

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()

  // The rail names every section with the count the header shows, so a long page
  // stays navigable and the two never disagree.
  await expect(orcaPage.getByRole('button', { name: 'Clients 3' })).toBeVisible()
  await expect(orcaPage.getByText('3 entities')).toBeVisible()

  // An empty section is one line, not a block of purpose and placeholder — nine
  // declared sections and three filled ones must not read as a mostly-empty page.
  await expect(orcaPage.getByText('Nothing here yet')).toHaveCount(0)

  // An entity is its title and the line that stands for it — and the summary is
  // the company's sentence, not the scaffold's HTML comment.
  await expect(orcaPage.getByText('Acme Corp', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText(/Renewal is Q3/)).toBeVisible()
  await expect(orcaPage.getByText(/One paragraph a stranger/)).toHaveCount(0)

  // README.md and <foldername>.md mark an entity just as index.md does.
  await expect(orcaPage.getByText('Globex', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Initech', { exact: true })).toBeVisible()

  // A folder with no main file is a subsection: its documents show inline,
  // rather than the folder becoming a card of its own. The documents read by
  // their heading, not their filename.
  await expect(orcaPage.getByText('Pricing', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Tiers', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Discounts', { exact: true })).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('brain-sections.png'), fullPage: false })
})

test('an entity is a place of its own, attachments included', async ({
  orcaPage,
  testRepoPath
}) => {
  seedBrain(testRepoPath)

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await orcaPage.getByText('Acme Corp', { exact: true }).click()

  await expect(orcaPage.getByRole('heading', { name: 'Acme Corp' })).toBeVisible()
  await expect(orcaPage.getByText('Pricing', { exact: true })).toBeVisible()
  // A nested folder inside the entity keeps its own label, and its documents
  // read by their heading — "Call, 11 March", not "2026-03-11".
  await expect(orcaPage.getByText('Calls', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Call, 11 March', { exact: true })).toBeVisible()
  // The file that the old scan dropped on the floor.
  await expect(orcaPage.getByText('contract-2026.pdf', { exact: true })).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('brain-entity.png'), fullPage: false })
})

test('a section with no entity yet can still gain its first one', async ({
  orcaPage,
  testRepoPath
}) => {
  seedBrain(testRepoPath)

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()

  // People is empty, so it renders as one line. Offering "New entity" only where
  // one already existed would make the first one uncreatable.
  await orcaPage
    .locator('section', { has: orcaPage.getByRole('heading', { name: 'People' }) })
    .getByRole('button', { name: 'Add' })
    .click()
  await orcaPage.getByRole('menuitem', { name: 'New entity' }).click()
  await orcaPage.getByPlaceholder('Name it, then Enter').fill('Dana Ops')
  await orcaPage.keyboard.press('Enter')

  // Straight into the entity that was just made, on disk with the main file
  // that is what makes it one.
  await expect(orcaPage.getByRole('heading', { name: 'Dana Ops' })).toBeVisible()
  expect(
    readFileSync(path.join(testRepoPath, '.buildex', 'people', 'dana-ops', 'index.md'), 'utf8')
  ).toBe('# Dana Ops\n\n')

  await orcaPage.screenshot({ path: proofPath('brain-new-entity.png'), fullPage: false })
})

test('the filter narrows to one entity and hides the rest', async ({ orcaPage, testRepoPath }) => {
  seedBrain(testRepoPath)

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await orcaPage.getByPlaceholder('Filter').fill('acme')

  await expect(orcaPage.getByText('Acme Corp', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Globex', { exact: true })).toHaveCount(0)
  // A section with nothing matching disappears rather than rendering empty.
  await expect(orcaPage.getByText('Roadmap', { exact: true })).toHaveCount(0)
  // One of a thing is not "1 entities".
  await expect(orcaPage.getByText('1 entity', { exact: true })).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('brain-filter.png'), fullPage: false })
})
