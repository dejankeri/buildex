# packs/core - the product content

This is **the OS content shipped into every company's `core` repo** (read-only for operators).

| Dir | Holds |
|---|---|
| `rules/` | operating rules assembled into the workspace agent config |
| `conventions.md` | the base conventions document (companies extend it) |
| `skills/` | the generic verbs: `capture-decision`, `tidy`, `weekly-review`, `map-update`, `new-client`, `content-draft` |
| `policy/` | the allow/ask/deny preset shipped into every workspace |
| `knowledge/` | the method, guardrails, connector filing recipes |
| `templates/` | engagement artifacts + the mini-app starter |

Not to be confused with `.claude/` at the repo root, which is BuildEx's *own* kernel for operating on
this monorepo. `packs/core` is the product; `.claude/` is the dogfood.
