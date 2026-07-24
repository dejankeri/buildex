import { mkdirSync, existsSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "../brain/graph.js";
import type { CatalogSource } from "../brain/catalog-source.js";
import type { PolicyPreset } from "../gate/policy.js";
import { installPack, readPack, slotOf, type InstallResult } from "../brain/catalog.js";
import { writeAppManifest } from "../brain/apps.js";
import { composePreset } from "../brain/pack-config.js";
import { generateAgentConfig, type LinkStrategy } from "../brain/agent-config.js";

export interface InstallCheck {
  app: boolean;
  skills: { name: string; present: boolean }[];
  policyFragment: boolean;
  ok: boolean;
}

/**
 * Find the root with a given slot, excluding core.
 */
function rootBySlot(roots: Root[], slot: string): Root | undefined {
  return roots.find((r) => r.name !== "core" && slotOf(r.name) === slot);
}

/**
 * Install a pack headlessly with real filesystem operations mirroring wiring.ts:349-360.
 * Composes installPack with InstallDeps that:
 * - writeApp via writeAppManifest
 * - copySkill via cpSync(recursive)
 * - pinMcp as a no-op (the engine pins from the MINTED key in Task 3)
 * - writePolicyFragment writes/removes <root>/policy/packs/<id>.json
 */
export function installPackHeadless(source: CatalogSource, roots: Root[], id: string): InstallResult {
  return installPack(source, roots, { id }, {
    writeApp: (roots, o) => {
      writeAppManifest(roots, o);
    },
    copySkill: (src, dest) => {
      cpSync(src, dest, { recursive: true });
    },
    pinMcp: () => {
      // no-op: the engine writes the pin itself (sandbox-step's pinKey - from a minted sandbox key
      // or the local lane's caller-supplied key), never from a keychain the way the product does.
    },
    writePolicyFragment: (targetDir, id, policy) => {
      const d = join(targetDir, "policy", "packs");
      const f = join(d, `${id}.json`);
      if (policy == null) {
        if (existsSync(f)) rmSync(f);
        return;
      }
      mkdirSync(d, { recursive: true });
      writeFileSync(f, JSON.stringify(policy, null, 2) + "\n");
    },
  });
}

/** The Claude Code permission rule granting all tools of one .mcp.json server. Verified live
 *  (2026-07-23, local-lane bisect): server key "buildex-pack:<id>" yields tool names
 *  mcp__buildex-pack_<id>__<tool> (":" → "_"), and the server-level rule (no tool suffix) covers
 *  them all. ONE definition - the settings allow-rule and the spawn's --allowedTools grant must
 *  never drift apart. */
export function serverAllowRule(serverKey: string): string {
  return `mcp__${serverKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Regenerate the workspace's agent-facing config AFTER an install, exactly like the product's sync
 * (wiring's regenConfig): recompose the preset from the core preset + every installed pack's policy
 * fragment, re-link skills (so the just-installed pack's skills reach .claude/skills), reassemble
 * CLAUDE.md, rewrite settings.json.
 *
 * `allowMcpServer`: the .mcp.json server key of the pack under test (e.g. "buildex-pack:acme").
 * A harness run has no daemon, so the product's PreToolUse gate hook - whose BuildEx policy engine
 * defaults unknown tools to allow - is not wired; without it, Claude Code's own default would
 * silently block every pinned MCP tool in the headless session. A server-level allow rule
 * reproduces the product's allow-tier behavior for exactly the pack under test. Gated-intent
 * behavior (ask-tier) stays out of deterministic runs - that is the proof track's gate-honesty
 * territory.
 */
export function regenAgentConfig(opts: {
  workspace: string;
  roots: Root[];
  corePackDir: string;
  allowMcpServer?: string;
  linkStrategy?: LinkStrategy;
}): { allow: string[] } {
  const presetPath = join(opts.corePackDir, "policy", "preset.json");
  if (!existsSync(presetPath)) {
    throw new Error(`core pack has no policy/preset.json (looked in ${opts.corePackDir}) - is this a core pack dir?`);
  }
  const base = JSON.parse(readFileSync(presetPath, "utf8")) as PolicyPreset;
  const preset = composePreset(base, opts.roots);
  const allow = opts.allowMcpServer ? [...preset.allow, serverAllowRule(opts.allowMcpServer)] : preset.allow;
  generateAgentConfig({
    workspace: opts.workspace,
    roots: opts.roots,
    preset: { ...preset, allow },
    ...(opts.linkStrategy ? { linkStrategy: opts.linkStrategy } : {}),
  });
  // The composed allow tier is the single source of truth for what the driven agent may do. It is
  // written to settings.json above AND returned here so the harness can pass the SAME list to the
  // spawn's --allowedTools: in a fresh, never-folder-trusted headless workspace settings.json does
  // not bind, so --allowedTools is the ONLY thing that grants Write/Edit/Bash. Granting only the
  // pack's mcp server (the old behavior) left every file-writing scenario denied at the permission
  // wall - a false FAIL that had nothing to do with the pack under test.
  return { allow };
}

/**
 * Verify that a pack was installed correctly by checking:
 * - app.json exists in private-slot root (iff manifest has app face)
 * - all declared skills exist in team-slot root (falling back to private when no team root)
 * - policy fragment exists in team-slot root (falling back to private when no team root)
 *
 * Returns ok=true only when all checks pass.
 */
export function verifyInstall(source: CatalogSource, roots: Root[], id: string): InstallCheck {
  const m = readPack(source, id);
  // A check for a pack that doesn't exist is a caller bug, not a "half failed install" - the
  // shape it would produce (app:true, skills:[], policyFragment:false) reads as a phantom failure.
  if (!m) throw new Error(`unknown pack: ${id}`);

  const priv = rootBySlot(roots, "private");
  if (!priv) throw new Error('no writable "private" root in this workspace');
  const app = !m.app || existsSync(join(priv.dir, "apps", id, "app.json"));

  // priv exists, so the private fallback always resolves - no second throw needed.
  const rulesRoot = rootBySlot(roots, "team") ?? priv;
  const skills = (m.skills ?? []).map((name) => ({
    name,
    present: existsSync(join(rulesRoot.dir, "skills", name, "SKILL.md")),
  }));

  const policyFragment = existsSync(join(rulesRoot.dir, "policy", "packs", `${id}.json`));

  const ok = app && skills.every((s) => s.present) && policyFragment;

  return { app, skills, policyFragment, ok };
}
