# Upstream baseline — measured, not assumed

Fork point: `b168f6f100` (upstream/main, 2026-07-26)

## Known-red on pristine upstream (NOT caused by BuildEx changes)

`pnpm run verify:localization-coverage` fails on unmodified upstream:

```
src/renderer/src/components/settings/terminal-advanced-platform-search.ts:66,67,105,106  "Ghostty"
src/renderer/src/components/settings/terminal-pane-appearance-search.ts:89,90            "Ghostty"
```

Verified by `git stash` → run → identical output → `git stash pop`.

**Consequence:** the phase gate is "no NEW failures vs this baseline", never "all green".
`pnpm lint` will always exit 1 here until upstream fixes it. Everything *before*
that final step passes, so lint remains a usable gate for all other rules.

## Green on pristine upstream

- `pnpm typecheck` (all 3 projects) — passes with BuildEx identity changes applied
- oxlint, switch-exhaustiveness, styled-scrollbars, reliability-gates,
  max-lines-ratchet, bundled-skill-guides, skill-bundle-manifest,
  localization-catalog — all pass with BuildEx changes applied
