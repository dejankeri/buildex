// The history secret audit. The repo is public, so we
// must prove no secret ever entered its history - not just the current tree (which CI's secret-scan
// covers). This scans every reachable commit; a key that was committed and later "removed" is still
// in history and must block the flip until the history is rewritten.
import { execFileSync } from "node:child_process";

export interface HistoryFinding {
  commit: string;
  file: string;
  pattern: string;
}
export interface AuditResult {
  clean: boolean;
  findings: HistoryFinding[];
}

// High-signal secret patterns (the same family as CI's secret-scan).
const PATTERNS = [
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "AKIA[0-9A-Z]{16}",
  "ASIA[0-9A-Z]{16}",
  "sk-ant-[A-Za-z0-9_-]{20,}",
  "sk-[A-Za-z0-9]{32,}",
  "ghp_[A-Za-z0-9]{36,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}",
  "AIza[0-9A-Za-z_-]{35}",
  "xsetup_[A-Za-z0-9]{20,}",
];

export function auditHistory(repoDir: string): AuditResult {
  const revs = execFileSync("git", ["rev-list", "--all"], { cwd: repoDir, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (revs.length === 0) return { clean: true, findings: [] };

  const findings: HistoryFinding[] = [];
  for (const pattern of PATTERNS) {
    let out = "";
    try {
      // `-e <pattern>` so patterns beginning with "-" (e.g. -----BEGIN…) aren't read as flags.
      // Prints `<rev>:<file>:<line>:…` for each commit tree that matches.
      out = execFileSync("git", ["grep", "-I", "-n", "-E", "-e", pattern, ...revs], { cwd: repoDir, encoding: "utf8" });
    } catch (e) {
      // git grep exits 1 when there are no matches - that's a clean pass, not an error.
      const status = (e as { status?: number }).status;
      if (status !== 1) throw e;
      continue;
    }
    const seen = new Set<string>();
    for (const line of out.split("\n").filter(Boolean)) {
      const parts = line.split(":");
      const commit = (parts[0] ?? "").slice(0, 8);
      const file = parts[1] ?? "";
      const key = `${commit}:${file}:${pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ commit, file, pattern });
    }
  }
  return { clean: findings.length === 0, findings };
}
