---
name: new-client
description: Use when the company takes on a new client or account and you want their space set up consistently - folder, key facts, and the first working docs - the way every other client is.
---

# new-client - stand up a new client space

Creates a consistent home for a new client or account so nothing about them lives in someone's head
or inbox.

## When to use

- A new client, customer, or account is starting.
- An existing relationship needs a proper home in the brain.

## Steps

1. Create `clients/<slug>/` with `profile.md` (who they are, the deal, key contacts, constraints).
2. Add `clients/<slug>/decisions.md` and `clients/<slug>/notes.md`.
3. Pull any existing material from `sources/` about them into the folder, with provenance kept.
4. Note the next action and owner.

## Rules

- One slug per client, stable over time (never rename churn).
- Nothing sensitive beyond what the brain already holds; respect the client's confidentiality.
- Outreach or contracts are outward actions - draft only, never send.
