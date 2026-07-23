// The sync control plane - coordination state only; knowledge never lives here.
// Engine: node:sqlite (built-in, zero native deps) in WAL mode; Litestream replicates the file
// externally (infra config, not code). All token material is stored hashed (hash-at-rest).
import { DatabaseSync } from "node:sqlite";
import { AuthError } from "../lib/errors.js";
import { newToken, hashToken, TOKEN_PREFIX } from "../lib/tokens.js";

export type Status = "active" | "revoked";
export type Access = "read" | "write" | "none";
export type Clock = () => number;

export interface Company {
  id: string;
  slug: string;
  name: string;
  mirrorRemotes: string[];
  status: Status;
}
export interface Operator {
  id: string;
  companyId: string;
  email: string;
  status: Status;
}
export interface Machine {
  id: string;
  operatorId: string;
  name: string;
  tokenHash: string;
  refreshTokenHash: string;
  lastSeen: number | null;
}
export interface AuditEvent {
  at: number;
  actor: string;
  companyId: string;
  action: string;
}

export class ControlPlaneStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly now: Clock = Date.now,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        mirror_remotes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS operators (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
        email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id),
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        refresh_token_hash TEXT NOT NULL UNIQUE, last_seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS setup_tokens (
        hash TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id),
        ttl_at INTEGER NOT NULL, consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS repo_permissions (
        principal TEXT NOT NULL, repo TEXT NOT NULL, access TEXT NOT NULL,
        PRIMARY KEY (principal, repo)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        at INTEGER NOT NULL, actor TEXT NOT NULL, company_id TEXT NOT NULL, action TEXT NOT NULL
      );
    `);
    this.migrateSupabaseSub();
  }

  /** Additive migration: link an operator to a Supabase auth user (`sub`), one-to-one.
   *  node:sqlite's ALTER TABLE cannot add a UNIQUE column directly ("Cannot add a UNIQUE
   *  column"), so the column is added plain and uniqueness is enforced by a separate unique
   *  index (SQLite unique indexes still allow any number of NULL rows). Guarded via
   *  `pragma table_info` so re-running on an already-migrated db is a no-op. */
  private migrateSupabaseSub(): void {
    const cols = this.db.prepare("PRAGMA table_info(operators)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "supabase_sub")) {
      this.db.exec("ALTER TABLE operators ADD COLUMN supabase_sub TEXT");
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_operators_supabase_sub ON operators (supabase_sub)",
    );
  }

  // --- companies & operators ---

  createCompany(c: { id: string; slug: string; name: string; mirrorRemotes?: string[] }): void {
    this.db
      .prepare("INSERT INTO companies (id, slug, name, mirror_remotes, status) VALUES (?, ?, ?, ?, 'active')")
      .run(c.id, c.slug, c.name, JSON.stringify(c.mirrorRemotes ?? []));
  }

  getCompany(id: string): Company | undefined {
    const row = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: row["id"] as string,
      slug: row["slug"] as string,
      name: row["name"] as string,
      mirrorRemotes: JSON.parse(row["mirror_remotes"] as string),
      status: row["status"] as Status,
    };
  }

  createOperator(o: { id: string; companyId: string; email: string }): void {
    this.db
      .prepare("INSERT INTO operators (id, company_id, email, status) VALUES (?, ?, ?, 'active')")
      .run(o.id, o.companyId, o.email);
  }

  getOperator(id: string): Operator | undefined {
    const row = this.db.prepare("SELECT * FROM operators WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: row["id"] as string,
      companyId: row["company_id"] as string,
      email: row["email"] as string,
      status: row["status"] as Status,
    };
  }

  /** Resolve the operator (and its company) linked to a Supabase auth user's `sub`, or null. */
  findOperatorBySupabaseSub(sub: string): { operatorId: string; companyId: string } | null {
    const row = this.db
      .prepare("SELECT id, company_id FROM operators WHERE supabase_sub = ?")
      .get(sub) as { id: string; company_id: string } | undefined;
    if (!row) return null;
    return { operatorId: row.id, companyId: row.company_id };
  }

  /** Link a Supabase auth user's `sub` to an operator, one-to-one. Throws if that sub is
   *  already linked to a different operator (enforced by the unique index). */
  linkOperatorSupabaseSub(operatorId: string, sub: string): void {
    this.db.prepare("UPDATE operators SET supabase_sub = ? WHERE id = ?").run(sub, operatorId);
  }

  /** Does a company with this slug already exist? Used by `slugFromEmail` to find a free slug. */
  private companyExistsBySlug(slug: string): boolean {
    return this.db.prepare("SELECT 1 FROM companies WHERE slug = ?").get(slug) !== undefined;
  }

  /** Lowercase, collapse non-alphanumerics to '-', trim; empty result falls back to "company". */
  private slugify(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";
  }

  /** Suffix -2, -3, ... off a slugified base until a free (unused) slug is found. */
  private dedupeSlug(base: string): string {
    let slug = base;
    for (let n = 2; this.companyExistsBySlug(slug); n++) {
      slug = `${base}-${n}`;
    }
    return slug;
  }

  /** Derive a company-of-one slug from an email's local-part: lowercased, non-alphanumerics
   *  collapsed to '-', trimmed; suffixed -2, -3, ... until a free slug is found. */
  slugFromEmail(email: string): string {
    const local = email.split("@")[0] ?? "";
    return this.dedupeSlug(this.slugify(local));
  }

  /** Derive a company slug from an operator-typed company name, same slugify+dedup rules as
   *  `slugFromEmail`. Used when anonymous onboarding gives the company a name up front. */
  slugFromName(name: string): string {
    return this.dedupeSlug(this.slugify(name));
  }

  // --- setup tokens (one-time, TTL) ---

  /** Mint a setup token bound to an operator; returns the RAW token (only the hash is stored). */
  mintSetupToken(opts: { operatorId: string; ttlMs: number }): string {
    const raw = newToken(TOKEN_PREFIX.setup);
    this.db
      .prepare("INSERT INTO setup_tokens (hash, operator_id, ttl_at, consumed_at) VALUES (?, ?, ?, NULL)")
      .run(hashToken(raw), opts.operatorId, this.now() + opts.ttlMs);
    return raw;
  }

  /** Consume a setup token exactly once; throws AuthError if unknown, expired, or already used. */
  consumeSetupToken(raw: string): { operatorId: string } {
    const hash = hashToken(raw);
    const row = this.db.prepare("SELECT * FROM setup_tokens WHERE hash = ?").get(hash) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new AuthError("unknown setup token");
    if (row["consumed_at"] != null) throw new AuthError("setup token already used");
    if ((row["ttl_at"] as number) < this.now()) throw new AuthError("setup token expired");
    this.db.prepare("UPDATE setup_tokens SET consumed_at = ? WHERE hash = ?").run(this.now(), hash);
    return { operatorId: row["operator_id"] as string };
  }

  // --- machines & refresh rotation ---

  registerMachine(m: {
    id: string;
    operatorId: string;
    name: string;
    tokenHash: string;
    refreshTokenHash: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO machines (id, operator_id, name, token_hash, refresh_token_hash, last_seen) VALUES (?, ?, ?, ?, ?, NULL)",
      )
      .run(m.id, m.operatorId, m.name, m.tokenHash, m.refreshTokenHash);
  }

  /** Resolve a machine by its access-token hash. Returns undefined once revoked/rotated away. */
  findMachineByTokenHash(tokenHash: string): Machine | undefined {
    const row = this.db.prepare("SELECT * FROM machines WHERE token_hash = ?").get(tokenHash) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToMachine(row) : undefined;
  }

  /** Rotate a machine's access + refresh tokens, keyed on the presented refresh hash. */
  rotateMachineTokens(opts: {
    refreshTokenHash: string;
    newTokenHash: string;
    newRefreshTokenHash: string;
  }): Machine {
    const row = this.db
      .prepare("SELECT * FROM machines WHERE refresh_token_hash = ?")
      .get(opts.refreshTokenHash) as Record<string, unknown> | undefined;
    if (!row) throw new AuthError("unknown refresh token");
    this.db
      .prepare("UPDATE machines SET token_hash = ?, refresh_token_hash = ? WHERE id = ?")
      .run(opts.newTokenHash, opts.newRefreshTokenHash, row["id"] as string);
    return this.findMachineByTokenHash(opts.newTokenHash)!;
  }

  // --- permission matrix ---

  setRepoPermission(p: { principal: string; repo: string; access: Access }): void {
    this.db
      .prepare(
        "INSERT INTO repo_permissions (principal, repo, access) VALUES (?, ?, ?) " +
          "ON CONFLICT(principal, repo) DO UPDATE SET access = excluded.access",
      )
      .run(p.principal, p.repo, p.access);
  }

  getAccess(principal: string, repo: string): Access {
    const row = this.db
      .prepare("SELECT access FROM repo_permissions WHERE principal = ? AND repo = ?")
      .get(principal, repo) as { access: Access } | undefined;
    return row?.access ?? "none";
  }

  // --- revoke ---

  /** Revoke an operator: mark revoked and drop all machines + permissions in one transaction, so
   *  a revoked principal loses read+write within one request (invariant 6 / permission-matrix). */
  revokeOperator(operatorId: string): void {
    const tx = this.db.prepare("SELECT 1"); // ensure db is live
    tx.get();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE operators SET status = 'revoked' WHERE id = ?").run(operatorId);
      this.db.prepare("DELETE FROM machines WHERE operator_id = ?").run(operatorId);
      this.db.prepare("DELETE FROM repo_permissions WHERE principal = ?").run(operatorId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // --- audit ---

  addAuditEvent(e: { actor: string; companyId: string; action: string }): void {
    this.db
      .prepare("INSERT INTO audit_events (at, actor, company_id, action) VALUES (?, ?, ?, ?)")
      .run(this.now(), e.actor, e.companyId, e.action);
  }

  listAuditEvents(companyId: string): AuditEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_events WHERE company_id = ? ORDER BY at ASC")
      .all(companyId) as Record<string, unknown>[];
    return rows.map((r) => ({
      at: r["at"] as number,
      actor: r["actor"] as string,
      companyId: r["company_id"] as string,
      action: r["action"] as string,
    }));
  }

  /** Count of companies - a cheap integrity read (used by the restore drill to prove queryability). */
  companyCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number };
    return row.n;
  }

  // --- lifecycle ---

  /** Force a WAL checkpoint so all bytes are flushed to the main db file (used by tests/backup). */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private closed = false;

  private rowToMachine(row: Record<string, unknown>): Machine {
    return {
      id: row["id"] as string,
      operatorId: row["operator_id"] as string,
      name: row["name"] as string,
      tokenHash: row["token_hash"] as string,
      refreshTokenHash: row["refresh_token_hash"] as string,
      lastSeen: (row["last_seen"] as number | null) ?? null,
    };
  }
}
