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

## Steps

1. Read the reference you need, all in `references/` beside this file:
   - `mcp-surface.md` - all 18 verbs, real parameter names, entity kinds, action enums.
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
- Never invent an entity kind or an action value. If it is not in `mcp-surface.md`, it does not exist.
