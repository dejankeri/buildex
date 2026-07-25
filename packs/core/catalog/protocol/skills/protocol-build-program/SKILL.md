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
   `build_workout`. **Send a workout's metadata and its `exercises` in the SAME call.** Creating the
   workout first and adding exercises after means a second call, and if you omit `workoutId` on it
   you create a *second, empty* workout rather than filling the first - the coach's library ends up
   with a duplicate of every session.
4. For a **mixed block** (training + nutrition in one program - the usual shape), attach both on the
   phase: `workoutDays` carries `{ workoutIds: [...] }` per day, `nutritionDays` carries
   `{ plannedNutritionTemplates: [...] }` per day. They are separate arrays on the same week, seven
   entries each. Nutrition placed on a `workoutDay` is silently not rendered.
5. Assign with `assign_program`. Assigning **deep-copies** the template into an independent client
   copy - later edits to the client's program do not touch the template, and vice versa. Edit the
   right one.
6. Read the program back with `get` and confirm the phases and exercises actually landed.
7. Tell the operator what you built in their language - the shape of the block and why, not a dump
   of every set.

## Rules

- **Editing a live program? `get` it first and keep every week you are not changing.** `phases`
  replaces the ENTIRE phase list, and each row needs one control key: `{ add: true, name: "Week 1" }`
  to create, `{ ref: "<phaseId>" }` to keep a week untouched, `{ modify: "<phaseId>", … }` to change
  one. A week you omit is deleted. Note `add` is a **boolean** here - in `build_nutrition` it names
  the row type instead. Full grammar: `../protocol-reference/references/mcp-surface.md`.
- `exercises` **replaces** the whole exercise list on a workout. To add one session, read the current
  list, append, and write the complete array back - or you will delete the rest.
- **Read `failCount` on every write.** These verbs are best-effort: rows they cannot parse are
  skipped, and the call still succeeds. A response carrying `failCount: 2` built two fewer weeks than
  you asked for, and only the number tells you.
- Never edit a template when the operator meant a client's assigned copy. If it is ambiguous, ask.
- Use round, coachable numbers - real set and rep schemes, sensible session lengths. Mirror the
  conventions already in the coach's other programs.
- Building and assigning are writes, not outward actions. Nothing here notifies the client.
