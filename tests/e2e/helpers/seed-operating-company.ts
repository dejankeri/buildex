import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// A brain the size a real company's actually is.
//
// The fixtures elsewhere hold three clients, which proves the shapes render but
// proves nothing about the page that has to survive them: the rail's scroll-spy,
// collapse, and whether a section of thirty entities still reads as a section.
// Deterministic — no clock, no randomness — so two seeds produce the same brain
// and a screenshot diff means a real change.

type Seeded = { documents: number; entities: number; attachments: number }

const CLIENTS_ENTERPRISE = [
  ['Northwind Logistics', 'Renewal is Q3. Champion left in February; new sponsor is Dana in Ops.'],
  ['Meridian Health', 'Three sites live, two pending security review. Slowest rollout we have.'],
  ['Atlas Freight', 'Expansion signed in January. Wants SSO before they add the EMEA team.'],
  ['Calder Manufacturing', 'Quiet since the pilot. Sponsor moved teams and nobody replaced them.'],
  ['Pinnacle Retail Group', 'Our largest account. Renewal is the whole of Q4 for this team.'],
  ['Hollis Energy', 'Procurement stalled on the DPA. Legal has had it three weeks.']
]

const CLIENTS_SMB = [
  ['Brightline Studio', 'Two seats, pays annually, never files a ticket.'],
  ['Fernwood Coaching', 'Came from the pricing page. Upgraded within a month.'],
  ['Oak & Iron', 'Churn risk: usage halved after their ops hire left.'],
  ['Selby Consulting', 'Wants the reporting API. Blocked on us, not on them.'],
  ['Marlow Design', 'Referred two others. Worth asking for a case study.'],
  ['Quill Bookkeeping', 'Downgraded in March, still active on the lower tier.'],
  ['Harbor Physio', 'Onboarded themselves. First support ticket was month five.'],
  ['Tenby Legal', 'Security review passed. Slow to roll out internally.'],
  ['Cove Analytics', 'Evaluating a competitor. Flagged by the usage drop, not by them.'],
  ['Ridgeway Farms', 'Seasonal usage. Goes quiet every winter and comes back.']
]

const CLIENTS_DIRECT = [
  ['Ambleside Group', 'Paused until spring. Budget froze in November.'],
  ['Kestrel Software', 'Migrating off the legacy plan. Needs the importer finished.'],
  ['Thornbury Partners', 'Signed on the strength of the audit log. Uses little else.'],
  ['Wexford Media', 'Heavy API user. Rate limits are a standing conversation.'],
  ['Lyndon Foods', 'Renewal auto-renewed. Nobody there has logged in since August.'],
  ['Garrick Ventures', 'Introduced us to two of their portfolio companies.'],
  ['Ashfield Care', 'Compliance-driven buyer. Every release note gets read.'],
  ['Belmont Trading', 'Trialling the export feature we shipped for Northwind.'],
  ['Corvin Labs', 'Research customer. Uses the product in a way nobody predicted.'],
  ['Dunmore Transport', 'Won back after six months away. Do not lose them twice.']
]

const PEOPLE = [
  ['Dana Whitfield', 'Head of Operations. Owns onboarding and the runbook.'],
  ['Samir Okonkwo', 'Engineering lead, platform. On call rotation owner.'],
  ['Priya Ramanathan', 'Design. Owns the design system and the review ritual.'],
  ['Tomas Lindqvist', 'Engineering, integrations. Wrote most of the importer.'],
  ['Aoife Brennan', 'Customer success, enterprise accounts.'],
  ['Marcus Feld', 'Sales. Enterprise pipeline and renewals.'],
  ['Hannah Osei', 'Finance and people ops. Owns the expense policy.'],
  ['Rafael Duarte', 'Engineering, front end. Owns the editor.'],
  ['Ingrid Sallinen', 'Support lead. Triage rota and the help centre.'],
  ['Yusuf Demir', 'Data. Owns the warehouse and the weekly numbers.'],
  ['Clara Bianchi', 'Marketing. Content, launches, and the changelog.'],
  ['Nikhil Advani', 'Engineering, security. Owns the audit log and reviews.'],
  ['Beatrix Vogel', 'Customer success, SMB. Owns the churn signals.'],
  ['Owen Faraday', 'Engineering, infrastructure. Owns deploys and cost.']
]

const DECISIONS = [
  ['2026-06-18', 'We stopped selling the starter tier'],
  ['2026-05-30', 'Support moved to a triage rota'],
  ['2026-05-02', 'We build the importer rather than buy one'],
  ['2026-04-21', 'Enterprise pricing becomes seat-based'],
  ['2026-04-03', 'Audit log ships to every tier, not just enterprise'],
  ['2026-03-19', 'We say no to the on-premise request'],
  ['2026-02-27', 'Design reviews happen before implementation, not after'],
  ['2026-02-11', 'One oncall engineer, not two'],
  ['2026-01-29', 'We keep the free trial at fourteen days'],
  ['2026-01-14', 'Deprecate the v1 API with a twelve-month window'],
  ['2025-12-08', 'Move the warehouse off the transactional database'],
  ['2025-11-20', 'Hire for support before hiring for sales'],
  ['2025-10-30', 'We do not build a mobile app this year'],
  ['2025-10-02', 'Company brain lives in its own repo']
]

const RULES = [
  ['code-review', 'Every change is reviewed. The author does not merge their own work.'],
  ['oncall', 'One engineer on call for a week. Handover is written, not spoken.'],
  ['security-review', 'Anything touching customer data gets a security review before it ships.'],
  ['expenses', 'Spend it as if it were yours. Above £500, ask first.'],
  ['comms', 'Decisions go in the brain. Chat is where we get to a decision, not where it lives.'],
  ['data-handling', 'Customer data never leaves production. No exports to a laptop, ever.'],
  ['hiring-bar', 'Two yes votes and no strong no. A maybe is a no.']
]

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Fill `<repoPath>/.buildex` with a company that has been running for a while.
 *
 * `commit` makes the brain look like one somebody has been keeping rather than
 * one that was just generated — without it every document shows as unsaved and
 * the page is a wall of amber.
 */
export function seedOperatingCompany(repoPath: string, options: { commit?: boolean } = {}): Seeded {
  const counts: Seeded = { documents: 0, entities: 0, attachments: 0 }
  const root = path.join(repoPath, '.buildex')

  // Why: the e2e repo is worker-scoped and shared between specs. Without this a
  // small fixture and this one merge into a brain neither test described, and
  // the failure reads as a rendering bug rather than a seeding one.
  rmSync(root, { recursive: true, force: true })

  const write = (relative: string, contents: string): void => {
    const absolute = path.join(root, ...relative.split('/'))
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents, 'utf8')
    if (relative.endsWith('.md')) {
      counts.documents += 1
    } else {
      counts.attachments += 1
    }
  }

  const entity = (folder: string, name: string, summary: string, extras: string[]): void => {
    write(`${folder}/${slug(name)}/index.md`, `# ${name}\n\n${summary}\n`)
    counts.entities += 1
    for (const extra of extras) {
      // The heading is the basename, not the path — documents render by their
      // heading now, and `# calls/2026-06-04.md` is not something anyone writes.
      const heading = extra.split('/').at(-1)?.replace(/\.md$/, '') ?? extra
      write(
        `${folder}/${slug(name)}/${extra}`,
        extra.endsWith('.md') ? `# ${heading}\n` : 'binary\n'
      )
    }
  }

  write(
    'strategy/overview.md',
    '# Strategy\n\nWe give small operating companies one place to keep what they know, so the answer to "why did we do it that way" survives the person who decided it.\n'
  )
  write('strategy/positioning.md', '# Positioning\n\nAgainst a wiki: we are opinionated.\n')
  write(
    'strategy/bets.md',
    '# What we are betting on\n\nThat teams will write more if the agent reads it.\n'
  )
  write(
    'strategy/icp.md',
    '# Who it is for\n\nTen to eighty people, one product, no knowledge team.\n'
  )
  write('strategy/competitors.md', '# The landscape\n\nThree wikis and a document graveyard.\n')

  for (const [date, subject] of DECISIONS) {
    write(
      `decisions/${date}-${slug(subject)}.md`,
      `# ${subject}\n\n**Date.** ${date}\n\n**Context.** What was true when this came up.\n\n**Decision.** ${subject}.\n\n**Consequences.** What we accepted by choosing it.\n`
    )
  }
  write('decisions/log.md', '# Decision log\n\nNewest first. Superseded, never deleted.\n')

  for (const [name, rule] of RULES) {
    write(`rules/${name}.md`, `# ${name.replace(/-/g, ' ')}\n\n${rule}\n`)
  }

  for (const [name, summary] of CLIENTS_ENTERPRISE) {
    entity('clients/enterprise', name, summary, [
      'commercials.md',
      'calls/2026-06-04.md',
      'calls/2026-04-16.md',
      'calls/2026-02-09.md',
      'contracts/msa-2026.pdf',
      'contracts/order-form.pdf'
    ])
  }
  for (const [name, summary] of CLIENTS_SMB) {
    entity('clients/smb', name, summary, ['notes.md'])
  }
  for (const [name, summary] of CLIENTS_DIRECT) {
    entity('clients', name, summary, ['notes.md', 'calls/2026-05-21.md'])
  }
  write(
    'clients/how-we-run-accounts.md',
    '# How we run accounts\n\nOne owner each, reviewed monthly.\n'
  )

  write('product/roadmap.md', '# Roadmap\n\nImporter, then reporting API, then SSO.\n')
  write('product/changelog.md', '# Changelog\n\nWhat shipped, newest first.\n')
  for (const name of ['tiers', 'discounts', 'enterprise-terms']) {
    write(`product/pricing/${name}.md`, `# ${name.replace(/-/g, ' ')}\n`)
  }
  for (const name of ['slack', 'stripe', 'hubspot', 'zapier', 'webhooks']) {
    write(`product/integrations/${name}.md`, `# ${name}\n`)
  }
  for (const name of ['overview', 'data-model', 'auth', 'jobs']) {
    write(`product/architecture/${name}.md`, `# ${name.replace(/-/g, ' ')}\n`)
  }

  for (const [name, summary] of PEOPLE) {
    entity('people', name, summary, ['one-on-ones.md'])
  }
  for (const name of ['onboarding', 'time-off', 'progression', 'remote']) {
    write(`people/handbook/${name}.md`, `# ${name.replace(/-/g, ' ')}\n`)
  }

  write('finance/model.md', '# The model\n\nHow the numbers are supposed to work.\n')
  write('finance/pricing-history.md', '# Pricing history\n')
  write('finance/runway.md', '# Runway\n')
  write('finance/forecast-2026.xlsx', 'binary\n')
  for (const quarter of ['2025-q3', '2025-q4', '2026-q1', '2026-q2']) {
    write(`finance/quarters/${quarter}.md`, `# ${quarter.toUpperCase()}\n`)
  }

  write('content/voice.md', '# Voice\n\nPlain, specific, never breathless.\n')
  write('content/launch-checklist.md', '# Launch checklist\n')
  for (const [name] of CLIENTS_ENTERPRISE.slice(0, 4)) {
    write(`content/case-studies/${slug(name)}.md`, `# ${name}\n`)
  }

  for (const date of ['2026-06-26', '2026-05-29', '2026-04-24', '2026-03-27', '2026-02-27']) {
    write(`reviews/${date}.md`, `# Review, ${date}\n\nWhat happened, and what it means.\n`)
  }

  if (options.commit) {
    // A brain somebody has been keeping, not one that was generated a second ago.
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' })
    }
    git('add', '--', '.buildex')
    try {
      git(
        '-c',
        'user.name=Seed',
        '-c',
        'user.email=seed@example.com',
        'commit',
        '-m',
        'The company brain, as of today',
        '--',
        '.buildex'
      )
    } catch {
      // Nothing to commit: this brain is already in history, which is what a
      // re-seed of a shared fixture repo looks like. The end state is the same.
    }
  }

  return counts
}
