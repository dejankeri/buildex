// One definition of "line-ending-neutral git", used by every place that shells out.
//
// On a stock Windows install (core.autocrlf=true, the Git-for-Windows default) a checkout would
// materialize LF blobs as CRLF in the working tree. Two consequences, both invariant breaches:
//
//   - invariant 8: the sync engine's conflict backup would no longer match the operator's file
//     byte-for-byte, so their work is silently altered on the way to being "preserved".
//   - invariant 9: `git status --porcelain` behind the live map would disagree with the engine about
//     whether the same repo is dirty - a trust surface that must be deterministic reporting one
//     thing while the engine acts on another.
//
// Pinning is safe because git is the database and markdown renders identically either way: every
// checkout stays LF-canonical on Windows and macOS alike.
export const GIT_LINE_ENDING_PIN = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"] as const;

/** Prefix `args` with the line-ending pin. Use for every git invocation that reads or writes a
 *  working tree - reading refs or config does not need it, but it is harmless there. */
export function pinnedGit(args: string[]): string[] {
  return [...GIT_LINE_ENDING_PIN, ...args];
}
