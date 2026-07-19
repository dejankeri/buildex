---
name: gdrive-find
description: Use when you need to find or read a file in Google Drive - a doc, sheet, or folder - before answering or acting, so you work from what's actually in the file not memory.
---

# gdrive-find - find the file in Drive

Pull the relevant Google Drive file into the conversation before you reason about it.

## When to use

- The operator asks about something that likely lives in Drive (a doc, a sheet, a shared folder).
- You are about to update or share a file and need the current version first.

## Steps

1. Search Drive for the file or folder with the Google Drive tools; prefer the most recent match.
2. Open the top hit and read its contents before summarizing - don't answer from the filename alone.
3. If several files match, list them briefly and ask which one rather than guessing.
4. Link the file you used so the operator can open it.

## Rules

- Reading Drive is safe and runs freely; **creating, editing, or changing sharing** on a file waits
  for the operator's approval - never widen access or overwrite content unattended.
