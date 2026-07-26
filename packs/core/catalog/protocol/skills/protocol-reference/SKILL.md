---
name: protocol-reference
description: Use when you need Protocol's exact tool parameters, entity kinds, action enums, domain model, or safety rules - the other protocol-* skills all delegate here rather than restating the surface, and getting a parameter name wrong loses data silently.
---

# protocol-reference - the ground truth for Protocol's surface

Protocol exposes its whole CRM as **18 intent verbs** rather than a tool per endpoint. Each verb is
fat: one `schedule` verb books appointments, configures booking, and fires reminders, chosen by an
`action` argument. That density is why this reference exists - the verb name tells you almost nothing
about what a given call will do.

## When to use

- Before any structural write (`build_program`, `build_workout`, `build_nutrition`, `manage_forms`),
  to confirm the exact parameter names.
- When you need the `find` / `get` entity kinds, or a verb's action enum.
- When you are unsure whether something is even reachable over MCP - see `references/guardrails.md`.
- When a call returned success but the data looks unchanged - read `references/pitfalls.md` first.

## How this coach works, versus how Protocol works

This reference is the ground truth for the *surface*. It cannot tell you how this particular
business coaches, and that is the half that makes the work feel right or wrong to the operator.
Real accounts differ completely: one tracks every meal against a food library, another writes
recipes as free text with no macros anywhere, a third delivers menus as content sections rather
than templates at all. Same tools, three unrecognisable houses.

So before a structural write, **check whether this company has already written its own verb** -
anything in `.claude/skills/` that is not a shipped `protocol-*` skill is the operator's own, and
it outranks anything here. When the coach corrects you on how it is done here rather than on a
fact, offer to save it with `remember-this`. The things worth remembering in coaching, from what
these accounts actually do:

- Naming: what programs, phases and templates are called, and what they are never named after.
- The nutrition model: food-library macros, recipe text, or menu-as-content.
- Check-in rhythm: which day, what gets reviewed, what a "bad week" is worth acting on.
- Rep and load notation, session structure, warm-up and finisher conventions.
- Who gets seen personally and who runs on templates.

## Steps

1. Read the reference you need, all in `references/` beside this file:
   - `surface-core.md` - **start here**: `find`/`get`, the entity kinds, and the replace grammar
     every array parameter follows. The three below assume it.
   - `surface-programming.md` - `build_program`, `build_workout`, `build_nutrition`,
     `assign_program`, `manage_library`.
   - `surface-clients.md` - `manage_client`, `record_progress`, `manage_forms`, `review_client`,
     `message`.
   - `surface-operations.md` - `manage_tasks`, `manage_media`, `schedule`, `manage_automations`,
     `review_inbox`.
   - `data-model.md` - clients, profiles, programs, templates, lifecycle stages.
   - `guardrails.md` - what Protocol deliberately will not do, and the access tiers.
   - `pitfalls.md` - the failure modes, led by parameter-name fidelity.
2. Quote parameter names from the reference rather than guessing from the shape of a previous call.
3. After a structural write, re-read the entity with `get` and confirm the field actually landed.

## Rules

- A wrong parameter name is **silently dropped and still returns success**. Never assume a 200 means
  the data saved - verify structural writes by reading them back.
- Array parameters like `exercises` and `questions` **replace** the whole array. Read, merge, then
  write the complete list, or you will delete the rest of it.
- Never invent an entity kind or an action value. If it is not in the surface files, it does not exist.
