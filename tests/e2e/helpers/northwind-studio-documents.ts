// Everything Northwind Studio has written: the documents that fill its brain and
// the one exchange the console frame shows.
//
// Split from northwind-studio-demo.ts, which stages the app — this file is the
// invented company's prose and nothing else, so the staging logic stays readable
// next to the fixture that grew around it.

export const DEMO_QUESTION = 'Which retainers renew before the end of Q3, and what are they worth?'

export const DEMO_ANSWER = `Three renew before the end of Q3. Clients and owners come from \`clients/\`,
the numbers from \`finance/position.md\`, and the activation figure from the July review.

| Client | Renews | Monthly | Owner | Where it stands |
|---|---|---|---|---|
| Vantage Analytics | 12 Aug | $18k | Mira | Activation 21% → 34%, short of the 40% brief |
| Helio | 3 Sep | $14k | Dan | Signed in July, first renewal |
| Fernbank | 28 Sep | $9k | Mira | Quiet since the June handover |

**Vantage is the one to prepare for.** The engagement was sold on 40% activation by
Q4 and it is at 34%, so the renewal conversation needs the trend, not the number.

I can draft that note with the figures already in it. It will sit in Pending until
you approve it — nothing goes to a client on its own.`

export const NORTHWIND_DOCS = {
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
