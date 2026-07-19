# Contributing to BuildEx

**Open platform, our roadmap.** BuildEx is MIT-licensed and developed in the open. You are free
to read, fork, run, and adapt every part of it. The direction, however, is founder-led: we build
toward a specific product thesis, and we optimize for that over breadth.

## What that means in practice

- **Issues and discussion are welcome** - bug reports, sharp questions, and real-world usage notes
  are the most useful contributions at this stage.
- **PRs**: small, focused fixes (bugs, docs, tests, portability) are welcome. Before investing in a
  larger change, open an issue - a feature that doesn't fit the roadmap may be declined even if it's
  well-built, and we'd rather save you the work.
- **The invariants are the contract.** A change that alters settled behavior must be justified as a
  decision in the open (see below), not slipped in.

## Ground rules

1. **Never commit anything secret or client-identifying.** No credentials, tokens, live infra
   values (hosts/IDs/costs), or customer data - ever. CI runs a secret scan (`task secret-scan`);
   it is a floor, not a substitute for judgment.
2. **Test-first at the module seam.** Every module lands with a hermetic suite (DI for fetch, git,
   keychain, agent spawn, clock); no network in unit lanes. `task ci` must be green.
3. **Honor the 10 invariants** (`CLAUDE.md`). They are non-negotiable; a PR that
   weakens one will be declined.
4. **Capture non-obvious decisions in the open.** Any behavior change, new dependency, or
   trade-off belongs in your PR description, argued where reviewers can see it — never slipped in
   silently.

## Getting started

```sh
npm install
task ci
```

Read [`CLAUDE.md`](CLAUDE.md) for the full operating model.

By contributing you agree your contributions are licensed under the repository's [MIT](LICENSE)
license.
