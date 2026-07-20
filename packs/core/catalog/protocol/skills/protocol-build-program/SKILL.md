---
name: protocol-build-program
description: Use when the operator asks you to build, edit, or assign a training program or workout in Protocol - so the block is grounded in the client's real profile and assignment does not overwrite a template.
---

# protocol-build-program - build and assign training

Programs are the heart of Protocol. Two things ruin them: building from assumptions instead of the
client's profile, and confusing a template with a client's copy.

## When to use

- "Build Sarah a 12-week strength block", "add a deload week", "change his Tuesday session"
- "Assign the hypertrophy template to Marcus"

## Steps

1. Read the client first (see `../protocol-client-review`). Training age, injuries, available days,
   and equipment all come from the profiles - build to those, not to a generic template.
2. Confirm the exact parameter names in `../protocol-reference/references/mcp-surface.md` before
   writing. `build_program` and `build_workout` have specific, easy-to-mistake argument shapes.
3. Build the structure with `build_program` (metadata, phases, content), and individual sessions with
   `build_workout`.
4. Assign with `assign_program`. Assigning **deep-copies** the template into an independent client
   copy - later edits to the client's program do not touch the template, and vice versa. Edit the
   right one.
5. Read the program back with `get` and confirm the phases and exercises actually landed.
6. Tell the operator what you built in their language - the shape of the block and why, not a dump
   of every set.

## Rules

- `exercises` **replaces** the whole exercise list on a workout. To add one session, read the current
  list, append, and write the complete array back - or you will delete the rest.
- Never edit a template when the operator meant a client's assigned copy. If it is ambiguous, ask.
- Use round, coachable numbers - real set and rep schemes, sensible session lengths. Mirror the
  conventions already in the coach's other programs.
- Building and assigning are writes, not outward actions. Nothing here notifies the client.
