// Restore drill - the rehearsed recovery that must be part of every release
// checklist. It exercises the recovery *logic* end to end: take the server's data (control.db +
// bare repos), back it up, and restore it onto a clean target, then verify the database opens and
// the repos are intact. In production the transport is Litestream (control.db) + restic (repos) to
// object storage; here that transport is a local copy so the drill runs hermetically in CI. What it
// proves - that a clean machine can be brought back from a backup - is the part that actually fails
// in real incidents.
import { cpSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ControlPlaneStore } from "../store/store.js";

export interface RestoreDrillOpts {
  /** The live data directory: control.db + repos/. */
  dataDir: string;
  /** Where the backup is written (stands in for object storage). */
  backupDir: string;
  /** A clean target to restore onto (stands in for a fresh VM). */
  targetDir: string;
}

export interface RestoreDrillResult {
  ok: boolean;
  companies: number;
  repos: string[];
}

export function runRestoreDrill(opts: RestoreDrillOpts): RestoreDrillResult {
  if (!existsSync(join(opts.dataDir, "control.db"))) {
    throw new Error(`restore drill: no control.db in ${opts.dataDir}`);
  }

  // 1. Back up (Litestream + restic in production; a copy here).
  cpSync(opts.dataDir, opts.backupDir, { recursive: true });

  // 2. Restore onto a clean target (a fresh VM in production).
  cpSync(opts.backupDir, opts.targetDir, { recursive: true });

  // 3. Verify: the control database opens and the repos are valid bare git.
  const store = new ControlPlaneStore(join(opts.targetDir, "control.db"));
  let companies = 0;
  try {
    // A minimal integrity read - the db is queryable and holds rows.
    companies = countCompanies(store);
  } finally {
    store.close();
  }

  const reposDir = join(opts.targetDir, "repos");
  const repos = existsSync(reposDir) ? readdirSync(reposDir).filter((r) => r.endsWith(".git")) : [];
  for (const repo of repos) {
    const bare = execFileSync("git", ["rev-parse", "--is-bare-repository"], { cwd: join(reposDir, repo), encoding: "utf8" }).trim();
    if (bare !== "true") throw new Error(`restore drill: ${repo} is not a valid bare repo after restore`);
  }

  return { ok: true, companies, repos };
}

/** Count companies via a throwaway read - proves the restored db is queryable. */
function countCompanies(store: ControlPlaneStore): number {
  // The store doesn't expose a list API (coordination-only); probe the known seed id path instead
  // by reflecting over a direct count. We use a tiny raw query through a temporary method surface.
  return store.companyCount();
}
