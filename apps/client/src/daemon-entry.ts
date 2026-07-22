// The PACKAGED app's daemon boot (B2b). esbuild bundles this file + the whole daemon into a single
// build/daemon.cjs; the Electron main process requires it and calls startPackagedDaemon() in-process
// (so asar-packed web assets + the bundled core pack are read through Electron's fs). This replaces the
// dev path (`npx tsx scripts/demo.ts`), which cannot exist in a shipped app - there is no repo, no tsx.
//
// It boots the MULTI-ORG daemon (B2a): a first run offers the "Acme Labs" demo SANDBOX (seeded from the
// bundled library, no remotes → never syncs) alongside "Start my company" (a real, empty local org that
// syncs once an account is opened). All content is compiled into the bundle; the only external inputs
// are the bundled core pack + gate-hook shipped as unpacked resources.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { startOrgDaemon, type RunningDaemon } from "./server-main.js";
import { resolveOrgsRoot } from "./orgs/roots.js";
import { resolveCorePackDir } from "./provision/core-pack.js";
import { provisionLocalWorkspace } from "./provision/local-workspace.js";
import { seedAcmeWorkspace } from "./demo/acme-seed.js";
import { augmentedPath } from "./agent/resolve-path.js";
import { bundleCatalogSource } from "./brain/catalog-source.js";
import type { Root } from "./brain/graph.js";
import type { PolicyPreset } from "./gate/policy.js";

export interface PackagedDaemonOpts {
  /** process.resourcesPath in the packaged app (electron-builder extraResources land here). Undefined
   *  in dev, where the bundle falls back to the repo tree relative to build/daemon.cjs. */
  resourcesPath?: string;
  /** Where the org registry lives - the Electron app's userData dir. Falls back to the demo-dir env or
   *  ~/.buildex-demo when unset (dev). */
  appDataDir?: string;
  /** Fixed loopback port (the gate-hook command embeds it, so it must be known before binding).
   *  Defaults to BUILDEX_PORT or 4319 (clear of the dev demo's 4317/4318). */
  port?: number;
  /** Keychain backend. "auto" (default, the shipped app) persists to the OS vault when available; a
   *  smoke test passes "memory" so a fresh-provision purge never shells to the real `security`/Cred
   *  Manager. */
  keychainMode?: "auto" | "system" | "memory";
}

/** Boot the multi-org daemon for the packaged app. Returns the running daemon (URL/port/close) so the
 *  Electron shell can load the URL. Pure-ish: all environment inputs are explicit opts (or env), so this
 *  is exercisable from a plain Node smoke test with the repo's own pack standing in for the bundle. */
export async function startPackagedDaemon(opts: PackagedDaemonOpts = {}): Promise<RunningDaemon> {
  const resourcesPath = opts.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath;
  // A Finder-launched app inherits a bare PATH, so the operator's `claude` (and the git/rg/node it
  // shells out to) are invisible and every agent spawn would ENOENT. Widen this process's PATH to the
  // common install dirs before anything spawns; the daemon runs in-process in Electron main, so this
  // one mutation covers every downstream child. See agent/resolve-path.ts.
  process.env["PATH"] = augmentedPath({ home: homedir(), current: process.env["PATH"] });
  // Dev fallback: build/daemon.cjs sits at <repo>/apps/client/build, so the repo root is three up.
  const repoRoot = join(__dirname, "..", "..", "..");
  const port = opts.port ?? Number(process.env["BUILDEX_PORT"] || 4319);

  // The bundled core pack: <resources>/core-pack when packaged, else <repo>/packs/core.
  const corePackDir = resolveCorePackDir({ ...(resourcesPath ? { resourcesPath } : {}), repoRoot });
  const catalogSource = bundleCatalogSource(join(corePackDir, "catalog"));
  const preset = JSON.parse(readFileSync(join(corePackDir, "policy", "preset.json"), "utf8")) as PolicyPreset;

  // The PreToolUse gate-hook: shipped UNPACKED (the operator's own `claude` runs `node <hook>` outside
  // asar, so it must be a real file). <resources>/gate-hook.mjs when packaged, else the repo copy.
  const gateHook = resourcesPath ? join(resourcesPath, "gate-hook.mjs") : join(repoRoot, "apps", "client", "scripts", "gate-hook.mjs");
  const gateCommand = `node "${gateHook}" http://127.0.0.1:${port}`;

  // The org registry root: the Electron userData dir when packaged, else the demo-dir/home fallback.
  const orgsRoot = resolveOrgsRoot({ env: process.env, homeDir: homedir(), ...(opts.appDataDir ? { appDataDir: opts.appDataDir } : {}) });

  // The web console is packed alongside the bundle (web/ is a sibling of build/ under the app root).
  const webRoot = join(__dirname, "..", "web");

  return startOrgDaemon({
    orgsRoot,
    base: {
      preset,
      claudeBin: "claude",
      catalogSource,
      gateCommand,
      usageOAuth: true,
      actor: "operator",
      schedulerIntervalMs: 60000,
      keychainMode: opts.keychainMode ?? "auto",
      webRoot,
      // Per-org connector gateway: hosts BuildEx's OAuth+MCP gateway on a loopback port so an installed
      // pack's tools (e.g. HeyGen, Linear) surface to the agent and show live Connect/connected status.
      // No founder providers in the shipped build (providers:[]); installed packs auto-register. The
      // router tears this down + rebinds on org switch (the port is fixed). `localhost` (not the IP
      // literal) for the OAuth redirect - some providers reject 127.0.0.1; the daemon also listens ::1.
      connectorsMcp: {
        providers: [],
        // Console+1 in production; when the console port is ephemeral (0, as in tests) the gateway is
        // ephemeral too, so we never derive a privileged port 1.
        gatewayPort: Number(process.env["BUILDEX_DEMO_GATEWAY_PORT"] ?? (port > 0 ? port + 1 : 0)),
        redirectBase: `http://localhost:${port}`,
      },
    },
    seedReal: (workspace: string): Root[] => provisionLocalWorkspace({ workspace, corePackDir, actor: "operator" }),
    seedDemo: (workspace: string): Root[] => seedAcmeWorkspace({ workspace, corePackDir }),
    port,
  });
}
