import { mkdirSync, existsSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Root } from "../brain/graph.js";
import type { CatalogSource } from "../brain/catalog-source.js";
import { installPack, readPack, slotOf, type InstallResult } from "../brain/catalog.js";
import { writeAppManifest } from "../brain/apps.js";

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
      // no-op: the engine pins the pack itself, from the MINTED sandbox key (Task 3's mintAndPin) - there is no regenConfig in a harness run.
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

  const priv = rootBySlot(roots, "private");
  if (!priv) throw new Error('no writable "private" root in this workspace');
  const app = !m?.app || existsSync(join(priv.dir, "apps", id, "app.json"));

  const rulesRoot = rootBySlot(roots, "team") ?? rootBySlot(roots, "private");
  if (!rulesRoot) throw new Error('no writable "team" or "private" root in this workspace');
  const skills = (m?.skills ?? []).map((name) => ({
    name,
    present: existsSync(join(rulesRoot.dir, "skills", name, "SKILL.md")),
  }));

  const policyFragment = existsSync(join(rulesRoot.dir, "policy", "packs", `${id}.json`));

  const ok = app && skills.every((s) => s.present) && policyFragment;

  return { app, skills, policyFragment, ok };
}
