---
name: gdrive-file
description: Use when the operator asks you to create, update, or share a file in Google Drive - draft a doc, save something, change who can access it - so file and sharing changes go through a reviewed action.
---

# gdrive-file - create, update, or share a Drive file

Turn a request into a concrete Google Drive action, proposed for the operator's approval.

## When to use

- The operator says "put this in Drive", "update the … doc", "share the folder with…".

## Steps

1. Search first (see gdrive-find) to avoid duplicating an existing file - update it if it exists.
2. State the action: which file, what content changes, and (for sharing) exactly who gets what access.
3. Propose it; creating, editing, or re-sharing is outward, so it surfaces as an approval card - wait.
4. After approval, link the file and confirm any sharing change you made.

## Rules

- Changing sharing or access is human-gated - widening who can see a file is easy to get wrong. Never batch around it.
- Prefer updating the canonical file over creating near-duplicates; keep the operator's content, don't rewrite it.
