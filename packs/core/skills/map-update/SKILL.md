---
name: map-update
description: Use when the workspace has grown or been reorganized and the living map of areas and their relationships should be refreshed so the team can see the shape of what they know.
---

# map-update - refresh the living map

Regenerates the human-readable map of the company's knowledge - its areas, key documents, and how
they link - so the team can navigate the brain by shape, not just by folder.

## When to use

- After a `tidy`, a backfill, or a burst of new documents.
- When someone can't find where a topic lives.

## Steps

1. Walk the workspace, following `[[wikilinks]]` and document references.
2. Group documents into areas and note the hubs each area connects to.
3. Write the map to `maps/overview.md` as readable markdown (the deterministic view is derived).
4. Flag orphaned documents that nothing links to.

## Rules

- The map is rendered from repo state - deterministic, never invented.
- Describe what exists; do not restructure files here (that's `tidy`).
