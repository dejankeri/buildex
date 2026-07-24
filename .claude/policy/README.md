# .claude/policy - the allow/ask/deny model (dogfood of invariant 5)

This directory documents buildex's own operating policy. The enforceable form lives in  
`.claude/settings.json` (`permissions.allow / ask / deny`), read natively by the agent CLI.

The three tiers, and how they map to invariant 5 ("wide autonomy, few gates"):

- **allow** - wide by default: reads, edits, local tests/typecheck/build, ordinary bash, web, and
  routine connected-tool calls. Flows autonomously; no approval. Unknown tools default to **allow**.
- **ask** - only the few **money / outbound-to-real-people / irreversible** actions: paying,
  messaging or emailing real people, publishing, and destructive bash (`rm -rf`,
  `git push --force`, `git reset --hard`). Surfaces as an approval before it runs, inline where the
  work is happening. Outward provider (MCP) calls are gated by intent at the connector gateway
  (`apps/connectors`), not by tool name here. This is the same allow/ask/deny preset the product
  ships into every workspace (`packs/core/policy/`, part of the core content pack) - here it guards
  the build itself. Every gated action - approval, denial, outward send - is recorded on the
  company activity ledger.
- **deny** - empty by default; the operator can add hard refusals, and can widen or tighten any
  gate. Autonomy is configured, not assumed.

**Not part of this relaxation:** the conductor bright-lines (invariant 4) still hold absolutely -
we never read another agent's credential store, keys, or `secrets/`, and never proxy model tokens.
That is enforced in code, independent of this allow/ask/deny preset, and is **not** weakened by an
empty `deny` list.

Deviations from this policy are decisions - capture them (`.claude/skills/capture-decision/`).
