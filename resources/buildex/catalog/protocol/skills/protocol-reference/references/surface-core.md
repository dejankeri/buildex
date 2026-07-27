# Protocol MCP surface - core: reading, and the replace grammar

The two read verbs every job starts with, the entity kinds they reach, and the shared write
grammar that array parameters follow across the whole surface. **Read this one first** - the
domain files assume it.

> **One of four.** The surface is split by the job you are doing, so you read the part you need
> rather than all 18 verbs:
>
> | File | Verbs |
> |---|---|
> | `surface-core.md` | `find` · `get` · the kind table · the replace grammar · `report_to_developers` |
> | `surface-programming.md` | `build_program` · `build_workout` · `build_nutrition` · `assign_program` · `manage_library` |
> | `surface-clients.md` | `manage_client` · `record_progress` · `manage_forms` · `review_client` · `message` |
> | `surface-operations.md` | `manage_tasks` · `manage_media` · `schedule` · `manage_automations` · `review_inbox` |


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
| `schedule` | write* | Appointments, check-in reminders, booking config, send a reminder now. |
| `manage_automations` | write* | Build/operate automations; `run` dispatches an execution now. |

\* **Tiers are per-ACTION on these two.** The verbs themselves list at `write`, because all but a
few of their actions are ordinary internal writes - booking an appointment, reading the booking
config, authoring an automation. Three actions reach a client and need a `send` key:
`schedule action=send_reminder` (fires now), `schedule action=reminder` (arms a recurring push),
and `manage_automations action=run` (dispatches an execution whose post-actions can email or
WhatsApp). A call above your tier is refused **by action name**, so report the one call you could
not make rather than the whole verb.

---

## Read tier

---

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

---

### `get` — fetch one entity by id

Required: `kind`, `id`.

| Param | Type | Notes |
|---|---|---|
| `kind` | string | **Required.** One of the 17 `get` kinds below. |
| `id` | string (uuid) | **Required.** The entity id. `get` maps it onto the right id param for you. |

---

### Paging, and knowing what you did not read

Every `find` carries `limit` (default 20-25, max 50-100 by kind) and, on the paged kinds, `offset`.
A paged response tells you where you stand:

```
{ kind, count, total, hasMore, nextOffset, items: [...] }
```

**Loop while `nextOffset` comes back**, passing it as the next `offset`. `total` is the real count,
so "86 check-ins, I read all 86" is a statement you can make honestly. Paged today: `progress`,
`task`, `appointment`, plus the kinds that already had it (`client`, `form`, `automation`, `media`,
`report`, `submission`, `automation_run`).

On kinds without paging there is no `total`, and the response falls back to a warning instead:
`defaultLimitApplied` (you set no limit, so a default cap applied) or `truncated` (you got exactly
the number you asked for, so there are probably more). Both mean *you are not looking at
everything* — raise the limit, or say what you covered.

Never describe a trend, a count, or "all of X" from a response carrying `hasMore: true`,
`truncated`, or `defaultLimitApplied`.

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

---

### The replace grammar (`phases`, `items`, `groups`)

Three verbs take a list that **replaces** an existing tree: `build_program.phases`,
`build_nutrition.items`, `build_workout.groups`. They share one grammar, and getting it wrong used
to delete the operator's work silently.

**Every row needs exactly one control key:**

| Key | Means |
|---|---|
| `add` | Create this row. **`build_program`: `add: true` (boolean).** `build_nutrition`: `add: "MEAL"` / `"LABEL"` / `"GROUP"` / `"SUPPLEMENT"` (the row type). |
| `ref` | Keep this existing row, and its children, exactly as they are. Takes the row's id. |
| `modify` | Patch this existing row. Takes the row's id. |

A row with none of the three is **rejected**. The list you send becomes the entire tree, so:

> **Editing something that already exists? `get` it first, and send `{ ref: <id> }` for every row
> you are keeping.** Omitting a row deletes it.

If every row is rejected, the write is now refused and nothing is saved — the server returns an
error naming the missing control key, and the existing content survives. Read the error and resend
with control keys; do not create a second record.

A *partial* failure still applies, and the response carries `failCount` and `entries`. Check it: a
plan that came back with `failCount: 2` is missing two rows you thought you wrote.

---

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
