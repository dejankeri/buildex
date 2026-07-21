---
name: protocol-onboard-client
description: Use when the operator wants to add a new client to Protocol, fill in someone's intake details, or move a client to a different lifecycle stage - so the record is complete enough for programming instead of a bare name.
---

# protocol-onboard-client - create a client worth programming for

A client record with only a name is not useful. Onboarding means the profiles are filled in well
enough that a program can actually be built from them.

## When to use

- "Add a new client", "set up Marcus", "put her intake into Protocol"
- "Move him to active", "she's a lead now" - lifecycle stage changes.

## Steps

1. Check the person does not already exist: `find` with `kind: "client"` and their name. Duplicate
   clients are painful to merge later.
2. Create the record with `manage_client` using its `create` object.
3. Fill in whichever of the four profiles the operator gave you material for - health, fitness,
   nutrition, behavioural. These are separate sub-resources on the same call; see
   `../protocol-reference/references/data-model.md`.
4. Set the lifecycle stage if the operator named one.
5. Read the client back with `review_client` and tell the operator what is still missing before a
   program can be built - do not quietly leave gaps.

## Rules

- Never invent intake data. If the operator did not give you a training age, a goal, or an injury
  history, leave the field empty and say which ones you left.
- Ask before creating a client whose name closely matches an existing one.
- Client creation is a write, not an outward action - it runs autonomously. Nothing here messages the
  client.
