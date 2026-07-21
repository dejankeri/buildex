# Teach the agent a verb (a skill)

A **skill** (a "verb") is a repeatable task you teach your agent once and run on demand — *draft the
weekly review*, *triage the inbox*, *prep a client proposal*. Skills are plain markdown files in your
brain, so they're versioned, editable, and shared with your team like everything else.

## The fastest way: the Teach button

1. Open the **Skills** panel (right rail).
2. Click **+ Teach**.
3. Describe the verb in plain language — what it does and when to use it.
4. Save. It appears as a card with **Run** and **Edit**.

**Run** creates a session, opens a chat, and prefills the verb so the agent carries it out — gated at
any outward action, like every turn.

## What a skill actually is

A skill is a `SKILL.md` file at `<root>/skills/<name>/SKILL.md` in a writable repo (your team or
private brain). It has YAML frontmatter and a markdown body:

```markdown
---
name: weekly-review
description: Use when the operator asks for the weekly review — so it's grounded in the brain, not invented.
---

# weekly-review — write this week's review from the brain

## When to use
- The operator says "weekly review", "what happened this week", or it's Friday.

## Steps
1. Read the recent decisions, meeting notes, and metrics.
2. Draft: wins, risks, and next week's three moves — short and concrete.
3. Save it under meetings/ and summarize what you wrote.

## Rules
- Ground every claim in a file; never invent numbers.
- Writing to the brain is fine; the sharp edges — messaging people, publishing, spending — wait for approval.
```

Because it's just a file, you can also create or edit it in any editor and commit it — the agent
picks it up on the next sync. The `description` is what the agent reads to decide *when* the verb
applies, so make it a crisp "use when …".

