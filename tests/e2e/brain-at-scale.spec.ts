import path from 'node:path'
import { mkdirSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import { seedOperatingCompany } from './helpers/seed-operating-company'

// The Brain against a company that has been running for a while: 172 documents,
// 40 entities, four levels of nesting, and attachments.
//
// The small fixtures prove the shapes render. This one is about what only shows
// up at size — whether the rail keeps its place while you scroll, whether
// collapsing a section of thirty entities actually shortens the page, and
// whether a section still reads as a section when it holds that many cards.

test.describe.configure({ mode: 'serial' })

const PROOF_DIR = path.resolve(__dirname, '..', '..', '.buildex-proofs', 'brain-at-scale')

function proofPath(name: string): string {
  mkdirSync(PROOF_DIR, { recursive: true })
  return path.join(PROOF_DIR, name)
}

/**
 * The client card, not the case study named after the same client.
 *
 * Documents render by their heading now, so `content/case-studies/northwind…`
 * reads "Northwind Logistics" too. The card is the one carrying the summary.
 */
function northwindCard(page: Page): Locator {
  return page.getByRole('button').filter({ hasText: 'Renewal is Q3' })
}

test('a company-sized brain stays legible', async ({ orcaPage, testRepoPath }) => {
  const seeded = seedOperatingCompany(testRepoPath, { commit: true })
  expect(seeded.entities).toBe(40)

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await expect(orcaPage.getByRole('button', { name: /^Clients/ }).first()).toBeVisible()

  // Nothing is unsaved: a brain somebody has been keeping should not open as a
  // wall of amber. This is also what proves the committed seed took.
  await expect(orcaPage.getByText('unsaved')).toBeVisible()
  await orcaPage.screenshot({ path: proofPath('scale-top.png') })

  // Enterprise clients live a level down — a subsection holding entities, which
  // is the deepest shape the page has to draw.
  await expect(northwindCard(orcaPage)).toBeVisible()
  await expect(orcaPage.getByText(/Champion left in February/)).toBeVisible()

  // Fifteen dated decision slugs truncated to a chip width are unreadable; the
  // heading somebody wrote is not.
  await expect(orcaPage.getByText('We stopped selling the starter tier')).toBeVisible()
  await expect(orcaPage.getByText(/2026-06-18-we-stopped/)).toHaveCount(0)
})

test('the rail follows the reader down a long page', async ({ orcaPage, testRepoPath }) => {
  seedOperatingCompany(testRepoPath, { commit: true })

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  const scroller = orcaPage.locator('div.overflow-y-auto').filter({ hasText: 'STRATEGY' }).last()

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2
  })
  // Why: scroll-spy runs on the scroll event, so give React a frame to paint the
  // new highlight before reading it.
  await orcaPage.waitForTimeout(300)

  // Something below the fold is now current, and it is not the first section.
  const current = orcaPage.locator('nav button[aria-current="true"]')
  await expect(current).toHaveCount(1)
  await expect(current).not.toHaveText(/^Strategy/)

  await orcaPage.screenshot({ path: proofPath('scale-scrolled.png') })
})

test('collapsing the biggest section shortens the page', async ({ orcaPage, testRepoPath }) => {
  seedOperatingCompany(testRepoPath, { commit: true })

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await expect(orcaPage.getByText('Ambleside Group', { exact: true })).toBeVisible()

  await orcaPage.getByRole('button', { name: 'Clients', exact: true }).click()

  // Everything under Clients goes, including the entities in its subsections.
  await expect(orcaPage.getByText('Ambleside Group', { exact: true })).toHaveCount(0)
  await expect(northwindCard(orcaPage)).toHaveCount(0)
  // The section itself stays, so it can be opened again.
  await expect(orcaPage.getByRole('button', { name: 'Clients', exact: true })).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('scale-collapsed.png') })
})

test('an entity carries its calls and its contracts', async ({ orcaPage, testRepoPath }) => {
  seedOperatingCompany(testRepoPath, { commit: true })

  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await northwindCard(orcaPage).click()

  await expect(orcaPage.getByRole('heading', { name: 'Northwind Logistics' })).toBeVisible()
  await expect(orcaPage.getByText('commercials', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('2026-06-04', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('msa-2026.pdf', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('order-form.pdf', { exact: true })).toBeVisible()

  await orcaPage.screenshot({ path: proofPath('scale-entity.png') })
})
