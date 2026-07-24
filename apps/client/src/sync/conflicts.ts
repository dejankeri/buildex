// Kept-work recovery - the read/restore surface over the sync engine's `.conflicts/<stamp>/`
// backups. When two machines change the same document, the engine keeps the operator's version
// byte-for-byte and resets to the team's copy (see engine.backupAndReset). That backup is worthless
// if the operator can't reach it: the file tree hides dotfiles, so without this module the kept
// version exists only for someone who opens a terminal - which the operator never will. This module
// lists what was kept, reads it for a side-by-side look, copies a file back over the current one
// (an ordinary edit that then flows through the normal checkpoint/save path - nothing here touches
// git), and dismisses the attention flag once the operator has decided. Dismissing NEVER deletes a
// backup: the `.conflicts/` dirs stay on disk forever (invariant 8) - only the `.sync-needs-help`
// marker, the "look at this" flag, is cleared.
//
// `root`/`stamp`/`file` arrive straight from HTTP params, so every path is confined before it
// touches the filesystem: the stamp must be the engine's plain epoch-ms string, and the file must
// resolve inside both the backup dir (the read side) and the repo (the write side) via
// lib/confine-path - the one confinement implementation. Filesystem access is injected so the
// module is testable without a real disk; the default is node:fs.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { confinePath } from "../lib/confine-path.js";

/** The paths the engine's conflict handling writes (engine.backupAndReset) - mirrored here, where
 *  they are read back. Both are in engine.INTERNAL, so neither is ever committed. */
const KEPT_DIR = ".conflicts";
const MARKER = ".sync-needs-help";

/** The filesystem surface this module touches - injected so tests run hermetically. */
export interface ConflictsFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Buffer;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
  mkdirSync(path: string, opts: { recursive: true }): void;
  copyFileSync(src: string, dest: string): void;
  writeFileSync(path: string, content: string): void;
  unlinkSync(path: string): void;
}

const realFs: ConflictsFs = {
  existsSync,
  readFileSync: (p) => readFileSync(p),
  readdirSync: (p) => readdirSync(p),
  statSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  unlinkSync,
};

/** A repo the engine may have kept work for - name is the wire id ("team"), dir the real path. */
export interface ConflictRoot {
  name: string;
  dir: string;
}

/** One kept file. `path` is repo-relative (posix separators - the same ids the vault uses);
 *  `differs` says whether the kept bytes still differ from the current workspace file - false once
 *  it has been copied back (or the versions were identical to begin with), so the console knows
 *  when there is nothing left to bring back. */
export interface KeptFile {
  path: string;
  differs: boolean;
}

/** One backup: everything the engine kept in a single conflict moment. `at` is the stamp as epoch
 *  ms - the moment the operator's version was set aside. */
export interface KeptBackup {
  root: string;
  stamp: string;
  at: number;
  files: KeptFile[];
}

export class Conflicts {
  private readonly fs: ConflictsFs;

  constructor(private readonly deps: { roots: ConflictRoot[]; fs?: ConflictsFs }) {
    this.fs = deps.fs ?? realFs;
  }

  /** Whether any root still carries the attention marker - the cheap probe the composition root
   *  uses to seed (and, after a dismiss, to clear) the header dot's needs-help state. */
  hasAttention(): boolean {
    return this.deps.roots.some((r) => this.fs.existsSync(join(r.dir, MARKER)));
  }

  /** Every backup that still needs the operator's attention, newest first per root. Only roots
   *  whose marker is present appear: a dismissed backup stays on disk but asks for nothing. */
  list(): KeptBackup[] {
    const out: KeptBackup[] = [];
    for (const root of this.deps.roots) {
      const marker = join(root.dir, MARKER);
      if (!this.fs.existsSync(marker)) continue;
      for (const stamp of this.stampsOf(root.dir, marker)) {
        const base = join(root.dir, KEPT_DIR, stamp);
        const files = this.walk(base, "").sort();
        out.push({
          root: root.name,
          stamp,
          at: Number(stamp),
          files: files.map((rel) => ({ path: rel, differs: this.differs(root.dir, base, rel) })),
        });
      }
    }
    return out;
  }

  /** Both sides of one kept file, for the console's side-by-side look. `current` is null when the
   *  workspace file no longer exists. Null when the root/stamp/file has no kept version (→ 404);
   *  throws on a path that tries to escape (→ 400). */
  read(rootName: string, stamp: string, file: string): { kept: string; current: string | null } | null {
    const loc = this.locate(rootName, stamp, file);
    if (!loc) return null;
    return {
      kept: this.fs.readFileSync(loc.kept).toString("utf8"),
      current: this.fs.existsSync(loc.current) ? this.fs.readFileSync(loc.current).toString("utf8") : null,
    };
  }

  /** Copy the kept version back over the current workspace file. Deliberately a plain file copy -
   *  an ordinary edit, exactly as if the operator had retyped it - so the change flows through the
   *  normal checkpoint/save path and shows up in history like any other. The backup itself is
   *  untouched, so copying back is as reversible as any edit. Returns the repo dir (the caller
   *  schedules its debounced checkpoint), or null when there is no such kept file. */
  restore(rootName: string, stamp: string, file: string): { dir: string } | null {
    const loc = this.locate(rootName, stamp, file);
    if (!loc) return null;
    this.fs.mkdirSync(dirname(loc.current), { recursive: true });
    this.fs.copyFileSync(loc.kept, loc.current);
    return { dir: loc.dir };
  }

  /** Clear the attention flag for one backup: drop its line from the marker, and remove the marker
   *  once no backup is left waiting. The backup dir itself is NEVER deleted - kept work stays on
   *  disk indefinitely (invariant 8); dismissing only says "I've decided, stop asking". False when
   *  the root or stamp doesn't exist (→ 404); an already-dismissed backup is success, not an error. */
  dismiss(rootName: string, stamp: string): boolean {
    const root = this.deps.roots.find((r) => r.name === rootName);
    if (!root) return false;
    if (!/^\d+$/.test(stamp)) throw new Error("invalid backup stamp");
    if (!this.fs.existsSync(join(root.dir, KEPT_DIR, stamp))) return false;
    const marker = join(root.dir, MARKER);
    if (!this.fs.existsSync(marker)) return true; // already dismissed - nothing left to clear
    const lines = this.fs
      .readFileSync(marker)
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.includes(`${KEPT_DIR}/${stamp}/`));
    // Only lines that still name a backup keep the marker alive; anything else (a hand-edited
    // remnant) must not leave the flag stuck on with nothing to show for it.
    if (lines.some((l) => STAMP_RE.test(l))) this.fs.writeFileSync(marker, lines.join("\n") + "\n");
    else this.fs.unlinkSync(marker);
    return true;
  }

  // --- internals ---

  /** Resolve one kept file's two locations. The stamp is required to be the engine's plain epoch-ms
   *  string and the file is confined to BOTH the backup dir and the repo - `..`, absolute paths,
   *  and symlink escapes all throw before any filesystem access. `.git` is additionally refused on
   *  principle: no kept file can legitimately live there (git never lists its own dir as changed),
   *  so a path naming it is an attack, not a restore. */
  private locate(rootName: string, stamp: string, file: string): { kept: string; current: string; dir: string } | null {
    const root = this.deps.roots.find((r) => r.name === rootName);
    if (!root) return null;
    if (!/^\d+$/.test(stamp)) throw new Error("invalid backup stamp");
    if (file.split("/").some((seg) => seg === ".git")) throw new Error(`path may not enter .git: ${file}`);
    const kept = confinePath(join(root.dir, KEPT_DIR, stamp), file);
    if (kept === null) throw new Error(`path escapes the kept-work area: ${file}`);
    const current = confinePath(root.dir, file);
    if (current === null) throw new Error(`path escapes the workspace: ${file}`);
    if (!this.fs.existsSync(kept)) return null;
    return { kept, current, dir: root.dir };
  }

  /** The stamps a marker asks attention for, newest first. Parsed from the marker's own lines (the
   *  engine appends one per conflict), so an old backup the operator already dismissed never
   *  resurfaces. A marker that names no stamp at all (hand-edited?) falls back to every backup dir
   *  on disk - when in doubt, show kept work rather than hide it. */
  private stampsOf(rootDir: string, marker: string): string[] {
    const text = this.fs.readFileSync(marker).toString("utf8");
    const named = [...new Set([...text.matchAll(STAMP_ALL_RE)].map((m) => m[1]!))];
    const onDisk = named.filter((s) => this.fs.existsSync(join(rootDir, KEPT_DIR, s)));
    const stamps = onDisk.length > 0 ? onDisk : this.allStamps(rootDir);
    return stamps.sort((a, b) => Number(b) - Number(a));
  }

  /** Every backup dir under `.conflicts/` (the unparseable-marker fallback). */
  private allStamps(rootDir: string): string[] {
    const base = join(rootDir, KEPT_DIR);
    if (!this.fs.existsSync(base)) return [];
    return this.fs.readdirSync(base).filter((name) => /^\d+$/.test(name) && this.fs.statSync(join(base, name)).isDirectory());
  }

  /** All files under `base`, as repo-relative posix paths (matching how the engine laid them out). */
  private walk(base: string, rel: string): string[] {
    const dir = rel ? join(base, rel) : base;
    if (!this.fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of this.fs.readdirSync(dir)) {
      const child = rel ? `${rel}/${name}` : name;
      if (this.fs.statSync(join(base, child)).isDirectory()) out.push(...this.walk(base, child));
      else out.push(child);
    }
    return out;
  }

  /** Whether the kept bytes still differ from the current workspace file (a missing current file
   *  counts as differing - there is plainly something to bring back). Byte comparison, not text:
   *  the engine's backup is byte-for-byte, so the answer must be too. */
  private differs(rootDir: string, base: string, rel: string): boolean {
    const current = join(rootDir, rel);
    if (!this.fs.existsSync(current)) return true;
    return !this.fs.readFileSync(join(base, rel)).equals(this.fs.readFileSync(current));
  }
}

/** A marker line that names a backup ("...saved under .conflicts/<stamp>/..."). */
const STAMP_RE = /\.conflicts\/(\d+)\//;
const STAMP_ALL_RE = /\.conflicts\/(\d+)\//g;
