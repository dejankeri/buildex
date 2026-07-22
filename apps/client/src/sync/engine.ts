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

/** Outcome of an auth-rotation attempt, returned by EngineAuth.onAuthError():
 *  - "rotated": a fresh token is stored - retry the git op once.
 *  - "revoked": the refresh token itself was rejected (401/403) - the account is dead, not a
 *    transient blip, so the engine throws AuthRevokedError and receive/publish surface needs-help.
 *  - "offline": rotation could not reach the server - transient; the original error propagates and
 *    the caller treats it as offline/queued and retries on the next tick. */
export type AuthRotation = "rotated" | "revoked" | "offline";

/** A push/fetch failed auth AND the refresh token was rejected - the account must be reconnected.
 *  Distinct from a transient network failure so the scheduler surfaces `needs-help` (reconnect)
 *  rather than `offline`/`queued` (will retry on its own). Carries NO conflict semantics: it never
 *  triggers a backup or hard-reset - the operator's work simply stays local until they reconnect. */
export class AuthRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRevokedError";
  }
}

export interface EngineAuth {
  /** gitAuthEnv(currentToken), or undefined when there is no account yet (local-only). */
  headerEnv(): Record<string, string> | undefined;
  /** Rotate after an auth-classified failure. See AuthRotation for what each outcome means. */
  onAuthError(): Promise<AuthRotation>;
}

export interface SyncDeps {
  now: () => number;
  /** Label written into commit messages and (later) surfaced in history. */
  actor: string;
  /** Present once an account is attached; injects the credential header and rotates on 401/403. */
  auth?: EngineAuth;
  /** Classify a git failure's stderr as an auth rejection. Overridable only for tests. */
  classifyAuthError?: (stderr: string) => boolean;
}

const DEFAULT_AUTH_RE = /\b(401|403)\b|Authentication failed|could not read Username|invalid credentials/i;

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
    } catch (e) {
      if (e instanceof AuthRevokedError) return "needs-help"; // revoked - reconnect, don't spin
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
    } catch (e) {
      if (e instanceof AuthRevokedError) return "needs-help"; // revoked - reconnect, don't spin
      return "queued";
    }
    return "ok";
  }

  /** Point (or re-point) a root's `origin` at `url`, idempotently. No fetch, no auth needed. */
  async addRemote(dir: string, url: string): Promise<void> {
    if (await this.hasRemote(dir)) await this.git(["remote", "set-url", "origin", url], dir);
    else await this.git(["remote", "add", "origin", url], dir);
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

  /** Whether any git remote is configured - false for a local-only stub repo (no account yet).
   *  Public because the console has to tell "waiting to be saved" apart from "there is nowhere to
   *  save to yet": with no account the card must state the truth rather than offer a save that
   *  cannot do anything. `git remote` is a local read - no network. */
  async hasRemote(dir: string): Promise<boolean> {
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
    // Everything the reset is about to overwrite, from BOTH sources:
    //  - what the remote changed relative to our HEAD (the classic conflict case), and
    //  - anything dirty in the working tree right now (modified, staged, or untracked).
    // The second half is not redundant: a rebase refuses to start at all on a dirty tree, so the
    // file that provoked this may never appear in the HEAD..origin/main list. Backing up only that
    // list would hard-reset an operator's uncommitted edit into nothing (invariant 8).
    const changed = new Set<string>([
      ...lines(await this.git(["diff", "--name-only", "HEAD", "origin/main"], dir)),
      ...lines(await this.git(["ls-files", "--modified", "--others", "--exclude-standard"], dir)),
      ...lines(await this.git(["diff", "--cached", "--name-only"], dir)),
    ]);

    for (const rel of changed) {
      // Never copy workspace-internal paths - .conflicts/ into .conflicts/ would nest forever.
      if (INTERNAL.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
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
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: this.deps.actor,
      GIT_AUTHOR_EMAIL: `${this.deps.actor}@buildex.local`,
      GIT_COMMITTER_NAME: this.deps.actor,
      GIT_COMMITTER_EMAIL: `${this.deps.actor}@buildex.local`,
    };
    const run = (): Promise<{ stdout: string }> =>
      execFileAsync("git", pinnedGit(args), {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: { ...base, ...(this.deps.auth?.headerEnv() ?? {}) }, // header read FRESH each attempt
      });
    try {
      return (await run()).stdout;
    } catch (e) {
      // One rotate-and-retry when the failure is an auth rejection AND we have a way to rotate. Local
      // ops never hit this (no network → no 401); only fetch/push can. A second failure propagates -
      // the scheduler already turns a thrown publish into `needs-help` and never loses local work.
      const stderr = (e as { stderr?: string })?.stderr ?? (e instanceof Error ? e.message : "");
      const classify = this.deps.classifyAuthError ?? ((s: string) => DEFAULT_AUTH_RE.test(s));
      if (this.deps.auth && classify(String(stderr))) {
        const outcome = await this.deps.auth.onAuthError();
        if (outcome === "rotated") return (await run()).stdout; // retry once with the rotated header
        if (outcome === "revoked") throw new AuthRevokedError(String(stderr)); // account dead → needs-help
        // "offline": rotation couldn't reach the server - fall through and propagate the original
        // error so the caller treats it as a transient offline/queued failure and retries later.
      }
      throw e;
    }
  }
}

/** Split git's newline output into trimmed, non-empty entries. */
function lines(out: string): string[] {
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Refuse to operate inside a cloud-synced folder - concurrent cloud sync corrupts git repos. */
export function assertNotCloudSynced(dir: string): void {
  if (CLOUD_DIRS.test(dir)) {
    throw new Error(`refusing to sync inside a cloud-synced folder (${dir}); move the workspace outside it`);
  }
}
