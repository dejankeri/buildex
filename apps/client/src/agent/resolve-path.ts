// Why this exists: a macOS app launched from Finder / the .dmg does NOT inherit the operator's shell
// PATH. It gets a bare `/usr/bin:/bin:/usr/sbin:/sbin`, so the agent CLI they installed into
// ~/.local/bin, Homebrew, npm-global, Volta, etc. is invisible and `spawn("claude")` fails with
// ENOENT (the crash this module prevents). The dev path (spawned from a terminal) already has a full
// PATH, so this only matters for the packaged app - `daemon-entry.ts` calls it before boot.
//
// The fix is to PREPEND the common CLI install dirs to whatever PATH we do have. Augmenting PATH
// (rather than resolving `claude` to one absolute path) also fixes the agent's OWN child processes -
// `claude` shells out to git, ripgrep, node, etc., which would hit the same bare-PATH wall. Pure and
// injectable (home dir + current PATH + delimiter) so it stays unit-testable with no real env.
import { join, delimiter as osDelimiter } from "node:path";

export interface AugmentPathDeps {
  /** The operator's home directory (os.homedir()). */
  home: string;
  /** The PATH we start from (process.env.PATH); may be undefined/empty. */
  current?: string | undefined;
  /** Path list delimiter (":" on posix, ";" on win). Defaults to the host's. */
  delimiter?: string;
}

/** The well-known dirs a coding-agent CLI (or its own child tools) is commonly installed into. Ordered
 *  most-specific-first; all are prepended ahead of the inherited PATH so an explicit install wins. */
export function commonBinDirs(home: string): string[] {
  return [
    join(home, ".local", "bin"), // pipx / uv / official installer (claude lives here on many setups)
    join(home, ".claude", "local"), // Claude Code's self-managed install location
    "/opt/homebrew/bin", // Homebrew on Apple Silicon
    "/opt/homebrew/sbin",
    "/usr/local/bin", // Homebrew on Intel / hand-installed tools
    "/usr/local/sbin",
    join(home, ".npm-global", "bin"), // npm prefix override
    join(home, ".yarn", "bin"),
    join(home, ".bun", "bin"),
    join(home, "Library", "pnpm"), // pnpm global bin (macOS)
    join(home, ".volta", "bin"),
    join(home, ".local", "share", "fnm"),
    "/usr/bin", // keep the bare baseline reachable too
    "/bin",
  ];
}

/** Return a PATH string with the common install dirs prepended to `current`, de-duplicated (first
 *  occurrence wins, preserving priority). Never drops an entry the caller already had. */
export function augmentedPath(deps: AugmentPathDeps): string {
  const delim = deps.delimiter ?? osDelimiter;
  const existing = (deps.current ?? "").split(delim).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...commonBinDirs(deps.home), ...existing]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(delim);
}
