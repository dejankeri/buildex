# Protocol MCP surface - clients and their progress

The client record, their check-ins and reports, and the forms that feed both. Assumes
`surface-core.md`.

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

### `review_client` — the client bundle

Required: `clientId`.

| Param | Type | Notes |
|---|---|---|
| `clientId` | string | **Required.** |

Returns one object: `client`, `profiles`, `programs`, `nutrition`, `recentProgress`,
`upcomingAppointments`, `openTasks`, `insights`. Each section is null-safe — a section that fails
comes back `null` rather than failing the whole call. Prefer this over 8 separate `find` calls.

---

### `message` — read-only messaging

No required params.

| Param | Type | Notes |
|---|---|---|
| `conversationId` | string | Fetch this conversation's messages. |
| `clientId` | string | When listing, filter conversations to this client. |
| `limit` | number | Result cap. |

With `conversationId` → messages. Without it → the conversation list. **There is no send path on
this verb.** Sending a client message is a coach-approval matter (see `guardrails.md`).

---

## Write tier

---

**Listing clients.** `find kind=client` takes `isActive` — and it matters more than it sounds. A
roster holds everyone who ever signed up: on a live account, 168 clients of whom **31 are active**.
Answering "how many clients do you have?" without it is wrong by five times. Also takes
`lifecycleStageId` for a pipeline stage, and a free-text `query` over name and email.

### `manage_client`

No schema-level required params, but you must pass either `clientId` **or** `create`.

| Param | Type | Notes |
|---|---|---|
| `clientId` | string | The client to edit; omit when passing `create`. |
| `create` | object | `{ firstName, lastName, email, phoneNumber?, sendAccessInstructions? }` |
| `lifecycleStageId` | string \| null | Move **this client** to a stage; `null` clears it. |
| `assignTrainerId` | string | Assign this trainer. The response's `assignment` object carries the assignment `id`. |
| `unassignAssignmentId` | string | Remove an assignment **by assignment id** (not trainer id). |
| `healthProfile` | object | Partial patch. |
| `fitnessProfile` | object | Partial patch. |
| `nutritionProfile` | object | Partial patch. |
| `behavioralProfile` | object | Partial patch. |
| `lifecycleStage` | object | Manages the tenant's **stage list itself**: `{ action: "create"\|"update"\|"reorder", ... }`. |

`lifecycleStageId` moves one client. `lifecycleStage` edits the pipeline columns for the whole
tenant. They are not the same thing.

---

### `record_progress`

Required: `action`. 3 actions.

| Param | Type | Action | Notes |
|---|---|---|---|
| `action` | string enum | — | **Required.** `entry` · `report` · `note` |
| `progressEntryId` | string | entry | Update this check-in; omit to create. |
| `clientId` | string | entry, note | |
| `entryDate` | string | entry (create) | `YYYY-MM-DD` |
| `measurements` | object | entry (**create and update**) | The numbers. See *Measurements* below. |
| `userNotes` | string | entry (create) | |
| `trainerNotes` | string | entry | |
| `internalNotes` | string | entry, report | |
| `status` | string | entry (update) | Free-form tenant status name. |
| `labels` | object[] | entry (update) | |
| `reportAction` | string enum | report | `update` · `approve` · `discard` |
| `reportId` | string | report | |
| `clientFacingSummary` | string | report | |
| `priority` | string | report | |
| `sections` | object | report | |
| `title` | string | note | |
| `content` | string | note | |
| `appointmentId` | string | note | |

#### Measurements - the numbers everything else is computed from

Keys, all optional, all **numbers** (a string `"80"` is discarded, not parsed):

`weightKg` · `bodyFatPercentage` · `muscleMassPercentage` · `leanMassPercentage` · `chestCm` ·
`waistCm` · `hipsCm` · `leftArmCm` · `rightArmCm` · `leftThighCm` · `rightThighCm` · `squat1rm` ·
`deadlift1rm` · `benchPress1rm` · `pullupsMax` · `kmTimeSeconds` · `vo2Max` · `sleepAverageHours`

`energy` · `mood` · `adherence` · `sleepQualityScore` are a **1-10 scale, not a percentage** - pass
8, not 80. Out of range is rejected outright.

- **Create** merges by client + date: a second check-in for the same day updates the first rather
  than duplicating. So re-recording a day is safe.
- **Update** (with `progressEntryId`) merges the keys you send over the existing ones - send only
  what you are correcting. Body-composition weights are recomputed from a new `weightKg`.
- Both paths echo the resulting `measurements`. Read it back; that is how you know the correction
  landed rather than assuming it.

`entry` create honors `clientId`/`entryDate`/`measurements`/`userNotes`/`trainerNotes`/
`internalNotes`; `entry` update honors `progressEntryId`/`status`/`trainerNotes`/`internalNotes`/
`labels`. Fields belonging to the other path are dropped.

---

### `manage_forms`

Required: `action`. 2 actions.

| Param | Type | Notes |
|---|---|---|
| `action` | string enum | **Required.** `create` · `update` |
| `formId` | string | Required for `update`. |
| `title` | string | |
| `description` | string | |
| `presentationType` | string | `SINGLE_PAGE` · `MULTI_PAGE` · `HABIT_TRACKING` · `PROGRESS_TRACKING` — **not** schema-validated; a bad value passes straight through. |
| `questions` | object[] | **Replaces the whole question array.** `get` the form first. See *Question rows* below. |
| `theme` | object | |
| `settings` | object | |

#### Question rows - and `mapTo`, which decides whether a check-in is analysable

**`mapTo` is the whole answers-to-measurements pipeline.** On submission, every answer carrying a
`mapTo` is written into the check-in's `measurements` (`WEIGHT` → `weightKg`, `WAIST` → `waistCm`,
…) - which is what every chart, trend and progress report reads. A question with **no** `mapTo` is
stored as text and is invisible to all of it. Build a weekly check-in without it and the form looks
perfect, collects diligently, and produces nothing you can plot. Set it on every question that
records a number; use `CUSTOM` for a qualitative question, `INFO` for a screen that asks nothing.

Both write paths return the resulting `questions` (id, type, title, mapTo) plus
`unmappedQuestionCount` - check it, it is how you catch this.

Row fields: `id` · `type` · `title` · `description` · `placeholder` · `required` · `purpose` ·
`options[{id,label}]` · `allowMultiple` · `maxRating` · `mapTo` · `pinned`.

`type` is one of `welcome` · `multiple_choice` · `picture_choice` · `yes_no` · `dropdown` ·
`short_text` · `long_text` · `legal` · `rating` · `upload_media` · `end_screen`. **There is no
`number` type** - a numeric field is `short_text` with `purpose: "number"`.

**Two families, two row shapes.** Questionnaires (`SINGLE_PAGE`, `MULTI_PAGE`) take full rows and
get welcome/end screens added automatically. Trackers (`PROGRESS_TRACKING` for weekly measurement
check-ins, `HABIT_TRACKING` for daily habits) take minimal rows - often just `{ mapTo, pinned }`,
no type or title - and get no bookends. Real accounts use both shapes; read the form you are
editing before assuming which.

**Keep each surviving question's `id`.** Submitted answers are stored against it, so replacing the
array with fresh ids orphans every past answer and loses that question's history.

Form reads go through `find` / `get`, never this verb.
