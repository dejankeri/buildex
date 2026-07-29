import path from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'

// The Store's marketplace management, in a real Electron launch.
//
// The three bundled marketplaces are shown and locked; a company's own are added
// and removed here, and land in the brain rather than on this machine — which is
// what makes them reach a teammate at all.
//
// Adding is the one path these tests drive only as far as its error: it fetches
// the marketplace's manifest to learn the name the agent will key installs by,
// and this suite is offline on purpose. What is asserted is that the failure
// reaches the operator instead of writing a marketplace under a guessed id.

test.describe.configure({ mode: 'serial' })

test.use({ seedMarketplaceIndexes: true })

const PROOF_DIR = path.resolve(__dirname, '..', '..', '.buildex-proofs', 'store-marketplaces')

function proofPath(name: string): string {
  mkdirSync(PROOF_DIR, { recursive: true })
  return path.join(PROOF_DIR, name)
}

const ACME_INDEX = {
  name: 'acme-internal',
  owner: { name: 'Acme' },
  plugins: [
    {
      name: 'acme-invoicing',
      displayName: 'Acme Invoicing',
      description: 'The invoicing system Acme runs on.',
      source: './plugins/acme-invoicing'
    }
  ]
}

function marketplacesFile(repoPath: string): string {
  return path.join(repoPath, '.buildex', 'marketplaces.json')
}

test('the bundled marketplaces are shown and cannot be removed', async ({ orcaPage }) => {
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()

  await orcaPage.getByRole('button', { name: 'Marketplaces', exact: true }).click()

  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog.getByText('Claude plugins')).toBeVisible()
  await expect(dialog.getByText('BuildEx', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Protocol', { exact: true })).toBeVisible()
  // Why: "Built in" is the whole claim — these ship with the app, so there is no
  // remove button beside any of them.
  await expect(dialog.getByText('Built in')).toHaveCount(3)
  await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(0)

  await orcaPage.screenshot({ path: proofPath('marketplaces-bundled.png') })
})

test('a marketplace it cannot read is refused rather than added under a guessed id', async ({
  orcaPage,
  testRepoPath
}) => {
  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Marketplaces', exact: true }).click()

  const dialog = orcaPage.getByRole('dialog')

  // A shape the fetch will not even attempt: caught before the network, so this
  // half of the check holds with or without one.
  await dialog.getByLabel('Marketplace', { exact: true }).fill('not a repo at all')
  await dialog.getByLabel('Name', { exact: true }).fill('Nowhere')
  await dialog.getByRole('button', { name: 'Add marketplace' }).click()
  await expect(dialog.getByText(/Point at owner\/repo/)).toBeVisible()
  await orcaPage.screenshot({ path: proofPath('marketplaces-rejected.png') })

  // A well-formed repo that does not exist. Whether this run has a network or
  // not, the marketplace cannot be read — and nothing may be written.
  await dialog.getByLabel('Marketplace', { exact: true }).fill('acme/no-such-marketplace-xyz')
  await dialog.getByRole('button', { name: 'Add marketplace' }).click()
  await expect(dialog.getByText(/Could not read/)).toBeVisible({ timeout: 30_000 })

  expect(existsSync(marketplacesFile(testRepoPath))).toBe(false)
})

test('a marketplace the company added is on the shelf, and comes off from here', async ({
  orcaPage,
  electronApp,
  testRepoPath
}) => {
  // Why seeded rather than added through the dialog: adding fetches the
  // marketplace's manifest, and this suite does not reach the network. This is
  // the state a teammate arrives in after cloning — the file committed, the
  // index fetched on their own machine — which is the state worth asserting.
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  writeFileSync(
    path.join(userDataDir, 'marketplace-index', 'acme-internal.json'),
    JSON.stringify({ fetchedAt: Date.now(), body: JSON.stringify(ACME_INDEX) }),
    'utf8'
  )
  mkdirSync(path.join(testRepoPath, '.buildex'), { recursive: true })
  writeFileSync(
    marketplacesFile(testRepoPath),
    JSON.stringify({
      marketplaces: [
        {
          id: 'acme-internal',
          label: 'Acme internal',
          repo: 'acme/plugins',
          defaultSegment: 'business'
        }
      ]
    }),
    'utf8'
  )

  try {
    await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Store' })).toBeVisible()

    // The point of adding one: its apps are on the shelf beside everyone else's.
    await expect(orcaPage.getByText('Acme Invoicing')).toBeVisible()
    await orcaPage.screenshot({ path: proofPath('marketplaces-company-shelf.png') })

    await orcaPage.getByRole('button', { name: 'Marketplaces', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog.getByText('Acme internal')).toBeVisible()
    await expect(dialog.getByText('acme/plugins')).toBeVisible()
    await orcaPage.screenshot({ path: proofPath('marketplaces-company.png') })

    await dialog.getByRole('button', { name: 'Remove Acme internal' }).click()

    await expect(dialog.getByText('Acme internal')).toBeHidden()
    // The last one off takes the file with it: an empty list left behind would
    // show a teammate a document that says nothing.
    await expect(() => expect(existsSync(marketplacesFile(testRepoPath))).toBe(false)).toPass({
      timeout: 10_000
    })

    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(orcaPage.getByText('Acme Invoicing')).toBeHidden()
  } finally {
    rmSync(path.join(testRepoPath, '.buildex'), { recursive: true, force: true })
  }
})
