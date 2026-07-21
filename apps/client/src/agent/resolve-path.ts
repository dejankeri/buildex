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
import { posix, win32 } from "node:path";

export interface AugmentPathDeps {
  /** The operator's home directory (os.homedir()). */
  home: string;
  /** The PATH we start from (process.env.PATH); may be undefined/empty. */
  current?: string | undefined;
  /** Path list delimiter (":" on posix, ";" on win). Defaults to the one this platform uses. */
  delimiter?: string;
  /** Host platform. Injected so both platforms' lists are testable from any CI lane. */
  platform?: NodeJS.Platform | string;
}

/** Where a coding-agent CLI lands on macOS/Linux. Ordered most-specific-first. */
function posixBinDirs(home: string): string[] {
  const j = posix.join;
  return [
    j(home, ".local", "bin"), // pipx / uv / official installer (claude lives here on many setups)
    j(home, ".claude", "local"), // Claude Code's self-managed install location
    "/opt/homebrew/bin", // Homebrew on Apple Silicon
    "/opt/homebrew/sbin",
    "/usr/local/bin", // Homebrew on Intel / hand-installed tools
    "/usr/local/sbin",
    j(home, ".npm-global", "bin"), // npm prefix override
    j(home, ".yarn", "bin"),
    j(home, ".bun", "bin"),
    j(home, "Library", "pnpm"), // pnpm global bin (macOS)
    j(home, ".volta", "bin"),
    j(home, ".local", "share", "fnm"),
    "/usr/bin", // keep the bare baseline reachable too
    "/bin",
  ];
}

/** Where the same CLIs land on Windows. None of the POSIX entries above is meaningful here, and the
 *  one that matters most - npm's global bin, `%APPDATA%\npm`, where `npm i -g @anthropic-ai/claude-code`
 *  writes `claude.cmd` - had no equivalent at all, so the packaged app could not see an npm-global
 *  install even after PATH widening.
 *
 *  Every entry is derived from `home`, so it inherits whatever form that takes - any drive letter, or
 *  a UNC path like `\\fileserver\home\ivan` on a domain-joined machine. Nothing here assumes `C:`.
 *
 *  `%APPDATA%` is `<home>\AppData\Roaming` by default; an operator who has redirected AppData, or set
 *  a custom `npm config set prefix`, is still covered, because the resolver searches their real PATH -
 *  this list only widens the search, it is not the sole route to the binary. */
function windowsBinDirs(home: string): string[] {
  const j = win32.join;
  return [
    j(home, ".local", "bin"), // official installer (claude.exe)
    j(home, ".claude", "local"), // Claude Code's self-managed install
    j(home, "AppData", "Roaming", "npm"), // npm -g  <- the gap that hid every npm-global agent CLI
    j(home, "AppData", "Local", "pnpm"),
    j(home, "AppData", "Local", "Yarn", "bin"),
    j(home, ".bun", "bin"),
    j(home, ".volta", "bin"),
    j(home, "scoop", "shims"),
  ];
}

/** The well-known dirs a coding-agent CLI (or its own child tools) is commonly installed into, for
 *  the given platform. All are prepended ahead of the inherited PATH so an explicit install wins. */
export function commonBinDirs(home: string, platform: NodeJS.Platform | string = process.platform): string[] {
  return platform === "win32" ? windowsBinDirs(home) : posixBinDirs(home);
}

/** Return a PATH string with the common install dirs prepended to `current`, de-duplicated (first
 *  occurrence wins, preserving priority). Never drops an entry the caller already had. */
export function augmentedPath(deps: AugmentPathDeps): string {
  const platform = deps.platform ?? process.platform;
  // Derive the delimiter from the platform, not the host. Windows separates PATH entries with ";"
  // precisely because ":" already terminates a drive letter, so splitting a Windows PATH on ":"
  // would cut every drive-qualified entry in half - "D:\tools\bin" and "\\server\share" alike.
  // On the real host this yields exactly node's own `path.delimiter`.
  const delim = deps.delimiter ?? (platform === "win32" ? ";" : ":");
  const existing = (deps.current ?? "").split(delim).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...commonBinDirs(deps.home, platform), ...existing]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(delim);
}
