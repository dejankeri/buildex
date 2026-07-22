// The organization model (B2a). The app can hold several organizations, each its own isolated local
// workspace (invariant 6 - hard company isolation, one git workspace per org). One org is the DEMO
// SANDBOX (Acme Labs): local-only and NON-syncable by construction - its repos have no git remote, so
// the sync engine already treats it as permanently "local" (see sync/engine.ts). The operator can
// also create their own real org and switch between them from the left-panel org switcher.
//
// This module owns ONLY the on-disk org registry + the active-org pointer; it seeds each org's
// content through injected seeders (DI at the seam) so it stays hermetic. The daemon rebuilds its
// single-workspace handler for whichever org is active (see orgs/router.ts) - no subsystem needs to
// know about multiple orgs.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Root } from "../brain/graph.js";

/** The fixed id of the demo sandbox org. Stable so `ensureDemo()` is idempotent across boots. */
export const DEMO_ORG_ID = "demo";

/** What we persist per org at `<orgsRoot>/<id>/org.json`. Root dirs are DERIVED from the workspace, so
 *  nothing here stores an absolute path - the orgs root can move (dev demo dir → packaged app-data). */
export interface OrgMeta {
  id: string;
  name: string;
  /** A demo/sandbox org: local-only, never synced, clearly marked in the UI. */
  sandbox: boolean;
  /** Root names in precedence order (dirs are `<workspace>/<name>`). */
  rootNames: string[];
  createdAt: number;
}

/** A resolved org: its metadata plus the absolute paths derived from the orgs root. */
export interface Org extends OrgMeta {
  dir: string;
  workspace: string;
  roots: Root[];
}

export interface OrgManagerDeps {
  /** Directory that holds one subdir per org plus the `active-org` pointer file. */
  orgsRoot: string;
  /** Seed a fresh REAL org's workspace (default: the local-workspace provisioner). Returns its roots. */
  seedReal: (workspace: string) => Root[];
  /** Seed the DEMO SANDBOX org's workspace (rich Acme brain, NO remotes). Returns its roots. */
  seedDemo: (workspace: string) => Root[];
  /** Purge any orphaned OS-vault secrets at a workspace path just before it is FRESHLY seeded. Closes
   *  the path-reuse edge (invariant 6): the keychain service id is sha256(path), the vault lives outside
   *  the workspace dir, so a path reused by a new company (the stable demo dir on `demo:setup --reset`,
   *  or a real org re-provisioned at a freed path) would otherwise inherit the old company's namespace.
   *  Default no-op keeps this class hermetic; the daemon wires the real keychain clear. */
  purge?: (workspace: string) => void;
  /** Injectable for hermetic tests. */
  idFactory?: () => string;
  now?: () => number;
}

export class OrgManager {
  private readonly orgsRoot: string;
  private readonly seedReal: (workspace: string) => Root[];
  private readonly seedDemo: (workspace: string) => Root[];
  private readonly purge: (workspace: string) => void;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(deps: OrgManagerDeps) {
    this.orgsRoot = deps.orgsRoot;
    this.seedReal = deps.seedReal;
    this.seedDemo = deps.seedDemo;
    this.purge = deps.purge ?? (() => {});
    this.idFactory = deps.idFactory ?? (() => randomUUID().slice(0, 8));
    this.now = deps.now ?? (() => Date.now());
  }

  private orgDir(id: string): string {
    return join(this.orgsRoot, id);
  }
  private metaPath(id: string): string {
    return join(this.orgDir(id), "org.json");
  }
  private get activePointer(): string {
    return join(this.orgsRoot, "active-org");
  }

  /** Resolve a stored OrgMeta into absolute paths. */
  private resolve(meta: OrgMeta): Org {
    const dir = this.orgDir(meta.id);
    const workspace = join(dir, "workspace");
    const roots = meta.rootNames.map((name) => ({ name, dir: join(workspace, name) }));
    return { ...meta, dir, workspace, roots };
  }

  private readMeta(id: string): OrgMeta | null {
    const p = this.metaPath(id);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as OrgMeta;
    } catch {
      return null; // a corrupt org.json is skipped, never crashes the list
    }
  }

  /** Every org on disk, newest first (demo sorts last so a real org a user just made leads). */
  list(): Org[] {
    if (!existsSync(this.orgsRoot)) return [];
    const orgs: Org[] = [];
    for (const name of readdirSync(this.orgsRoot)) {
      const dir = join(this.orgsRoot, name);
      if (!statSync(dir).isDirectory()) continue;
      const meta = this.readMeta(name);
      if (meta) orgs.push(this.resolve(meta));
    }
    return orgs.sort((a, b) => {
      if (a.sandbox !== b.sandbox) return a.sandbox ? 1 : -1; // real orgs first, demo last
      return b.createdAt - a.createdAt;
    });
  }

  get(id: string): Org | null {
    const meta = this.readMeta(id);
    return meta ? this.resolve(meta) : null;
  }

  /** The active org: the pointer if valid, else the first listed org (prefers a real one), else null. */
  active(): Org | null {
    if (existsSync(this.activePointer)) {
      const id = readFileSync(this.activePointer, "utf8").trim();
      const org = this.get(id);
      if (org) return org;
    }
    return this.list()[0] ?? null;
  }

  setActive(id: string): void {
    if (!this.get(id)) throw new Error(`unknown org: ${id}`);
    mkdirSync(this.orgsRoot, { recursive: true });
    writeFileSync(this.activePointer, id);
  }

  /** Create the demo sandbox org if it doesn't exist yet; idempotent. Returns it either way. */
  ensureDemo(): Org {
    const existing = this.get(DEMO_ORG_ID);
    if (existing) return existing;
    const dir = this.orgDir(DEMO_ORG_ID);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    this.purge(workspace); // clear any orphaned secrets at this (stable) path before re-seeding it
    const roots = this.seedDemo(workspace);
    const meta: OrgMeta = {
      id: DEMO_ORG_ID,
      name: "Acme Labs",
      sandbox: true,
      rootNames: roots.map((r) => r.name),
      createdAt: this.now(),
    };
    writeFileSync(this.metaPath(DEMO_ORG_ID), JSON.stringify(meta, null, 2) + "\n");
    return this.resolve(meta);
  }

  /** First-boot bootstrap, idempotent. On the VERY first launch (no active-org pointer yet) it stands
   *  up BOTH the operator's own empty org ("My Organization") AND the Acme sandbox, and lands the
   *  operator in their OWN org - the sandbox sits alongside to explore, but leading with a demo full of
   *  fake data overwhelms a fresh operator. Every later boot just resolves the persisted active org
   *  (respecting a switch the operator made). Returns the org to activate. */
  bootstrap(opts?: { firstRealName?: string }): Org {
    const firstRun = !existsSync(this.activePointer);
    this.ensureDemo(); // the Acme sandbox is always present alongside
    if (firstRun) {
      // create() seeds the empty real org and makes it active, so the operator starts in their own org.
      return this.create({ name: opts?.firstRealName ?? "My Organization" });
    }
    const active = this.active() ?? this.ensureDemo();
    this.setActive(active.id); // persist the resolved choice so it's stable next boot
    return active;
  }

  /** Clear the OS-vault secrets for EVERY org on this machine and return how many were cleared. The
   *  honest answer to "uninstall leaves credentials behind" (macOS runs no code on drag-to-Trash): the
   *  operator taps this in-app, before uninstalling, to wipe every connector token / git credential the
   *  app ever stored. Reuses the same per-workspace purge as fresh provisioning. Leaves the workspace
   *  FILES intact (invariant 8 - never lose the operator's work); only the vault namespace is cleared. */
  forgetAllSecrets(): number {
    const orgs = this.list();
    for (const org of orgs) this.purge(org.workspace);
    return orgs.length;
  }

  /** Create a real (syncable-later) local org and make it active. */
  create(opts: { name: string }): Org {
    const name = opts.name.trim();
    if (!name) throw new Error("an organization needs a name");
    const id = this.idFactory();
    if (this.get(id)) throw new Error(`org id collision: ${id}`);
    const dir = this.orgDir(id);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    this.purge(workspace); // defensive: a freed id reused at this path must not inherit old secrets
    const roots = this.seedReal(workspace);
    const meta: OrgMeta = {
      id,
      name,
      sandbox: false,
      rootNames: roots.map((r) => r.name),
      createdAt: this.now(),
    };
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2) + "\n");
    this.setActive(id);
    return this.resolve(meta);
  }
}
