// @buildex/client - Electron desktop app + local daemon (the product)
// Package seam: real modules land here as capabilities ship.

/** Identifies this app package. Proves the workspace + typecheck + test wiring is live. */
export const appName = "@buildex/client" as const;

export function describe(): string {
  return "buildex - Electron desktop app + local daemon (the product)";
}
