---
name: _template
description: Copy this directory to create a new BuildEx skill (a verb). Replace this description with a one-line, trigger-oriented summary - "Use when …" - so the agent knows exactly when to reach for it. Delete this line.
---

# <skill name> - <what verb this performs>

<One paragraph: what this skill does and why it exists, in the operator's terms.>

## When to use

- <Concrete trigger 1.>
- <Concrete trigger 2.>

## Steps

1. <First action.>
2. <Second action.>

## Rules

- <Invariants this verb must honor - e.g. gated actions surface an approval; nothing secret leaves
  the keychain; deviations are captured via capture-decision.>

<!--
Skill-authoring notes (delete before shipping a real skill):
- Skills are BuildEx's "verbs". Product verbs ship in packs/core/skills/ (in the core content pack); repo-
  operating verbs live here in .claude/skills/.
- Precedence at runtime is private > team > core. Keep each skill single-purpose.
- The description is what triggers discovery - make it specific and trigger-oriented.
-->
