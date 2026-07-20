// The capability-pack catalog + install surface (App Store; extends the Apps surface). A pack lives at
// `<catalog>/<id>/pack.json` and declares optional faces: an external app, an MCP entry the runtime
// connects to (runtime owns OAuth), skill folders, and policy hints. Pack DEFINITIONS come from a
// CatalogSource (the bundled core pack, read live - see catalog-source.ts), while installed-STATE and
// install TARGETS are the writable workspace roots. This module is the deterministic list (invariant
// 9, zero LLM) + the install orchestrator. Path hardening mirrors brain/apps.ts.
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "./graph.js";
import type { AppManifest } from "./apps.js";
import type { CatalogSource } from "./catalog-source.js";
import { PACK_KEY_PREFIX, entryTool, type ConnectorPolicy, type McpServerConfig, type PolicyEntry } from "@buildex/connectors";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** The install target is a *slot* - "team" | "private" - not a literal repo name. Repo names may be
 *  company-suffixed (demo seeds "team-acme"/"private-you"; a synced account may name the team brain
 *  after the company). Map a raw root name to its slot so both the read side (installedIn) and the
 *  write side (targetRoot) speak slots, and the real product (bare "team"/"private") still matches. */
function slotOf(name: string): string {
  if (name === "core") return "core";
  if (name === "team" || name.startsWith("team-")) return "team";
  if (name === "private" || name.startsWith("private-")) return "private";
  return name;
}

export interface PackMcp {
  kind: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** OAuth scopes hint for the gateway path; DCR falls back to server defaults when absent. */
  scopes?: string[];
  /** Keep this MCP as a direct remote pin instead of routing it through the connector gateway - for
   *  non-DCR providers that need a static OAuth client (e.g. Google Gmail/Calendar/Drive). */
  direct?: boolean;
  /** Corrections to the gateway's name-based tool classifier, shipped WITH the pack because only the
   *  pack author knows the provider's real semantics. Two things the heuristic cannot know:
   *   - a tool whose name reads outward but only reads (Protocol's `message` lists conversations);
   *   - an intent-verb tool where the outward action hides in an argument, gated with a `when` rule
   *     (`schedule` books appointments freely but `action: "send_reminder"` waits for a human).
   *  This is a BASELINE, not a lock: the operator can still tighten or widen any tool, and their
   *  choice wins for that tool. It is re-read from the catalog on every sync, never persisted, so a
   *  pack update that tightens a gate reaches providers that are already connected. */
  policy?: ConnectorPolicy;
}
/** The API-key connection face - the operator pastes a static key instead of running OAuth. Public
 *  metadata only; the key itself is runtime-injected into the keychain (never a manifest). */
export interface PackApiKey {
  /** How a pasted key reaches the app.
   *  "mcp-bearer": inject as `<header>: <prefix><key>` on the app's own remote MCP url - the dual-door
   *                servers (Stripe, Protocol, Intercom) accept an API key where OAuth would go.
   *  "rest":       the key authenticates a REST/GraphQL API a gateway connector wraps as tools. */
  transport: "mcp-bearer" | "rest";
  /** Header the key rides in. Default "Authorization". */
  header?: string;
  /** Value prefix. Default "Bearer ". */
  prefix?: string;
  /** REST base URL the gateway connector calls (transport "rest" only). */
  apiBase?: string;
  /** Public page where the operator generates the key. */
  docsUrl: string;
  /** Short hint shown in the store, e.g. "Restricted key (rk_…)". */
  hint?: string;
}
/** The escape-hatch face: a second, broader credential the provider will only mint through its OWN
 *  browser consent, because the MCP connection cannot carry it.
 *
 *  Protocol is the shape this exists for. Its MCP OAuth access token authenticates `/mcp` and nothing
 *  else, so everything the MCP surface deliberately omits - billing, hard deletes, outbound client
 *  messaging - is unreachable no matter how the agent is asked. The provider issues a REST key from a
 *  separate loopback flow: browser consent → single-use code on our loopback → server-to-server
 *  exchange → key. This face describes that flow declaratively so the daemon can drive it.
 *
 *  Deliberately NEVER run at install. Provisioning is a real grant (often a broader one than the MCP
 *  connection), so it happens when the work actually needs it, with the operator watching. */
export interface PackProvision {
  /** The provider page the operator approves on. `{redirect_uri}` and `{state}` are substituted. Must
   *  carry no query string of its own - providers commonly append theirs with a raw `?`. */
  authorizeUrl: string;
  /** Where the daemon POSTs the code, server-to-server. The browser never sees this response. */
  exchangeUrl: string;
  /** Callback query param carrying the single-use code. Default "code". */
  codeParam?: string;
  /** Request-body field the code is sent as. Default "code". */
  codeField?: string;
  /** Optional body field carrying this machine's name, so the provider can label and rotate the key
   *  per device rather than piling up credentials. */
  hostField?: string;
  /** Dotted path to the credential in the exchange response, e.g. "data.protocolApiKey". */
  keyPath: string;
  /** Optional dotted path to an API base URL issued alongside the credential. */
  apiBasePath?: string;
  /** Environment variable the credential reaches the agent under. */
  envKey: string;
  /** Environment variable the API base reaches the agent under. */
  envBase?: string;
  /** One line naming what this grant actually allows - shown to the operator BEFORE the browser opens.
   *  Required: a broader-than-MCP credential must never be requested without saying so. */
  grants: string;
  /** Public page describing the grant. */
  docsUrl: string;
}

export interface PackManifest {
  id: string;
  name: string;
  icon?: string;
  summary?: string;
  app?: { url: string; icon?: string };
  mcp?: PackMcp;
  apiKey?: PackApiKey;
  provision?: PackProvision;
  skills?: string[];
  policy?: { allow?: string[]; ask?: string[]; deny?: string[] };
}
export interface PackMeta extends PackManifest {
  installed: boolean;
  /** The writable root a pack is installed in (team|private), or undefined if not installed. */
  installedIn?: string;
  faces: { app: boolean; mcp: boolean; apiKey: boolean; provision: boolean; skills: number };
  /** True when this pack's escape-hatch credential has been provisioned on this machine. */
  provisioned?: boolean;
  /** True when a static API key is stored for this pack (set by callers with keychain access, e.g.
   *  the daemon packStore; the pure catalog reader leaves it undefined). Drives the store's
   *  "connected via key" state. */
  apiKeyConnected?: boolean;
}

/** How many of a pack's declared skills actually resolve to a SKILL.md dir in the pack. */
function countSkills(dir: string, skills: string[] | undefined): number {
  if (!skills) return 0;
  let n = 0;
  for (const s of skills) {
    if (NAME_RE.test(s) && existsSync(join(dir, "skills", s, "SKILL.md"))) n++;
  }
  return n;
}

/** Is this a well-formed policy entry - a bare tool name, or a `{tool, when}` rule whose conditions map
 *  argument names to non-empty value lists? */
function validEntry(e: unknown, allowRules: boolean): boolean {
  if (typeof e === "string") return e.trim().length > 0;
  if (!allowRules || typeof e !== "object" || e === null) return false;
  const r = e as { tool?: unknown; when?: unknown };
  if (typeof r.tool !== "string" || !r.tool.trim()) return false;
  if (r.when === undefined) return true;
  if (typeof r.when !== "object" || r.when === null || Array.isArray(r.when)) return false;
  return Object.values(r.when as Record<string, unknown>).every(
    (vals) => Array.isArray(vals) && vals.length > 0 && vals.every((v) => ["string", "number", "boolean"].includes(typeof v)),
  );
}

/** Validate a pack's classifier corrections. Fails CLOSED - a malformed policy skips the whole pack
 *  rather than connecting it with the gate silently missing. `hidden` takes bare names only: a tool is
 *  in the agent's list or not, and that is decided before any call (and so any argument) exists. */
function validPackPolicy(p: unknown): boolean {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const { read, gated, hidden, ...rest } = p as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return false; // unknown key - refuse rather than ignore
  for (const [list, allowRules] of [
    [read, true],
    [gated, true],
    [hidden, false],
  ] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((e) => validEntry(e, allowRules))) return false;
  }
  return true;
}

/** Validate the escape-hatch face. Both URLs must be https - this flow carries a credential broader
 *  than the MCP connection, so it never rides plaintext - and the authorize URL must not already carry
 *  both placeholders, since the consent page has no other way to learn where to send the operator back.
 *  `grants` is required: the operator is told what they are granting before the browser opens, never
 *  after. (The redirect_uri the daemon substitutes is a bare loopback path with no query string of its
 *  own - consent pages commonly append their params with a raw `?`.) */
function validProvision(p: PackProvision): boolean {
  const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!str(p.authorizeUrl) || !str(p.exchangeUrl) || !str(p.keyPath) || !str(p.envKey)) return false;
  if (!str(p.grants) || !str(p.docsUrl)) return false;
  for (const u of [p.authorizeUrl, p.exchangeUrl, p.docsUrl]) if (!u.startsWith("https://")) return false;
  if (!p.authorizeUrl.includes("{redirect_uri}") || !p.authorizeUrl.includes("{state}")) return false;
  for (const k of ["codeParam", "codeField", "hostField", "apiBasePath", "envBase"] as const) {
    if (p[k] !== undefined && !str(p[k])) return false;
  }
  return true;
}

/** Validate + normalize a raw manifest; returns undefined if it must be skipped. */
function parsePack(dir: string, id: string): PackManifest | undefined {
  let m: PackManifest;
  try {
    m = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as PackManifest;
  } catch {
    return undefined;
  }
  if (m.id !== id || !NAME_RE.test(id)) return undefined;
  if (typeof m.name !== "string" || !m.name.trim()) return undefined;
  if (m.app && !/^https?:\/\//.test(m.app.url ?? "")) return undefined;
  if (m.mcp) {
    if (m.mcp.kind === "http" && !/^https?:\/\//.test(m.mcp.url ?? "")) return undefined;
    if (m.mcp.kind === "stdio" && !(typeof m.mcp.command === "string" && m.mcp.command.trim())) return undefined;
    if (m.mcp.kind !== "http" && m.mcp.kind !== "stdio") return undefined;
    if (m.mcp.policy !== undefined && !validPackPolicy(m.mcp.policy)) return undefined;
  }
  if (m.provision && !validProvision(m.provision)) return undefined;
  if (!m.app && !m.mcp && countSkills(dir, m.skills) === 0) return undefined; // must have ≥1 face
  return m;
}

/** The writable (non-core) root a pack is installed in, or undefined. Detected by the app manifest OR
 *  the per-install policy-fragment marker (written for EVERY install) - so an app-less pack
 *  (mcp/skills only) is still recognised as installed and its MCP gets pinned. First match wins. */
function installedRoot(roots: Root[], id: string): string | undefined {
  for (const root of roots) {
    if (root.name === "core") continue;
    if (existsSync(join(root.dir, "apps", id, "app.json"))) return slotOf(root.name);
    if (existsSync(join(root.dir, "policy", "packs", `${id}.json`))) return slotOf(root.name);
  }
  return undefined;
}

export function readPack(source: CatalogSource, id: string): PackManifest | undefined {
  const dir = source.dir(id);
  return dir ? parsePack(dir, id) : undefined;
}

/** Deterministic pack list, sorted by name. Definitions come from `source` (read live); installed
 *  state is derived from the writable workspace `roots`. Invalid packs are skipped, never thrown. */
export function listPacks(source: CatalogSource, roots: Root[]): PackMeta[] {
  const out: PackMeta[] = [];
  for (const id of source.ids()) {
    const dir = source.dir(id);
    if (!dir) continue;
    const m = parsePack(dir, id);
    if (!m) continue;
    const inRoot = installedRoot(roots, id);
    out.push({
      ...m,
      installed: !!inRoot,
      ...(inRoot ? { installedIn: inRoot } : {}),
      faces: { app: !!m.app, mcp: !!m.mcp, apiKey: !!m.apiKey, provision: !!m.provision, skills: countSkills(dir, m.skills) },
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Install orchestration (Task 3) --------------------------------------------------------------

export interface InstallDeps {
  writeApp: (roots: Root[], o: { repo: string; name: string; manifest: AppManifest }) => void;
  copySkill: (srcDir: string, destDir: string) => void;
  pinMcp: (key: string, cfg: McpServerConfig | null) => void;
  writePolicyFragment: (targetDir: string, id: string, policy: PackManifest["policy"] | null) => void;
}
export interface InstallResult {
  id: string;
  target: string;
  did: { app: boolean; skills: string[]; mcp: boolean; policy: boolean };
}

function targetRoot(roots: Root[], target: string): Root {
  if (target === "core") throw new Error("cannot install into core (read-only)");
  // `target` is a slot ("team"|"private"); resolve it to the writable root whose name maps to it,
  // so company-suffixed names ("team-acme") match the bare slot the UI sends.
  const root = roots.find((r) => r.name !== "core" && slotOf(r.name) === target);
  if (!root) throw new Error(`no writable "${target}" root in this workspace`);
  return root;
}

/** Map a pack's mcp face to a concrete .mcp.json server config. */
export function packMcpConfig(m: PackMcp): McpServerConfig {
  if (m.kind === "http") return { type: "http", url: m.url! };
  return { type: "stdio", command: m.command!, ...(m.args ? { args: m.args } : {}), ...(m.env ? { env: m.env } : {}) };
}

/** A connector-gateway provider spec (structurally matches ProviderSpec in connector-gateway.ts). */
export interface PackProviderSpec {
  name: string;
  url: string;
  scopes?: string[];
  /** The pack's classifier corrections, handed to the gateway as the baseline under any operator
   *  overrides. Named `basePolicy` (not `policy`) so it can never be mistaken for, or persisted as,
   *  the operator's own tightening. */
  basePolicy?: ConnectorPolicy;
}

/** Map a pack's mcp face to a connector-gateway provider - the unified connection path: the
 *  gateway OAuths the provider itself (DCR), proxies it, and re-exposes it to the agent over loopback.
 *  Returns null when the pack has no mcp face, is a local `stdio` server, or is flagged `direct` (a
 *  non-DCR provider that must stay a remote pin, e.g. Google Gmail/Calendar/Drive). Those keep the
 *  `packMcpConfig` direct-pin path; everything else routes through the gateway. */
export function packMcpProvider(m: PackManifest): PackProviderSpec | null {
  const mcp = m.mcp;
  if (!mcp || mcp.kind !== "http" || mcp.direct) return null;
  return {
    name: m.id,
    url: mcp.url!,
    ...(mcp.scopes ? { scopes: mcp.scopes } : {}),
    ...(mcp.policy ? { basePolicy: mcp.policy } : {}),
  };
}

/** Keychain key holding a pack's static API key (the connector:<id>:apikey namespace, sibling to the
 *  OAuth token namespace). Public convention - the value is never a manifest or repo secret. */
export function apiKeyKeychainKey(id: string): string {
  return `connector:${id}:apikey`;
}

/** Keychain key holding a pack's provisioned escape-hatch credential. A THIRD namespace, deliberately
 *  distinct from `:apikey` (the operator's pasted MCP key) and the OAuth slots: this credential is
 *  usually broader than either, and conflating them would let clearing one silently revoke another. */
export function provisionKeychainKey(id: string): string {
  return `connector:${id}:provisioned`;
}
/** Keychain key holding the API base URL issued alongside that credential. */
export function provisionBaseKeychainKey(id: string): string {
  return `connector:${id}:provisioned-base`;
}

/** A minimal secret reader - the client Keychain satisfies it structurally. */
export interface KeyReader {
  get(key: string): string | undefined;
}

/** The connection-mode signal for a `mcp-bearer` pack: when the operator has stored an API key for it,
 *  that key OVERRIDES OAuth. The pack's own MCP url is direct-pinned with the key as a Bearer header
 *  (and, by the same predicate, kept OFF the OAuth gateway). Returns the header-injected direct-pin
 *  config, or null when the pack is not in API-key mode (no `mcp-bearer` face, or no key stored).
 *  Presence of the stored key is the whole mode state - there is no separate mode store. */
export function packApiKeyPin(m: PackManifest, keys: KeyReader | undefined): McpServerConfig | null {
  const ak = m.apiKey;
  if (!ak || ak.transport !== "mcp-bearer" || m.mcp?.kind !== "http" || !m.mcp.url) return null;
  const key = keys?.get(apiKeyKeychainKey(m.id));
  if (!key) return null;
  const header = ak.header ?? "Authorization";
  const prefix = ak.prefix ?? "Bearer ";
  return { type: "http", url: m.mcp.url, headers: { [header]: `${prefix}${key}` } };
}

/** Install a pack into a writable root by composing the injected face-writers. Definitions (manifest +
 *  skill folders) come from `source`; the pack is written into the target workspace root. Deterministic. */
export function installPack(source: CatalogSource, roots: Root[], opts: { id: string; target: string }, deps: InstallDeps): InstallResult {
  const root = targetRoot(roots, opts.target);
  const packSrc = source.dir(opts.id);
  const m = packSrc ? parsePack(packSrc, opts.id) : undefined;
  if (!packSrc || !m) throw new Error(`unknown pack: ${opts.id}`);

  const did: InstallResult["did"] = { app: false, skills: [], mcp: false, policy: false };
  if (m.app) {
    deps.writeApp(roots, {
      repo: root.name,
      name: m.id,
      manifest: { kind: "external", url: m.app.url, ...(m.app.icon ? { icon: m.app.icon } : {}) },
    });
    did.app = true;
  }
  if (m.skills) {
    for (const s of m.skills) {
      if (NAME_RE.test(s) && existsSync(join(packSrc, "skills", s, "SKILL.md"))) {
        deps.copySkill(join(packSrc, "skills", s), join(root.dir, "skills", s));
        did.skills.push(s);
      }
    }
  }
  if (m.mcp) { deps.pinMcp(`${PACK_KEY_PREFIX}${m.id}`, packMcpConfig(m.mcp)); did.mcp = true; }
  // Always write the policy fragment - empty when the pack has no hints - so it doubles as the
  // install marker (installedRoot) for app-less packs. did.policy reflects real hints only.
  deps.writePolicyFragment(root.dir, m.id, m.policy ?? {});
  if (m.policy) did.policy = true;
  return { id: m.id, target: root.name, did };
}

/** Reverse an install: remove the app folder, skill dirs, MCP pin, and policy fragment. The pack's
 *  skill list is read from `source` (the same definition install used). */
export function uninstallPack(source: CatalogSource, roots: Root[], opts: { id: string; target: string }, deps: InstallDeps): InstallResult {
  const root = targetRoot(roots, opts.target);
  if (!NAME_RE.test(opts.id)) throw new Error(`invalid pack id: ${opts.id}`);
  const did: InstallResult["did"] = { app: false, skills: [], mcp: false, policy: false };
  const appDir = join(root.dir, "apps", opts.id);
  if (existsSync(join(appDir, "app.json"))) { rmSync(appDir, { recursive: true, force: true }); did.app = true; }
  const packSrc = source.dir(opts.id);
  const m = packSrc ? parsePack(packSrc, opts.id) : undefined;
  if (m?.skills) {
    for (const s of m.skills) {
      const sd = join(root.dir, "skills", s);
      if (NAME_RE.test(s) && existsSync(sd)) { rmSync(sd, { recursive: true, force: true }); did.skills.push(s); }
    }
  }
  deps.pinMcp(`${PACK_KEY_PREFIX}${opts.id}`, null); did.mcp = true;
  deps.writePolicyFragment(root.dir, opts.id, null); did.policy = true;
  return { id: opts.id, target: root.name, did };
}
