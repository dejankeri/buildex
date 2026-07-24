# The activity ledger

The ledger is your company's record of consequential moments — every time the AI's work waited for
a human and what happened next. It answers, at a glance: *what went outward, who approved it, what
was refused.*

## What gets recorded

One line per gated moment:

- an **approval** — an outward action (a send, a post, a charge) that an operator tapped through
- a **denial** — an action an operator refused
- an **auto-denial** — an action nobody answered in time (the card timed out, so it was refused)

Each line carries the time, the decision, who made it, and a plain-language description of what the
AI wanted to do — the same wording you saw on the approval card.

## What deliberately isn't recorded

Routine autonomous work — reading, drafting, editing, research. That's the point of wide autonomy:
the AI works freely, and the ledger stays *readable*. A month of operation is dozens of meaningful
lines, not thousands of noise entries. Document changes have their own record — every doc's
**History**.

## Where it lives

The ledger is a plain document in your team's brain — one file per month under `activity/`. It syncs
to your whole team like any other document, appears in your Files, and is versioned forever. Nothing
hidden, no separate database: the record your team audits is a page anyone can read.

You'll also see the current month at a glance in the **Brain** view, under the Gate.
