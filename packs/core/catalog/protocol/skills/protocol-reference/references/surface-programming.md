# Protocol MCP surface - programming

Building and assigning what a client trains and eats: programs, workouts, nutrition templates,
and the exercise/food library behind them. Assumes `surface-core.md`, especially the replace
grammar - every array here follows it.

> **One of four.** The surface is split by the job you are doing, so you read the part you need
> rather than all 18 verbs:
>
> | File | Verbs |
> |---|---|
> | `surface-core.md` | `find` · `get` · the kind table · the replace grammar · `report_to_developers` |
> | `surface-programming.md` | `build_program` · `build_workout` · `build_nutrition` · `assign_program` · `manage_library` |
> | `surface-clients.md` | `manage_client` · `record_progress` · `manage_forms` · `review_client` · `message` |
> | `surface-operations.md` | `manage_tasks` · `manage_media` · `schedule` · `manage_automations` · `review_inbox` |


---

### `build_program`

No required params (omit `programId` to create).

| Param | Type | Notes |
|---|---|---|
| `programId` | string | Edit this program; omit to create. |
| `name` | string | |
| `userId` | string | Assign to a client; omit for a library template. |
| `programType` | string enum | `WORKOUT` · `NUTRITION` · `FULL` |
| `sections` | string[] | Plan sections. |
| `phases` | object[] | Weekly phases (one phase = one week). **Replaces the phase list** — see [the replace grammar](#the-replace-grammar-phases-items-groups); `add` is a **boolean** here. |
| `content` | object | `{ collections: [...] }` — replaces program content. The **menu-as-content** model; see below. |
| `metadata` | object | Partial metadata patch (name / description / programGoal / programType / sections / …). |
| `importWorkoutId` | string | Import this workout into the library. |
| `duplicatePhaseId` | string | Duplicate this phase within the program. |

Copying/assigning to a client is `assign_program`, not this verb.

`phases[].nutritionGoal` values: `AGGRESSIVE_DEFICIT` · `DEFICIT` · `MINOR_DEFICIT` ·
`MAINTENANCE` · `MINOR_SURPLUS` · `SURPLUS`. This one is **not** schema-validated — a bad value is
persisted verbatim.

#### `content` — the menu-as-content model

Some coaches deliver food as a menu on the program instead of as day plans. `content.collections` is
that library: a collection groups items, and an item of type `SUBCOLLECTION` nests more items to any
depth (max 6) — meal-time sections like Doručak / Ručak / Večera.

```
content: { collections: [
  { name: "JELOVNIK", type: "recipes", items: [
      { type: "SUBCOLLECTION", name: "Doručak", items: [
          { type: "NUTRITION_TEMPLATE", nutritionTemplateId: "<recipe id>" } ] } ] } ] }
```

| Item `type` | Carries |
|---|---|
| `SUBCOLLECTION` | `name` + nested `items` (a meal-time section) |
| `NUTRITION_TEMPLATE` | `nutritionTemplateId` — a recipe |
| `MEDIA` | `mediaId` — photo / video / PDF |
| `WORKOUT` | `workoutId` |

Collection `type` is a free label (`recipes`, `guides`, `general`, …). Items are referenced **by id**
and snapshotted in; unresolved ids are reported and skipped.

> **Read/write asymmetry.** You WRITE a subcollection's children as `items`. `get kind=program`
> returns them under `subcollection.items`. Both are accepted on write, so a read-then-write-back is
> safe — but read the nested items from `subcollection.items` or you will think they vanished.

For per-DAY content use `phases[].contentDays` instead.

#### Mixed weeks — training *and* nutrition on the same phase

The common real shape. A phase carries parallel day arrays, seven entries each, and they are
independent: editing one does not disturb the other.

| Array | A day looks like |
|---|---|
| `workoutDays` | `{ workoutIds: ["<workoutId>"], isRestDay: false }`, or `{ isRestDay: true }` |
| `nutritionDays` | `{ plannedNutritionTemplates: ["<templateId>"] }` |
| `contentDays` | `{ mediaIds: ["<mediaId>"] }` |

Nutrition placed on a `workoutDay` is **not rendered** — it must go in `nutritionDays`.

Day objects are **not** reconciled the way rows are: they are stored as given. A day whose fields are
not from the real vocabulary is rejected outright rather than coerced (an invented
`{ day: "Monday", workout: "Upper A" }` used to become a silent rest day). The accepted fields are
`workoutIds`, `plannedNutritionTemplates`, `recoveryActivities`, `mediaIds`, `isRestDay`, `name`,
`dayType`, `dayFocus`, `notes`. A bare `{}` is a valid empty day.

---

### `assign_program`

Required: `action`. 5 actions.

| Param | Type | Notes |
|---|---|---|
| `action` | string enum | **Required.** `assign` · `activate` · `deactivate` · `move` · `unlink` |
| `programId` | string | The program to act on (activate / deactivate / move / unlink). |
| `copyFromProgramId` | string | `assign`: the source program/template to deep-copy. |
| `userId` | string | `assign`: the client who will own the new copy. |
| `name` | string | `assign`: name for the new program. |
| `startDate` | string | `activate`: `YYYY-MM-DD`; defaults to today. |
| `position` | integer | `move`: 0-based position in the client's program list. |

**`copyFromProgramId` is the source; `programId` is not.** On `assign` they are different things —
`programId` names the program to act on for the *other four* actions. Passing `programId` to
`assign` is the easiest mistake on this verb, and it used to create a brand-new **empty** program
assigned to the client while reporting success. It is refused now, but know which key you mean.
`assign` also requires `userId`: a copy owned by nobody is a library duplicate, not an assignment.

`assign` produces an **independent deep copy** — its `templateId` stays null by design. That is not
a bug to correct. The copy is independent all the way down: the source's **workouts and nutrition
templates are duplicated into new rows too**, so editing the client's session does not change the
template it came from. Edit the client's copy for that client; edit the source to change the recipe
for everyone you assign it to next.

`unlink` only applies to programs that carry a `templateId` — those come from the web app's link
flow. A program you assigned is already independent, so `unlink` answers "not linked to a template".
That is the correct answer, not a failure.

**The copy duplicates per DAY-REFERENCE, not per distinct item.** A 4-week block whose seven days
each point at the same nutrition plan yields 28 copies of it; a workout used in all four weeks
becomes four rows. This matches ~99.7% of the product's real programs (measured), so it is the house
shape, not a defect — but two things follow. Titles are copied **verbatim**, so a workout named after
one client will carry that name into the next client's plan; name sessions by content, never by
person. And an edit to the client's copy applies to the day you edit, not to every day that
originally shared the item.

---

### `build_workout`

No required params (omit `workoutId` to create).

| Param | Type | Notes |
|---|---|---|
| `workoutId` | string | Edit this workout; omit to create. |
| `name` | string | |
| `userId` | string | Assign to a client; omit for a template. |
| `isTemplate` | boolean | |
| `difficulty` | string enum | `EASY` · `MODERATE` · `HARD` · `VERY_HARD` |
| `goal` | string enum | `WEIGHT_LOSS` · `MUSCLE_GAIN` · `STRENGTH` · `ENDURANCE` · `FLEXIBILITY` · `SPORT_SPECIFIC` · `GENERAL_FITNESS` · `REHABILITATION` |
| `durationMinutes` | number | |
| `exercises` | object[] | The exercise groups. **Replaces the whole tree** — see [the replace grammar](#the-replace-grammar-phases-items-groups); `add` names the row TYPE here (`"GROUP"` / `"EXERCISE"`). |
| `metadata` | object | Partial metadata patch (name / difficulty / goal / …). |

The param is `exercises` — not `groups`, not `exerciseGroups`. Both enum values are also re-checked
on the `metadata` patch path, so a bad `metadata.difficulty` gives a clean error.

#### The two-level shape

GROUP rows at the top; each group's movements go in its own nested `exercises` array. Exercises
never sit at the top level.

```
{ add:"GROUP", section:"MAIN", format:"SUPERSET", restAfterGroupSeconds:120,
  exercises:[ { add:"EXERCISE", exerciseId:"<id>", sets:4, repRule:"8-10", restAfterSeconds:90 } ] }
```

| Field | On | Notes |
|---|---|---|
| `section` | GROUP | `WARMUP` · `MAIN` · `FINISHER` · `COOLDOWN`. Validated — a descriptive value like "Strength" is rejected. |
| `format` | GROUP | `REGULAR` (the overwhelming default) · `SUPERSET` · `CIRCUIT` · `DROPSET` · `AMRAP` · `EMOM` · `TABATA` · `FOR_TIME` · … Validated. |
| `rounds`, `timeCapSeconds`, `restBetweenRoundsSeconds` | GROUP | For circuits / AMRAP / EMOM. |
| `restAfterGroupSeconds` | GROUP | Rest after the block. |
| `exerciseId` | EXERCISE | A library id — resolve it with `find kind=exercise` first. A name is not a reference. |
| `sets`, `repRule` | EXERCISE | There is **no `reps` field**; reps live in `repRule`. |
| `restAfterSeconds` | EXERCISE | Rest between sets. **Set this** — it is on ~3 of every 4 real exercises. |
| `weight`, `tempo`, `notes` | EXERCISE | `rir` / `rpe` exist but are barely used in practice. |

`repRule` is a **structured grammar**, not free text — the same one the coach's builder enforces, so
a value it rejects would render red in their UI. Valid: `"10"`, `"8-10"`, `"10 / 8 / 6"`,
`"10x25kg"`, `"30s"`, `"5:00 / 4:30"`, `"bw"`, `"80%"`. Rejected: `"AMRAP"`, `"to failure"`,
`"60s hold"`, and anything with an unknown unit. Units: `kg` `lbs` `lb` `%` `bw` `bodyweight` `m`
`meters` `yd` `yards` `min` `s` `sec` — note `cal`, `km` and `in` are **not** supported by either
side. Unilateral work ("10 each side") has no notation: put it in `notes` and keep `repRule` numeric.

---

### `build_nutrition`

No required params (omit `templateId` to create).

| Param | Type | Notes |
|---|---|---|
| `templateId` | string | Edit this template; omit to create. |
| `name` | string | |
| `userId` | string | Assign to a client; omit for a library template. |
| `items` | object[] | The full **flat** item tree — a `LABEL` heading row followed by its foods as sibling `MEAL` rows, all top-level (foods do **not** nest inside the label; nested `items` are only for `GROUP` alternatives). A food row is `{ add:"MEAL", foodId, quantity, measure }`. **Replaces the tree** — see [the replace grammar](#the-replace-grammar-phases-items-groups). |
| `metadata` | object | Partial patch. Only `name` / `description` / `tags` / `templateMode` are honored. |

`metadata.templateMode`: `ADVANCED` (default — a "My Daily Nutrition" day plan) · `SIMPLE` (a
"My Meals/Recipes" entry). Pass it at create time so the template lands in the right place.
Macros are computed for you — don't hand-total them.

---

### `manage_library`

Required: `action`. 3 actions.

| Param | Type | Action | Notes |
|---|---|---|---|
| `action` | string enum | — | **Required.** `create_exercise` · `update_exercise` · `resolve_foods` |
| `exerciseId` | string | update_exercise | Required for update. |
| `name` | string | both exercise actions | |
| `primaryMuscleGroups` | string[] | exercise | The supported muscle-group path. |
| `equipmentRequired` | string[] | exercise | |
| `exerciseType` | string | exercise | |
| `difficultyLevel` | string | exercise | |
| `isCompound` | boolean | exercise | |
| `instructions` | string | exercise | |
| `videoUrl` | string | exercise | |
| `names` | string[] | resolve_foods | Convenience form — plain food names. |
| `queries` | object[] | resolve_foods | `{ name, quantity?, measure? }`. Takes precedence over `names`. |
