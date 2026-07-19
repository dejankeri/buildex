// Deterministic per-file history (trust surfaces render from repo state, zero LLM).
// Ported from the prototype: git log scoped to one file, parsed with an ASCII unit-separator so
// commit subjects can't break the field split. Read-only - never fetches or commits.
import { execFileSync } from "node:child_process";

export interface HistoryEntry {
  sha: string;
  /** Author commit time as a unix epoch (ms). */
  at: number;
  author: string;
  subject: string;
}

const US = "\x1f"; // unit separator - safe field delimiter (can't appear in a subject line)
const RS = "\x1e"; // record separator - marks the start of each commit block in a --name-only log
const SHA_RE = /^[0-9a-f]{7,40}$/i; // a plausible git object id - guards the `git show <sha>:…` arg

/** The content of `relPath` exactly as it was at commit `sha` (powers one-tap history restore).
 *  Read-only. Throws on a malformed sha or a path that did not exist at that commit. The sha is
 *  validated and passed via execFile args (never a shell), so it can't be used to inject. */
export function fileAtCommit(repoDir: string, relPath: string, sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error(`invalid commit id: ${JSON.stringify(sha)}`);
  return execFileSync("git", ["show", `${sha}:${relPath}`], { cwd: repoDir, encoding: "utf8" });
}

/** Commits that touched `relPath`, newest first. Empty if the file has no history. */
export function fileHistory(repoDir: string, relPath: string): HistoryEntry[] {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["log", `--format=%H${US}%at${US}%an${US}%s`, "--", relPath],
      { cwd: repoDir, encoding: "utf8" },
    );
  } catch {
    return [];
  }
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, at, author, subject] = line.split(US);
      return { sha: sha!, at: Number(at) * 1000, author: author ?? "", subject: subject ?? "" };
    });
}

export interface ChangeEntry extends HistoryEntry {
  /** Repo-relative paths this commit touched (may be capped by `--name-only` output). */
  files: string[];
}

/**
 * The `limit` most recent commits across the whole repo, newest first, each with the files it
 * touched. This is the "Learning accrues" surface - the brain's decisions landing in git over
 * time. Read-only; never fetches or commits. Empty for a repo with no history.
 */
export function recentChanges(repoDir: string, limit = 12): ChangeEntry[] {
  let out: string;
  try {
    // A record separator prefixes every commit header so subjects (which may contain the unit
    // separator's neighbours, unicode, etc.) can never be confused with the file list that follows.
    out = execFileSync(
      "git",
      ["log", `-n`, String(limit), "--name-only", `--format=${RS}%H${US}%at${US}%an${US}%s`],
      { cwd: repoDir, encoding: "utf8" },
    );
  } catch {
    return [];
  }
  return out
    .split(RS)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const [sha, at, author, subject] = (lines[0] ?? "").split(US);
      const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);
      return { sha: sha!, at: Number(at) * 1000, author: author ?? "", subject: subject ?? "", files };
    });
}
