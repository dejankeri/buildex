// The deliberate layer of invariant 2: save() bundles every checkpoint since the last save into ONE
// named commit and sends it - checkpoints are never pushed as-is. Real git in tmpdirs, like
// engine.test.ts; deterministic via the injected clock.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SyncEngine, isCheckpointSubject, CHECKPOINT_MARK } from "./engine.js";

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
/** A local-only repo (no account yet) - the remoteless workspace the last-save ref exists for. */
function localRepo(name: string): string {
  const dir = join(root, name);
  git(["init", "--initial-branch=main", dir], root);
  return dir;
}
const subjects = (dir: string, ref = "HEAD") => git(["log", "--format=%s", ref], dir).trim().split("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "buildex-save-"));
  remote = seedRemote();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function engine(now = () => 1_700_000_000_000) {
  return new SyncEngine({ now, actor: "operator" });
}

describe("checkpoint marking", () => {
  it("marks every checkpoint subject so the two layers of history stay distinguishable", async () => {
    const op = clone("op");
    writeFileSync(join(op, "notes.md"), "hi\n");
    await engine().checkpoint(op);
    const subject = subjects(op)[0]!;
    expect(subject.startsWith(CHECKPOINT_MARK)).toBe(true);
    expect(isCheckpointSubject(subject)).toBe(true);
  });
});

describe("save - squash + name + push", () => {
  it("bundles several checkpoints into ONE named commit and pushes it; no checkpoint reaches the remote", async () => {
    const op = clone("op");
    const e = engine();
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(op, `doc${i}.md`), `edit ${i}\n`);
      expect(await e.checkpoint(op)).toBe("committed");
    }
    expect(await e.save(op, "Repriced the Pro tier")).toBe("ok");

    // The remote gained exactly one commit, named by the operator - never the checkpoints.
    expect(subjects(remote, "main")).toEqual(["Repriced the Pro tier", "seed"]);
    // The local log is the same named layer now (the checkpoints were folded into the save).
    expect(subjects(op)).toEqual(["Repriced the Pro tier", "seed"]);
    // And the save carries all of the checkpoints' content.
    const verify = clone("verify");
    for (let i = 0; i < 3; i++) expect(readFileSync(join(verify, `doc${i}.md`), "utf8")).toBe(`edit ${i}\n`);
  });

  it("checkpoints dirty work itself before saving - an unrecorded edit is part of the save", async () => {
    const op = clone("op");
    writeFileSync(join(op, "draft.md"), "dirty, never checkpointed\n");
    expect(await engine().save(op, "First draft")).toBe("ok");
    expect(git(["show", "main:draft.md"], remote)).toBe("dirty, never checkpointed\n");
    expect(git(["status", "--porcelain"], op).trim()).toBe("");
  });

  it("falls back to a deterministic summary when the message is blank", async () => {
    const op = clone("op");
    const e = engine();
    writeFileSync(join(op, "a.md"), "a\n");
    await e.checkpoint(op);
    writeFileSync(join(op, "b.md"), "b\n");
    await e.checkpoint(op);
    expect(await e.save(op, "")).toBe("ok");
    expect(subjects(op)[0]).toBe("Save: 2 documents updated (a.md, b.md)");
  });

  it("reports no-change when level with the remote and clean - nothing to save", async () => {
    const op = clone("op");
    expect(await engine().save(op, "nothing here")).toBe("no-change");
    expect(subjects(remote, "main")).toEqual(["seed"]);
  });

  it("rebases onto a teammate's save first, so the squash base is current", async () => {
    const op1 = clone("op1");
    const op2 = clone("op2");
    writeFileSync(join(op1, "theirs.md"), "teammate\n");
    expect(await engine().save(op1, "Their save")).toBe("ok");

    writeFileSync(join(op2, "mine.md"), "mine\n");
    await engine().checkpoint(op2);
    expect(await engine().save(op2, "My save")).toBe("ok");
    // Linear named history: my save sits on top of theirs, nothing lost, no checkpoint subjects.
    expect(subjects(remote, "main")).toEqual(["My save", "Their save", "seed"]);
  });

  it("strips a leading checkpoint marker from an operator message so the save can never vanish from History", async () => {
    const op = clone("op");
    writeFileSync(join(op, "a.md"), "a\n");
    expect(await engine().save(op, "~ looks like a checkpoint")).toBe("ok");
    expect(subjects(op)[0]).toBe("looks like a checkpoint");
  });
});

describe("save - remoteless workspace (squash against the last-save ref)", () => {
  it("first save folds the whole checkpoint history into one named root commit and reports local", async () => {
    const dir = localRepo("solo");
    const e = engine();
    writeFileSync(join(dir, "plan.md"), "v1\n");
    await e.checkpoint(dir);
    writeFileSync(join(dir, "plan.md"), "v2\n");
    await e.checkpoint(dir);

    expect(await e.save(dir, "The plan")).toBe("local");
    expect(subjects(dir)).toEqual(["The plan"]); // one named commit IS the history
    expect(readFileSync(join(dir, "plan.md"), "utf8")).toBe("v2\n");
  });

  it("a later save squashes only the checkpoints made since the last save", async () => {
    const dir = localRepo("solo2");
    const e = engine();
    writeFileSync(join(dir, "plan.md"), "v1\n");
    await e.checkpoint(dir);
    expect(await e.save(dir, "The plan")).toBe("local");

    writeFileSync(join(dir, "plan.md"), "v2\n");
    await e.checkpoint(dir);
    writeFileSync(join(dir, "notes.md"), "notes\n");
    await e.checkpoint(dir);
    expect(await e.save(dir, "Revised the plan")).toBe("local");

    expect(subjects(dir)).toEqual(["Revised the plan", "The plan"]);
  });

  it("reports no-change on a remoteless workspace with nothing new since the last save", async () => {
    const dir = localRepo("solo3");
    const e = engine();
    writeFileSync(join(dir, "plan.md"), "v1\n");
    expect(await e.save(dir, "The plan")).toBe("local");
    expect(await e.save(dir, "again")).toBe("no-change");
    expect(subjects(dir)).toEqual(["The plan"]);
  });
});

describe("save - offline and the pushSave retry", () => {
  it("queues offline: the named commit exists locally, and pushSave sends it once reconnected", async () => {
    const op = clone("op");
    const e = engine();
    writeFileSync(join(op, "q.md"), "made offline\n");
    git(["remote", "set-url", "origin", `file://${join(root, "gone.git")}`], op);
    expect(await e.save(op, "Offline save")).toBe("queued");
    expect(subjects(op)[0]).toBe("Offline save"); // named and retained locally

    git(["remote", "set-url", "origin", `file://${remote}`], op);
    expect(await e.pushSave(op)).toBe("ok");
    expect(subjects(remote, "main")[0]).toBe("Offline save");
  });

  it("pushSave sends ONLY the named save - checkpoints made after the click stay home", async () => {
    const op = clone("op");
    const e = engine();
    writeFileSync(join(op, "q.md"), "asked to send\n");
    git(["remote", "set-url", "origin", `file://${join(root, "gone.git")}`], op);
    expect(await e.save(op, "What I asked to send")).toBe("queued");

    // The operator keeps working while offline - newer checkpoints on top of the unpushed save.
    writeFileSync(join(op, "later.md"), "an hour of work afterwards\n");
    await e.checkpoint(op);

    git(["remote", "set-url", "origin", `file://${remote}`], op);
    expect(await e.pushSave(op)).toBe("ok");
    expect(subjects(remote, "main")[0]).toBe("What I asked to send");
    expect(git(["ls-tree", "-r", "--name-only", "main"], remote)).not.toContain("later.md");
  });

  it("pushSave is a no-op before anything was ever saved", async () => {
    const op = clone("op");
    expect(await engine().pushSave(op)).toBe("no-change");
  });

  it("a nameless re-save of an unpushed save keeps its name instead of re-squashing it away", async () => {
    const op = clone("op");
    const e = engine();
    writeFileSync(join(op, "q.md"), "x\n");
    git(["remote", "set-url", "origin", `file://${join(root, "gone.git")}`], op);
    expect(await e.save(op, "My named save")).toBe("queued");

    git(["remote", "set-url", "origin", `file://${remote}`], op);
    expect(await e.save(op)).toBe("ok"); // saving again by hand, message left blank
    expect(subjects(remote, "main")[0]).toBe("My named save");
  });
});

describe("save - the conflict path stays the never-lose path", () => {
  it("backs the operator's version up and reports needs-help; a later save proceeds cleanly", async () => {
    const op1 = clone("op1");
    const op2 = clone("op2");

    writeFileSync(join(op1, "doc.md"), "op1 version\n");
    expect(await engine().save(op1, "Their change")).toBe("ok");

    const precious = "op2 precious edit\n";
    writeFileSync(join(op2, "doc.md"), precious);
    expect(await engine(() => 1_700_000_000_000).save(op2, "My change")).toBe("needs-help");

    // Invariant 8: the operator's version survives byte-for-byte; the tree holds the team's.
    expect(readFileSync(join(op2, ".conflicts", "1700000000000", "doc.md"), "utf8")).toBe(precious);
    expect(readFileSync(join(op2, "doc.md"), "utf8")).toBe("op1 version\n");
    expect(existsSync(join(op2, ".sync-needs-help"))).toBe(true);
    // Nothing was squashed over the conflict, and the next save works normally.
    writeFileSync(join(op2, "doc.md"), "recovered by hand\n");
    expect(await engine().save(op2, "Brought my edit back")).toBe("ok");
    expect(subjects(remote, "main")[0]).toBe("Brought my edit back");
  });
});

describe("saveScoped - the record surface's auto-save", () => {
  it("saves and pushes when everything waiting lives under the prefix", async () => {
    const op = clone("op");
    mkdirSync(join(op, "activity"), { recursive: true });
    writeFileSync(join(op, "activity", "2026-07.md"), "- entry\n");
    expect(await engine().saveScoped(op, "activity/", "Activity ledger update")).toBe("ok");
    expect(subjects(remote, "main")[0]).toBe("Activity ledger update");
  });

  it("does nothing when other unsaved work is waiting - it must never publish undecided work", async () => {
    const op = clone("op");
    mkdirSync(join(op, "activity"), { recursive: true });
    writeFileSync(join(op, "activity", "2026-07.md"), "- entry\n");
    writeFileSync(join(op, "pricing.md"), "not decided yet\n");
    expect(await engine().saveScoped(op, "activity/", "Activity ledger update")).toBe("no-change");
    expect(subjects(remote, "main")).toEqual(["seed"]); // nothing left the machine
    // Everything is still checkpointed locally (crash safety) and rides the next manual save.
    expect(git(["status", "--porcelain"], op).trim()).toBe("");
  });

  it("reports local (and squashes nothing) when there is no remote to send to", async () => {
    const dir = localRepo("solo");
    mkdirSync(join(dir, "activity"), { recursive: true });
    writeFileSync(join(dir, "activity", "2026-07.md"), "- entry\n");
    expect(await engine().saveScoped(dir, "activity/", "Activity ledger update")).toBe("local");
    expect(git(["rev-list", "--count", "--all"], dir).trim()).toBe("0"); // nothing committed here
  });
});
