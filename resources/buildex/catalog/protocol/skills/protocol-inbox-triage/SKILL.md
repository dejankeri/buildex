---
name: protocol-inbox-triage
description: Use when the operator asks what needs their attention, wants their Protocol inbox cleared, or asks about tasks and boards - so they get a short list of real decisions instead of an undifferentiated pile.
---

# protocol-inbox-triage - turn the pile into a short list

"What needs me?" is a request for judgement, not a list. Read everything, surface the few things that
actually need the operator.

## When to use

- "What needs me today?", "clear my inbox", "anything urgent?"
- "Add a task", "move that card", "what's on the board?"

## Steps

1. Call `review_inbox` with `action: "overview"` - one bundle of what is waiting.
   It returns the **top 25 insights, not all of them**, plus `insightsTotal` and an
   `insightBreakdown` counting the whole set by type and severity. Lead with the shape of the pile
   before the individual items - "518 active, mostly plateau warnings, three worth your morning" is
   the answer to "what needs me"; listing 25 rows is not. Only raise `insightLimit` when you are
   genuinely working the whole list.
2. Read `message` for unread client conversations. This verb is **read-only**; it never sends
   anything, so reading is free.
3. Group what you find: needs a decision / needs a reply / can be cleared / can wait.
4. Clear only what is genuinely noise, using `review_inbox` (`mark_read`, `dismiss_insight`,
   `mark_insight_read`) - and say what you cleared.
5. Manage tasks and boards with `manage_tasks` when the operator asks. It covers the whole kanban
   surface behind one `action`, and the per-action parameter list is published on the action enum -
   read it, because a param an action does not use is silently dropped rather than rejected. Two
   that bite: a task is named by `title` while a board, column or label is named by `name` (send the
   wrong one and the write succeeds having changed nothing), and creating a task needs a `boardId`
   or `columnId`, not just a title.
6. Report the short list. Three real items beats forty rows.

## Rules

- Never dismiss an insight the operator has not seen if it concerns a client's health or a payment.
  Surface those, do not clear them.
- Reading messages is not replying. Protocol has no MCP verb that messages a client - see
  `../protocol-rest-escape` for why, and what it costs to do it anyway.
- Say what you cleared, always. Silent triage is indistinguishable from losing things.
