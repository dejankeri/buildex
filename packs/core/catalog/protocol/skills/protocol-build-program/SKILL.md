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
2. Confirm the exact parameter names in `../protocol-reference/references/surface-programming.md` before
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
5. Assign with `assign_program` — `action: "assign"`, the source as **`copyFromProgramId`** (not
   `programId`, which is what the other actions use), and the client as `userId`. Both are required;
   without the source you would create an empty plan for that client.
   Assigning **deep-copies** the template into an independent client copy, all the way down: the
   workouts and nutrition templates are duplicated too. Later edits to the client's program - or to
   its sessions - do not touch the template, and vice versa. Edit the client's copy to change that
   client; edit the source to change what the next person gets.
6. Read the program back with `get` and confirm the phases and exercises actually landed.
7. Tell the operator what you built in their language - the shape of the block and why, not a dump
   of every set.

## Rules

- **Editing a live program? `get` it first and keep every week you are not changing.** `phases`
  replaces the ENTIRE phase list, and each row needs one control key: `{ add: true, name: "Week 1" }`
  to create, `{ ref: "<phaseId>" }` to keep a week untouched, `{ modify: "<phaseId>", … }` to change
  one. A week you omit is deleted. Note `add` is a **boolean** here - in `build_nutrition` it names
  the row type instead. Full grammar: `../protocol-reference/references/surface-programming.md`.
- `exercises` **replaces** the whole exercise list on a workout - and so does a group's own nested
  `exercises` array. Changing one movement in a superset means sending that group's complete list
  with `{ ref: <exerciseId> }` for the ones you are keeping. Read the current list, merge, write it
  all back.
- **A workout is two levels: groups, then movements inside them.** A movement needs a real
  `exerciseId` (resolve it with `find kind=exercise` - a name is not a reference), `sets`, and
  `repRule`. There is no `reps` field.
- **Prescribe rest.** `restAfterSeconds` on each exercise, `restAfterGroupSeconds` on the block.
  Real coaches set it on most exercises; a session without rest reads half-finished to a client.
- **Never put a client's name in a workout or nutrition-template title.** Assigning deep-copies
  those titles **verbatim** to the next client, so a session called "Sarah - Upper A" ends up in
  Marcus's plan still saying Sarah. Name them by what they are: "Upper A - Push", "Cut Block Daily
  Nutrition". The program name is where the client belongs, and `assign` lets you set that per copy.
- **Assigning multiplies rows, and that is normal.** The copy duplicates a workout or template once
  per day it is referenced - a 4-week block referencing one daily nutrition plan produces 28 copies.
  That is how ~99.7% of this product's real programs are shaped, so do not "clean it up" or report it
  as a fault. It also means edits to the client's copy are per-day: change the session on the day
  you mean.
- **`repRule` is a structured grammar, not prose** - `"8-10"`, `"10 / 8 / 6"`, `"10x25kg"`, `"30s"`.
  Free text ("AMRAP", "to failure", "60s hold") is rejected, because the coach's own builder would
  render it as invalid. Unilateral work has no notation: keep `repRule` numeric and say "each side"
  in `notes`.
- **Read `failCount` on every write.** These verbs are best-effort: rows they cannot parse are
  skipped, and the call still succeeds. A response carrying `failCount: 2` built two fewer weeks than
  you asked for, and only the number tells you.
- Never edit a template when the operator meant a client's assigned copy. If it is ambiguous, ask.
  The two are fully independent after an assign, so the wrong choice is silent: the change lands
  somewhere real, just not where the operator meant. `find kind=program` with the client's id shows
  which copies are theirs.
- Use round, coachable numbers - real set and rep schemes, sensible session lengths. Mirror the
  conventions already in the coach's other programs.
- Building and assigning are writes, not outward actions. Nothing here notifies the client.
