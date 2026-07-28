import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'

// Marketing screenshot capture. NOT a test — it asserts only enough to know the
// surface actually rendered before the shutter fires. Run it explicitly:
//
//   BUILDEX_CAPTURE=1 npx playwright test tests/e2e/buildex-marketing-capture.spec.ts \
//     --config tests/playwright.config.ts --project electron-headless --workers=1
//
// Output: .buildex-marketing/*.png (gitignored), copied into the website repo.
// It runs inside the e2e harness on purpose: that harness overrides HOME, so the
// app never touches the real ~/.claude or ~/.orca while posing for pictures.

test.describe.configure({ mode: 'serial' })
test.use({ seedMarketplaceIndexes: true })

// Why skipped by default: this is a tool, not a test. It proves nothing about the
// product and only costs CI a minute. Set BUILDEX_CAPTURE=1 to run it.
test.skip(
  !process.env.BUILDEX_CAPTURE,
  'marketing capture — set BUILDEX_CAPTURE=1 to regenerate the screenshots'
)

const SHOT_DIR = path.resolve(__dirname, '..', '..', '.buildex-marketing')
const SHOT_W = 1440
const SHOT_H = 900

function shotPath(name: string): string {
  mkdirSync(SHOT_DIR, { recursive: true })
  return path.join(SHOT_DIR, name)
}

// The one-time "Workspace board moved to the bottom bar" hint outlives a 6s wait
// and lands in frame. Remove the toast layer outright rather than racing it.
async function hideTransientChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    const selectors = ['[data-sonner-toaster]', '[data-sonner-toast]', '[role="status"]']
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        node.remove()
      }
    }
  })
}

const NORTHWIND = {
  'strategy/overview.md': `---
name: strategy
description: Where Northwind Studio is going in 2026
---

# Strategy — 2026

We are a six-person product design studio. We win on **speed with taste**: a
working prototype in the first week, not a deck in the third.

## The bet

Mid-market SaaS teams have money and no design bench. They do not want a
rebrand; they want their core flow to stop leaking users. We sell that.

## What we will not do

- No hourly billing. Fixed scope, fixed price, fixed date.
- No logo-only work. It does not compound into product work.
- No more than four active engagements at once.
`,
  'rules/operating.md': `---
name: rules
description: How we operate day to day
---

# Operating rules

1. **Every engagement opens with a written scope.** No work starts before it is
   agreed in writing and filed under \`clients/\`.
2. **Nothing outward goes without a human.** Proposals, invoices and client mail
   wait for a person, always.
3. **Decisions get written down the day they are made.**
4. **Fridays are for the studio.** No client calls, no delivery deadlines.
`,
  'decisions/log.md': `---
name: decisions
description: What we decided, and why
---

# Decision log

## 2026-07-14 — Net-30 for enterprise, net-14 for everyone else
Enterprise procurement will not move faster than 30 days and we kept losing
deals arguing about it. Supersedes the flat net-14 terms from January.

## 2026-06-28 — We stop taking logo-only projects
Three of them last quarter, none turned into product work.

## 2026-06-02 — Four active engagements, hard cap
Five broke us in May. Quality dropped on two, and we nearly lost Vantage.
`,
  'clients/vantage.md': `---
name: Vantage Analytics
description: Retainer - dashboard and onboarding redesign
---

# Vantage Analytics

**Status:** active retainer · **Since:** March 2026 · **Owner:** Mira

Redesigning the analytics dashboard and first-run onboarding. Their activation
rate sat at 21%; the brief is to get it past 40% by Q4.
`,
  'people/team.md': `---
name: team
description: Who we are and who owns what
---

# The studio

| Person | Role | Owns |
|---|---|---|
| Mira | Principal designer | Vantage, Northwind brand |
| Dan | Product designer | Helio, onboarding practice |
| Sasha | Engineer | Prototypes, design system |
| Ellis | Operations | Contracts, invoicing, the calendar |
`,
  'finance/position.md': `---
name: finance
description: Cash position and what is committed
---

# Position — July 2026

- **Cash:** $312k
- **Committed revenue (signed):** $488k through Q4
- **Runway with zero new work:** 11 months
`,
  'product/practice.md': `---
name: practice
description: What we sell, and how the work is shaped
---

# The practice

A engagement is six weeks: one week to a working prototype, four to build it
out with their team, one to hand over.
`,
  'content/voice.md': `---
name: voice
description: How Northwind sounds in public
---

# Voice

Plain, specific, never breathless. We show the work rather than describe it.
`,
  'reviews/2026-07.md': `---
name: July 2026
description: What happened this month, and what it means
---

# July 2026

Activation work on Vantage landed at 34%, short of the 40% target but up from
21%. Helio signed. We held the four-engagement cap for the second month.
`
}

// Why clipped to the main panel: the e2e harness names its repo
// "orca-e2e-repo-<random>" in the sidebar, which reads as test scaffolding on a
// marketing page. The panel is the product surface anyway.
// 1163x727 is 16:10, matching the .shot aspect-ratio on the site, so the frame
// is not letterboxed when it lands in the rotator.
const PANEL_CLIP = { x: 277, y: 0, width: 1163, height: 727 }

test('capture the Brain and the Store', async ({ orcaPage, electronApp, testRepoPath }) => {
  // A marketing shot at the default test window size looks like a bug report.
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.setBounds({ x: 0, y: 0, width: size.w, height: size.h })
      }
    },
    { w: SHOT_W, h: SHOT_H }
  )
  // The site is a dark instrument panel; a light screenshot on it looks like a
  // photo of a different product.
  await orcaPage.evaluate(() => {
    document.documentElement.classList.add('dark')
    document.documentElement.classList.remove('light')
  })
  await orcaPage.waitForTimeout(600)

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

  // Real content behind the coverage bars: an empty brain photographs as an
  // empty brain, which is not what the product is for.
  for (const [rel, body] of Object.entries(NORTHWIND)) {
    const full = path.join(testRepoPath, '.buildex', rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  // Commit them: the header counts uncommitted documents as "unsaved", and a
  // marketing shot should show a company at rest, not mid-edit.
  execFileSync('git', ['add', '-A'], { cwd: testRepoPath })
  execFileSync('git', ['commit', '-m', 'Northwind Studio company brain'], { cwd: testRepoPath })

  await orcaPage.getByRole('button', { name: 'Store', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Brain', exact: true }).click()
  await orcaPage.waitForTimeout(2500)
  await hideTransientChrome(orcaPage)
  await orcaPage.screenshot({ path: shotPath('demo-brain.png'), clip: PANEL_CLIP })
})
