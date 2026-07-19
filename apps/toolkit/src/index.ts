// @buildex/toolkit - Company setup toolkit: provision, backfill, connector scaffold,
// promotion-checklist, history-secret-audit. These are tested library functions imported by the
// sync/provisioning paths and tests; a thin argv CLI wrapper over them is not built yet (no `bin`).

/** Identifies this app package. Proves the workspace + typecheck + test wiring is live. */
export const appName = "@buildex/toolkit" as const;

export function describe(): string {
  return "@buildex/toolkit - Company setup toolkit: provision, backfill, connector scaffold; CLI wrapper pending";
}
