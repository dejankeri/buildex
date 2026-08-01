// The five other businesses the operator runs. Northwind Studio is the sixth and
// the one every other frame is about.
//
// Prose only — demo-portfolio-companies.ts stands them up. They differ on
// purpose: one brain lives in a repo of its own, one has a night's writing still
// uncommitted, and coverage runs from nearly complete to barely started. A table
// whose rows all say the same thing cannot show what the table is for.

export type DemoBusiness = {
  /** Directory name, and so the name the Portfolio lists it under. */
  slug: string
  summary: string
  /** Sections to create. A subset on purpose — coverage is a gradient. */
  folders: string[]
  /** Written and committed: what this company has already saved. */
  saved: Record<string, string>
  /** Written and left uncommitted: the "unsaved" column, earned rather than set. */
  unsaved?: Record<string, string>
  /** Keep the brain in a repo of its own rather than in the company's repo. */
  separateBrainRepo?: boolean
}

const TIDEWATER: DemoBusiness = {
  slug: 'tidewater-coffee',
  summary: 'We roast single-origin coffee and ship it on subscription to about 900 households.',
  folders: ['inbox', 'strategy', 'decisions', 'rules', 'clients', 'product', 'finance'],
  separateBrainRepo: true,
  saved: {
    'strategy/overview.md': `---
name: strategy
description: What Tidewater is for, and what it is betting on
---

# Strategy

A roastery that sells direct. No wholesale, no cafés — both are how small
roasters end up running a business they did not choose.

## The bet

People who care enough to buy single-origin will pay for freshness they can
taste. We roast Tuesday, ship Wednesday, and say so on the bag.

## What we will not do

- No supermarket listings. The margin is a rounding error and the freshness
  promise dies on a shelf.
- No subscription discounting. It trains the list to wait.
`,
    'product/roasts.md': `---
name: roasts
description: What we sell and how the range is meant to work
---

# The range

| Roast | Origin | Rotates | Notes |
|---|---|---|---|
| Harbour | Colombia, Huila | Standing | The one people start on |
| Longshore | Ethiopia, Guji | Seasonal | Sells out most months |
| Nightwatch | Blend | Standing | Dark, for the milk drinkers |

Longshore is the reason people stay subscribed and the reason they complain —
when it is out, churn that month roughly doubles.
`,
    'decisions/log.md': `---
name: decisions
description: Calls worth remembering, dated
---

# Decision log

## 2026-05 — Stopped the founder's-note insert

Cost more to print than the bag margin on a single order and nobody mentioned
it in the exit survey. Reverse only with evidence, not with a hunch.

## 2026-03 — Roast Tuesday, not Monday

Monday roasting meant Friday arrivals for the west, which is the worst day to
receive coffee you want to drink on a weekend.
`,
    'finance/position.md': `---
name: finance
description: Where the numbers stand
---

# Position — July 2026

- 912 active subscriptions, up 34 on June
- Average order £19.40, roughly flat for four months
- Churn 4.1%, and it tracks Longshore availability more than anything else

Cash covers about five months of green-coffee purchasing at the current rate.
`,
    'rules/operating.md': `---
name: rules
description: How this business is run day to day
---

# Operating rules

- Nothing goes to the full list without a human reading it first.
- Green coffee is bought against contracts, never on the spot market.
- If a shipment is late, we tell them before they ask.
`,
    'clients/wholesale-enquiries.md': `---
name: wholesale
description: The enquiries we keep turning down, and why we keep the record
---

# Wholesale enquiries

We do not sell wholesale. Kept because the same four cafés ask twice a year and
the answer should not depend on who reads the email.
`
  }
}

const LEDGER_LANE: DemoBusiness = {
  slug: 'ledger-and-lane',
  summary: 'A two-person bookkeeping practice looking after about forty small businesses.',
  folders: ['inbox', 'strategy', 'rules', 'clients', 'finance'],
  saved: {
    'strategy/overview.md': `---
name: strategy
description: What the practice is for
---

# Strategy

Bookkeeping for owner-run businesses too small for a finance hire and too messy
for software alone. We win on being the one who already knows their year.

## The bet

Fixed monthly fee, no hourly billing. It makes us refuse the clients whose books
are a rescue job, which is the point.
`,
    'rules/operating.md': `---
name: rules
description: How the practice works
---

# Operating rules

- Nothing is filed without a second read. Two people, both of them look.
- No client is onboarded in the last week of a quarter.
- A question from a client gets an answer the same day, even if the answer is
  "not yet".
`,
    'clients/book.md': `---
name: clients
description: Who we look after, and where each one stands
---

# The book

| Client | Since | Fee | Where it stands |
|---|---|---|---|
| Harbour Physio | 2023 | £340/mo | VAT quarter closes 31 Aug |
| Selby Joinery | 2021 | £280/mo | Chasing three months of receipts |
| Corvin Labs | 2025 | £520/mo | R&D claim due, needs their timesheets |
| Marlow Design | 2024 | £310/mo | Clean. Never late with anything |

Selby is the one to watch: same conversation four quarters running.
`
  },
  // A night's writing, not yet saved. This is what the Unsaved column counts,
  // and why the Portfolio can say which business is waiting on the operator.
  unsaved: {
    'inbox/2026-07-30.md': `---
name: inbox
description: Captured mid-session, not yet filed
---

# 30 July

- Selby asked about the R&D scheme. They almost certainly do not qualify —
  check before answering, because saying no wrongly costs us the referral.
- Two clients this month asked whether we do payroll. We do not. Third quarter
  running it has come up.
`,
    'finance/position.md': `---
name: finance
description: Where the practice stands
---

# Position — July 2026

- 41 clients, 2 leaving at the year end, neither for price
- Monthly recurring £13.9k, up £600 on the quarter
- One person's holiday is the whole capacity plan, which is the risk

Payroll keeps coming up. Adding it means a third person, and a third person
means the fixed fee has to move.
`
  }
}

const ORRERY: DemoBusiness = {
  slug: 'orrery-labs',
  summary: 'A two-person software product: scheduling for clinics that still run on paper.',
  folders: ['inbox', 'strategy', 'decisions', 'rules', 'product', 'clients', 'finance', 'reviews'],
  saved: {
    'strategy/overview.md': `---
name: strategy
description: What Orrery is for
---

# Strategy

Scheduling for small clinics — physio, dental, podiatry — that still run a paper
diary and a phone. Not a practice-management suite. The diary, done properly.

## The bet

The thing that makes them switch is not features, it is the migration. We import
a year of a paper diary from photographs in under an hour, and nobody else will.
`,
    'product/roadmap.md': `---
name: product
description: What is shipped, what is next
---

# Product

Shipped: diary, reminders, waiting list, the photo importer.
Next: recurring appointments. Asked for by eleven of the last fourteen trials.

Not doing: billing. Every clinic already has an accountant who will not move.
`,
    'decisions/log.md': `---
name: decisions
description: Calls worth remembering
---

# Decision log

## 2026-06 — SMS reminders stay, email reminders go

Email reminders had a 4% open rate with this audience. SMS costs money and works.

## 2026-04 — No free tier

Free trials convert at 31%. The free tier converted at 2% and generated most of
the support load.
`,
    'clients/trials.md': `---
name: trials
description: Who is trialling, and what is blocking each one
---

# Open trials

| Clinic | Started | Blocking |
|---|---|---|
| Ashgrove Physio | 12 Jul | Wants recurring appointments |
| Bell Lane Dental | 21 Jul | Nothing — chase for the decision |
| Torridge Podiatry | 26 Jul | Their receptionist is on leave until August |
`,
    'finance/position.md': `---
name: finance
description: Where the numbers stand
---

# Position — July 2026

- 38 paying clinics, £74/mo average
- £2.8k MRR, up £310 on June
- Two people, both part time, no outside money
`,
    'reviews/2026-07.md': `---
name: July 2026
description: The month, and what it means
---

# July 2026

Three trials opened, one closed. The photo importer is doing the selling — every
clinic that used it converted. Recurring appointments is now the only blocker
anybody names twice.
`
  }
}

const QUARRY_ROAD: DemoBusiness = {
  slug: 'quarry-road-gym',
  summary: 'A 90-member strength gym with two coaches and a small online coaching list.',
  folders: ['inbox', 'strategy', 'rules', 'clients', 'finance'],
  saved: {
    'strategy/overview.md': `---
name: strategy
description: What the gym is for
---

# Strategy

Barbell strength for adults who are not athletes. Coached sessions, capped at
eight, so nobody trains unsupervised in their first year.

## The bet

Retention, not acquisition. A member who stays two years is worth six who try
January. Everything we do is aimed at month 13.
`,
    'rules/operating.md': `---
name: rules
description: How the gym runs
---

# Operating rules

- Every new member gets three one-to-one sessions before a group class. No
  exceptions, including for people who "have lifted before".
- Classes cap at eight. We turn people away rather than run nine.
- No twelve-month contracts. Monthly, cancel any time.
`,
    'finance/position.md': `---
name: finance
description: Where the numbers stand
---

# Position — July 2026

- 91 members, £62/mo average
- Online list: 14 at £120/mo
- Rent is 38% of revenue, which is the number to watch
`
  }
}

const SALTMARSH: DemoBusiness = {
  slug: 'saltmarsh-supply',
  summary: 'A small wholesaler of outdoor gear to independent shops across the south west.',
  folders: ['inbox', 'strategy', 'clients'],
  saved: {
    'strategy/overview.md': `---
name: strategy
description: What Saltmarsh is for
---

# Strategy

We carry three brands the big distributors will not: too small, too slow, too
awkward to stock. Independent shops buy from us because nobody else has them.

## The risk

Any one of those brands signing a national distributor ends a third of the
business in a quarter. Two of the three are family-owned. One is not.
`,
    'clients/accounts.md': `---
name: accounts
description: Who buys, and how much
---

# Accounts

Nineteen shops. Four of them are 60% of revenue, all four in Cornwall, all four
seasonal. Winter is thin and always will be.
`
  }
}

/** Northwind Studio is staged separately; these are the rest of the portfolio. */
export const DEMO_PORTFOLIO_BUSINESSES: DemoBusiness[] = [
  TIDEWATER,
  ORRERY,
  LEDGER_LANE,
  QUARRY_ROAD,
  SALTMARSH
]
