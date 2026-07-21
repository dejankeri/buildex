/** Normalize a relative path to forward slashes.
 *
 *  The live map keys every file POSIX-style, and the agent's tool events must produce the SAME key or
 *  a touched file never lights up on the map. On Windows `path.relative` yields backslashes, so both
 *  sides have to normalize - and they have to normalize identically. This was previously one
 *  expression written out twice (brain/graph.ts and agent/parser.ts); the coupling was by copy, so
 *  changing one would silently desync tool events from the map again.
 *
 *  Deliberately unconditional, not win32-gated: a POSIX filename may legally contain a literal
 *  backslash, and mangling it here is CONSISTENT on both sides, so map keys still match and only the
 *  display differs. Gating on win32 would make the two sides disagree - strictly worse. */
export function toPosix(p: string): string {
  return p.split("\\").join("/");
}
