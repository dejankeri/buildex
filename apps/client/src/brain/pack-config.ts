// Sync-time pack wiring: (1) re-pin every installed pack's MCP entry into .mcp.json on each
// regenConfig, and (2) compose the effective policy preset = base ⊕ installed
// packs' policy fragments, so the generated settings.json and the runtime gate agree. Deterministic,
// zero LLM - rendered from repo state.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "./graph.js";
import type { PolicyPreset } from "../gate/policy.js";
import { listPacks, packMcpConfig, packMcpProvider, packApiKeyPin, type KeyReader } from "./catalog.js";
import type { CatalogSource } from "./catalog-source.js";
import { PACK_KEY_PREFIX, type McpServerConfig } from "@buildex/connectors";

/** Direct `.mcp.json` pins for installed packs, keyed `buildex-pack:<id>`. Packs whose mcp face routes
 *  through the connector gateway (DCR-capable remote MCPs) are intentionally excluded: their
 *  tools reach the agent via the loopback gateway, not a direct remote pin. Only `stdio` (local),
 *  `direct` (non-DCR) packs, and packs in API-key mode (a stored `mcp-bearer` key) are direct-pinned -
 *  the last with the key injected as a Bearer header (see `packApiKeyPin`). `keys` is the keychain
 *  reader; omit it (tests/embedders) and no pack is treated as keyed. */
export function installedPackMcpEntries(source: CatalogSource, roots: Root[], keys?: KeyReader): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const p of listPacks(source, roots)) {
    if (!p.installed) continue;
    const keyed = packApiKeyPin(p, keys);
    if (keyed) { out[`${PACK_KEY_PREFIX}${p.id}`] = keyed; continue; } // API-key mode overrides OAuth
    if (!p.mcp) continue;
    if (packMcpProvider(p)) continue; // gateway-routed → not direct-pinned
    out[`${PACK_KEY_PREFIX}${p.id}`] = packMcpConfig(p.mcp);
  }
  return out;
}

/** Desired pack pins PLUS explicit `null`s for any `buildex-pack:*` key still in .mcp.json that is no
 *  longer installed - so `writeMcpEntries` removes stale pins on uninstall (it only deletes keys set
 *  to null). Non-pack keys (the gateway, operator servers) are never touched. */
export function reconciledPackMcpEntries(source: CatalogSource, workspaceDir: string, roots: Root[], keys?: KeyReader): Record<string, McpServerConfig | null> {
  const desired = installedPackMcpEntries(source, roots, keys);
  const entries: Record<string, McpServerConfig | null> = { ...desired };
  const mcpPath = join(workspaceDir, ".mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const doc = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
      for (const key of Object.keys(doc.mcpServers ?? {})) {
        if (key.startsWith(PACK_KEY_PREFIX) && !(key in desired)) entries[key] = null;
      }
    } catch {
      /* ignore a corrupt file - writeMcpEntries starts fresh */
    }
  }
  return entries;
}

interface PolicyFragment {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

/** Base preset ⊕ every installed-pack policy fragment (`<root>/policy/packs/*.json`). Union of the
 *  allow/ask/deny rule strings; `default` is carried from the base. Malformed fragments are skipped. */
export function composePreset(base: PolicyPreset, roots: Root[]): PolicyPreset {
  const allow = new Set(base.allow);
  const ask = new Set(base.ask);
  const deny = new Set(base.deny);
  for (const root of roots) {
    const d = join(root.dir, "policy", "packs");
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      try {
        const p = JSON.parse(readFileSync(join(d, f), "utf8")) as PolicyFragment;
        (p.allow ?? []).forEach((r) => allow.add(r));
        (p.ask ?? []).forEach((r) => ask.add(r));
        (p.deny ?? []).forEach((r) => deny.add(r));
      } catch {
        /* skip malformed fragment */
      }
    }
  }
  return { allow: [...allow], ask: [...ask], deny: [...deny], default: base.default };
}
