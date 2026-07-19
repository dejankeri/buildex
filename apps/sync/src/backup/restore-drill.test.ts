import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ControlPlaneStore } from "../store/store.js";
import { runRestoreDrill } from "./restore-drill.js";

let base: string;
let dataDir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "buildex-restore-"));
  dataDir = join(base, "srv");
  mkdirSync(join(dataDir, "repos"), { recursive: true });
  // seed control.db with a company + a bare repo, as the live server would hold
  const store = new ControlPlaneStore(join(dataDir, "control.db"));
  store.createCompany({ id: "c1", slug: "northwind", name: "Northwind" });
  store.checkpoint();
  store.close();
  execFileSync("git", ["init", "--bare", join(dataDir, "repos", "team-northwind.git")], { stdio: "ignore" });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("runRestoreDrill - recover control.db + repos onto a clean machine", () => {
  it("backs up, restores onto a fresh target, and verifies the data is intact", () => {
    const backupDir = join(base, "backup");
    const targetDir = join(base, "clean-vm", "srv");

    const result = runRestoreDrill({ dataDir, backupDir, targetDir });

    expect(result.ok).toBe(true);
    expect(result.companies).toBe(1);
    expect(result.repos).toContain("team-northwind.git");

    // the restored control.db really opens and holds the company
    const restored = new ControlPlaneStore(join(targetDir, "control.db"));
    expect(restored.getCompany("c1")).toMatchObject({ slug: "northwind" });
    restored.close();

    // the restored repo is a valid bare git repo
    const bare = execFileSync("git", ["rev-parse", "--is-bare-repository"], { cwd: join(targetDir, "repos", "team-northwind.git"), encoding: "utf8" }).trim();
    expect(bare).toBe("true");
  });

  it("fails clearly if the backup is missing the control database", () => {
    const backupDir = join(base, "empty-backup");
    mkdirSync(backupDir, { recursive: true });
    expect(() => runRestoreDrill({ dataDir: backupDir, backupDir: join(base, "b2"), targetDir: join(base, "t2") })).toThrow(/control\.db/i);
  });
});
