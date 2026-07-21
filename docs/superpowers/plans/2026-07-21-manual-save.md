# Manual Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sending the operator's work to the cloud automatically. Work is checkpointed locally as it happens; one click in the pending tray sends all of it.

**Architecture:** `SyncEngine.syncWritable()` today fuses stage → commit → fetch → rebase → push into one act, and the scheduler calls it on a 2-second debounce. That fusion is the entire reason every edit reaches the cloud. This plan splits it into `checkpoint` (local, no network), `receive` (inbound), and `publish` (outbound, operator-triggered), then repoints the scheduler: debounce → `checkpoint`, background tick → `receive`, and nothing → `publish` except a click.

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers), Node 22 built-ins, Vitest, real `git` in temp dirs, plain browser JS for the console UI.

**Spec:** `docs/superpowers/specs/2026-07-21-manual-save-design.md`

## Global Constraints

- **The rule this implements:** other people's work arrives on its own; the operator's leaves only when they say so.
- **The load-bearing property: `checkpoint` must make no network call.** Everything else follows from it. If that assertion is ever weakened, automatic publishing silently returns.
- Operator-facing copy must never contain `push`, `commit`, `branch`, `merge`, `diff`, or `repo`. Those words appear nowhere in the console's operator copy today except three deep-linked places, and this feature must not add a fourth.
- All relative imports use **`.js` specifiers** (`module: NodeNext`). `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` are on; type-only imports use `import type`.
- Every git invocation goes through `pinnedGit()` from `lib/git-pin.ts` — it keeps checkouts LF-canonical so the conflict backup stays byte-for-byte on Windows (invariant 8).
- **No network in unit lanes.** Tests drive real `git` against `file://` bare repos in temp dirs, never a real remote.
- `apps/client` runs on the Windows CI lane. Do not add posix-only assumptions to `src/`.
- The invariant registry (`src/invariants/invariants-registry.test.ts`) asserts the tagged set is exactly `determinism, gates, permission-matrix, secrets, sync-safety`. **Reuse the existing `sync-safety` tag — inventing a new tag name fails the gate.**
- `core` stays read-only and pull-only. Never checkpoint or publish it.
- Do not wire the automations drain — out of scope.
- Commit after every task. Run `task ci` before the final task's commit.

---

### Task 1: Counting unsaved work

A read-only, network-free module that answers "how much is waiting?" in the operator's terms. Kept out of the engine so the engine stays about moving work, not measuring it.

**Files:**
- Create: `apps/client/src/sync/unsaved.ts`
- Create: `apps/client/src/sync/unsaved.test.ts`
- Modify: `apps/client/src/sync/engine.ts` (export the existing `INTERNAL` constant)

**Interfaces:**
- Consumes: `pinnedGit(args: string[]): string[]` from `../lib/git-pin.js`; `INTERNAL: string[]` from `./engine.js`.
- Produces: `interface Unsaved { files: number; oldestAt: number | null }`, `unsavedIn(dir: string): Promise<Unsaved>`, `unsavedAcross(dirs: string[]): Promise<Unsaved>`, `STALE_AFTER_MS: number`, `isStale(oldestAt: number | null, now: number): boolean`. Tasks 4 and 5 depend on these exact names.

**Deviation from the spec, deliberate:** the spec shows the API returning `unsaved: { files, oldestAt }` and leaves the 24-hour nudge threshold to the UI. But the spec also requires that threshold be tested on a fake clock "in both directions", and `apps/client/web/` has no clock injection and no test runner — the logic would ship untested. So the threshold lives here as a pure, injected-clock function, and the daemon sends a derived `stale` boolean alongside `oldestAt`. The browser compares nothing.

- [ ] **Step 1: Export `INTERNAL` from the engine**

In `apps/client/src/sync/engine.ts`, change the declaration (currently around line 31) from `const INTERNAL` to:

```ts
/** Workspace-internal paths that must never be committed, and must never be counted as unsaved work
 *  (invariant: secrets/backups stay local). Exported so `unsaved.ts` filters by the same list rather
 *  than keeping a second copy that could drift. */
export const INTERNAL = [".conflicts", ".sync-needs-help", ".sessions", ".agent"];
```

- [ ] **Step 2: Write the failing test**

Create `apps/client/src/sync/unsaved.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { unsavedIn, unsavedAcross, isStale, STALE_AFTER_MS } from "./unsaved.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
} as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let root: string;
let remote: string;

function seedRemote(): string {
  const bare = join(root, "remote.git");
  git(["init", "--bare", "--initial-branch=main", bare], root);
  const seed = join(root, "seed");
  git(["clone", `file://${bare}`, seed], root);
  writeFileSync(join(seed, "doc.md"), "base\n");
  git(["add", "."], seed);
  git(["commit", "-m", "seed"], seed);
  git(["push", "origin", "HEAD:main"], seed);
  return bare;
}
function clone(name: string): string {
  const dir = join(root, name);
  git(["clone", `file://${remote}`, dir], root);
  git(["checkout", "main"], dir);
  return dir;
}
function commitFile(dir: string, rel: string, body: string): void {
  writeFileSync(join(dir, rel), body);
  git(["add", "-A"], dir);
  git(["commit", "-m", `edit ${rel}`], dir);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "buildex-unsaved-"));
  remote = seedRemote();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("unsavedIn", () => {
  it("reports nothing when level with the remote", async () => {
    const dir = clone("a");
    expect(await unsavedIn(dir)).toEqual({ files: 0, oldestAt: null });
  });

  it("counts a committed-but-unsent change and dates it", async () => {
    const dir = clone("a");
    commitFile(dir, "doc.md", "changed\n");
    const u = await unsavedIn(dir);
    expect(u.files).toBe(1);
    expect(u.oldestAt).toBeGreaterThan(0);
  });

  it("counts FILES, not revisions - the operator thinks in documents", async () => {
    const dir = clone("a");
    commitFile(dir, "doc.md", "one\n");
    commitFile(dir, "doc.md", "two\n");
    commitFile(dir, "doc.md", "three\n");
    expect((await unsavedIn(dir)).files).toBe(1);
  });

  it("dates the work from the OLDEST unsent checkpoint, which is what the nudge escalates on", async () => {
    const dir = clone("a");
    commitFile(dir, "one.md", "1\n");
    const first = (await unsavedIn(dir)).oldestAt;
    commitFile(dir, "two.md", "2\n");
    expect((await unsavedIn(dir)).oldestAt).toBe(first);
  });

  it("counts an edit that has not been checkpointed yet - it is genuinely unsaved", async () => {
    const dir = clone("a");
    writeFileSync(join(dir, "fresh.md"), "typed a second ago\n");
    expect((await unsavedIn(dir)).files).toBe(1);
  });

  it("does not double-count a file that is both committed and edited again", async () => {
    const dir = clone("a");
    commitFile(dir, "doc.md", "committed\n");
    writeFileSync(join(dir, "doc.md"), "and edited again\n");
    expect((await unsavedIn(dir)).files).toBe(1);
  });

  it("never counts workspace-internal paths", async () => {
    const dir = clone("a");
    mkdirSync(join(dir, ".conflicts", "123"), { recursive: true });
    writeFileSync(join(dir, ".conflicts", "123", "doc.md"), "backup\n");
    writeFileSync(join(dir, ".sync-needs-help"), "flagged\n");
    mkdirSync(join(dir, ".sessions"), { recursive: true });
    writeFileSync(join(dir, ".sessions", "s1.json"), "{}\n");
    expect(await unsavedIn(dir)).toEqual({ files: 0, oldestAt: null });
  });

  it("treats everything as unsaved when there is no account yet", async () => {
    const dir = join(root, "localonly");
    mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", "."], dir);
    writeFileSync(join(dir, "a.md"), "a\n");
    writeFileSync(join(dir, "b.md"), "b\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "local"], dir);
    const u = await unsavedIn(dir);
    expect(u.files).toBe(2);
    expect(u.oldestAt).toBeGreaterThan(0);
  });

  it("reports nothing for a repository with no commits at all", async () => {
    const dir = join(root, "empty");
    mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", "."], dir);
    expect(await unsavedIn(dir)).toEqual({ files: 0, oldestAt: null });
  });
});

describe("isStale", () => {
  const t = 1_700_000_000_000;

  it("is not stale with nothing waiting", () => {
    expect(isStale(null, t)).toBe(false);
  });

  it("is not stale just under a day", () => {
    expect(isStale(t - (STALE_AFTER_MS - 1), t)).toBe(false);
  });

  it("is stale just over a day", () => {
    expect(isStale(t - (STALE_AFTER_MS + 1), t)).toBe(true);
  });

  it("is not stale exactly on the threshold - the nudge fires after a day, not at it", () => {
    expect(isStale(t - STALE_AFTER_MS, t)).toBe(false);
  });

  it("is not stale for a future timestamp, so a clock skew never invents urgency", () => {
    expect(isStale(t + 60_000, t)).toBe(false);
  });
});

describe("unsavedAcross", () => {
  it("sums the files and keeps the earliest date", async () => {
    const a = clone("a");
    const b = clone("b");
    commitFile(a, "one.md", "1\n");
    const aOldest = (await unsavedIn(a)).oldestAt!;
    commitFile(b, "two.md", "2\n");
    commitFile(b, "three.md", "3\n");
    const u = await unsavedAcross([a, b]);
    expect(u.files).toBe(3);
    expect(u.oldestAt).toBe(aOldest);
  });

  it("reports nothing across clean roots", async () => {
    expect(await unsavedAcross([clone("a"), clone("b")])).toEqual({ files: 0, oldestAt: null });
  });

  it("ignores a root that is not a repository rather than failing the whole count", async () => {
    const a = clone("a");
    commitFile(a, "one.md", "1\n");
    const notARepo = join(root, "plain");
    mkdirSync(notARepo, { recursive: true });
    expect((await unsavedAcross([a, notARepo])).files).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm run test --workspace @buildex/client -- unsaved.test
```

Expected: FAIL — `Failed to resolve import "./unsaved.js"`.

- [ ] **Step 4: Write the implementation**

Create `apps/client/src/sync/unsaved.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm run test --workspace @buildex/client -- unsaved.test
npm run typecheck --workspace @buildex/client
```

Expected: 17 tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/sync/unsaved.ts apps/client/src/sync/unsaved.test.ts apps/client/src/sync/engine.ts
git commit -m "feat(sync): count unsaved work in documents, not revisions

Ten edits to one document are one unsaved thing to an operator, so this counts
distinct files across both unsent checkpoints and edits not yet checkpointed -
a count taken mid-burst is never misleadingly low.

Read-only and network-free: the tray polls it, and it must never be the reason
saving appears to fail. INTERNAL moves from private to exported so the filter
is one list rather than two that could drift."
```

---

### Task 2: Split the engine

Three operations replace one. `syncWritable` is kept as a delegating alias so the tree stays green; Task 3 removes it once the scheduler stops calling it.

**Files:**
- Modify: `apps/client/src/sync/engine.ts`
- Modify: `apps/client/src/sync/engine.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `type CheckpointResult = "committed" | "no-change"`, `type ReceiveResult = "ok" | "needs-help" | "offline" | "local"`, and on `SyncEngine`: `checkpoint(dir: string): Promise<CheckpointResult>`, `receive(dir: string): Promise<ReceiveResult>`, `publish(dir: string): Promise<SyncResult>`. `SyncResult` and `syncReadonly` are unchanged. Task 3 depends on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `apps/client/src/sync/engine.test.ts` (the file's existing `root`/`remote`/`clone`/`seedRemote` helpers and `git` helper are in scope — reuse them, do not redefine them):

```ts
describe("checkpoint", () => {
  it("commits local work and reports that it did", async () => {
    const dir = clone("cp");
    writeFileSync(join(dir, "doc.md"), "mine\n");
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.checkpoint(dir)).toBe("committed");
    expect(git(["status", "--porcelain"], dir).trim()).toBe("");
  });

  it("reports no-change when there is nothing to record", async () => {
    const dir = clone("cp2");
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.checkpoint(dir)).toBe("no-change");
  });

  it("reports no-change when only workspace-internal paths changed", async () => {
    const dir = clone("cp3");
    mkdirSync(join(dir, ".conflicts", "1"), { recursive: true });
    writeFileSync(join(dir, ".conflicts", "1", "doc.md"), "backup\n");
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.checkpoint(dir)).toBe("no-change");
  });
});

describe("receive", () => {
  it("brings a teammate's work in without sending ours", async () => {
    const mine = clone("mine");
    const theirs = clone("theirs");
    writeFileSync(join(theirs, "theirs.md"), "from them\n");
    git(["add", "-A"], theirs);
    git(["commit", "-m", "theirs"], theirs);
    git(["push", "origin", "HEAD:main"], theirs);

    writeFileSync(join(mine, "mine.md"), "from me\n");
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    await engine.checkpoint(mine);
    expect(await engine.receive(mine)).toBe("ok");

    expect(existsSync(join(mine, "theirs.md"))).toBe(true);
    // Ours stayed home: the bare remote has no knowledge of mine.md.
    expect(git(["ls-tree", "-r", "--name-only", "main"], remote)).not.toContain("mine.md");
  });

  it("reports local when there is no account yet", async () => {
    const dir = join(root, "noremote");
    mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", "."], dir);
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.receive(dir)).toBe("local");
  });

  it("reports offline when the remote cannot be reached", async () => {
    const dir = clone("gone");
    git(["remote", "set-url", "origin", `file://${join(root, "does-not-exist.git")}`], dir);
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.receive(dir)).toBe("offline");
  });
});

describe("publish", () => {
  it("sends local work to the remote", async () => {
    const dir = clone("pub");
    writeFileSync(join(dir, "doc.md"), "mine\n");
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.publish(dir)).toBe("ok");
    expect(git(["show", "main:doc.md"], remote)).toContain("mine");
  });

  it("records work and reports queued when the remote is unreachable", async () => {
    const dir = clone("pubq");
    git(["remote", "set-url", "origin", `file://${join(root, "does-not-exist.git")}`], dir);
    writeFileSync(join(dir, "doc.md"), "mine\n");
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.publish(dir)).toBe("queued");
    // The work is safe locally even though it could not be sent (invariant 8).
    expect(git(["log", "--format=%s", "-1"], dir)).toContain("op: update");
  });

  it("reports local when there is no account yet, having still recorded the work", async () => {
    const dir = join(root, "pubnoremote");
    mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", "."], dir);
    writeFileSync(join(dir, "doc.md"), "mine\n");
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.publish(dir)).toBe("local");
    expect(git(["log", "--format=%s", "-1"], dir)).toContain("op: update");
  });

  it("reports no-change when there is nothing to send", async () => {
    const dir = clone("pubclean");
    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.publish(dir)).toBe("no-change");
  });
});

describe("SYNC-SAFETY INVARIANT [release-gate:sync-safety]: recording work never sends it", () => {
  it("checkpoint leaves the remote untouched", async () => {
    const dir = clone("never-sends");
    const before = git(["rev-parse", "main"], remote).trim();

    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `doc${i}.md`), `edit ${i}\n`);
      expect(await engine.checkpoint(dir)).toBe("committed");
    }

    expect(git(["rev-parse", "main"], remote).trim()).toBe(before);
  });

  it("checkpoint succeeds even when the remote is unreachable, proving it never touches the network", async () => {
    const dir = clone("no-network");
    git(["remote", "set-url", "origin", `file://${join(root, "does-not-exist.git")}`], dir);
    writeFileSync(join(dir, "doc.md"), "mine\n");

    const engine = new SyncEngine({ now: () => 1, actor: "op" });
    expect(await engine.checkpoint(dir)).toBe("committed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test --workspace @buildex/client -- engine.test
```

Expected: FAIL — `engine.checkpoint is not a function`.

- [ ] **Step 3: Implement the split**

In `apps/client/src/sync/engine.ts`, add the two result types next to `SyncResult` (around line 22):

```ts
export type SyncResult = "ok" | "needs-help" | "queued" | "no-change" | "local";
/** Recording work locally. No network, so no offline case exists. */
export type CheckpointResult = "committed" | "no-change";
/** Taking other people's work in. Never sends anything. */
export type ReceiveResult = "ok" | "needs-help" | "offline" | "local";
```

Replace the whole `syncWritable` method (currently lines 44-84) with:

```ts
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
```

Replace `commitMessage` (currently lines 127-135) with a version that takes the file list it already had to compute, plus the new `stagedFiles` helper. This removes a second `diff --cached` call and lets `checkpoint` decide on the same list it names:

```ts
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
```

Delete the now-unused `isDirty` method (currently lines 100-102).

Finally add the temporary alias directly below `publish`, so existing callers keep compiling until Task 3 repoints them:

```ts
  /** @deprecated Repointed in Task 3 and deleted there. Identical to `publish`. */
  async syncWritable(dir: string): Promise<SyncResult> {
    return this.publish(dir);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test --workspace @buildex/client -- engine.test
npm run typecheck --workspace @buildex/client
```

Expected: all PASS, including the pre-existing conflict-backup suite (its behaviour is unchanged — it now exercises `publish` through the alias). Typecheck clean.

- [ ] **Step 5: Verify the invariant registry still agrees**

```bash
npm run test --workspace @buildex/client -- invariants-registry
```

Expected: PASS. The new suite reuses the existing `sync-safety` tag, so the tagged set is unchanged. If this fails, a new tag name was invented — rename it to `sync-safety`.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/sync/engine.ts apps/client/src/sync/engine.test.ts
git commit -m "feat(sync): split recording work from sending it

syncWritable fused stage/commit/fetch/rebase/push into one act, which is why
every edit reached the cloud: the scheduler could not ask for one half without
getting the other. It becomes checkpoint (local, no network), receive
(inbound), and publish (the only operation that pushes).

The release gate now asserts the load-bearing property directly - checkpoint
leaves the remote untouched, and succeeds even when the remote is unreachable,
which it could not do if it touched the network.

checkpoint also decides on the staged file list rather than status --porcelain,
which reported the internal paths stage() had just unstaged and could ask git
to commit nothing. syncWritable stays as a delegating alias until the scheduler
is repointed."
```

---

### Task 3: Repoint the scheduler

The debounce stops publishing. This is the task that changes the product's behaviour.

**Files:**
- Modify: `apps/client/src/sync/scheduler.ts`
- Modify: `apps/client/src/sync/scheduler.test.ts`
- Modify: `apps/client/src/sync/engine.ts` (delete the `syncWritable` alias)

**Interfaces:**
- Consumes: `checkpoint`, `receive`, `publish`, `syncReadonly` from Task 2.
- Produces: `SyncEngineLike` gains `checkpoint`, `receive`, `syncReadonly`; `SyncSchedulerDeps` gains `readonlyRoots: () => string[]`; `flushNow()` is replaced by `publishAll(): Promise<SyncStatus>`. Task 4 depends on `publishAll`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/client/src/sync/scheduler.test.ts`, following the file's existing fake-clock and fake-engine helpers:

```ts
describe("manual save", () => {
  it("records work on the debounce but never sends it", async () => {
    const { scheduler, engine, clock } = makeScheduler();
    scheduler.touch("/w/team");
    await clock.advance(10_000);
    expect(engine.calls.checkpoint).toEqual(["/w/team"]);
    expect(engine.calls.publish).toEqual([]);
  });

  it("takes teammates' work in on the background tick, and still sends nothing", async () => {
    const { scheduler, engine, clock } = makeScheduler();
    scheduler.start();
    await clock.advance(45_000);
    expect(engine.calls.receive).toEqual(["/w/team", "/w/private"]);
    expect(engine.calls.syncReadonly).toEqual(["/w/core"]);
    expect(engine.calls.publish).toEqual([]);
  });

  it("sends everything only when the operator asks", async () => {
    const { scheduler, engine } = makeScheduler();
    expect(await scheduler.publishAll()).toBe("ok");
    expect(engine.calls.publish).toEqual(["/w/team", "/w/private"]);
  });

  it("never sends core, which is read-only", async () => {
    const { scheduler, engine } = makeScheduler();
    scheduler.touch("/w/core");
    await scheduler.publishAll();
    expect(engine.calls.checkpoint).not.toContain("/w/core");
    expect(engine.calls.publish).not.toContain("/w/core");
  });

  it("records but does not send on shutdown - quitting must not publish", async () => {
    const { scheduler, engine } = makeScheduler();
    scheduler.touch("/w/team");
    scheduler.stop();
    await Promise.resolve();
    expect(engine.calls.publish).toEqual([]);
  });

  it("retries a save that failed while offline", async () => {
    const { scheduler, engine, clock } = makeScheduler();
    engine.publishResult = "queued";
    expect(await scheduler.publishAll()).toBe("queued");
    engine.publishResult = "ok";
    await clock.advance(5_000);
    expect(engine.calls.publish.length).toBeGreaterThan(2);
  });
});
```

Extend the file's existing fake engine so it records per-operation calls and can be steered. If the existing fake is named differently, adapt these names to it rather than duplicating a second fake:

```ts
function makeEngine() {
  return {
    calls: { checkpoint: [] as string[], receive: [] as string[], publish: [] as string[], syncReadonly: [] as string[] },
    publishResult: "ok" as SyncResult,
    async checkpoint(dir: string) { this.calls.checkpoint.push(dir); return "committed" as const; },
    async receive(dir: string) { this.calls.receive.push(dir); return "ok" as const; },
    async publish(dir: string) { this.calls.publish.push(dir); return this.publishResult; },
    async syncReadonly(dir: string) { this.calls.syncReadonly.push(dir); },
  };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test --workspace @buildex/client -- scheduler.test
```

Expected: FAIL — `scheduler.publishAll is not a function`.

- [ ] **Step 3: Repoint the scheduler**

In `apps/client/src/sync/scheduler.ts`:

Update the imports and the two interfaces:

```ts
import type { SyncResult, CheckpointResult, ReceiveResult } from "./engine.js";

export interface SyncEngineLike {
  checkpoint(dir: string): Promise<CheckpointResult>;
  receive(dir: string): Promise<ReceiveResult>;
  publish(dir: string): Promise<SyncResult>;
  syncReadonly(dir: string): Promise<void>;
}

export interface SyncSchedulerDeps {
  engine: SyncEngineLike;
  /** The writable (non-`core`) roots - the only ones that may be checkpointed or published. */
  writableRoots: () => string[];
  /** Read-only roots (`core`) - pulled on the tick, never sent. */
  readonlyRoots: () => string[];
  clock: Clock;
  onStatus?: (s: SyncStatus) => void;
  regenConfig?: () => void;
}
```

Replace the body of `schedulePull` so the tick receives rather than flushes:

```ts
  private schedulePull(): void {
    this.pullTimer = this.deps.clock.setTimer(() => {
      this.schedulePull(); // keep ticking
      void this.receiveAll();
    }, PULL_MS);
  }

  /** Take in whatever arrived, in both directions of the workspace. Sends nothing, so this is safe
   *  to run unattended - it is the "other people's work arrives on its own" half of the rule. */
  private async receiveAll(): Promise<void> {
    for (const dir of this.deps.readonlyRoots()) {
      try {
        await this.deps.engine.syncReadonly(dir);
      } catch {
        /* offline or not a repo - core is rebuilt from the remote next tick */
      }
    }
    for (const dir of this.deps.writableRoots()) {
      try {
        const r = await this.deps.engine.receive(dir);
        if (r === "needs-help") this.setStatus("needs-help");
      } catch {
        /* nothing arrived; the operator's own work is untouched */
      }
    }
  }
```

Replace `flush()` with a checkpoint-only version, and add `publishAll()` alongside it:

```ts
  private setStatus(s: SyncStatus): void {
    this.lastStatus = s;
    this.deps.onStatus?.(s);
  }

  /** Record dirty roots locally. NO NETWORK - this is what the debounce runs. */
  private async flush(): Promise<SyncStatus> {
    if (this.flushing) {
      this.rerun = true;
      return this.lastStatus;
    }
    this.flushing = true;
    try {
      if (this.debounceTimer !== null) this.deps.clock.clearTimer(this.debounceTimer);
      if (this.maxWaitTimer !== null) this.deps.clock.clearTimer(this.maxWaitTimer);
      this.debounceTimer = null;
      this.maxWaitTimer = null;
      const roots = [...this.dirty];
      this.dirty.clear();
      if (roots.length === 0) return this.lastStatus;
      this.deps.regenConfig?.();
      // A throw (non-repo, cloud-synced folder) must never crash the loop - the file is already on
      // disk. Roots are distinct repos, so there is no cross-root race.
      await Promise.all(
        roots.map(async (dir) => {
          try {
            await this.deps.engine.checkpoint(dir);
          } catch {
            /* the operator's file is on disk regardless */
          }
        }),
      );
      return this.lastStatus;
    } finally {
      this.flushing = false;
      if (this.rerun) {
        this.rerun = false;
        void this.flush();
      }
    }
  }

  /** Send everything the operator has. The one path that pushes, and only they trigger it
   *  (POST /api/sync). */
  async publishAll(): Promise<SyncStatus> {
    await this.flush(); // record anything still in the debounce window first
    const roots = this.deps.writableRoots();
    this.setStatus("busy");
    const results = await Promise.all(
      roots.map(async (dir): Promise<SyncResult> => {
        try {
          return await this.deps.engine.publish(dir);
        } catch {
          return "no-change";
        }
      }),
    );
    const status = worstStatus(results);
    this.setStatus(status);

    // Offline roots keep their checkpoints locally; retry on a delay.
    const queued = roots.filter((_, i) => results[i] === "queued");
    if (this.backoffTimer !== null) this.deps.clock.clearTimer(this.backoffTimer);
    this.backoffTimer = null;
    if (queued.length > 0) {
      this.backoffTimer = this.deps.clock.setTimer(() => {
        this.backoffTimer = null;
        void this.publishAll();
      }, BACKOFF_MS);
    }
    return status;
  }
```

Update `stop()`'s comment and keep its behaviour — it now records rather than sends, which is the point:

```ts
  /** Record any pending work and halt every timer - call on app shutdown so no edit is stranded.
   *  It does NOT send: saving is the operator's decision, and quitting is not a decision to save.
   *  The checkpoints are on local disk and go out with their next save. */
  stop(): void {
    this.clearAllTimers();
    if (this.dirty.size > 0) void this.flush();
    this.clearAllTimers();
  }
```

Delete the old `flushNow()` method.

- [ ] **Step 4: Delete the engine alias**

In `apps/client/src/sync/engine.ts`, delete the `syncWritable` method added in Task 2 Step 3.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test --workspace @buildex/client -- scheduler.test
npm run typecheck --workspace @buildex/client
```

Expected: scheduler tests PASS. **Typecheck will fail in `wiring.ts`** — it still calls `flushNow` and constructs the scheduler without `readonlyRoots`. That is expected and Task 4 fixes it; do not patch `wiring.ts` here beyond what Task 4 specifies.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/sync/scheduler.ts apps/client/src/sync/scheduler.test.ts apps/client/src/sync/engine.ts
git commit -m "feat(sync): the debounce records work, it no longer sends it

The loop keeps its debounce, its backoff and its 45s tick; only the targets
change. The debounce checkpoints, the tick receives, and nothing schedules a
publish - publishAll is reachable only from the operator's click.

Shutdown records but does not send: quitting an app is not a decision to
publish, and the checkpoints are on local disk either way.

Two things fall out. The debounce can no longer fail from a network error,
because it no longer touches the network. And syncReadonly finally runs - it
has been implemented but unreachable, because SyncEngineLike declared only
syncWritable, so core was never actually updated."
```

---

### Task 4: Wire the daemon

**Files:**
- Modify: `apps/client/src/wiring.ts`
- Modify: `apps/client/src/daemon/daemon.ts`

**Interfaces:**
- Consumes: `publishAll()` (Task 3); `unsavedAcross(dirs)`, `Unsaved`, `isStale(oldestAt, now)` (Task 1).
- Produces: `GET /api/sync` → `{ status: string, unsaved: { files: number, oldestAt: number | null, stale: boolean } }`; `POST /api/sync` publishes. Task 5 consumes this shape and does no date arithmetic of its own.

- [ ] **Step 1: Write the failing test**

Add to `apps/client/src/daemon/daemon.test.ts`, matching that file's existing handler-construction helper:

```ts
it("reports status and what is waiting to be saved", async () => {
  const handler = makeHandler({
    syncStatus: () => "ok",
    unsavedFn: async () => ({ files: 14, oldestAt: 1_700_000_000_000, stale: false }),
  });
  const res = await handler(new Request("http://d/api/sync"));
  expect(await res.json()).toEqual({
    status: "ok",
    unsaved: { files: 14, oldestAt: 1_700_000_000_000, stale: false },
  });
});

it("reports nothing waiting when the daemon has no counter wired", async () => {
  const handler = makeHandler({ syncStatus: () => "ok" });
  const res = await handler(new Request("http://d/api/sync"));
  expect(await res.json()).toEqual({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false } });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test --workspace @buildex/client -- daemon.test
```

Expected: FAIL — the response is `{ status: "ok" }` with no `unsaved` key.

- [ ] **Step 3: Add the daemon dep and change the route**

In `apps/client/src/daemon/daemon.ts`, add to the deps interface beside the existing `syncStatus`:

```ts
  /** What is waiting to be saved, for the pending tray's one card. Optional: a daemon without it
   *  reports nothing waiting rather than failing the status poll. */
  unsavedFn?: () => Promise<{ files: number; oldestAt: number | null; stale: boolean }>;
```

Replace the `GET /api/sync` route (currently lines 593-595):

```ts
    if (method === "GET" && path === "/api/sync") {
      const unsaved = (await deps.unsavedFn?.()) ?? { files: 0, oldestAt: null, stale: false };
      return json({ status: deps.syncStatus?.() ?? "ok", unsaved });
    }
```

Update the comment on `POST /api/sync` (line 590) so the route's meaning is not mistaken for the old force-flush:

```ts
    // "Save now" - the operator's explicit decision to send everything. The only path that pushes.
    if (method === "POST" && path === "/api/sync") {
      return json({ result: await deps.syncFn() });
    }
```

- [ ] **Step 4: Wire it in `wiring.ts`**

At the scheduler construction (around line 248), add the new dep:

```ts
    readonlyRoots: () => config.roots.filter((r) => slotOf(r.name) === "core").map((r) => r.dir),
```

Import `slotOf` from `./brain/catalog.js` if it is not already imported in this file.

Replace the `syncFn` body (around line 755) so it publishes:

```ts
    syncFn: async () => {
      const s = await scheduler.publishAll();
      return s === "needs-help" ? "needs-help" : s === "queued" ? "queued" : s === "local" ? "local" : "ok";
    },
```

Add `unsavedFn` beside `syncStatus` (around line 761). The staleness comparison happens here, once, against the real clock — the browser is never handed a comparison to make:

```ts
    unsavedFn: async () => {
      const u = await unsavedAcross(writableDirs());
      return { ...u, stale: isStale(u.oldestAt, Date.now()) };
    },
```

Import them at the top of the file:

```ts
import { unsavedAcross, isStale } from "./sync/unsaved.js";
```

- [ ] **Step 5: Verify**

```bash
npm run test --workspace @buildex/client
npm run typecheck --workspace @buildex/client
```

Expected: the whole client suite PASSES and typecheck is clean — Task 3's expected `wiring.ts` failure is now resolved.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/wiring.ts apps/client/src/daemon/daemon.ts apps/client/src/daemon/daemon.test.ts
git commit -m "feat(sync): report what is waiting, and make POST /api/sync mean save

GET /api/sync gains an unsaved count so the tray can show one card without a
second endpoint; POST /api/sync changes from force-a-flush to the operator's
explicit save. Both routes already existed, so no new surface.

writableRoots/readonlyRoots now come from slotOf() rather than a name !=
'core' test, which is the classification the rest of the client already uses."
```

---

### Task 5: The pending card and the dot

The operator-facing half. `apps/client/web/` has no test runner, so this task is verified by driving the real app.

**Files:**
- Modify: `apps/client/web/js/pending.js`
- Modify: `apps/client/web/js/sync.js`
- Modify: `apps/client/web/js/projects.js`
- Modify: `apps/client/web/js/boot.js`
- Modify: `apps/client/web/styles/right-rail.css`

**Interfaces:**
- Consumes: `GET /api/sync` → `{ status, unsaved: { files, oldestAt } }`, `POST /api/sync` (Task 4).
- Produces: no JS exports other tasks rely on — this is the last task.

- [ ] **Step 1: Render the card in the pending tray**

In `apps/client/web/js/pending.js`, add a save card rendered above the approval cards. It fetches `/api/sync` alongside the existing `/api/pending` call and prepends its markup. Follow the file's existing DOM-building style.

Note: `stale` and the day count come from the daemon (Task 4). This file does no date arithmetic — the threshold is tested server-side and must not be duplicated here.

```js
const DAY_MS = 86400000;

// One pinned card above the approvals. Sending work to the company is an outward action, so this is
// the right tray for it (invariant 5) - but it is a single action with no decline, so it is shaped
// differently from the Approve/Deny pairs.
function saveCardHtml(sync, connected) {
  const n = sync.unsaved.files;
  if (n === 0) return "";
  const noun = n === 1 ? "change" : "changes";
  const stale = sync.unsaved.stale;
  const days = stale ? Math.max(1, Math.round((Date.now() - sync.unsaved.oldestAt) / DAY_MS)) : 0;

  if (!connected) {
    return (
      '<div class="pcard save' + (stale ? " stale" : "") + '">' +
      "<b>Save your work</b>" +
      "<p>" + n + " " + noun + " are staying on this machine. Connect an account to keep them safe." +
      "</p>" +
      '<button class="pbtn" id="save-now" data-connect="1">Connect an account</button>' +
      "</div>"
    );
  }
  const line = stale
    ? "This work has been on this machine for " + days + " day" + (days === 1 ? "" : "s") +
      ". It exists nowhere else."
    : n + " " + noun + " on this machine haven't been saved to your company yet.";
  return (
    '<div class="pcard save' + (stale ? " stale" : "") + '">' +
    "<b>Save your work</b>" +
    "<p>" + line + "</p>" +
    '<button class="pbtn" id="save-now">Save now</button>' +
    "</div>"
  );
}
```

`connected` is not a new lookup — a workspace with no account already reports `status === "local"`, in the same response:

```js
  const sync = await (await fetch("/api/sync")).json();
  const html = saveCardHtml(sync, sync.status !== "local") + existingApprovalCardsHtml;
```

Wire the button in the same place the tray binds its Approve/Deny handlers. **Check first whether `switchRight` is in scope in `pending.js`** — it is defined in `right-rail.js`, and these files share scope via plain script tags rather than modules. If it is not reachable, use the same mechanism the other cards use to change tabs rather than adding an import:

```js
  const saveBtn = document.querySelector("#save-now");
  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (saveBtn.dataset.connect) return switchRight("apps"); // no account yet - send them to setup
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        await fetch("/api/sync", { method: "POST" });
      } finally {
        rPending(); // re-render: the count is now zero, or the failure shows in the dot
      }
    };
  }
```

The card is hidden entirely in the sandbox org, which is local-forever. Follow the existing `body.sandbox` convention rather than adding a JS check:

```css
body.sandbox .pcard.save { display: none; }
```

- [ ] **Step 2: Add the dot state**

In `apps/client/web/js/sync.js`, add `unsaved` to the state/copy map:

```js
    unsaved: "You have unsaved work · click to save",
```

In `apps/client/web/styles/layout.css`, give it the neutral-but-noticeable treatment beside the existing dot states — reuse the `--gate` amber that `queued` already uses, without the pulse:

```css
.sync.unsaved .d { background: var(--gate); }
```

- [ ] **Step 3: Derive the state from the poll**

In `apps/client/web/js/projects.js`, the sync poll currently maps a bare status string. Update it for the new shape, with problems taking precedence over the unsaved count:

```js
      const s = await (await fetch("/api/sync")).json();
      const st =
        s.status === "needs-help" ? "help" :
        s.status === "queued" ? "queued" :
        s.status === "local" ? "local" :
        s.unsaved && s.unsaved.files > 0 ? "unsaved" : "ok";
      setSync(syncBusy ? "busy" : st);
```

- [ ] **Step 4: Route the dot click by state**

In `apps/client/web/js/boot.js`, replace the unconditional `switchRight("synclog")` binding:

```js
  // The dot leads to whatever the operator most likely wants: unsaved work means the action lives in
  // the pending tray, otherwise the change log answers "what happened?".
  $("#sync").onclick = () =>
    switchRight(document.querySelector("#sync").classList.contains("unsaved") ? "pending" : "synclog");
```

- [ ] **Step 5: Style the card**

In `apps/client/web/styles/right-rail.css`, beside the existing `.pcard` rules:

```css
.pcard.save { border-left: 3px solid var(--gate); }
.pcard.save.stale { border-left-color: var(--crit); }
.pcard.save p { margin: 4px 0 8px; color: var(--dim); }
```

- [ ] **Step 6: Verify in the real app**

Use the `run-worktree-app` skill to launch this worktree's app, then confirm by hand:

1. Edit a document. Within ~10 seconds the pending tray shows **Save your work** with a count, and the dot turns amber. **Nothing has been sent.**
2. Click **Save now**. The card disappears, the dot returns to green.
3. Stop the sync service (or disconnect); edit and save. The dot shows `queued` and the card stays.
4. In the Acme sandbox org, no save card appears at all.

Record what you actually observed, including anything that did not match.

- [ ] **Step 7: Run the full gate and commit**

```bash
task ci
```

Expected: exit 0.

```bash
git add apps/client/web/js/pending.js apps/client/web/js/sync.js apps/client/web/js/projects.js apps/client/web/js/boot.js apps/client/web/styles/right-rail.css apps/client/web/styles/layout.css
git commit -m "feat(ui): one card to save your work

The pending tray is already the default tab and already means 'something needs
you', so the save card belongs there - but it is a single action with no
decline, so it is shaped differently from the Approve/Deny pairs.

The count is files, not revisions: ten edits to one document is one unsaved
thing to an operator. After a day the card states the stakes plainly rather
than repeating a number. With no account the button offers to connect one, and
only when there is actually work waiting, so it is never a standing
advertisement.

No new operator-facing vocabulary: no push, commit, branch, merge or diff."
```

---

## Verification of the whole change

After Task 5, confirm the behaviour the spec promises, end to end:

- Editing for several minutes sends nothing. `git -C <workspace>/team log origin/main..HEAD` shows checkpoints; the bare remote is unchanged.
- A teammate's push appears locally within ~45 seconds without any operator action.
- One click sends everything, and the count returns to zero.
- Quitting the app does not send.
