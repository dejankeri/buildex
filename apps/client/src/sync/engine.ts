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
/** Recording work locally. No network, so no offline case exists. */
export type CheckpointResult = "committed" | "no-change";
/** Taking other people's work in. Never sends anything. */
export type ReceiveResult = "ok" | "needs-help" | "offline" | "local";

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

  /** Record local work as a checkpoint. NO NETWORK - this is the operation that made automatic
   *  publishing possible when it was fused with push, and keeping it network-free is what makes
   *  "your work leaves only when you say so" true rather than aspirational. */
  async checkpoint(dir: string): Promise<CheckpointResult> {
    assertNotCloudSynced(dir);
    await this.stage(dir);
    const staged = await this.stagedFiles(dir);
    if (staged.length === 0) return "no-change";
    await this.git(["commit", "-m", this.commitMessage(staged)], dir);
    return "committed";
  }

  /** Take other people's work in: fetch, then rebase our checkpoints on top. Sends nothing. On a
   *  real conflict the operator's version is backed up before anything is reset (invariant 8). */
  async receive(dir: string): Promise<ReceiveResult> {
    assertNotCloudSynced(dir);
    // No account yet - nothing to receive from. Not an error, and never "offline", which means a
    // remote exists but could not be reached.
    if (!(await this.hasRemote(dir))) return "local";
    try {
      await this.git(["fetch", "origin"], dir);
    } catch {
      return "offline";
    }
    // A freshly-provisioned remote has no main branch yet, so there is nothing to rebase onto.
    if (!(await this.remoteMainExists(dir))) return "ok";
    try {
      await this.git(["rebase", "origin/main"], dir);
    } catch {
      await this.backupAndReset(dir);
      return "needs-help";
    }
    return "ok";
  }

  /** Send everything to the company's copy. The ONLY operation that pushes, and the only one the
   *  operator triggers - nothing schedules it. */
  async publish(dir: string): Promise<SyncResult> {
    assertNotCloudSynced(dir);
    await this.checkpoint(dir);

    if (!(await this.hasRemote(dir))) return "local";

    const received = await this.receive(dir);
    if (received === "needs-help") return "needs-help";
    // Offline: any checkpoints are retained locally and go out on the next attempt.
    if (received === "offline") return (await this.isAhead(dir)) ? "queued" : "no-change";

    if (!(await this.isAhead(dir))) return "no-change";
    try {
      await this.git(["push", "origin", "HEAD:main"], dir);
    } catch {
      return "queued";
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

  /** Files staged for the next checkpoint. Empty means there is genuinely nothing to record - which
   *  `status --porcelain` cannot tell us, because it also reports the internal paths we just unstaged. */
  private async stagedFiles(dir: string): Promise<string[]> {
    return (await this.git(["diff", "--cached", "--name-only"], dir))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private commitMessage(files: string[]): string {
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
