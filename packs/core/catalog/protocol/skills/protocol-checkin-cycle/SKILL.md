---
name: protocol-checkin-cycle
description: Use when the operator wants to run weekly check-ins, review progress entries, log a client's numbers, or write up a meeting note in Protocol - so the review reflects the trend rather than a single week's noise.
---

# protocol-checkin-cycle - run the weekly review loop

Check-ins are where coaching actually happens. The job is to read the trend, not to restate this
week's numbers back at the operator.

## When to use

- "Run this week's check-ins", "log Sarah's weigh-in", "who hasn't checked in?"
- "Write up my notes from the call with Marcus"

## Steps

1. Find who is due: `find` with `kind: "progress"` (or `review_inbox` for the wider "what needs
   me" bundle - see `../protocol-inbox-triage`).
2. For each client, read their history with `review_client` before judging a single entry. One heavy
   week after a holiday is not a trend.
   **Pass an explicit `limit` whenever you are looking at a trend.** `find` caps at 20-25 by default;
   a client with four years of check-ins gives you the most recent 25 unless you ask for more. The
   response tells you: `defaultLimitApplied` means you did not set one, `truncated` means you exactly
   filled the one you set. Either way you are not looking at the whole history yet.
   The list rows carry only dates and status - **measurements come from `get kind=progress`**, one
   per entry. Budget for that before promising a full-history analysis.
3. Record with `record_progress`, choosing the right `action`:
   - `entry` - a check-in's numbers
   - `report` - triage an AI progress report
   - `note` - a meeting note
4. Where the trend genuinely warrants a programming change, say so and hand off to
   `../protocol-build-program` or `../protocol-nutrition`. Do not silently change the plan.
5. Summarise for the operator by exception - who needs them, and why.

## Rules

- Read at least a few weeks of history before recommending a change. Reacting to one data point is
  the most common way to make coaching worse.
- Write notes the way a coach would - specific and human. Never produce a template with the numbers
  swapped in.
- Logging a check-in or a note is a write, and reaches nobody.
- **Approving a report is different: it publishes to the client.** The report appears in their app
  the moment it is approved, so it waits for the operator's tap. Get the `clientFacingSummary` right
  *before* you approve - approval requires one, and it is what the client reads. `update` the draft
  as many times as you like; approve once, deliberately.
- Everything else here reaches nobody. If the operator wants the client told about something,
  that is `../protocol-scheduling` or a message they send themselves.
