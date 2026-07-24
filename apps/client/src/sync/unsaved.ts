// How much work is waiting to be saved, in the terms the operator thinks in: documents, not
// revisions. Ten edits to one document are one unsaved thing to them, so this counts distinct FILES.
//
// Read-only and network-free by construction - it never fetches. That matters twice: the pending
// tray polls it, so it must be cheap; and it must never be the reason saving appears to fail.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { join } from "node:path";
import { pinnedGit } from "../lib/git-pin.js";
import { INTERNAL } from "./engine.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface Unsaved {
  /** Distinct files changed on this machine that the company's copy does not have yet. */
  files: number;
  /** Epoch ms of the oldest unsaved checkpoint, or null when nothing is waiting. Drives the nudge. */
  oldestAt: number | null;
  /** The waiting files themselves (repo-relative, the set `files` counts) - what the aggregate's
   *  save-note suggestion is written from. */
  paths: string[];
}

export interface UnsavedAggregate {
  files: number;
  oldestAt: number | null;
  /** A deterministic prefilled save note derived from the waiting files ("Updated pricing.md and
   *  2 more in clients/"), or null when nothing is waiting. The Save card prefills its message
   *  input with this; the operator keeps or edits it. */
  suggestion: string | null;
  /** True when at least one root's count threw and was skipped (e.g. a transient git `index.lock`
   *  race). The tally is then a FLOOR, not the truth: a caller must not read a possibly-lower number
   *  as "nothing changed" and blank the card - that would breach invariant 8 for a moment. */
  incomplete: boolean;
}

const NOTHING: Unsaved = { files: 0, oldestAt: null, paths: [] };

/** How long work may sit unsaved before the card stops reporting a number and starts stating the
 *  stakes. Saving is fully manual by design, so this nudge is the only thing between an operator and
 *  losing a laptop's worth of work - it lives here, with an injected clock, so it is actually tested
 *  rather than being an untested comparison in browser JavaScript. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Whether waiting work is old enough to escalate the card. A future timestamp (clock skew between
 *  machines, since commit dates come from whoever made them) is never stale. */
export function isStale(oldestAt: number | null, now: number): boolean {
  if (oldestAt === null) return false;
  return now - oldestAt > STALE_AFTER_MS;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", pinnedGit(args), {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

function isInternal(rel: string): boolean {
  return INTERNAL.some((p) => rel === p || rel.startsWith(`${p}/`));
}

function lines(out: string): string[] {
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** One entry from `git status --porcelain -uall -z`. `path` is the file this record is actually
 *  about - the destination for a rename/copy, the file itself otherwise. `orig` is set only for a
 *  rename or copy (status code starting with `R` or `C`): the same document under its old name, so
 *  a caller must not also count it. */
interface PorcelainRecord {
  path: string;
  orig?: string;
}

/** Parse `git status --porcelain -uall -z`. Verified empirically against real git in a scratch
 *  repo: each record is a single NUL-terminated field `XY<space><path>`, and for a rename or copy
 *  (code starting with `R`/`C`, e.g. plain `R ` or the rename+modify combo `RM`) the *next*
 *  NUL-terminated field is the original path, with no prefix of its own. Unlike porcelain v1, `-z`
 *  never quotes or C-escapes paths - confirmed by round-tripping a path with a space and a
 *  non-ASCII character - so this needs no arrow-splitting or unquoting. */
function parsePorcelainZ(out: string): PorcelainRecord[] {
  const fields = out.split("\0");
  const records: PorcelainRecord[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue; // the split leaves a trailing empty field after the final NUL
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) continue;
    if (code[0] === "R" || code[0] === "C") {
      const orig = fields[++i];
      records.push(orig ? { path, orig } : { path });
    } else {
      records.push({ path });
    }
  }
  return records;
}

async function remoteMainExists(dir: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], dir);
    return true;
  } catch {
    return false;
  }
}

async function hasAnyCommit(dir: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", "HEAD"], dir);
    return true;
  } catch {
    return false;
  }
}

/** What is waiting in one root. Never throws for an ordinary repository state. */
export async function unsavedIn(dir: string): Promise<Unsaved> {
  const committed = await hasAnyCommit(dir);
  const upstream = committed ? await remoteMainExists(dir) : false;

  const paths = new Set<string>();
  // Working-tree paths with genuinely uncommitted work (unstaged, staged, or untracked) - as
  // opposed to paths that only appear because an earlier commit is unsent. Only these have an
  // on-disk mtime worth trusting as "when this became unsaved".
  const dirtyPaths = new Set<string>();

  if (committed) {
    // With an upstream, "unsaved" is everything the company's copy does not have. Without one - a
    // workspace with no account yet, or one that has never saved - everything counts.
    // THREE dots, not two. `a..b` on a diff is a plain tree comparison, so a file only a TEAMMATE
    // changed shows up as our unsaved work in the window after a fetch but before the rebase lands.
    // `a...b` diffs from the merge base - only what WE changed since we diverged.
    const ahead = upstream
      ? await git(["diff", "--name-only", "origin/main...HEAD"], dir)
      : await git(["ls-files"], dir);
    for (const rel of lines(ahead)) paths.add(rel);
  }

  // Edits made since the last checkpoint are genuinely unsaved too, so a count taken mid-burst is
  // never misleadingly low. `-uall` expands an untracked directory into its individual files
  // rather than collapsing it to one entry, and `-z` gives unquoted, unambiguous paths plus the
  // origin path of a rename - so a renamed document is not also counted under its old name.
  const porcelainOut = await git(["status", "--porcelain", "-uall", "-z"], dir);
  for (const rec of parsePorcelainZ(porcelainOut)) {
    if (rec.orig) paths.delete(rec.orig); // same document under its old name - not a second one
    paths.add(rec.path);
    dirtyPaths.add(rec.path);
  }

  for (const rel of [...paths]) if (isInternal(rel)) paths.delete(rel);
  for (const rel of [...dirtyPaths]) if (isInternal(rel)) dirtyPaths.delete(rel);
  if (paths.size === 0) return NOTHING;

  return {
    files: paths.size,
    oldestAt: await oldestUnsavedAt(dir, committed, upstream, dirtyPaths),
    paths: [...paths].sort(), // sorted so the same waiting set always reads the same (invariant 9)
  };
}

/** The oldest moment any unsaved work has been waiting, from whichever of its two sources exist:
 *  a committed-but-unsent change is dated by its commit time; work never checkpointed at all is
 *  dated by its on-disk mtime, since git has no timestamp for it. Only null when there is nothing
 *  in either source - callers only reach this once `files > 0`, so that means one source is empty,
 *  not both. A file that vanished between listing and stat-ing is skipped, not thrown over. */
async function oldestUnsavedAt(
  dir: string,
  committed: boolean,
  upstream: boolean,
  dirtyPaths: ReadonlySet<string>,
): Promise<number | null> {
  const candidates: number[] = [];

  if (committed) {
    const range = upstream ? "origin/main..HEAD" : "HEAD";
    const out = await git(["log", "--format=%ct", "--reverse", range], dir);
    const first = lines(out)[0];
    if (first) {
      const secs = Number(first);
      if (Number.isFinite(secs)) candidates.push(secs * 1000);
    }
  }

  for (const rel of dirtyPaths) {
    try {
      candidates.push(statSync(join(dir, rel)).mtimeMs);
    } catch {
      // Listed a moment ago, gone now (e.g. an editor swap file) - not unsaved work we can date.
    }
  }

  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** What is waiting across every writable root, collapsed into the one number the tray shows. A root
 *  whose count throws is skipped rather than failing the whole count - a broken root must not hide
 *  real unsaved work in the others - but its failure is reported via `incomplete`, so a caller can
 *  refuse to blank a real count on a number it knows to be only a floor. */
export async function unsavedAcross(dirs: string[]): Promise<UnsavedAggregate> {
  let incomplete = false;
  const each = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return await unsavedIn(dir);
      } catch {
        incomplete = true; // this root's number is unknown, not zero
        return NOTHING;
      }
    }),
  );
  const files = each.reduce((n, u) => n + u.files, 0);
  const dates = each.map((u) => u.oldestAt).filter((d): d is number => d !== null);
  return {
    files,
    oldestAt: dates.length > 0 ? Math.min(...dates) : null,
    suggestion: suggestSaveMessage(each.flatMap((u) => u.paths)),
    incomplete,
  };
}

/** The prefilled save note, in the operator's vocabulary and derived only from the waiting file
 *  set - deterministic (invariant 9): paths are de-duplicated and sorted, so the same waiting work
 *  always yields the same words. Null when nothing is waiting, so the card can simply not prefill. */
export function suggestSaveMessage(paths: string[]): string | null {
  const sorted = [...new Set(paths)].sort();
  if (sorted.length === 0) return null;
  const name = (p: string) => p.split("/").pop() || p;
  if (sorted.length === 1) return `Updated ${name(sorted[0]!)}`;
  if (sorted.length === 2) return `Updated ${name(sorted[0]!)} and ${name(sorted[1]!)}`;
  // Three or more: name the first, count the rest, and place them when they all share one folder.
  const tops = new Set(sorted.map((p) => (p.includes("/") ? p.split("/")[0]! : "")));
  const where = !tops.has("") && tops.size === 1 ? ` in ${[...tops][0]}/` : "";
  return `Updated ${name(sorted[0]!)} and ${sorted.length - 1} more${where}`;
}
