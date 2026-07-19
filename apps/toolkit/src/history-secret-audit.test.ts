import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { auditHistory } from "./history-secret-audit.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-audit-"));
  git(["init", "--initial-branch=main", dir], dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function commit(file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  git(["add", "."], dir);
  git(["commit", "-m", msg], dir);
}

describe("auditHistory - the history secret gate", () => {
  it("passes a history with no secrets", () => {
    commit("readme.md", "# hello\n", "init");
    commit("readme.md", "# hello world\n", "edit");
    const res = auditHistory(dir);
    expect(res.clean).toBe(true);
    expect(res.findings).toEqual([]);
  });

  it("catches a secret that was committed and later removed (still in history)", () => {
    // Build the fake key from parts so this SOURCE file has no literal key for CI's secret-scan to
    // flag - the runtime-written commit content below still contains the full string for the audit.
    const fakeKey = "AKIA" + "IOSFODNN7EXAMPLE";
    commit("config.md", `aws key: ${fakeKey}\n`, "oops committed a key");
    commit("config.md", "aws key: (moved to env)\n", "remove the key from HEAD");
    // HEAD is clean, but the key is still reachable in history - the flip must NOT proceed.
    const res = auditHistory(dir);
    expect(res.clean).toBe(false);
    expect(res.findings.some((f) => f.file === "config.md" && /AKIA/.test(f.pattern) || f.pattern.includes("AKIA"))).toBe(true);
  });

  it("returns clean for an empty repo", () => {
    expect(auditHistory(dir).clean).toBe(true);
  });
});
