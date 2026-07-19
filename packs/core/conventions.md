# Conventions - how this company's brain is organized

> This is the base convention set every BuildEx workspace starts with. Companies extend it; they never
> have to start from a blank page. Structure lives here, in readable prose the agent follows - not
> in a database or a schema.

## The shape of the brain

- **Plain markdown, everywhere.** Every document is a `.md` file an agent (or a person) can read in
  any editor, forever. Optional light YAML frontmatter is fine; nothing requires it.
- **Areas are folders.** Group by what the company does: `strategy/`, `clients/`, `finance/`,
  `people/`, `product/`, `content/`, `decisions/`, `reviews/`, `maps/`. Add areas as needed.
- **One idea per file.** Prefer many small, linkable documents over few large ones. Link with
  `[[wikilinks]]` (by filename) or `[text](relative/path.md)`.
- **Nothing is deleted.** Supersede and archive. History is the audit trail; git keeps it.

## Filing incoming material

- Connector material lands under `sources/<connector>/` with provenance frontmatter (source, id,
  timestamp, link). Treat it as raw input, not the brain - the `tidy` verb files what matters into
  the areas above, on the team's terms.
- Keep provenance intact when you move something out of `sources/`.

## Decisions

- Non-obvious calls go in `decisions/log.md` via the `capture-decision` verb, in the same session.
- A decision that changes an earlier one supersedes it with a new dated entry; the old stays.

## Voice

- Plain, specific, honest. Name things by what people recognize. Prefer the concrete true detail
  over the clever line. This voice carries into anything the `content-draft` verb produces.

## Safety

- Reads and drafts flow freely. Anything **outward or irreversible** - sending, publishing,
  posting, deleting - waits for a human tap (the policy preset makes this automatic).
