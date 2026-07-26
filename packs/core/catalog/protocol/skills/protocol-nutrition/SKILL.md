---
name: protocol-nutrition
description: Use when the operator asks you to build or adjust a client's nutrition plan, hit a calorie or macro target, add a recipe, or fix a meal in Protocol - so the plan matches how this coach actually feeds their clients.
---

# protocol-nutrition - build plans people can actually follow

A nutrition plan that hits a macro target exactly but asks for 2.61 fillets is worthless. Clean,
practical numbers matter more than arithmetic precision.

And before any of that: **coaches do not all model food the same way.** Building a macro-tracked day
plan for a coach whose whole practice is recipes produces something they will not use.

## When to use

- "Cut him to 2800", "build her a meal plan", "swap the breakfast", "recalculate his macros"
- "Add this recipe", "put together next week's menu"

## Step 0 - find out how THIS coach works

Do this once per account, before your first write. `find` with `kind: "nutrition"` and read a few of
their existing plans with `get`. You are looking for which of three shapes they use:

| What you see | Their model | Build it with |
|---|---|---|
| `MEAL` rows carrying `foodId`, `quantity`, `measure`; day totals in `nutrients` | **Macro-tracked** | `build_nutrition` items, foods resolved first |
| `LABEL` + `EMBEDDED_TEMPLATE` rows; `nutrients` all zero | **Recipe-book** | `build_nutrition` items, embedding existing recipes |
| Almost no nutrition templates; the food lives in the program's `content` collections | **Menu-as-content** | `build_program` content, not `build_nutrition` |

Match what you find. If a coach's plans have no macros anywhere, that is their model - not missing
data to helpfully fill in.

## A. Macro-tracked day plans

1. Read the client first (see `../protocol-client-review`) - the nutrition profile carries
   preferences, allergies, and dislikes that override any target.
2. Resolve real foods with `manage_library` (`resolve_foods`). You need a `foodId` before you can
   write a food row this way.
3. Build with `build_nutrition`. The tree is **flat**: a meal is a `{ add: "LABEL", name: "Breakfast" }`
   heading followed by its foods as *sibling* rows - `{ add: "MEAL", foodId, quantity, measure }` -
   not nested inside it. Macros are computed from the tree; never pass `nutrients` yourself.
4. Sanity-check as a coach would: are these portions a person would actually weigh out?
5. Read it back with `get` and confirm the items landed before reporting.

## B. Recipe-book plans (a day assembled from recipes)

The coach keeps a library of reusable recipes and composes each day out of them.

- A **recipe** is a template with `metadata.templateMode: "SIMPLE"` ("My Meals/Recipes"). Its rows
  may be plain ingredient lines - `{ add: "MEAL", name: "badem" }` with no `foodId`, quantity or
  measure. That is legitimate; do not force library foods on a coach who does not use them.
- A **day plan** is `ADVANCED` and is built as `{ add: "LABEL", name: "Doručak" }` followed by
  `{ add: "EMBEDDED_TEMPLATE", templateId: "<recipe>" }`. Repeat per meal.
- The recipe is **snapshotted** into the day plan, so editing the recipe later does not rewrite
  plans already built from it. The embedded row's own `name` is empty - the name lives inside the
  snapshot, so read `embeddedTemplate.name`, not `name`.
- **These plans total zero calories, and that is correct.** Reuse the coach's existing recipes
  (`find kind=nutrition`, `isTemplate: true`) rather than inventing new ones.

## C. Menu-as-content

Some coaches deliver food as a menu attached to the program, not as day plans at all: a collection
named for the menu, whose items are `SUBCOLLECTION`s per meal-time, each holding recipes.

Build it with **`build_program`** `content`, not `build_nutrition`:

```
content: { collections: [ { name: "JELOVNIK", type: "recipes", items: [
  { type: "SUBCOLLECTION", name: "Doručak", items: [
      { type: "NUTRITION_TEMPLATE", nutritionTemplateId: "<recipe>" } ] } ] } ] }
```

The recipes themselves are still nutrition templates - create them with `build_nutrition` first,
then reference them by id. Full grammar: `../protocol-reference/references/surface-programming.md`.

## Rules

- **Prefer clean numbers over an exact target.** Whole eggs, whole or half scoops, grams to the
  nearest 5-10. Landing at ~2950 kcal with tidy portions beats hitting 3000 exactly with strange
  fractions - artificial precision reads as machine-generated and coaches will not use it.
- Never override a stated allergy or restriction to make a target work. Report the conflict instead.
- `items` replaces the item tree. Read, merge, write the whole thing - every row needs one control
  key (`add` / `ref` / `modify`), and a row you omit is deleted. Keep untouched rows with
  `{ ref: "<id>" }`.
- **Check `failCount` before you tell the operator it is done.** Rows the server cannot parse are
  skipped and the call still succeeds; `failCount: 3` means three foods are missing from the plan you
  are about to describe. If the whole write is refused, retry with the `templateId` you were handed -
  do not create a second plan.
