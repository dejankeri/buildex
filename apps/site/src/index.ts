// @buildex/site - buildexponential.org (static)
// Package seam: real modules land here as capabilities ship.

/** Identifies this app package. Proves the workspace + typecheck + test wiring is live. */
export const appName = "@buildex/site" as const;

export function describe(): string {
  return "BuildEx - buildexponential.org (static)";
}
