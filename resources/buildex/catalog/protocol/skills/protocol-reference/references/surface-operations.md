# Protocol MCP surface - running the practice

The calendar, the kanban, the media library, the inbox, and automations - the operational half
that is not about one client's programming. Assumes `surface-core.md`.

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

**Labels.** `create_label` makes one (name + color, both required); `find kind=task_label` lists
them; `labelIds` on create_task/update_task puts them ON a task, replacing whatever was there. Ids
that do not resolve are skipped silently by the service, so the write reports back
`unresolvedLabelIds` — check it. Filter by them with `find kind=task labelIds=[...]`.

**Assignees.** A task can have several: `assigneeIds` replaces the set, `assigneeId` is a
one-owner convenience. Unresolved ids come back as `unresolvedAssigneeIds`. Subtasks take a single
`assigneeId`.

**The filters that answer the usual questions.** `find kind=task` takes `isOverdue` ("what's
late?"), `assigneeId` ("what's on Ana's plate?"), `labelIds`, `dueAfter`/`dueBefore`, `priority`,
`columnId`, `boardId`, `isArchived` and a free-text `searchTerm` that also matches label names.

**`title` names a task or subtask; `name` names a board, column or label.** Send the wrong one and
it is silently dropped - the write returns success and nothing changes. `create_task` also needs a
`boardId` or a `columnId`; a title alone is refused. The per-action parameter list is published on
the `action` enum - read it rather than guessing, because anything an action does not read is
dropped rather than rejected. `reorder_subtasks` / `reorder_columns` take the COMPLETE id list.

---

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

`categoryIds` **replaces** the media's category set. To add one more folder, `get` the media, send
all its existing ids plus the new one - otherwise you quietly unfile it from the rest.

---

### `review_inbox`

No required param — `action` defaults to `overview`. 5 actions.

| Param | Type | Notes |
|---|---|---|
| `action` | string enum | `overview` (default) · `mark_read` · `mark_all_read` · `dismiss_insight` · `mark_insight_read` |
| `notificationId` | string | `mark_read` |
| `insightId` | string | `dismiss_insight`, `mark_insight_read` |
| `insightLimit` | number | `overview`: how many insights (default 25, max 200), highest priority first. |

`overview` returns `{ dashboard, notifications, unreadCount, insights, insightsTotal,
insightBreakdown }`, each section null-safe. **`insights` is the top 25, not all of them** - a real
account had 518. `insightsTotal` and `insightBreakdown` (counts by type and severity) describe the
whole set, so describe the pile honestly - "518 active, mostly plateau warnings, here are the 25
that matter" - rather than reporting 25 as if it were everything. Raise `insightLimit` only when
you are genuinely working the whole list; it is the most expensive read on the surface.

---

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
| `sharedAvailabilities` | object[] | booking_config | `{dayOfWeek 1-7, startTime "HH:MM:SS", endTime, timezoneId, isActive}`. Full replace — **omit to preserve**. |
| `globalSettings` | object | booking_config | |
| `eventConfigurations` | object[] | booking_config | |

`booking_config` write: pass `sharedAvailabilities`, `globalSettings`, **and**
`eventConfigurations` together — the write path expects all three even though the verb's own schema
does not mark them required. `globalSettings.maximumAdvanceDays` is restricted to
`7` · `14` · `30` · `60` · `90` to stay in lock-step with the coach dashboard's own preset picker.

`send_reminder` is outward — it reaches the client. Confirm before firing it.

#### Recurring check-ins, and the booking page

`action: "reminder"` is how a weekly check-in gets scheduled: `clientId` + `formId` + `startTime`
(the FIRST occurrence) + `recurrenceRule`, an iCal RRULE - `FREQ=WEEKLY;BYDAY=MO`, or
`FREQ=WEEKLY;INTERVAL=2;BYDAY=FR` for fortnightly. Defaults: `responseWindowHours` 48,
`reminderHoursBefore` 0 (fires at the occurrence), `reminderType` PROGRESS_CHECK_IN.

`action: "booking_config"` writes the coach's **public** booking page. **Read it first**
(`read: true`). `globalSettings` is merged, so send only the keys you are changing;
`sharedAvailabilities` and `eventConfigurations` are whole-array replaces, so **omit them unless
you mean to rewrite them** - a real coach has ~66 availability slots and a short list deletes the
rest. `maximumAdvanceDays` must be one of 7 / 14 / 30 / 60 / 90.

`modality` is closed: `IN_PERSON` · `VIRTUAL` · `HYBRID` · `ASYNCHRONOUS`.

**Only `send_reminder` is outward.** Everything else on this verb is a plain write and works on a
write-tier key.

---

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
`PROGRESS_REPORT` is the one registered kind (triggers `PROGRESS_ENTRY_CREATED` and `MANUAL`);
confirm with `find kind=automation_kind` before assuming another exists. `run` needs
`triggerData` - for PROGRESS_REPORT that is `{ entryId: "<progress entry uuid>" }`. **`run` is the
only outward action here** and it is approval-gated, so getting the payload wrong spends the
operator's tap for nothing. Authoring (create/update/activate/pause/archive) is a plain write.
Read what an execution actually did with `find kind=automation_run`.
