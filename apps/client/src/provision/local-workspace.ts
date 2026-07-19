// Self-serve first-run provisioning: lay down a complete LOCAL workspace - the read-only
// `core` pack plus writable `team` and `private` stubs - as git repos with no remote, so a fresh
// install can start working with zero network. "Open an account" later attaches remotes and syncs
// (the stub→provisioned migration). Empty starter by design: a welcome only, never fake company data,
// so nothing an operator sees pretends to be real (and nothing is lost when the stub team is later
// reconciled with a provisioned one).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "../brain/graph.js";
import { provisionLocalCore, initAndCommit, type LocalCoreOpts } from "./core-pack.js";

export type LocalWorkspaceOpts = LocalCoreOpts;

/** Whether this is a first run - no local `core` repo has been provisioned yet. */
export function isFirstRun(workspace: string): boolean {
  return !existsSync(join(workspace, "core", ".git"));
}

/** The fixed local-workspace roots (precedence order). Dir names equal root names so the map/vault
 *  display exactly the paths the agent (cwd = workspace) can open. */
function localRoots(workspace: string): Root[] {
  return ["core", "team", "private"].map((name) => ({ name, dir: join(workspace, name) }));
}

/** The boot seam: ensure a local workspace exists and return its roots. On a first run it provisions
 *  from the bundled pack (which must therefore be resolvable); afterwards it just returns the existing
 *  roots - so a booted app never depends on the bundled pack being present. */
export function ensureLocalWorkspace(opts: { workspace: string; corePackDir?: string; actor?: string }): Root[] {
  if (!isFirstRun(opts.workspace)) return localRoots(opts.workspace);
  if (!opts.corePackDir) throw new Error("first run needs the bundled core pack to provision core");
  return provisionLocalWorkspace({ workspace: opts.workspace, corePackDir: opts.corePackDir, ...(opts.actor ? { actor: opts.actor } : {}) });
}

/** Provision (or complete) a local workspace: `core` from the bundled pack, plus empty `team` and
 *  `private` stubs. Idempotent per repo - an already-provisioned repo is left untouched, so re-running
 *  never clobbers operator work (invariant #8). Returns the roots in precedence order [core, team,
 *  private]; none has a remote, so the sync loop reports the neutral "local" state. */
export function provisionLocalWorkspace(opts: LocalWorkspaceOpts): Root[] {
  const actor = opts.actor ?? "operator";
  const core = provisionLocalCore(opts);
  const team = seedStub(opts.workspace, "team", actor, {
    "CLAUDE.md": "# Your team brain\n\nShared with your teammates once you connect an account. Decisions, strategy, and clients live here as plain markdown.\n",
    "README.md": "# Welcome to your team brain\n\nThis is the shared company workspace. It's empty for now - ask the agent to help you set it up, or connect an account to sync it with your team.\n",
  });
  const priv = seedStub(opts.workspace, "private", actor, {
    "notes.md": "# My notes\n\nPrivate to you. Nothing here syncs until you open an account.\n",
  });
  return [core, team, priv];
}

/** Create one writable stub repo at `<workspace>/<name>` with starter files, committed locally with no
 *  remote. Idempotent: an existing repo (git dir present) is left as-is. */
function seedStub(workspace: string, name: string, actor: string, files: Record<string, string>): Root {
  const dir = join(workspace, name);
  const root: Root = { name, dir };
  if (existsSync(join(dir, ".git"))) return root; // already provisioned - never overwrite
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  initAndCommit(dir, actor, `seed ${name}`);
  return root;
}
