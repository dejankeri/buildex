// Shared path confinement - the ONE implementation (wiring's doc resolver, brain/apps, brain/skills,
// and server/app-serve all call this). A bare `full.startsWith(base)` prefix check is wrong twice
// over: it accepts sibling dirs that merely share the prefix string ("/ws/team-evil" starts with
// "/ws/team"), and it is defeated by a symlink inside the base pointing outside it. So: a
// separator-safe comparison, and canonicalize BOTH sides first (macOS temp dirs are themselves
// symlinks, e.g. /var -> /private/var - realpathing only one side would reject every legitimate
// path under them).
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Resolve `rel` inside `base` and confine it there. Returns the resolved absolute path (lexical,
 *  not canonical - callers stat/read/write through it) when its REAL location stays inside `base`'s
 *  REAL location; null on any escape (`..` traversal, absolute `rel`, sibling-prefix, a symlink
 *  pointing out, a dangling symlink). Targets that don't exist yet (saveDoc / writeSkillFile create
 *  files) are handled by canonicalizing the deepest existing ancestor - as is a base dir that
 *  itself hasn't been created yet (a fresh repo's apps/ or skills/). */
export function confinePath(base: string, rel: string): string | null {
  const absBase = resolve(base);
  const full = resolve(absBase, rel);
  // Lexical gate first: after resolve(), any `..` escape or absolute `rel` lands outside absBase.
  if (full !== absBase && !full.startsWith(absBase + sep)) return null;
  const realBase = realpathMissingOk(absBase);
  const realFull = realpathMissingOk(full);
  if (realBase === null || realFull === null) return null;
  if (realFull !== realBase && !realFull.startsWith(realBase + sep)) return null;
  return full;
}

/** realpath for a path that may not exist yet: canonicalize the deepest existing ancestor and
 *  re-append the missing remainder. A component that EXISTS but can't be canonicalized - a dangling
 *  symlink, a link loop, an unreadable dir - returns null: writing "through" a dangling link would
 *  create the file wherever the link points, so it must never pass confinement. */
function realpathMissingOk(path: string): string | null {
  let cur = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null; // ELOOP, EACCES, … → refuse
      // ENOENT can also mean a DANGLING SYMLINK at `cur` - lstat sees the link itself; refuse it.
      try {
        lstatSync(cur);
        return null;
      } catch {
        /* truly absent - keep walking up */
      }
      const parent = dirname(cur);
      if (parent === cur) return null; // hit the fs root without finding an existing ancestor
      missing.push(basename(cur));
      cur = parent;
    }
  }
}
