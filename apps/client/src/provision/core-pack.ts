// Self-serve, zero-network provisioning of the read-only core pack. Until an operator opens an
// account there is no cloud to clone `core` from, so the app ships `packs/core` as a bundled resource
// and lays it down as a LOCAL git repo with no remote. The sync loop then reports the neutral "local"
// state (see sync/engine.ts) rather than a misleading "queued". When the operator later opens an
// account, provisioning attaches a real remote - the stub→provisioned migration.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedGit } from "../lib/git-pin.js";
import type { Root } from "../brain/graph.js";

/** Where to look for the bundled core pack. */
export interface CorePackEnv {
  /** process.resourcesPath in a packaged Electron app - electron-builder's extraResources land here.
   *  Undefined in dev/tests. */
  resourcesPath?: string;
  /** Repo root, where `packs/core` lives in-tree (dev/demo). */
  repoRoot?: string;
  /** Existence probe - injected so the resolver is unit-testable without a real filesystem. */
  exists?: (p: string) => boolean;
}

/** A file every valid core pack carries - used to reject an empty/broken bundle. */
const PACK_MARKER = join("rules", "operating.md");

/** Resolve the bundled core-pack dir. The packaged app wins (`<resources>/core-pack`); dev falls back
 *  to `packs/core` in the repo. Throws if neither candidate carries a real pack - a broken bundle must
 *  fail loudly rather than silently provision an empty core. */
export function resolveCorePackDir(env: CorePackEnv): string {
  const exists = env.exists ?? existsSync;
  const candidates: string[] = [];
  if (env.resourcesPath) candidates.push(join(env.resourcesPath, "core-pack"));
  if (env.repoRoot) candidates.push(join(env.repoRoot, "packs", "core"));
  for (const dir of candidates) {
    if (exists(join(dir, PACK_MARKER))) return dir;
  }
  throw new Error(`core pack not found - the app bundle is missing packs/core (looked in: ${candidates.join(", ") || "<none>"})`);
}

export interface LocalCoreOpts {
  /** Workspace dir; core is created at `<workspace>/core`. */
  workspace: string;
  /** Resolved bundled core pack (see resolveCorePackDir). */
  corePackDir: string;
  /** Commit author label; defaults to "operator". */
  actor?: string;
}

/** Materialize a local, no-remote `core` repo from the bundled pack - the zero-network path. Idempotent:
 *  if a git repo already exists at `<workspace>/core` it is left untouched (never clobber an operator's
 *  workspace - invariant #8). Returns the core Root. The repo has NO remote, so the sync loop reports
 *  the neutral "local" state until the operator opens an account. */
export function provisionLocalCore(opts: LocalCoreOpts): Root {
  const dir = join(opts.workspace, "core");
  const root: Root = { name: "core", dir };
  if (existsSync(join(dir, ".git"))) return root; // already provisioned - leave it as-is

  mkdirSync(dir, { recursive: true });
  cpSync(opts.corePackDir, dir, { recursive: true });
  // Assemble CLAUDE.md from the pack's operating rules - the same source demo-setup uses, so a local
  // stub workspace and a provisioned one present the agent an identical core rule set.
  const operating = join(opts.corePackDir, "rules", "operating.md");
  if (existsSync(operating)) writeFileSync(join(dir, "CLAUDE.md"), readFileSync(operating, "utf8"));

  initAndCommit(dir, opts.actor ?? "operator", "seed core pack");
  return root;
}

/** Init a local (no-remote) git repo at `dir` and commit everything in it. Shared by the core and the
 *  team/private stub provisioners - a stub is just a local repo whose remote is attached later, on
 *  account-open. Deterministic commit identity, independent of the operator's global git config. */
export function initAndCommit(dir: string, actor: string, message: string): void {
  const git = (args: string[]): void => void execFileSync("git", pinnedGit(args), { cwd: dir, env: gitEnv(actor), stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--initial-branch=main"]);
  git(["add", "-A"]);
  git(["commit", "-m", message]);
}

/** Deterministic commit identity, independent of the operator's global git config (mirrors SyncEngine). */
function gitEnv(actor: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: actor,
    GIT_AUTHOR_EMAIL: `${actor}@buildex.local`,
    GIT_COMMITTER_NAME: actor,
    GIT_COMMITTER_EMAIL: `${actor}@buildex.local`,
  };
}
