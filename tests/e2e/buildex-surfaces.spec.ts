import path from 'node:path'
import { mkdirSync } from 'node:fs'
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

test('company brain tab opens in the right sidebar', async ({ orcaPage }) => {
  const brainTab = orcaPage.getByRole('button', { name: 'Company Brain' })
  await expect(brainTab).toBeVisible()

  await brainTab.click()
  await expect(orcaPage.getByText('No company repo connected')).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('brain-tab.png') })
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
  await expect(orcaPage.getByText('No packs available yet')).toBeVisible()
  await orcaPage.screenshot({ path: proofPath('store-page.png') })
})

test('explorer stays the default right-sidebar tab', async ({ orcaPage }) => {
  // Why: BuildEx registers Brain after Explorer on purpose — visibleItems[0] is
  // the fallback tab, so leading with Brain would displace the developer default.
  await expect(orcaPage.getByRole('button', { name: /^Explorer/ })).toBeVisible()

  const activeTab = await getStoreState<string>(orcaPage, 'rightSidebarTab')
  expect(activeTab).not.toBe('brain')
})
