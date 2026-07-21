// The sync engine - carries the sync-safety invariant: never lose an
// operator's work. Lifted-and-hardened from the prototype: the `.conflicts/<ts>/` never-lose backup
// and the cloud-guard are ported; commit messages are upgraded from a fixed string to a readable
// actor+files summary; the offline queue (retain unpushed commits, push on reconnect) is net-new
// (the prototype had none). Uses real git; deterministic via an injected clock.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pinnedGit } from "../lib/git-pin.js";

const execFileAsync = promisify(execFile);

// Every git invocation is async (off the event loop) AND bounded by a timeout: a wedged remote on a
// network fetch/push must never hang the daemon - which, when git ran synchronously, froze every HTTP
// route and the live agent stream. On timeout git is killed (SIGTERM) and the call
// rejects; the writable-sync path treats that like any offline failure (retain the commit, queue a
// retry). Generous maxBuffer so a large `status`/`diff` on a big workspace never trips ENOBUFS.
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export type SyncResult = "ok" | "needs-help" | "queued" | "no-change" | "local";

export interface SyncDeps {
  now: () => number;
  /** Label written into commit messages and (later) surfaced in history. */
  actor: string;
}

/** Workspace-internal paths that must never be committed, and must never be counted as unsaved work
 *  (invariant: secrets/backups stay local). Exported so `unsaved.ts` filters by the same list rather
 *  than keeping a second copy that could drift. */
export const INTERNAL = [".conflicts", ".sync-needs-help", ".sessions", ".agent"];
const CLOUD_DIRS = /(Dropbox|Google Drive|iCloud|Mobile Documents|CloudStorage|OneDrive)/i;

export class SyncEngine {
  constructor(private readonly deps: SyncDeps) {}

  /** Read-only repos (core): fetch and hard-reset to origin - local edits are discarded by design. */
  async syncReadonly(dir: string): Promise<void> {
    assertNotCloudSynced(dir);
    await this.git(["fetch", "origin"], dir);
    await this.git(["reset", "--hard", "origin/main"], dir);
  }

  /** Writable repos (team/private): commit → rebase → push, with never-lose conflict backup. */
  async syncWritable(dir: string): Promise<SyncResult> {
    assertNotCloudSynced(dir);
    await this.stage(dir);
    if (await this.isDirty(dir)) {
      await this.git(["commit", "-m", await this.commitMessage(dir)], dir);
    }

    // Local-only stub repo - no account opened yet, so no remote is configured. The operator's work
    // is safely committed to local git (git is the database, invariant #2); there is simply nothing
    // to sync *to*. Report "local" so the loop no-ops cleanly and the dot shows a neutral not-synced
    // state - never "queued", which means a remote exists but is offline and should be retried.
    if (!(await this.hasRemote(dir))) return "local";

    // Fetch to learn the remote head; if we're offline (or the remote is wedged - the git timeout
    // fires), retain any local commits (offline queue).
    try {
      await this.git(["fetch", "origin"], dir);
    } catch {
      return (await this.isAhead(dir)) ? "queued" : "no-change";
    }

    // Rebase local commits onto the remote - but only if the remote has a main branch yet. A
    // freshly-provisioned repo is empty (no origin/main), so there is nothing to rebase onto; we
    // just push the initial commit. On a real conflict, never lose the local version.
    if (await this.remoteMainExists(dir)) {
      try {
        await this.git(["rebase", "origin/main"], dir);
      } catch {
        return this.backupAndReset(dir);
      }
    }

    if (!(await this.isAhead(dir))) return "no-change";
    try {
      await this.git(["push", "origin", "HEAD:main"], dir);
    } catch {
      return "queued"; // push failed (offline / wedged) - commit retained, will push on the next sync
    }
    return "ok";
  }

  // --- internals ---

  /** Stage everything except workspace-internal paths (which must never enter a commit). */
  private async stage(dir: string): Promise<void> {
    await this.git(["add", "-A"], dir);
    for (const p of INTERNAL) {
      try {
        await this.git(["reset", "-q", "--", p], dir);
      } catch {
        /* path not present - fine */
      }
    }
  }

  private async isDirty(dir: string): Promise<boolean> {
    return (await this.git(["status", "--porcelain"], dir)).trim().length > 0;
  }

  private async isAhead(dir: string): Promise<boolean> {
    try {
      return parseInt((await this.git(["rev-list", "--count", "origin/main..HEAD"], dir)).trim(), 10) > 0;
    } catch {
      return true; // no origin/main ref yet → we have everything locally
    }
  }

  /** Whether any git remote is configured - false for a local-only stub repo (no account yet). */
  private async hasRemote(dir: string): Promise<boolean> {
    return (await this.git(["remote"], dir)).trim().length > 0;
  }

  /** Whether the remote has a main branch yet (a freshly-provisioned repo does not). */
  private async remoteMainExists(dir: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], dir);
      return true;
    } catch {
      return false;
    }
  }

  private async commitMessage(dir: string): Promise<string> {
    const files = (await this.git(["diff", "--cached", "--name-only"], dir))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const shown = files.slice(0, 5).join(", ");
    const more = files.length > 5 ? ` (+${files.length - 5} more)` : "";
    return `${this.deps.actor}: update ${shown}${more}`;
  }

  /** Conflict path: abort, back up the local version byte-for-byte, reset to remote, flag. */
  private async backupAndReset(dir: string): Promise<SyncResult> {
    try {
      await this.git(["rebase", "--abort"], dir);
    } catch {
      /* rebase may have failed before starting (e.g. bad upstream) - nothing to abort */
    }
    const stamp = String(this.deps.now());
    const changed = (await this.git(["diff", "--name-only", "HEAD", "origin/main"], dir))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const rel of changed) {
      const src = join(dir, rel);
      if (!existsSync(src)) continue;
      const dest = join(dir, ".conflicts", stamp, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }

    await this.git(["reset", "--hard", "origin/main"], dir);
    writeFileSync(
      join(dir, ".sync-needs-help"),
      `Conflict at ${stamp}. Your version was saved under .conflicts/${stamp}/ - nothing was lost.\n`,
    );
    return "needs-help";
  }

  private async git(args: string[], cwd: string): Promise<string> {
    // Async execFile (off the event loop) with a hard timeout so a hung network op can't freeze the
    // daemon. On non-zero exit / timeout this rejects; several probes (isAhead, remoteMainExists) are
    // expected to fail on a fresh remote and are caught by their callers. stderr is captured on the
    // rejected error (err.stderr) rather than leaking to the console.
    // pinnedGit keeps every checkout LF-canonical, so backupAndReset's byte-for-byte backup holds on
    // a stock Windows install too (invariant 8). See lib/git-pin.ts for why.
    const { stdout } = await execFileAsync("git", pinnedGit(args), {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: this.deps.actor,
        GIT_AUTHOR_EMAIL: `${this.deps.actor}@buildex.local`,
        GIT_COMMITTER_NAME: this.deps.actor,
        GIT_COMMITTER_EMAIL: `${this.deps.actor}@buildex.local`,
      },
    });
    return stdout;
  }
}

/** Refuse to operate inside a cloud-synced folder - concurrent cloud sync corrupts git repos. */
export function assertNotCloudSynced(dir: string): void {
  if (CLOUD_DIRS.test(dir)) {
    throw new Error(`refusing to sync inside a cloud-synced folder (${dir}); move the workspace outside it`);
  }
}
