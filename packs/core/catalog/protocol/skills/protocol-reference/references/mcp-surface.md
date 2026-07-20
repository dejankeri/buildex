# Protocol MCP surface — the 18 verbs

The whole served surface is **exactly 18 intent verbs**. There are no other tools. Each verb
reshapes your input and forwards it to Protocol's internal layer, so **parameter names are exact** —
see `pitfalls.md` for why a wrong key is worse than an error.

Transport: MCP over remote HTTP, one route (`POST /mcp`), stateless — no session state survives
between calls. Auth is a per-coach key; every call runs tenant-scoped to that one coach.

Tiers are cumulative: `read` < `write` < `send`. A call above the key's tier is **denied with an
explicit error** naming the required tier — not silently dropped. Don't retry it.

## Verb index

| Verb | Tier | Purpose |
|---|---|---|
| `find` | read | List/search entities of one kind. |
| `get` | read | Fetch one entity by id, full detail. |
| `review_client` | read | One-call full picture of a single client. |
| `message` | read | Read conversations/messages. Does **not** send. |
| `manage_client` | write | Create/update a client, its stage, trainer, and 4 profiles. |
| `build_program` | write | Create/edit a program's structure (metadata, phases, content). |
| `assign_program` | write | Assign (deep-copy) a program to a client, or flip its lifecycle. |
| `build_workout` | write | Create/edit a workout: metadata + full exercise tree. |
| `build_nutrition` | write | Create/edit a nutrition template: metadata + full item tree. |
| `record_progress` | write | Check-in entry, progress-report triage, or meeting note. |
| `manage_library` | write | Custom exercises; batch-resolve food names. |
| `manage_forms` | write | Create/update an intake / check-in / assessment form. |
| `manage_tasks` | write | The whole kanban surface (tasks, subtasks, boards, columns, labels). |
| `manage_media` | write | Media library: attach, edit, categorize, share. |
| `review_inbox` | write | The coach's "what needs me" bundle + triage flips. |
| `report_to_developers` | write | Escalate a gap. Emails a fixed internal inbox, never a client. |
| `schedule` | send | Appointments, check-in reminders, booking config, send a reminder now. |
| `manage_automations` | send | Build/operate automations; `run` dispatches an execution now. |

Only two verb+action pairs carry an outward path: `schedule action=send_reminder` and
`manage_automations action=run`. That is the entire reason the `send` tier exists.

---

## Read tier

### `find` — list/search one kind

Required: `kind`.

| Param | Type | Notes |
|---|---|---|
| `kind` | string | **Required.** One of the 23 kinds below. |
| `query` | string | Free-text search (where the kind supports it). |
| `clientId` | string | Filter to one client (where supported). |
| `formId` | string | `kind=submission`. |
| `isTemplate` | boolean | Templates vs client-assigned (program / workout / nutrition). |
| `status` | string | Status filter (where supported). |
| `limit` | number | Result cap. |
| `muscleGroup` | string | `kind=exercise` — primary muscle group (e.g. CHEST, BACK, THIGHS). |
| `exerciseType` | string | `kind=exercise` — STRENGTH, CARDIO, FLEXIBILITY, … |
| `difficultyLevel` | string | `kind=exercise` — BEGINNER … ELITE. |
| `isCompound` | boolean | `kind=exercise` — compound (true) vs isolation (false). |
| `automationId` | string | `kind=automation_run` — **required for that kind**. |
| `specialPurpose` | string | `kind=submission` — CHECK_IN, INITIAL_QUESTIONNAIRE, SURVEY, OTHER. |

Filters that a given kind's underlying list doesn't support are **ignored silently** — you get the
unfiltered list, not an error.

### `get` — fetch one entity by id

Required: `kind`, `id`.

| Param | Type | Notes |
|---|---|---|
| `kind` | string | **Required.** One of the 17 `get` kinds below. |
| `id` | string (uuid) | **Required.** The entity id. `get` maps it onto the right id param for you. |

### `find` / `get` kind table

23 `find` kinds; `get` covers a 17-kind subset. The 6 list-only kinds have **no by-id fetch**.

| kind | `find` | `get` | id param used internally |
|---|---|---|---|
| `client` | ✓ | ✓ | `clientId` |
| `program` | ✓ | ✓ | `programId` |
| `workout` | ✓ | ✓ | `workoutId` |
| `nutrition` | ✓ | ✓ | `templateId` |
| `exercise` | ✓ | ✓ | `exerciseId` |
| `food` | ✓ | ✓ | `foodId` |
| `appointment` | ✓ | ✓ | `appointmentId` |
| `form` | ✓ | ✓ | `formId` |
| `task` | ✓ | ✓ | `taskId` |
| `board` | ✓ | ✓ | `boardId` |
| `automation` | ✓ | ✓ | `automationId` |
| `progress` | ✓ | ✓ | `progressEntryId` |
| `purchase` | ✓ | ✓ | `purchaseId` |
| `media` | ✓ | ✓ | `mediaId` |
| `report` | ✓ | ✓ | `reportId` |
| `submission` | ✓ | ✓ | `submissionId` |
| `transcript` | ✓ | ✓ | `transcriptId` |
| `conversation` | ✓ | — | list-only |
| `lifecycle_stage` | ✓ | — | list-only |
| `lab` | ✓ | — | list-only |
| `health_metric` | ✓ | — | list-only |
| `automation_run` | ✓ | — | list-only; requires `automationId` |
| `automation_kind` | ✓ | — | list-only; the kind catalog, takes no params |

Remember: on `get` you always pass the id as **`id`**, never as `clientId`/`programId`/etc. The
right-hand column is what happens internally, not what you send.

### `review_client` — the client bundle

Required: `clientId`.

| Param | Type | Notes |
|---|---|---|
| `clientId` | string | **Required.** |

Returns one object: `client`, `profiles`, `programs`, `nutrition`, `recentProgress`,
`upcomingAppointments`, `openTasks`, `insights`. Each section is null-safe — a section that fails
comes back `null` rather than failing the whole call. Prefer this over 8 separate `find` calls.

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

### `build_program`

No required params (omit `programId` to create).

| Param | Type | Notes |
|---|---|---|
| `programId` | string | Edit this program; omit to create. |
| `name` | string | |
| `userId` | string | Assign to a client; omit for a library template. |
| `programType` | string enum | `WORKOUT` · `NUTRITION` · `FULL` |
| `sections` | string[] | Plan sections. |
| `phases` | object[] | Weekly phases (one phase = one week). **Replaces the phase list.** |
| `content` | object | `{ collections: [...] }` — replaces program content. |
| `metadata` | object | Partial metadata patch (name / description / programGoal / programType / sections / …). |
| `importWorkoutId` | string | Import this workout into the library. |
| `duplicatePhaseId` | string | Duplicate this phase within the program. |

Copying/assigning to a client is `assign_program`, not this verb.

`phases[].nutritionGoal` values: `AGGRESSIVE_DEFICIT` · `DEFICIT` · `MINOR_DEFICIT` ·
`MAINTENANCE` · `MINOR_SURPLUS` · `SURPLUS`. This one is **not** schema-validated — a bad value is
persisted verbatim.

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

`assign` produces an **independent deep copy** — its `templateId` stays null by design. That is not
a bug to correct.

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
| `exercises` | object[] | The exercise groups. **Replaces the whole tree.** |
| `metadata` | object | Partial metadata patch (name / difficulty / goal / …). |

The param is `exercises` — not `groups`, not `exerciseGroups`. Both enum values are also re-checked
on the `metadata` patch path, so a bad `metadata.difficulty` gives a clean error.

### `build_nutrition`

No required params (omit `templateId` to create).

| Param | Type | Notes |
|---|---|---|
| `templateId` | string | Edit this template; omit to create. |
| `name` | string | |
| `userId` | string | Assign to a client; omit for a library template. |
| `items` | object[] | The full flat item tree (LABEL headers + MEAL food rows). **Replaces the tree.** |
| `metadata` | object | Partial patch. Only `name` / `description` / `tags` / `templateMode` are honored. |

`metadata.templateMode`: `ADVANCED` (default — a "My Daily Nutrition" day plan) · `SIMPLE` (a
"My Meals/Recipes" entry). Pass it at create time so the template lands in the right place.
Macros are computed for you — don't hand-total them.

### `record_progress`

Required: `action`. 3 actions.

| Param | Type | Action | Notes |
|---|---|---|---|
| `action` | string enum | — | **Required.** `entry` · `report` · `note` |
| `progressEntryId` | string | entry | Update this check-in; omit to create. |
| `clientId` | string | entry, note | |
| `entryDate` | string | entry (create) | `YYYY-MM-DD` |
| `measurements` | object | entry (create) | |
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

`entry` create honors `clientId`/`entryDate`/`measurements`/`userNotes`/`trainerNotes`/
`internalNotes`; `entry` update honors `progressEntryId`/`status`/`trainerNotes`/`internalNotes`/
`labels`. Fields belonging to the other path are dropped.

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

### `manage_forms`

Required: `action`. 2 actions.

| Param | Type | Notes |
|---|---|---|
| `action` | string enum | **Required.** `create` · `update` |
| `formId` | string | Required for `update`. |
| `title` | string | |
| `description` | string | |
| `presentationType` | string | `SINGLE_PAGE` · `MULTI_PAGE` · `HABIT_TRACKING` · `PROGRESS_TRACKING` — **not** schema-validated; a bad value passes straight through. |
| `questions` | object[] | **Replaces the whole question array.** `get` the form first. |
| `theme` | object | |
| `settings` | object | |

Form reads go through `find` / `get`, never this verb.

### `manage_tasks`

Required: `action`. 16 actions.

`create_task` · `update_task` · `complete_task` · `move_task` · `archive_completed` ·
`create_subtask` · `update_subtask` · `toggle_subtask` · `reorder_subtasks` · `create_board` ·
`update_board` · `create_column` · `update_column` · `reorder_columns` · `create_label` ·
`update_label`

Everything except `action` is forwarded verbatim; pass the fields that action needs.

| Param | Type | Typically used by |
|---|---|---|
| `taskId` | string | task + subtask actions |
| `subtaskId` | string | update_subtask, toggle_subtask |
| `subtaskIds` | string[] | reorder_subtasks |
| `boardId` | string | board + column actions |
| `columnId` | string | move_task, update_column |
| `columnIds` | string[] | reorder_columns |
| `labelId` | string | update_label |
| `title` | string | tasks / subtasks |
| `name` | string | boards / columns / labels |
| `description` | string | tasks |
| `dueAt` | string | tasks — `YYYY-MM-DD` |
| `clientId` | string | tasks |
| `assigneeId` | string | tasks / subtasks |
| `isDone` | boolean | toggle_subtask |
| `position` | integer | move_task, columns |
| `color` | string | labels / columns / boards |
| `icon` | string | boards |
| `wipLimit` | integer | columns |
| `isDoneColumn` | boolean | columns |
| `isArchived` | boolean | boards |
| `defaultColumns` | string[] | create_board |

Task/board reads go through `find` (`kind=task`, `kind=board`) and `get`.

### `manage_media`

Required: `action`. 6 actions.

| Param | Type | Notes |
|---|---|---|
| `action` | string enum | **Required.** `attach` · `update` · `create_category` · `update_category` · `share` · `update_share` |
| `mediaId` | string | |
| `categoryId` | string | |
| `shareId` | string | |
| `url` | string | `attach`: the hosted asset URL. There is no raw upload path. |
| `name` | string | Also the free-text filter key on `find kind=media`. |
| `type` | string | `IMAGE` · `VIDEO` · `AUDIO` · `FILE` · `DOCUMENT` · … |
| `thumbnailUrl` | string | |
| `userId` | string | Assign media / scope a category to this client. |
| `categoryIds` | string[] | |
| `color` | string | |
| `iconEmoji` | string | |
| `order` | integer | |
| `parentId` | string | Nested category. |
| `description` | string | |
| `shareType` | string enum | `PUBLIC` · `USER_SPECIFIC` — **create only**; `update_share` cannot re-type a share (recreate it). |
| `sharedWithUserIds` | string[] | |
| `permission` | string enum | `READ` · `WRITE` |
| `expiresAt` | string | ISO datetime. |
| `isActive` | boolean | |

Shares never send an email.

### `review_inbox`

No required param — `action` defaults to `overview`. 5 actions.

| Param | Type | Notes |
|---|---|---|
| `action` | string enum | `overview` (default) · `mark_read` · `mark_all_read` · `dismiss_insight` · `mark_insight_read` |
| `notificationId` | string | `mark_read` |
| `insightId` | string | `dismiss_insight`, `mark_insight_read` |

`overview` returns `{ dashboard, notifications, unreadCount, insights }`, each section null-safe.

### `report_to_developers`

Required: `summary`.

| Param | Type | Notes |
|---|---|---|
| `summary` | string | **Required.** What you could not do, and why. |
| `goal` | string | What the coach was trying to achieve. |
| `toolOrArea` | string | The verb or product area involved. |
| `error` | string | Exact error text, if any. |

Emails a fixed internal inbox — never a client. Only call it after the coach agrees.

---

## Send tier

### `schedule`

Required: `action`. 7 actions.

| Param | Type | Action | Notes |
|---|---|---|---|
| `action` | string enum | — | **Required.** `create` · `update` · `cancel` · `reminder` · `booking_config` · `gcal_disconnect` · `send_reminder` |
| `appointmentId` | string | update, cancel, send_reminder | |
| `title` | string | create, update, reminder | |
| `startTime` | string | create, update, reminder | ISO-8601 instant. |
| `endTime` | string | create, update | ISO-8601 instant. |
| `clientId` | string | create, reminder | |
| `type` | string | create, update | |
| `modality` | string | create, update | |
| `location` | string | create, update | |
| `description` | string | create, update, reminder | |
| `status` | string | update | |
| `formId` | string | reminder | The check-in form the reminder asks for. |
| `recurrenceRule` | string | reminder | |
| `responseWindowHours` | number | reminder | |
| `reminderHoursBefore` | number | reminder | |
| `reminderType` | string | reminder | |
| `read` | boolean | booking_config | `true` reads the config instead of writing it. |
| `trainerId` | string | booking_config | |
| `bookingUrlSlug` | string | booking_config | |
| `sharedAvailabilities` | object[] | booking_config | |
| `globalSettings` | object | booking_config | |
| `eventConfigurations` | object[] | booking_config | |

`booking_config` write: pass `sharedAvailabilities`, `globalSettings`, **and**
`eventConfigurations` together — the write path expects all three even though the verb's own schema
does not mark them required. `globalSettings.maximumAdvanceDays` is restricted to
`7` · `14` · `30` · `60` · `90` to stay in lock-step with the coach dashboard's own preset picker.

`send_reminder` is outward — it reaches the client. Confirm before firing it.

### `manage_automations`

Required: `action`. 6 actions.

| Param | Type | Notes |
|---|---|---|
| `action` | string enum | **Required.** `create` · `update` · `activate` · `pause` · `archive` · `run` |
| `automationId` | string | Required for everything except `create`. |
| `name` | string | `create` |
| `kind` | string | `create` — enumerate valid kinds via `find kind=automation_kind`. |
| `config` | object | Kind-specific config. |
| `triggerConfig` | object | Kind-specific trigger config. |
| `triggerData` | object | `run`: kind-specific trigger payload. |

`create` lands the automation in DRAFT. `run` **dispatches an execution now** — outward. Read a
run's outcome with `find kind=automation_run` + `automationId`.
