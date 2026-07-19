// Boot the multi-org BuildEx demo (B2a): the org switcher in action. "Acme Labs" is a local-only
// SANDBOX (never synced) you can play with immediately; "Start my company" creates your own real org.
// Reuses scripts/demo-setup.ts to seed the rich Acme brain into the demo org's workspace, then strips
// its git remotes so the sandbox can never sync.
//
// Dev-only: seeding the demo shells `npx tsx` and needs the repo. The packaged app (B2b) will seed
// the demo from bundled library content instead. Run:  npm run demo:orgs   (opens in your browser)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Root } from "../apps/client/src/brain/graph.js";
import { startOrgDaemon } from "../apps/client/src/server-main.js";
import { resolveOrgsRoot } from "../apps/client/src/orgs/roots.js";
import { resolveCorePackDir } from "../apps/client/src/provision/core-pack.js";
import { provisionLocalWorkspace } from "../apps/client/src/provision/local-workspace.js";
import { seedAcmeWorkspace } from "../apps/client/src/demo/acme-seed.js";
import { bundleCatalogSource } from "../apps/client/src/brain/catalog-source.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env["BUILDEX_DEMO_PORT"] || 4317);

try {
  const v = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  console.log(`Using your claude CLI: ${v}`);
} catch {
  console.warn("⚠  `claude` was not found on PATH. The UI will load, but chat needs the Claude Code CLI installed + logged in.");
}

const orgsRoot = resolveOrgsRoot({ homeDir: homedir() });
const preset = JSON.parse(readFileSync(join(REPO, "packs", "core", "policy", "preset.json"), "utf8"));
const gateHook = join(REPO, "apps", "client", "scripts", "gate-hook.mjs");
const gateCommand = `node "${gateHook}" http://127.0.0.1:${port}`;
const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
const corePackDir = resolveCorePackDir({ ...(resourcesPath ? { resourcesPath } : {}), repoRoot: REPO });
const catalogSource = bundleCatalogSource(join(corePackDir, "catalog"));

// Demo fixtures on so "Sync now" files sample material without real creds; OFF everywhere else. The
// sandbox has no remotes, so nothing leaves the machine regardless.
process.env["BUILDEX_DEMO_FIXTURES"] ??= "1";

/** A real (empty) local org from the bundled pack — no remote yet (syncable once an account opens). */
const seedReal = (workspace: string): Root[] => provisionLocalWorkspace({ workspace, corePackDir, actor: "operator" });

/** The demo SANDBOX: lay down the rich Acme brain as no-remote git repos (permanently local, never
 *  syncs). Same shared library the packaged app uses - no shell-out, no repo checkout. */
const seedDemo = (workspace: string): Root[] => seedAcmeWorkspace({ workspace, corePackDir });

const daemon = await startOrgDaemon({
  orgsRoot,
  base: {
    preset,
    claudeBin: "claude",
    catalogSource,
    gateCommand,
    usageOAuth: true,
    actor: "operator",
    schedulerIntervalMs: 60000,
    keychainMode: (process.env["BUILDEX_KEYCHAIN"] as "auto" | "system" | "memory") || "auto",
    webRoot: join(REPO, "apps", "client", "web"),
  },
  seedReal,
  seedDemo,
  port,
});

console.log(`
🟢  BuildEx (multi-org) is running.

    ${daemon.url}

    Switch organizations from the top of the left panel. "Acme Labs" is a local-only
    SANDBOX (never synced); use "Start my company" to create your own.

    Press Ctrl+C to stop.
`);

process.on("SIGINT", async () => {
  await daemon.close();
  process.exit(0);
});
await new Promise(() => {});
