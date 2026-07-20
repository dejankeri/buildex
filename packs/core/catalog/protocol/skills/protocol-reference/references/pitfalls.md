# Pitfalls — how a successful-looking call goes wrong

Failure modes on this surface, worst first.

---

## 1. Parameter-name fidelity — the one that will actually bite you

**A wrong parameter key is not an error. It is silently dropped, and the call still returns
success.**

Every verb reshapes your input and forwards it to an internal layer that reads only the keys it was
built for. A key it doesn't recognize is ignored. Nothing validates that the field you sent
survived the trip. So:

> A plausible-looking, well-typed call can return HTTP 200 with no error while quietly doing less
> than you asked — sometimes far less. **Data loss looks exactly like success.**

This is the single highest-risk thing about operating Protocol. Treat parameter names as exact
strings copied from `mcp-surface.md`, never as things to guess, pluralize, or "correct" to whatever
seems more natural.

### Known concrete examples

| Verb | You pass | Internally it's called | What went wrong when they mismatched |
|---|---|---|---|
| `build_workout` | `exercises` | `groups` | The tree used to be forwarded as `exerciseGroups`. Create-only calls looked fine; every call that also passed exercises created a workout with **zero exercises** — silently, with a success response. |
| `find kind=media` | `query` | `name` (not `searchTerm`) | Most list surfaces filter on `searchTerm`; the media one filters on `name`. A media search silently returned the **entire** library unfiltered instead of matching. |

Both are fixed now. They are here because they show the shape of the failure, and because that
shape recurs.

`find` now defends against this generally by **double-forwarding**: `query` goes out as both
`searchTerm` and `name`, and `clientId` goes out as both `clientId` and `userId`. Every consumer
ignores the key it doesn't read, so nothing is lost either way. That redundancy is deliberate
insurance, not sloppiness — don't try to "clean it up" by picking one.

### The general defence — verify the write landed

**After any structural write, re-read the entity with `get` and check the field actually saved.**

```
build_workout { name, exercises: [...] }   →  returns { workoutId, workout }
get { kind: "workout", id: workoutId }     →  does the exercise tree have your groups in it?
```

Do this for: `build_workout.exercises`, `build_nutrition.items`, `build_program.phases` /
`.content`, `manage_forms.questions`, and any profile patch through `manage_client`. If a call
returns success but the entity you fetch afterward looks thin or empty, **suspect a dropped
parameter before concluding the data wasn't meant to save.**

Most write verbs already return the resolved entity in their response — read it rather than
assuming. If the returned entity doesn't reflect your input, the write did not do what you think.

---

## 2. Array fields REPLACE, they do not append

These parameters overwrite the entire collection with what you send. Anything you omit is deleted.

| Verb | Param | Replaces |
|---|---|---|
| `build_workout` | `exercises` | The whole exercise tree. |
| `build_nutrition` | `items` | The whole item tree. |
| `build_program` | `phases` | The whole phase list. |
| `build_program` | `content` | The whole content-collection set. |
| `manage_forms` | `questions` | The whole question array. |

**Always `get` the entity first**, merge your change into the existing array, and send the complete
result. Sending "just the new question" deletes every other question on the form — successfully,
with no warning.

The same holds at the storage layer: these are unvalidated jsonb blobs. Exactly what you send is
what is stored. A field renamed or nested one level wrong is not an error; it's simply absent on
the next read.

---

## 3. Filters that don't apply just no-op

`find`'s `status` / `isTemplate` / `clientId` / etc. are forwarded to whichever list surface the
`kind` maps to, and that surface ignores any filter it doesn't support. Passing `status` against a
kind that can't filter by status returns the **unfiltered** list, with no warning.

Don't trust that a result set was narrowed. If the count looks suspiciously like "everything",
it probably is — filter client-side or narrow by a filter you know that kind supports.

---

## 4. Pagination indexing is not consistent

Page indexing differs by resource family. **Media list endpoints are 0-indexed** (first page is
`page: 0`); most other families (exercises, workouts, programs, …) are **1-indexed** (first page is
`page: 1`).

Passing `page: 1` to a media list silently skips the first page's worth of results. Before assuming
an off-by-one is a bug, check which family you're in.

---

## 5. `review_client` is one call that replaces many

Don't fan out 8 reads to assemble a picture of a client. `review_client { clientId }` returns
`client`, `profiles`, `programs`, `nutrition`, `recentProgress`, `upcomingAppointments`,
`openTasks`, and `insights` in one call.

Each section is **null-safe**: a section that fails comes back `null` rather than failing the whole
bundle. So a `null` section means "that read failed or is empty" — it is not proof the client has
none of that thing. Re-read that one section with `find` if it matters.

Same pattern for the coach's side: `review_inbox` (default `action=overview`) bundles dashboard,
notifications, unread count, and insights, each independently null-safe.

---

## 6. Multi-step verbs stop at the first failure

A composite verb (e.g. `build_program` doing create → phases → content in sequence) **short-circuits
on the first failing step**. It does not roll back what already succeeded, and it does not apply
the rest.

So a failed `build_program` can leave a created-but-empty program behind. On a failure, `get` the
entity and find out how far it actually got before retrying — a blind retry may create a second
orphan.

---

## 7. A verb's schema does not validate everything downstream

Input validation runs once, against the verb's own top-level schema. The layer beneath is invoked
directly and its own required-field rules are **not** schema-enforced on that path.

Practical rule: **pass every field an action conceptually needs, even when the verb's schema
doesn't mark it required.** The clearest case is `schedule action=booking_config` — send
`sharedAvailabilities`, `globalSettings`, and `eventConfigurations` together.

Some enums are documented but not enforced, so a bad value passes straight through and is persisted
verbatim:

| Field | Enforced? |
|---|---|
| `build_workout.difficulty` / `.goal` | Yes — including on the `metadata` patch path. |
| `manage_forms.presentationType` | **No** — documented only. |
| `build_program.phases[].nutritionGoal` | **No** — `phases` is a bare object array. |

---

## 8. Action-specific fields are dropped by the other actions

Multi-action verbs read only the fields that action uses:

- `record_progress action=report` with `reportAction: approve` or `discard` **ignores the edit
  fields** (`clientFacingSummary`, `sections`, …). To change *and* approve, call
  `reportAction: update` first, then approve as a second call.
- `record_progress action=entry` splits by path: create reads `clientId` / `entryDate` /
  `measurements` / `userNotes` / `trainerNotes` / `internalNotes`; update reads `progressEntryId` /
  `status` / `trainerNotes` / `internalNotes` / `labels`. Fields from the other path vanish.
- `build_nutrition.metadata` honors only `name` / `description` / `tags` / `templateMode`. Other
  keys in the patch are dropped by design.
- `manage_media action=update_share` cannot change `shareType`. Recreate the share to re-type it.

---

## 9. Two things that look like bugs but are not

- **`assign_program action=assign` leaves `templateId` null.** The deep copy is deliberately
  independent of its source template. Do not "repair" it.
- **`manage_client`'s `lifecycleStage` sub-object manages the tenant's stage *list*, not one
  client's stage.** To move a single client, use the top-level `lifecycleStageId`. To add / rename /
  reorder the pipeline columns, use `lifecycleStage: { action, ... }`. Confusing the two rewrites
  the wrong thing entirely.

Related: response envelopes are intentionally quirky in places (a not-found that returns a
success-shaped body with `data: false` or `null`). An inconsistent-looking response is often
preserved-on-purpose behavior, not an error to route around.

---

## 10. Don't reach past the verbs to work around a wall

If a verb can't express what the coach asked, the answer is **not** to find a lower-level route
around it. Two legitimate moves:

1. Do it a different way within the 18 verbs.
2. Tell the coach plainly what you couldn't do and offer `report_to_developers`.

Faking a result, or quietly performing a walled action through some other path, is the failure this
whole reference exists to prevent.
