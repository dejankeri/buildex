import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import type { GlobalSettings } from '../../../src/shared/types'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './terminal'
import { DEMO_ANSWER, DEMO_QUESTION, NORTHWIND_DOCS } from './northwind-studio-documents'

// Northwind Studio: an invented six-person design studio used to stage the app
// for pictures and for the live demo. Nothing here is a mock of the product —
// it is real content in a real launch. Only the company is fiction, so no real
// company data ends up on a public page.
//
// Used by buildex-marketing-capture.spec.ts (shoots it) and
// buildex-demo-live.spec.ts (leaves it open to click around).

export { DEMO_ANSWER, DEMO_QUESTION, NORTHWIND_DOCS }

export const DEMO_WINDOW = { width: 1440, height: 900 }

// The one-time "Workspace board moved to the bottom bar" hint outlives a 6s wait
// and lands in frame. Hide the toast layer rather than racing it.
//
// Hidden, never removed: these nodes are React's — the Radix ones are portals
// still mounted in the sidebar's tree. Detaching them makes React's own cleanup
// throw NotFoundError on the next unmount, which takes out the workspace list
// and puts a crash dialog in the frame. A style change React does not track is
// the only edit that is safe here.
export async function hideTransientChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    const selectors = [
      '[data-sonner-toaster]',
      '[data-sonner-toast]',
      '[role="status"]',
      // The "Workspace board moved to the bottom bar" hint is a Radix tooltip in
      // a portal, not a toast — it survived the toast-only sweep.
      '[role="tooltip"]',
      '[data-radix-popper-content-wrapper]'
    ]
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        node.style.setProperty('display', 'none', 'important')
      }
    }
  })
}

// The harness names its repo orca-e2e-repo-<random>, which reads as test
// scaffolding in the sidebar. Relabel it to the demo company the rest of these
// screenshots are about. This only rewrites a folder label — it does not change
// anything the product is doing.
export async function relabelDemoRepo(page: Page, realName: string): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const hits: Text[] = []
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        if (node.nodeValue?.includes(from)) {
          hits.push(node)
        }
      }
      for (const node of hits) {
        node.nodeValue = node.nodeValue?.replaceAll(from, to) ?? null
      }
    },
    { from: realName, to: 'northwind-studio' }
  )
}

// global-setup gives every test repo a second worktree on branch `e2e-secondary`
// so worktree tests have something to switch to. It is harness scaffolding — no
// operator has one — and in the sidebar it reads as a branch of the business.
// Same justification as relabelDemoRepo: this hides a row the harness added,
// not a row the product did. Hidden rather than detached, for the reason
// hideTransientChrome gives.
export async function hideScaffoldWorktreeRow(page: Page, branch: string): Promise<void> {
  await page.evaluate((name) => {
    for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-worktree-id]'))) {
      if (row.textContent?.includes(name)) {
        row.style.setProperty('display', 'none', 'important')
      }
    }
  }, branch)
}

// A demo at the default test window size looks like a bug report.
export async function resizeDemoWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.setBounds({ x: 0, y: 0, width: size.width, height: size.height })
    }
  }, DEMO_WINDOW)
}

// Set the real setting rather than toggling the class: the terminal and chat
// panes read the theme from settings, so a class flip leaves them white inside
// an otherwise dark window.
export async function applyDarkTheme(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ theme: 'dark' })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
    document.documentElement.classList.add('dark')
    document.documentElement.classList.remove('light')
  })
  await page.waitForTimeout(1200)
}

// A Claude Code session renders from its transcript JSONL, so writing one is how
// the chat gets something to show. The conversation is scripted demo content
// about the same invented studio as the brain docs — the harness has no signed-in
// agent. What is real is the renderer: this is the app's own markdown table, not
// a mockup of one.
function claudeTranscript(sessionId: string, userText: string, assistantText: string): string {
  const userTime = new Date()
  const assistantTime = new Date(userTime.getTime() + 2_000)
  return `${[
    {
      sessionId,
      uuid: `${sessionId}-user`,
      timestamp: userTime.toISOString(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: userText }] }
    },
    {
      sessionId,
      uuid: `${sessionId}-assistant`,
      timestamp: assistantTime.toISOString(),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text: assistantText }] }
    }
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')}\n`
}

// Leave the full-screen surfaces and go back to the workspace. Brain and Store
// set activeView; ensureTerminalVisible only sets the active *tab*, so without
// this the console stays unmounted behind whichever surface is open.
export async function showWorkspace(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.setState({ activeView: 'terminal' })
  })
}

// Turn the active terminal tab into a chat holding the retainer answer.
export async function stageDemoConsole(page: Page): Promise<void> {
  await showWorkspace(page)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  // The chat view is behind a setting; without this the tab silently stays a
  // terminal and the toggle looks like it did nothing.
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })

  const descriptor = await waitForActivePaneHookDescriptor(page)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = 'buildex-northwind-demo'
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'buildex-demo-chat-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, claudeTranscript(sessionId, DEMO_QUESTION, DEMO_ANSWER))

  await page.evaluate(
    ({ paneKey, worktreeId, id, transcript }) => {
      window.__store
        ?.getState()
        .setAgentStatus(
          paneKey,
          { state: 'idle', prompt: 'retainer renewals', agentType: 'claude' },
          'Claude',
          undefined,
          { worktreeId },
          { providerSession: { key: 'session_id', id, transcriptPath: transcript } }
        )
    },
    {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      id: sessionId,
      transcript: transcriptPath
    }
  )
  await page.evaluate(
    ({ tab, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tab
      )
      if (!unifiedTab) {
        throw new Error('Unified terminal tab not found for chat toggle')
      }
      state.toggleTabViewMode(unifiedTab.id)
    },
    { tab: tabId, worktreeId: descriptor.worktreeId }
  )

  // The table is the point of the frame — do not proceed until it is on screen.
  await expect(page.getByRole('table').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Vantage Analytics').first()).toBeVisible()
}

// Three saves rather than one, dated apart. A brain arrives over weeks, and the
// History tab's whole claim — that every save is a commit you can walk back —
// reads as a filing cabinet when there is a single entry in it.
const SAVE_SUBJECTS = {
  foundations: 'Strategy, operating rules and the decision log',
  engagements: 'The Vantage engagement, the team, and what we make',
  july: 'July review, where the numbers stand, and how we sound'
} as const

const NORTHWIND_SAVES: { subject: string; daysAgo: number; documents: string[] }[] = [
  {
    subject: SAVE_SUBJECTS.foundations,
    daysAgo: 9,
    documents: ['strategy/overview.md', 'rules/operating.md', 'decisions/log.md']
  },
  {
    subject: SAVE_SUBJECTS.engagements,
    daysAgo: 4,
    documents: ['clients/vantage.md', 'people/team.md', 'product/practice.md']
  },
  {
    subject: SAVE_SUBJECTS.july,
    daysAgo: 1,
    documents: ['reviews/2026-07.md', 'finance/position.md', 'content/voice.md']
  }
]

// Real content behind the coverage bars: an empty brain photographs as an empty
// brain, which is not what the product is for. Committed, because the header
// counts uncommitted documents as "unsaved" and a demo should show a company at
// rest, not mid-edit.
export function writeNorthwindBrain(repoPath: string): void {
  const now = Date.now()
  const commit = (subject: string, daysAgo: number): void => {
    execFileSync('git', ['add', '-A'], { cwd: repoPath })
    // Dated back so the history reads as a company's, not as one scripted
    // minute. Both variables: git takes the author date from one and the date
    // the log sorts and displays by from the other.
    const when = new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString()
    execFileSync('git', ['commit', '-m', subject], {
      cwd: repoPath,
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }
    })
  }

  // The scaffold gets its own save. Rolling it into the first tranche would file
  // ten seed documents under a subject about three of them.
  if (execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString().trim()) {
    commit('Set up the company brain', 12)
  }

  for (const save of NORTHWIND_SAVES) {
    for (const relative of save.documents) {
      const full = path.join(repoPath, '.buildex', relative)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, NORTHWIND_DOCS[relative as keyof typeof NORTHWIND_DOCS])
    }
    commit(save.subject, save.daysAgo)
  }
}

/** The newest save's subject — what the Brain header and History show first. */
export const NORTHWIND_LAST_SAVE = SAVE_SUBJECTS.july

/**
 * The save worth opening in a picture: not the newest.
 *
 * History lists newest first, so expanding the top entry pushes every other save
 * below the fold and the frame stops looking like a history at all.
 */
export const NORTHWIND_SAVE_TO_OPEN = SAVE_SUBJECTS.engagements
