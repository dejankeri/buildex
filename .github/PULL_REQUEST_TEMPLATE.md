<!--
Thanks for contributing to BuildEx. Small, focused PRs land fastest. For anything larger than a
bug/doc/test/portability fix, please open an issue first — a feature that doesn't fit the roadmap may
be declined even if it's well-built (see CONTRIBUTING.md).
-->

## What & why

<!-- What does this change do, and what problem does it solve? Link the issue it closes, if any. -->

Closes #

## How it was tested

<!-- Which suites/lanes did you run? Paste the relevant `task ci` result. -->

- [ ] `task ci` is green locally.

## Decision capture

<!-- Does this change settled behavior, add a dependency, or resolve a trade-off? If so, record it
     in the PR description where reviewers can see it. Otherwise, tick "no decision". -->

- [ ] No non-obvious decision — or — captured in the description.

## Invariant checklist

This change does **not** weaken any of the 10 invariants (`CLAUDE.md` §"The 10 invariants"). Confirm
each that your change could touch:

- [ ] **Local-first** — the agent still works on local files; the cloud syncs, never thinks.
- [ ] **Git is the database** — every artifact stays plain files + commits; no shadow DB.
- [ ] **Documents are plain markdown** — rendered views stay derived-on-demand, never committed.
- [ ] **Conductor bright-lines** — never reads an agent's credential store, proxies model tokens,
      sets provider API keys, or renders provider sign-in. (The one documented exception is the
      opt-in usage strip.)
- [ ] **Outward/irreversible ⇒ human-gated** — such actions still surface as approval cards.
- [ ] **Hard company isolation** — per-company repos; server-side permission matrix; per-machine tokens.
- [ ] **Identity from JWT only** — S2S-minted setup tokens; validated loopback redirects; one-time state.
- [ ] **Never lose operator work** — unclean content is backed up + flagged, never discarded.
- [ ] **Deterministic trust surfaces** — map / history / admin render from repo state with zero LLM.
- [ ] **Build the seam, not the engine** — interfaces for deferred capabilities stay in place.
- [ ] **No new telemetry** — v1 telemetry is none; this change adds no analytics/telemetry/crash reporting.

## Security

- [ ] No secret, credential, live infra value (hosts/IDs/costs), or client-identifying detail is added
      to any file or the commit history. (`task secret-scan` is a floor, not a substitute for judgment.)
