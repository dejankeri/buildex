# .claude/policy - the allow/ask/deny model (dogfood of invariant 5)

This directory documents buildex's own operating policy. The enforceable form lives in  
`.claude/settings.json` (`permissions.allow / ask / deny`), read natively by the agent CLI.

The three tiers, and how they map to invariant 5 ("outward or irreversible ⇒ human-gated"):

- **allow** - reads, edits, local tests/typecheck, non-mutating git. Flows freely; no approval.
- **ask** - anything **outward or irreversible**: `git push`, `git commit`, deploys, `gh`,
  `rm`, `npm publish`. Surfaces as an approval before it runs. This is the same allow/ask/deny
  preset the product ships into every workspace (`packs/core/policy/`, part of the core content pack) - here it
  guards the build itself.
- **deny** - never readable: env files, `secrets/`, keys, and **any agent credential store**
  (`~/.claude`, OS keychains). Encodes the conductor bright-lines (invariant 4): we never read
  another agent's credentials, full stop.

Autonomy is earned per action, never assumed. Deviations from this policy are decisions - capture
them (`.claude/skills/capture-decision/`).
