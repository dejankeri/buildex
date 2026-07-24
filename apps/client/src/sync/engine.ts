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

export type SyncResult = "ok" | "needs-help" | "reconnect" | "queued" | "no-change" | "local";
/** Recording work locally. No network, so no offline case exists. */
export type CheckpointResult = "committed" | "no-change";

/** Every checkpoint's commit subject starts with this marker, so the two layers of history are
 *  distinguishable forever after: checkpoints are the automatic crash-safety layer and History
 *  collapses them; saves are the deliberate named layer History shows. One definition, imported by
 *  the history renderer, rather than a second copy that could drift. */
export const CHECKPOINT_MARK = "~";

/** Whether a commit subject is a checkpoint's (vs a deliberate save's). */
export function isCheckpointSubject(subject: string): boolean {
  return subject.startsWith(CHECKPOINT_MARK);
}

/** Remembers the last deliberate save. When a remote exists, origin/main IS the last save by
 *  construction (saves are the only pushes) - the ref is what covers a remoteless workspace, though
 *  it is updated on every save either way so a workspace that later gains or loses its remote keeps
 *  a correct base. A ref, not a file: it lives in .git/, so it can never be committed or synced. */
const LAST_SAVE_REF = "refs/buildex/last-save";
/** Taking other people's work in. Never sends anything. */
export type ReceiveResult = "ok" | "needs-help" | "reconnect" | "offline" | "local";

/** Outcome of an auth-rotation attempt, returned by EngineAuth.onAuthError():
 *  - "rotated": a fresh token is stored - retry the git op once.
 *  - "revoked": the refresh token itself was rejected (401/403) - the account is dead, not a
 *    transient blip, so the engine throws AuthRevokedError and receive/publish surface reconnect.
 *  - "offline": rotation could not reach the server - transient; the original error propagates and
 *    the caller treats it as offline/queued and retries on the next tick. */
export type AuthRotation = "rotated" | "revoked" | "offline";

/** A push/fetch failed auth AND the refresh token was rejected - the account must be reconnected.
 *  Distinct from a transient network failure so the scheduler surfaces `reconnect` rather than
 *  `offline`/`queued` (will retry on its own). Carries NO conflict semantics: it never
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
      if (e instanceof AuthRevokedError) return "reconnect"; // revoked - operator must reconnect
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
    if (received === "reconnect") return "reconnect"; // revoked during the pre-push fetch
    // Offline: any checkpoints are retained locally and go out on the next attempt.
    if (received === "offline") return (await this.isAhead(dir)) ? "queued" : "no-change";

    if (!(await this.isAhead(dir))) return "no-change";
    try {
      await this.git(["push", "origin", "HEAD:main"], dir);
    } catch (e) {
      if (e instanceof AuthRevokedError) return "reconnect"; // revoked - operator must reconnect
      return "queued";
    }
    return "ok";
  }

  /** The deliberate act (invariant 2): bundle every checkpoint since the last save into ONE named
   *  commit, then send it. Checkpoints stay the automatic crash-safety layer and are NEVER pushed
   *  as-is - the squash here is what turns a firehose of tiny edits into "one meaningful snapshot
   *  per save". An empty `message` falls back to a deterministic summary of the changed files. */
  async save(dir: string, message = ""): Promise<SyncResult> {
    assertNotCloudSynced(dir);
    // Record dirty work first: the receive below rebases, and a rebase refuses to start on a dirty
    // tree - the engine would treat that as a conflict and hard-reset (invariant 8).
    await this.checkpoint(dir);
    // Bring the squash base current. On a real conflict the never-lose backup path has already run
    // inside receive - the operator recovers from the kept copy; nothing is squashed over it.
    const received = await this.receive(dir);
    if (received === "needs-help" || received === "reconnect") return received;
    // "ok"/"local"/"offline" all continue: the squash and the name are local acts; the push at the
    // end reports whether the save also left the machine.
    return this.squashAndSend(dir, message);
  }

  /** The retry half of a save that could not send: push the LAST NAMED SAVE and nothing newer. A
   *  retry must send what the operator asked to send when they saved - never checkpoints (or a
   *  fresh squash) of work they did afterwards. No-op ("no-change") before any save exists. */
  async pushSave(dir: string): Promise<SyncResult> {
    assertNotCloudSynced(dir);
    if (!(await this.hasRemote(dir))) return "local";
    let sha: string;
    try {
      sha = (await this.git(["rev-parse", "--verify", "--quiet", LAST_SAVE_REF], dir)).trim();
    } catch {
      return "no-change"; // nothing has ever been saved - there is nothing to retry
    }
    try {
      await this.git(["push", "origin", `${sha}:refs/heads/main`], dir);
    } catch (e) {
      if (e instanceof AuthRevokedError) return "reconnect";
      return "queued"; // still offline (or the remote moved) - the save stays safe locally
    }
    return "ok";
  }

  /** Auto-save for a record surface (the activity ledger): a save that runs only when EVERYTHING
   *  waiting in the root lives under `prefix` - other unsaved work is the operator's to name and
   *  send, so its presence turns this into a no-op and the record rides their next save. With no
   *  remote there is nowhere to send to; the entry stays checkpointed (the caller's touch path). */
  async saveScoped(dir: string, prefix: string, message: string): Promise<SyncResult> {
    assertNotCloudSynced(dir);
    if (!(await this.hasRemote(dir))) return "local";
    await this.checkpoint(dir);
    const received = await this.receive(dir);
    if (received === "needs-help" || received === "reconnect") return received;
    // Offline: nothing is squashed - the checkpointed entry goes out with the next save instead of
    // arming a retry loop for a background record write.
    if (received === "offline") return "queued";
    const base = await this.saveBase(dir);
    const changed = base
      ? lines(await this.git(["diff", "--name-only", base, "HEAD"], dir))
      : lines(await this.git(["ls-files"], dir));
    if (changed.length === 0) return "no-change";
    if (!changed.every((f) => f.startsWith(prefix))) return "no-change";
    return this.squashAndSend(dir, message);
  }

  /** Point (or re-point) a root's `origin` at `url`, idempotently. No fetch, no auth needed. */
  async addRemote(dir: string, url: string): Promise<void> {
    if (await this.hasRemote(dir)) await this.git(["remote", "set-url", "origin", url], dir);
    else await this.git(["remote", "add", "origin", url], dir);
  }

  /** Local-disconnect primitive (invariant 8): drop `origin` so the root reverts to unconnected, but
   *  touch nothing else - no fetch, no reset, no commit is read or written, so every checkpoint stays
   *  in `git log` exactly as it was. A no-op (never throws) on a root that has no remote, since
   *  "already disconnected" is success, not an error the caller must special-case. */
  async removeRemote(dir: string): Promise<void> {
    if (await this.hasRemote(dir)) await this.git(["remote", "remove", "origin"], dir);
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
    return `${CHECKPOINT_MARK}${this.deps.actor}: update ${shown}${more}`;
  }

  /** The commit a save squashes onto: origin/main when the remote has one (post-receive it is an
   *  ancestor of HEAD holding exactly what is already published), else the last-save ref (the
   *  remoteless workspace), else null - a workspace that has never saved at all. */
  private async saveBase(dir: string): Promise<string | null> {
    if (await this.remoteMainExists(dir)) return (await this.git(["rev-parse", "origin/main"], dir)).trim();
    try {
      return (await this.git(["rev-parse", "--verify", "--quiet", LAST_SAVE_REF], dir)).trim();
    } catch {
      return null;
    }
  }

  /** The squash-name-push tail shared by save() and saveScoped(). Runs on a clean tree (both
   *  callers checkpoint first). `git reset --soft` moves HEAD only - the index still holds the
   *  pre-squash tree, so the commit that follows carries every checkpoint's content in one named
   *  snapshot; the checkpoint commits themselves drop out of the branch (they remain reachable from
   *  the reflog, but History is the named layer from here on). */
  private async squashAndSend(dir: string, message: string): Promise<SyncResult> {
    // A save's subject must never read as a checkpoint - strip a leading marker rather than let a
    // pasted "~..." message vanish from History.
    const named = message.trim().replace(/^~+\s*/, "");
    if (!(await this.hasAnyCommit(dir))) return "no-change"; // brand-new empty root - nothing at all
    const base = await this.saveBase(dir);
    const ahead = base
      ? parseInt((await this.git(["rev-list", "--count", `${base}..HEAD`], dir)).trim(), 10)
      : parseInt((await this.git(["rev-list", "--count", "HEAD"], dir)).trim(), 10);
    if (ahead === 0) {
      // Level with the base and (post-checkpoint) clean: nothing to save. Keep the ref current so a
      // later disconnect leaves the remoteless workspace with the right base.
      await this.git(["update-ref", LAST_SAVE_REF, "HEAD"], dir);
      return "no-change";
    }
    // What this save will contain - computed BEFORE any ref moves, so a net-zero run of checkpoints
    // (an edit made and undone) is detected while backing out is still trivial.
    const changed = base
      ? lines(await this.git(["diff", "--name-only", base, "HEAD"], dir))
      : lines(await this.git(["ls-files"], dir));
    if (changed.length === 0) {
      if (base) {
        // The checkpoints summed to no change - fold them away; HEAD lands exactly on the base.
        await this.git(["reset", "--soft", base], dir);
        await this.git(["update-ref", LAST_SAVE_REF, "HEAD"], dir);
      }
      return "no-change";
    }
    const tip = (await this.git(["log", "-1", "--format=%s"], dir)).trim();
    // The one commit ahead is already a named save (an earlier save that could not send, being
    // retried by hand) - keep it, name included, rather than re-squash it under a fallback subject.
    // An explicit message wins: the operator is renaming the bundle now.
    const keep = named === "" && ahead === 1 && !isCheckpointSubject(tip);
    if (!keep) {
      if (base) {
        await this.git(["reset", "--soft", base], dir);
      } else {
        // The very first save of a workspace that has never had one: no base exists, so the save
        // becomes the single root commit - everything before it was checkpoints.
        const branch = (await this.git(["symbolic-ref", "--quiet", "HEAD"], dir)).trim();
        await this.git(["update-ref", "-d", branch], dir);
      }
      await this.git(["commit", "-m", named || saveMessage(changed)], dir);
    }
    await this.git(["update-ref", LAST_SAVE_REF, "HEAD"], dir);
    if (!(await this.hasRemote(dir))) return "local";
    try {
      await this.git(["push", "origin", "HEAD:main"], dir);
    } catch (e) {
      if (e instanceof AuthRevokedError) return "reconnect";
      return "queued"; // the named save is retained locally and goes out on the next attempt
    }
    return "ok";
  }

  /** Whether the repo has any commit yet (a freshly-initialised root does not). */
  private async hasAnyCommit(dir: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], dir);
      return true;
    } catch {
      return false;
    }
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
    // APPEND, never overwrite: a second conflict can land before the operator has looked at the
    // first, and the recovery surface (sync/conflicts.ts) lists backups from these lines - an
    // overwrite would leave the earlier backup on disk but unreachable from the console.
    writeFileSync(
      join(dir, ".sync-needs-help"),
      `Conflict at ${stamp}. Your version was saved under .conflicts/${stamp}/ - nothing was lost.\n`,
      { flag: "a" },
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

/** The fallback save subject when the operator leaves the message blank: a deterministic summary of
 *  what the save contains, in their vocabulary (documents, not commits). */
function saveMessage(files: string[]): string {
  const noun = files.length === 1 ? "document" : "documents";
  const shown = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? `, +${files.length - 3} more` : "";
  return `Save: ${files.length} ${noun} updated (${shown}${more})`;
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
