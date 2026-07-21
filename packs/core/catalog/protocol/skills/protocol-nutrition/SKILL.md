---
name: protocol-nutrition
description: Use when the operator asks you to build or adjust a client's nutrition plan, hit a calorie or macro target, or fix a meal in Protocol - so the plan uses real portions a person can actually eat.
---

# protocol-nutrition - build plans people can actually follow

A nutrition plan that hits a macro target exactly but asks for 2.61 fillets is worthless. Clean,
practical numbers matter more than arithmetic precision.

## When to use

- "Cut him to 2800", "build her a meal plan", "swap the breakfast", "recalculate his macros"

## Steps

1. Read the client first (see `../protocol-client-review`) - the nutrition profile carries
   preferences, allergies, and dislikes that override any target.
2. Resolve real foods with `manage_library` (`resolve_foods`) rather than inventing entries.
3. Build with `build_nutrition`. Macros are computed from the item tree - build the tree correctly and
   the totals follow.
4. Sanity-check the result as a coach would: are these portions a person would actually weigh out?
5. Read it back with `get` and confirm the items landed before reporting.

## Rules

- **Prefer clean numbers over an exact target.** Whole eggs, whole or half scoops, grams to the
  nearest 5-10. Landing at ~2950 kcal with tidy portions beats hitting 3000 exactly with strange
  fractions - artificial precision reads as machine-generated and coaches will not use it.
- Never override a stated allergy or restriction to make a target work. Report the conflict instead.
- `items` replaces the item tree. Read, merge, write the whole thing.
