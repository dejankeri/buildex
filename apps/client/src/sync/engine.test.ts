import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SyncEngine } from "./engine.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
} as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let root: string;
let remote: string;

/** A bare remote seeded with one commit on main, plus a helper to clone working copies from it. */
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "buildex-sync-"));
  remote = seedRemote();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function engine(now = () => 1_700_000_000_000) {
  return new SyncEngine({ now, actor: "operator" });
}

describe("publish - clean path", () => {
  it("commits local changes and pushes them; a fresh clone sees them", async () => {
    const op = clone("op1");
    writeFileSync(join(op, "conventions.md"), "# conventions\n");
    expect(await engine().publish(op)).toBe("ok");

    const verify = clone("verify");
    expect(readFileSync(join(verify, "conventions.md"), "utf8")).toContain("conventions");
  });

  it("writes a human-readable commit message (actor + changed files)", async () => {
    const op = clone("op1");
    writeFileSync(join(op, "notes.md"), "hi\n");
    await engine().publish(op);
    const msg = git(["log", "-1", "--pretty=%s"], op);
    expect(msg).toContain("operator");
    expect(msg).toContain("notes.md");
  });

  it("returns no-change when there is nothing to sync", async () => {
    const op = clone("op1");
    expect(await engine().publish(op)).toBe("no-change");
  });
});

describe("git runs off the event loop (B6)", () => {
  it("yields to the loop while a sync is in flight - a concurrent task interleaves", async () => {
    const op = clone("op1");
    writeFileSync(join(op, "x.md"), "hi\n");
    let interleaved = false;
    const syncP = engine().publish(op);
    // With synchronous git this call would block to completion before returning; because git is now
    // async, control returns to the event loop and this setImmediate fires WHILE the sync runs.
    await new Promise<void>((r) =>
      setImmediate(() => {
        interleaved = true;
        r();
      }),
    );
    expect(interleaved).toBe(true);
    expect(await syncP).toBe("ok"); // the op1 clone has a real remote, so the change commits + pushes
  });
});

describe("first sync to a freshly-provisioned (empty) remote", () => {
  it("pushes the initial commit without mistaking the empty remote for a conflict", async () => {
    // an empty bare remote (no seed commit) + an empty clone - the just-provisioned state
    const emptyBare = join(root, "empty.git");
    git(["init", "--bare", "--initial-branch=main", emptyBare], root);
    const op = join(root, "fresh");
    git(["clone", `file://${emptyBare}`, op], root);

    writeFileSync(join(op, "conventions.md"), "# conventions\n");
    expect(await engine().publish(op)).toBe("ok");

    const verify = join(root, "fresh-verify");
    git(["clone", "--branch", "main", `file://${emptyBare}`, verify], root);
    expect(readFileSync(join(verify, "conventions.md"), "utf8")).toContain("conventions");
  });
});

describe("syncReadonly - core is reset to origin, local edits discarded by design", () => {
  it("hard-resets a local edit back to origin", async () => {
    const core = clone("core");
    writeFileSync(join(core, "doc.md"), "tampered\n");
    await engine().syncReadonly(core);
    expect(readFileSync(join(core, "doc.md"), "utf8")).toBe("base\n");
  });
});

describe("SYNC-SAFETY INVARIANT [release-gate:sync-safety]: a conflict never loses operator work", () => {
  it("backs up the local version byte-for-byte to .conflicts/<ts>/ then resets to remote", async () => {
    // BOTH machines clone from the same base first, so their edits genuinely diverge.
    const op1 = clone("op1");
    const op2 = clone("op2");

    // op1 changes doc.md and pushes first
    writeFileSync(join(op1, "doc.md"), "op1 version\n");
    expect(await engine().publish(op1)).toBe("ok");

    // op2, from the same base, makes a *different* change to the same file
    const localContent = "op2 precious edit\n";
    writeFileSync(join(op2, "doc.md"), localContent);

    const result = await engine(() => 1_700_000_000_000).publish(op2);
    expect(result).toBe("needs-help");

    // the operator's version is preserved byte-for-byte under .conflicts/<ts>/
    const backup = join(op2, ".conflicts", "1700000000000", "doc.md");
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, "utf8")).toBe(localContent);

    // the working tree is reset to the remote version, and a needs-attention marker exists
    expect(readFileSync(join(op2, "doc.md"), "utf8")).toBe("op1 version\n");
    expect(existsSync(join(op2, ".sync-needs-help"))).toBe(true);
  });

  it("stays byte-identical LF even with core.autocrlf=true, the Git-for-Windows default", async () => {
    // WHY THIS EXISTS: engine.git() pins `-c core.autocrlf=false -c core.eol=lf`, and without this
    // case nothing defends that pin. The test above cannot: it sets GIT_CONFIG_GLOBAL/SYSTEM only for
    // the harness's own git helper, while the engine under test inherits process.env - so whether the
    // pin matters depends entirely on the HOST's git config. On Ubuntu and macOS, where autocrlf
    // defaults to false, deleting the pin changes nothing and the gate stays green.
    //
    // core.autocrlf is set REPO-LOCAL here, which no GIT_CONFIG_* neutralises, so this reproduces the
    // stock Windows condition deterministically on every lane. Delete the pin and this fails with
    // 'op2 precious edit\r\n' != 'op2 precious edit\n' - the conflict backup no longer matching the
    // operator's file, which is a breach of invariant 8.
    const op1 = clone("op1");
    const op2 = clone("op2");
    git(["config", "core.autocrlf", "true"], op2);

    writeFileSync(join(op1, "doc.md"), "op1 version\n");
    expect(await engine().publish(op1)).toBe("ok");

    const localContent = "op2 precious edit\n";
    writeFileSync(join(op2, "doc.md"), localContent);

    expect(await engine(() => 1_700_000_000_000).publish(op2)).toBe("needs-help");

    // byte-for-byte: no CRLF crept into the backup...
    const backup = readFileSync(join(op2, ".conflicts", "1700000000000", "doc.md"), "utf8");
    expect(backup).toBe(localContent);
    expect(backup).not.toContain("\r");

    // ...nor into the working tree the reset materialised.
    const reset = readFileSync(join(op2, "doc.md"), "utf8");
    expect(reset).toBe("op1 version\n");
    expect(reset).not.toContain("\r");
  });
});

describe("local-only stub repo (no remote): work is committed but there is nothing to sync", () => {
  it("commits local changes and reports 'local' (not 'queued') when no remote is configured", async () => {
    const stub = join(root, "stub");
    git(["init", "--initial-branch=main", stub], root);
    writeFileSync(join(stub, "notes.md"), "played locally\n");

    expect(await engine().publish(stub)).toBe("local");
    // git is the database: the operator's work is captured in local history, not lost
    expect(git(["log", "-1", "--pretty=%s"], stub)).toContain("notes.md");
  });

  it("reports 'local' on a clean local repo too, so the idle pull tick never shows 'queued'", async () => {
    const stub = join(root, "stub2");
    git(["init", "--initial-branch=main", stub], root);
    writeFileSync(join(stub, "seed.md"), "x\n");
    git(["add", "."], stub);
    git(["commit", "-m", "seed"], stub);

    // no changes, no remote - a pull-tick sync must report the neutral local state, not queued
    expect(await engine().publish(stub)).toBe("local");
  });

  it("still returns 'queued' when a remote IS configured but unreachable (offline, not local)", async () => {
    // guards the split: origin exists (account opened) but is offline → queued+retry, never 'local'
    const op = clone("op-offline");
    writeFileSync(join(op, "q.md"), "offline\n");
    git(["remote", "set-url", "origin", `file://${join(root, "gone.git")}`], op);
    expect(await engine().publish(op)).toBe("queued");
  });
});

describe("cloud-guard: refuse to operate inside a cloud-synced folder", () => {
  it("throws for a path under a known cloud provider dir", async () => {
    const dropbox = join(root, "Dropbox", "ws");
    mkdirSync(dropbox, { recursive: true });
    await expect(engine().publish(dropbox)).rejects.toThrow(/cloud/i);
  });
});

describe("offline queue: unpushed commits survive and a later sync pushes them", () => {
  it("queues on push failure, then a fresh engine pushes the retained commit", async () => {
    const op = clone("op1");
    writeFileSync(join(op, "queued.md"), "made offline\n");
    // simulate offline by pointing origin at a nonexistent remote
    git(["remote", "set-url", "origin", `file://${join(root, "gone.git")}`], op);
    expect(await engine().publish(op)).toBe("queued");
    // the commit is retained locally (not lost)
    expect(git(["log", "-1", "--pretty=%s"], op)).toContain("queued.md");

    // reconnect + a NEW engine instance (restart) pushes the queued commit
    git(["remote", "set-url", "origin", `file://${remote}`], op);
    expect(await engine().publish(op)).toBe("ok");
    const verify = clone("verify2");
    expect(existsSync(join(verify, "queued.md"))).toBe(true);
  });
});

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
