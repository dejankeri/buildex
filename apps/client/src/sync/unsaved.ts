// How much work is waiting to be saved, in the terms the operator thinks in: documents, not
// revisions. Ten edits to one document are one unsaved thing to them, so this counts distinct FILES.
//
// Read-only and network-free by construction - it never fetches. That matters twice: the pending
// tray polls it, so it must be cheap; and it must never be the reason saving appears to fail.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
}

const NOTHING: Unsaved = { files: 0, oldestAt: null };

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

/** Paths from `status --porcelain`. Entries are `XY path`, or `XY orig -> new` for a rename; the
 *  destination is the path that is actually unsaved. Quoted paths (non-ASCII) keep their quotes,
 *  which is harmless here because the result is only ever counted, never opened. */
function porcelainPaths(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      const rest = l.slice(3);
      const arrow = rest.indexOf(" -> ");
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    })
    .filter(Boolean);
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

  if (committed) {
    // With an upstream, "unsaved" is everything the company's copy does not have. Without one - a
    // workspace with no account yet, or one that has never saved - everything counts.
    const ahead = upstream
      ? await git(["diff", "--name-only", "origin/main..HEAD"], dir)
      : await git(["ls-files"], dir);
    for (const rel of lines(ahead)) paths.add(rel);
  }

  // Edits made since the last checkpoint are genuinely unsaved too, so a count taken mid-burst is
  // never misleadingly low.
  for (const rel of porcelainPaths(await git(["status", "--porcelain"], dir))) paths.add(rel);

  for (const rel of [...paths]) if (isInternal(rel)) paths.delete(rel);
  if (paths.size === 0) return NOTHING;

  return { files: paths.size, oldestAt: await oldestUnsavedAt(dir, committed, upstream) };
}

async function oldestUnsavedAt(dir: string, committed: boolean, upstream: boolean): Promise<number | null> {
  if (!committed) return null; // only edits on disk, nothing checkpointed yet
  const range = upstream ? "origin/main..HEAD" : "HEAD";
  const out = await git(["log", "--format=%ct", "--reverse", range], dir);
  const first = lines(out)[0];
  if (!first) return null;
  const secs = Number(first);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

/** What is waiting across every writable root, collapsed into the one number the tray shows. A root
 *  that is not a repository is skipped rather than failing the whole count - a broken root must not
 *  hide real unsaved work in the others. */
export async function unsavedAcross(dirs: string[]): Promise<Unsaved> {
  const each = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return await unsavedIn(dir);
      } catch {
        return NOTHING;
      }
    }),
  );
  const files = each.reduce((n, u) => n + u.files, 0);
  const dates = each.map((u) => u.oldestAt).filter((d): d is number => d !== null);
  return { files, oldestAt: dates.length > 0 ? Math.min(...dates) : null };
}
