# Protocol data model — the domain underneath the verbs

The verbs in `mcp-surface.md` are thin: they forward your input into these entities almost
verbatim. Knowing the real shapes is what lets you predict *why* a call that returned success
saved something different from what you asked for.

## Tenant isolation

Every entity carries a `tenant_id`. Your key resolves to exactly one coach principal, and every
call is evaluated against that principal's tenant. You cannot see, reference, or write another
tenant's rows — an id from outside the tenant simply doesn't resolve. Never try to bridge two
tenants by passing ids between sessions.

## `BaseTenantEntity` — what every row looks like

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | **App-generated** on insert, not a DB default. |
| `tenant_id` | uuid, nullable | Nullable only because a handful of legacy/system rows predate strict tenancy. |
| `created_at` | timestamp | App-assigned on insert. |
| `updated_at` | timestamp | App-assigned on insert **and** bumped on every update. |

There are **no DB column defaults** on `id` / `created_at` / `updated_at` — no `uuid_generate_v4()`,
no `now()`. The app layer populates them. Practical consequence: any path that bypasses the entity
layer hits NOT NULL violations; there is no database-side safety net. You never generate these
yourself through the MCP verbs — never invent an `id` and expect it to be honored.

`LifecycleStage` is the exception in shape only: it declares `tenant_id` / `created_at` /
`updated_at` individually rather than inheriting them, with identical app-side behavior.

## `User` — one entity for coaches AND clients

There is no separate clients table. A coach and a client are both rows in `users`, distinguished by
**`role`**:

| `role` | Who |
|---|---|
| `TRAINER` | A coach. |
| `CLIENT` | A client of the tenant. |
| `ADMIN` | Tenant admin. |
| `SYSTEM` | Internal/system actor. |

- `role` is stored as the string enum **name**, not an ordinal or a PG enum type.
- `teamPermissions` — a jsonb array of `OWNER` · `ADMIN` · `COACH`, used for coach-side team
  scoping. Orthogonal to `role`.
- `tenantId` — every user belongs to exactly one tenant.
- Because coaches and clients share a table, a `userId` param is not automatically a client id.
  When a verb says "the client", pass a `CLIENT`-role user id.

### The four client profiles — separate 1:1 sub-resources

Health, fitness, nutrition, and behavioral data are **not columns on the `User` row**. Each is its
own table with a unique `user_id`, a strict one-to-one with the user:

| Profile | Table | Patch it with |
|---|---|---|
| Health | `user_health_profiles` | `manage_client` → `healthProfile` |
| Fitness | `user_fitness_profiles` | `manage_client` → `fitnessProfile` |
| Nutrition | `user_nutrition_profiles` | `manage_client` → `nutritionProfile` |
| Behavioral | `user_behavioral_profiles` | `manage_client` → `behavioralProfile` |

There is no combined "profile" blob to read or write in one shot. `review_client` bundles them for
you on the read side under `profiles`. Related detail rows (medical conditions, physical assessment
results) live in their own tables hanging off the health profile.

Additional profile families exist beyond these four (biometric, genomic) but are not exposed as
`manage_client` patches.

### Lifecycle stages — the client pipeline

`lifecycle_stages` rows are **tenant-scoped**, ordered by `position`, and carry an `is_terminal`
flag (terminal stages are what the dashboard counts as churned). A client points at one stage via a
nullable FK.

Two distinct operations, easily confused:

| Intent | Call |
|---|---|
| Move **one client** into a stage | `manage_client` with `lifecycleStageId` (`null` clears it) |
| Add / rename / reorder the **stages themselves** | `manage_client` with `lifecycleStage: { action: "create"\|"update"\|"reorder", ... }` |

List the stages with `find kind=lifecycle_stage`. The scalar stage id on the user row is a
read-only mirror — the stage move goes through the dedicated path above, not by writing the field.

## Programs, workouts, and nutrition templates

Three different things that all support a "template vs client copy" split.

### Program

- **Assignment** is the plain scalar `user_id` on the program row. One program belongs to one
  client.
- **Structure** lives in jsonb: `phases` (an array where **one phase = one week**), `sections`, and
  `content_collections` (linked media/content).
- **Templates**: `is_template` marks a reusable library program. `template_id` is set only when a
  program resolves placeholder tokens against a template's placeholder map.
- Enum-ish columns (`status`, `program_type`, `planning_type`, …) are plain string names.

### Workout

- The workout **is** its exercise-groups jsonb array. Writing it replaces the whole tree; there is
  no partial merge at the entity level.
- `is_template` / public-library flags mirror `Program`'s.
- Difficulty, experience level, unit system, training goal, and visibility are all string names.
  `template_mode` is the single enum stored as a numeric ordinal rather than a string — relevant
  only if you ever look at a raw value.

### Nutrition template

- Built as a flat item tree (LABEL headers + MEAL food rows) via `build_nutrition.items`, which
  replaces the tree wholesale.
- `templateMode` selects where it lives for the client: `ADVANCED` = a day plan
  ("My Daily Nutrition"), `SIMPLE` = a recipe/meal entry ("My Meals/Recipes"). Set it at create
  time.
- Macro totals are computed on write. Don't hand-total them.

### Exercise library

- `exercises` is a shared library referenced by workouts, not owned by them.
- The real muscle-group data lives in a separate `exercise_muscle_groups` join table, written
  delete-then-reinsert. Always go through `primaryMuscleGroups` (the `manage_library` param) —
  the singular `muscle_group` / `muscle_groups` columns on the entity itself are deprecated and not
  exposed on the DTO.

## Assignment: how a template becomes a client's own copy

`assign_program action=assign` with `copyFromProgramId` + `userId` (+ `name`) **deep-copies** the
source program or template into a new program owned by that client.

The copy is **independent**:

| | |
|---|---|
| Copied | The whole structure — phases, sections, content collections. |
| Owner | The new program's `user_id` is the client. |
| `templateId` | **Stays null, by design.** |
| Link to source | None. Editing the source afterwards does **not** flow through. |
| Editing the copy | Safe — it never overlays back onto the template. |

That null `templateId` is the invariant, not an oversight — do not "repair" it. If a coach wants
changes to propagate, the answer is to re-assign a fresh copy, not to relink.

Workouts and nutrition templates have no separate assign verb: they are created with `userId` set
(client-owned) or omitted (library template), and `isTemplate` marks the library form.
`build_program.importWorkoutId` imports a workout into the library.

## Other entities you will touch

| Entity | Shape notes |
|---|---|
| `ProgressEntry` (the check-in) | `status` is a **free-form tenant status name**, not an enum, defaulting to `PENDING`. `measurements` / `answers` / `labels` / `media` are jsonb pass-through. `source` records provenance: `REMINDER`, `AD_HOC`, `COACH`, or null for legacy rows. |
| `Task` (kanban) | A task's column FK is NOT NULL — a task always lives in a column. Assignees and labels are many-to-many join tables; subtasks are ordered by `position`. Client / creator / source-task scalar ids are read-only mirrors. |
| `Appointment` | `type`, `status`, `modality`, cancellation reason, exception type are all plain string names. Participant info and metadata are jsonb blobs. |
| `Conversation` / `Message` | Conversation `type`: `DIRECT` · `GROUP` · `INFO`. Per-participant delivery state (`SENT` · `DELIVERED` · `READ` · `FAILED`) lives inside a jsonb array, not a column. |
| `NutritionLog` | One row per logged meal for a user. `log_date` and `log_time` surface as plain `'YYYY-MM-DD'` / `'HH:mm:ss'` strings. |

## jsonb is not validated

`Program.phases` / `.sections` / `.contentCollections`, the workout exercise tree, nutrition log
items, progress-entry measurements and labels, message participant statuses — all jsonb, with **no
schema enforcement at the database layer**. Exactly what you send is what gets stored. A field
renamed, nested one level wrong, or omitted is not an error; it is simply absent on the next read.

Match the shape exactly. When in doubt, `get` the entity first and diff against what you're about
to send.
