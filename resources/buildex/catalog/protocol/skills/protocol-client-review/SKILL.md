---
name: protocol-client-review
description: Use when the operator asks how a client is doing, wants a catch-up before a session, or asks anything that needs a client's current state - so the answer comes from Protocol's live record instead of memory or guesswork.
---

# protocol-client-review - understand a client before you act

The most common Protocol request is some form of "how is Sarah doing?". Answer it from one call, not
by stitching together guesses.

## When to use

- "How's Sarah doing?", "catch me up before my 3pm", "who's slipping?"
- As **step 1 of every other protocol skill** - never write to a client you have not read first.

## Steps

1. Resolve the person to an id: `find` with `kind: "client"` and a `query`. If several match, ask the
   operator which one rather than picking.
2. Call `review_client` with that `clientId`. This is one call that returns the record, all four
   profiles, programs, nutrition, progress, appointments, tasks, and insights - use it instead of a
   dozen `get` calls.
3. Read what is actually there before summarising. Note the last check-in date, the current program
   phase, and anything overdue.
4. Answer in the operator's terms - what changed, what needs a decision, what you would do next.
   Lead with the thing that needs them, not a data dump.

## Rules

- If the client cannot be found, say so plainly. Never proceed against a guessed id - a write to the
  wrong client is not something the operator can easily undo.
- `review_client` is read-only and runs autonomously. Prefer it over `find`+`get` chains.
- Report gaps honestly: "no check-in logged since the 4th" is more useful than a confident summary
  built on stale data.
