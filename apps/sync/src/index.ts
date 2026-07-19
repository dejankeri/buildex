// @buildex/sync - the thin cloud service - identity, git hosting, seats
// Package seam: real modules land here as capabilities ship.

/** Identifies this app package. Proves the workspace + typecheck + test wiring is live. */
export const appName = "@buildex/sync" as const;

export function describe(): string {
  return "buildex - the thin cloud service - identity, git hosting, seats";
}
