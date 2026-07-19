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
import { PACK_KEY_PREFIX, type McpServerConfig } from "@buildex/connectors";

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
}
export interface PackManifest {
  id: string;
  name: string;
  icon?: string;
  summary?: string;
  app?: { url: string; icon?: string };
  mcp?: PackMcp;
  skills?: string[];
  policy?: { allow?: string[]; ask?: string[]; deny?: string[] };
}
export interface PackMeta extends PackManifest {
  installed: boolean;
  /** The writable root a pack is installed in (team|private), or undefined if not installed. */
  installedIn?: string;
  faces: { app: boolean; mcp: boolean; skills: number };
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
  }
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
      faces: { app: !!m.app, mcp: !!m.mcp, skills: countSkills(dir, m.skills) },
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
}

/** Map a pack's mcp face to a connector-gateway provider - the unified connection path: the
 *  gateway OAuths the provider itself (DCR), proxies it, and re-exposes it to the agent over loopback.
 *  Returns null when the pack has no mcp face, is a local `stdio` server, or is flagged `direct` (a
 *  non-DCR provider that must stay a remote pin, e.g. Google Gmail/Calendar/Drive). Those keep the
 *  `packMcpConfig` direct-pin path; everything else routes through the gateway. */
export function packMcpProvider(m: PackManifest): PackProviderSpec | null {
  const mcp = m.mcp;
  if (!mcp || mcp.kind !== "http" || mcp.direct) return null;
  return { name: m.id, url: mcp.url!, ...(mcp.scopes ? { scopes: mcp.scopes } : {}) };
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
