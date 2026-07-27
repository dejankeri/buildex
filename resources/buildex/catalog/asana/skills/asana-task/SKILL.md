---
name: asana-task
description: Use when the operator asks you to capture work into Asana - create a task, set a due date, assign to a project - so it lands in the workspace in a clear, reviewable shape.
---

# asana-task - create or update an Asana task

Turn a request into a well-formed Asana task, proposed for the operator's approval.

## When to use

- The operator says "make a task for…", "assign this to…", "set a due date on…".

## Steps

1. Search first (see asana-search) to avoid duplicating an existing task - update it if it exists.
2. Draft the task: a clear name, a short note with the why, the right project and due date.
3. Propose the create/update; it is an outward change, so it surfaces as an approval card - wait.
4. After approval, share the task link and note what you set.

## Rules

- Prefer updating an existing task over creating a near-duplicate.
- Don't invent assignees or dates; leave what you don't know for the operator to fill.
