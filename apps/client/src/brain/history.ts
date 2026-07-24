// Deterministic per-file history (trust surfaces render from repo state, zero LLM).
// Ported from the prototype: git log scoped to one file, parsed with an ASCII unit-separator so
// commit subjects can't break the field split. Read-only - never fetches or commits.
//
// History shows the DELIBERATE layer (invariant 2): named saves, one per meaningful moment. The
// automatic checkpoint layer (subjects marked by the sync engine) is collapsed - the run of
// checkpoints newer than the last save becomes one synthetic "Unsaved changes" row, and older
// checkpoint commits are dropped - so History reads like a changelog, never a firehose of edits.
import { execFileSync } from "node:child_process";
import { isCheckpointSubject } from "../sync/engine.js";

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

/** The subject of the one synthetic row the checkpoint layer collapses into. */
export const UNSAVED_SUBJECT = "Unsaved changes";

/** Saved versions that touched `relPath`, newest first, with any checkpoints newer than the last
 *  save collapsed into one "Unsaved changes" row (only when this file is among them - the log is
 *  already file-scoped). Empty if the file has no history. */
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
  const entries = out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, at, author, subject] = line.split(US);
      return { sha: sha!, at: Number(at) * 1000, author: author ?? "", subject: subject ?? "" };
    });
  return collapseCheckpoints(entries, (lead) => ({ ...lead[0]!, subject: UNSAVED_SUBJECT }));
}

export interface ChangeEntry extends HistoryEntry {
  /** Repo-relative paths this commit touched (may be capped by `--name-only` output). */
  files: string[];
}

/**
 * The most recent saved versions across the whole repo (drawn from the `limit` most recent
 * commits), newest first, each with the files it touched - checkpoints newer than the last save
 * collapse into one "Unsaved changes" row carrying the union of their files. This is the "Learning
 * accrues" surface - the brain's decisions landing in git over time. Read-only; never fetches or
 * commits. Empty for a repo with no history.
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
  const entries = out
    .split(RS)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const [sha, at, author, subject] = (lines[0] ?? "").split(US);
      const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);
      return { sha: sha!, at: Number(at) * 1000, author: author ?? "", subject: subject ?? "", files };
    });
  return collapseCheckpoints(entries, (lead) => ({
    ...lead[0]!,
    subject: UNSAVED_SUBJECT,
    files: [...new Set(lead.flatMap((e) => e.files))],
  }));
}

/** Collapse the checkpoint layer out of a newest-first history: the leading run of checkpoint
 *  commits (work newer than the last save) folds - via `fold` - into ONE synthetic row anchored on
 *  the newest of them, and any checkpoint deeper in the list is dropped. Purely a function of the
 *  entries' subjects, so double-rendering the same repo state stays byte-identical (invariant 9). */
function collapseCheckpoints<T extends HistoryEntry>(entries: T[], fold: (lead: T[]) => T): T[] {
  let i = 0;
  while (i < entries.length && isCheckpointSubject(entries[i]!.subject)) i++;
  const lead = entries.slice(0, i);
  const rest = entries.slice(i).filter((e) => !isCheckpointSubject(e.subject));
  return lead.length > 0 ? [fold(lead), ...rest] : rest;
}
