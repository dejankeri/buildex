// The client composition root (the single place every module is wired together - the pattern the
// prototype called buildDeps). Both the headless entry and the Electron shell build the daemon
// through this, so there is one assembly of driver + gate + sync + brain + mini-apps.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { confinePath } from "./lib/confine-path.js";
import { createDaemon, type Handler, type VaultReader, type Catalog, type TreeNode, type SkillEditor, type AutomationEngine, type ConnectorControl, type ConnectorGatewayView } from "./daemon/daemon.js";
import { startGatewayHttp, writeGatewayRegistration, writeMcpEntries } from "@buildex/connectors";
import { ConnectorGatewayHub } from "./brain/connector-gateway.js";
import { readSkill, writeSkillFile, composeSkill, validateSkill, skillTemplate } from "./brain/skills.js";
import { listApps, writeAppManifest, type AppManifest } from "./brain/apps.js";
import { reconciledPackMcpEntries, composePreset } from "./brain/pack-config.js";
import { listPacks, installPack, uninstallPack, packMcpProvider, packApiKeyPin, apiKeyKeychainKey, type InstallDeps } from "./brain/catalog.js";
import { emptyCatalogSource, type CatalogSource } from "./brain/catalog-source.js";
import { buildAgentView } from "./brain/agent-view.js";
import { serveApp, brokerData } from "./server/app-serve.js";
import {
  AutomationDefStore,
  AutomationStateFile,
  migrateJsonToYaml,
  isDue,
  nextRunMs,
  type Cadence,
  type CatchUp,
} from "./brain/automations.js";
import { AutomationsClient } from "./sync/automations-client.js";
import { drainOnce, type DrainSource } from "./sync/automation-drain.js";
import { ConnectorHub } from "./brain/connectors.js";
import { createKeychain } from "./keychain/keychain.js";
import { FileSessionStore } from "./daemon/sessions.js";
import { FileProjectStore } from "./daemon/projects.js";
import { Gate } from "./gate/gate.js";
import { PolicyEngine, type PolicyPreset } from "./gate/policy.js";
import { ApprovalBroker, GATE_CARD_TTL_MS } from "./gate/approval.js";
import { ClaudeCodeDriver } from "./agent/claude-driver.js";
import { nodeSpawnAgent } from "./agent/node-spawn.js";
import type { UiEvent } from "./agent/types.js";
import { buildGraph, type Root } from "./brain/graph.js";
import { recentChanges } from "./brain/history.js";
import { fileHistory, fileAtCommit } from "./brain/history.js";
import { SyncEngine } from "./sync/engine.js";
import { SyncScheduler, type Clock, type TimerHandle, type SyncStatus } from "./sync/scheduler.js";
import { generateAgentConfig } from "./brain/agent-config.js";
import { AppBus } from "./miniapp/app-bus.js";
import { fetchUsage, nodeTokenReader, anthropicUsageCall, type UsageReport } from "./brain/usage.js";

export interface ClientConfig {
  workspace: string;
  /** Repo roots in precedence order [core, team, private] (any subset is fine). */
  roots: Root[];
  /** The source of App Store pack DEFINITIONS - the bundled core pack, read live per store open (see
   *  brain/catalog-source.ts). Installed state still derives from `roots`. Omit → an empty store (a
   *  boot that wires no catalogue shows nothing, never a stale copy). */
  catalogSource?: CatalogSource;
  preset: PolicyPreset;
  claudeBin: string;
  /** Directory of the built operator console; served at / when set. */
  webRoot?: string;
  /** Label used for sync commits; defaults to "operator". */
  actor?: string;
  /** Company display info (shown in the console top bar). */
  company?: { name: string };
  /** The PreToolUse gate-hook command written into .claude/settings.json on regen. Omit for the
   *  local demo (native permissions, no hook) - the production sync worker sets it. */
  gateCommand?: string;
  /** If set (>0), start the in-daemon automation scheduler on this interval (ms). Omit in tests. */
  schedulerIntervalMs?: number;
  /** If set, drain durable automations from this sync worker instead of the local-only timer. */
  automationsSync?: { baseUrl: string; token: string };
  /** Poll interval (ms) for the durable drain loop; defaults to schedulerIntervalMs. */
  drainIntervalMs?: number;
  /** If set, spawn the agent with CLAUDE_CONFIG_DIR here - a config home isolated from the operator's
   *  own Claude Code (no inherited hooks) so the agent gets clean tools. Requires a one-time login in
   *  that dir. When unset, the agent uses the operator's config (the file-map keeps the brain usable). */
  agentConfigDir?: string;
  /** Opt-in (default off): show the real Claude subscription usage in the bottom strip. When true,
   *  a display-only read-out reads the operator's Claude OAuth token to call Anthropic's usage
   *  endpoint (documented bright-line exception - see usage.ts). Off → no strip. */
  usageOAuth?: boolean;
  /** Opt-in (default off): the OAuth+MCP connector gateway. When set, buildex hosts its gateway
   *  over loopback HTTP and connects these providers, giving the agent live (gated) MCP tools. Real
   *  provider OAuth apps are founder config; off → nothing runs. */
  connectorsMcp?: {
    providers: { name: string; url: string; scopes?: string[] }[];
    /** Fixed loopback port for the gateway MCP host (so .mcp.json has a stable URL). Default 4318. */
    gatewayPort?: number;
    /** Daemon base URL for OAuth callbacks. Default http://127.0.0.1:4317. */
    redirectBase?: string;
  };
  /** Lifecycle hook for the background sync loop: the daemon runner calls `start()` on boot and
   *  `stop()` (a final flush) on shutdown. Omit in tests - the scheduler still coalesces writes, it
   *  just never runs the idle pull tick. */
  onScheduler?: (s: SyncScheduler) => void;
  /** Lifecycle hook for the connector-gateway HTTP host: called (once, synchronously) with a promise
   *  for the running host as soon as it's launched, so a multi-org runner can await `close()` before
   *  rebinding the fixed gateway port on the next org (see orgs/router.ts). The promise rejects if the
   *  host fails to bind; the caller catches. Only fires when `connectorsMcp` is set. */
  onGatewayHost?: (host: Promise<{ close: () => Promise<void> }>) => void;
  /** Per-connector OAuth client credentials for the FILE connectors, runtime-injected from env
   *  (e.g. BUILDEX_GMAIL_CLIENT_ID) and NEVER committed. Absent → that connector stays fixture/apikey. */
  connectorsOAuth?: Record<string, { clientId: string; clientSecret?: string }>;
  /** Keychain backend. "memory" (default) - ephemeral, for tests/embedders; "auto" - persist to
   *  the OS keychain on macOS when available, else in-memory; "system" - require the OS keychain. */
  keychainMode?: "auto" | "system" | "memory";
  /** Daemon base URL for the file-connector OAuth loopback redirect. Default http://127.0.0.1:4317. */
  connectorsRedirectBase?: string;
}

export function buildClientHandler(config: ClientConfig): Handler {
  const actor = config.actor ?? "operator";
  // App Store pack definitions - read live from the bundled catalogue on each store open. Defaults to
  // an empty source so a boot that wires none shows an empty store, never a frozen copy.
  const catalogSource = config.catalogSource ?? emptyCatalogSource();
  // Real timers, unref'd so a pending debounce / pull tick / approval-card TTL never keeps the process
  // alive on its own (the http server does that) and never hangs a test that built the handler without
  // a running server.
  const realClock: Clock = {
    now: Date.now,
    setTimer: (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref?.();
      return h as unknown as TimerHandle;
    },
    clearTimer: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
  // The approval broker: ask-tier tools raise a card and block until the operator taps - or until the
  // card TTL auto-denies, so a tool call never hangs forever (see GATE_CARD_TTL_MS). What routes tools
  // here at run time is the PreToolUse gate hook in the generated .claude/settings.json (agent-config)
  // together with config.gateCommand (set by the demo runner); with neither, native permissions apply.
  const broker = new ApprovalBroker({
    idFactory: randomUUID,
    now: Date.now,
    ttlMs: GATE_CARD_TTL_MS,
    setTimer: (fn, ms) => realClock.setTimer(fn, ms),
    clearTimer: (h) => realClock.clearTimer(h as TimerHandle),
  });
  const gate = new Gate(new PolicyEngine(composePreset(config.preset, config.roots)), broker);
  // Allowlist the model aliases the composer can request (the --model security boundary), and pin
  // Sonnet 5 as BuildEx's default so an unspecified model never falls through to the `claude` CLI's
  // own default. The CLI resolves each alias to its current release (sonnet ⇒ Sonnet 5, etc.).
  const driver = new ClaudeCodeDriver({ spawn: nodeSpawnAgent, bin: config.claudeBin, allowedModels: ["opus", "sonnet", "haiku", "fable"], defaultModel: "sonnet", ...(config.agentConfigDir ? { configDir: config.agentConfigDir } : {}) });
  const appBus = new AppBus({ idFactory: randomUUID });
  const sync = new SyncEngine({ now: Date.now, actor });
  // The writable (non-core) repo dirs - the only roots the sync loop may commit to (core is read-only).
  const writableDirs = (): string[] => config.roots.filter((r) => r.name !== "core").map((r) => r.dir);
  // The background sync loop. Assigned below once regenConfig exists; saveDoc/skillEditor/connectors
  // reference it only at request time (well after assignment), so the forward use is safe.
  let scheduler: SyncScheduler;

  // The workspace file map, appended to the agent's system prompt every turn. The daemon can
  // enumerate the workspace freely; the agent often can't (Bash/Glob/Grep may be gated or absent in
  // the operator's environment), so we hand it the paths up front - it navigates by Read. This is
  // what lets skills like weekly-review work without shell access.
  const workspaceHint = (): string => {
    const paths: string[] = [];
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.type === "file") paths.push(n.path);
        else if (n.children) walk(n.children);
      }
    };
    walk(config.roots.map((r) => ({ name: r.name, path: r.name, type: "dir" as const, children: treeOf(r.dir, r.name) })));
    const shown = paths.slice(0, 250);
    return (
      "You work in a git-backed markdown workspace (the company brain). Some tools - Bash, Glob, " +
      "Grep - may be unavailable or gated in this environment; when they are, do NOT give up: " +
      "navigate by reading files directly with the Read tool using the exact paths below, and write " +
      "with Edit/Write. Workspace files" +
      (paths.length > shown.length ? ` (first ${shown.length} of ${paths.length})` : ` (${paths.length})`) +
      ":\n" +
      shown.join("\n")
    );
  };

  const vault: VaultReader = {
    listDocs: () => buildGraph(config.roots).nodes.filter((n) => n.kind === "file").map((n) => n.id),
    // Docs are listed by root NAME (e.g. "team/…"); map that back to the real repo dir to read them.
    readDoc: (path) => {
      const { repoDir, rel } = splitRepoPath(config.roots, path);
      const full = repoDir ? resolveWithin(repoDir, rel) : resolveInWorkspace(config.workspace, path);
      return readFileSync(full, "utf8");
    },
    history: (path) => {
      const { repoDir, rel } = splitRepoPath(config.roots, path);
      return repoDir ? fileHistory(repoDir, rel) : [];
    },
    // The doc's content at an earlier commit - the read half of one-tap restore (the write half is
    // saveDoc). Same repo-confined path resolution as reads; fileAtCommit validates the sha.
    readDocAt: (path, sha) => {
      const { repoDir, rel } = splitRepoPath(config.roots, path);
      if (!repoDir) throw new Error(`path must be inside a repo: ${path}`);
      return fileAtCommit(repoDir, rel, sha);
    },
  };

  // Write a markdown doc into the brain (same path resolution as reads), then commit it. Refuses a
  // path that doesn't resolve into a known repo, and the resolver guards against traversal.
  const saveDoc = (docPath: string, content: string): void => {
    const { repoDir, rel } = splitRepoPath(config.roots, docPath);
    if (!repoDir) throw new Error(`path must be inside a repo (e.g. team/notes.md): ${docPath}`);
    const full = resolveWithin(repoDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content.endsWith("\n") ? content : content + "\n");
    scheduler.touch(repoDir); // schedule a debounced commit+push - the file is already saved on disk
  };

  const catalog: Catalog = {
    skills: () => listSkills(join(config.workspace, ".claude", "skills")),
    connectors: () => listConnectors(config.roots),
    routines: () => [], // local routines are a v1 seam - none configured yet
  };

  // Keychain (created before regenConfig so pack MCP re-pinning can read stored API keys). Persistence
  // is opt-in via config so tests/embedders never touch the real OS keychain; the demo sets
  // keychainMode:"auto" so a real authorization survives a daemon restart.
  const keychain = createKeychain({ mode: config.keychainMode ?? "memory", workspace: config.workspace });

  // Regenerate the native agent config, threading the (optional) gate-hook command. Used after a
  // skill is authored and by the sync route, so the workspace's .claude stays consistent.
  const regenConfig = () => {
    const preset = composePreset(config.preset, config.roots);
    generateAgentConfig({
      workspace: config.workspace,
      roots: config.roots,
      preset,
      ...(config.gateCommand ? { gateCommand: config.gateCommand } : {}),
    });
    // Re-pin every installed pack's MCP entry, removing stale pins, and keep the
    // runtime gate's policy in step with the settings.json we just wrote.
    writeMcpEntries(config.workspace, reconciledPackMcpEntries(catalogSource, config.workspace, config.roots, keychain));
    gate.setPreset(preset);
  };
  // Reconcile the derived agent config against installed state at boot (idempotent): re-links skills,
  // recomposes the preset, and - importantly - migrates stale `buildex-pack:*` direct pins off .mcp.json
  // for packs now routed through the gateway. Without this, a pack converted from direct→gateway
  // keeps a leftover direct pin until the next install/sync.
  regenConfig();

  // Now that regenConfig exists, build the background sync loop and hand it to the runner (start/stop).
  // The latest status drives the header dot via GET /api/sync (needs-help when a conflict was backed up).
  let lastSyncStatus: SyncStatus = "ok";
  scheduler = new SyncScheduler({
    engine: sync,
    writableRoots: writableDirs,
    regenConfig,
    clock: realClock,
    onStatus: (s) => { lastSyncStatus = s; },
  });
  config.onScheduler?.(scheduler);

  // Pass an agent run's UiEvents through unchanged, then schedule a sync once the run ends - this is
  // what commits the agent's own edits (they are written to disk directly, never committed inline).
  async function* touchAfterRun(src: AsyncIterable<UiEvent>): AsyncIterable<UiEvent> {
    try {
      yield* src;
    } finally {
      for (const dir of writableDirs()) scheduler.touch(dir);
    }
  }

  const skillEditor: SkillEditor = {
    read: (name) => readSkill(config.workspace, config.roots, name),
    template: (name) => skillTemplate(name),
    write: ({ name, description, instructions, repo }) => {
      const content = composeSkill({ name, description, instructions });
      const check = validateSkill(content);
      const { path } = writeSkillFile(config.roots, { name, repo, content });
      regenConfig(); // link the new/edited verb into .claude/skills so the agent can find it
      const root = config.roots.find((r) => r.name === repo);
      // Schedule a debounced commit+push; the file is already saved, so a later sync loses nothing.
      if (root) scheduler.touch(root.dir);
      return { ok: check.ok, issues: check.issues, path };
    },
  };

  const appCatalog = { list: () => listApps(config.roots) };
  const appStore = {
    create: (input: { repo: string; name: string; kind: "local" | "external"; title?: string; icon?: string; url?: string }) => {
      const manifest: AppManifest =
        input.kind === "external"
          ? { ...(input.title ? { name: input.title } : {}), ...(input.icon ? { icon: input.icon } : {}), kind: "external", url: input.url ?? "" }
          : { ...(input.title ? { name: input.title } : {}), ...(input.icon ? { icon: input.icon } : {}), kind: "local", data: { read: true, write: false } };
      const starter = input.kind === "local" ? starterAppHtml(input.title ?? input.name) : undefined;
      writeAppManifest(config.roots, { repo: input.repo, name: input.name, manifest, ...(starter != null ? { starter } : {}) });
      const root = config.roots.find((r) => r.name === input.repo);
      if (root) scheduler.touch(root.dir); // debounced commit+push, like skills
      return { name: input.name };
    },
  };

  // App Store: install a capability pack (external app + skills + MCP pin + policy hints) into a
  // writable root, then regenConfig - which re-links skills, reconciles pack MCP pins, and recomposes
  // the effective preset. pinMcp is a no-op here on purpose: regenConfig owns pinning from installed
  // state (so uninstall's stale pins are removed too).
  const installDeps: InstallDeps = {
    writeApp: (roots, o) => { writeAppManifest(roots, o); },
    copySkill: (src, dest) => { cpSync(src, dest, { recursive: true }); },
    pinMcp: () => { /* regenConfig reconciles all pack pins from installed state */ },
    writePolicyFragment: (targetDir, id, policy) => {
      const d = join(targetDir, "policy", "packs");
      const f = join(d, `${id}.json`);
      if (policy == null) { if (existsSync(f)) rmSync(f); return; } // uninstall drops the fragment so it stops composing
      mkdirSync(d, { recursive: true });
      writeFileSync(f, JSON.stringify(policy, null, 2) + "\n");
    },
  };
  // Late-bound (assigned in the connector-gateway block below, which is set up after packStore): when
  // a pack with a gateway-routable MCP face is installed/removed, reconcile the gateway's providers so
  // its tools connect (or leave) immediately. Undefined when the gateway is off - then packs fall back
  // to the direct pin, unchanged.
  let syncGatewayProviders: (() => void | Promise<void>) | undefined;
  const packStore = {
    list: () => listPacks(catalogSource, config.roots).map((p) =>
      p.apiKey && keychain.get(apiKeyKeychainKey(p.id)) ? { ...p, apiKeyConnected: true } : p),
    install: (id: string, target: string) => {
      const res = installPack(catalogSource, config.roots, { id, target }, installDeps);
      const root = config.roots.find((r) => r.name === target);
      regenConfig();
      void syncGatewayProviders?.(); // register the pack's MCP as a gateway provider
      if (root) scheduler.touch(root.dir); // debounced commit+push of the new app/skill/policy files
      return res;
    },
    uninstall: (id: string, target: string) => {
      const res = uninstallPack(catalogSource, config.roots, { id, target }, installDeps);
      const root = config.roots.find((r) => r.name === target);
      regenConfig();
      void syncGatewayProviders?.(); // drop the pack's gateway provider
      if (root) scheduler.touch(root.dir);
      return res;
    },
    setApiKey: (id: string, key: string | null) => {
      // The stored key IS the connection mode. Setting it flips a mcp-bearer pack from OAuth to the
      // direct pasted-key pin; clearing it reverts to OAuth. regenConfig re-pins .mcp.json from that
      // state; syncGatewayProviders adds/removes the OAuth gateway provider to match.
      if (key) keychain.set(apiKeyKeychainKey(id), key);
      else keychain.delete(apiKeyKeychainKey(id));
      regenConfig();
      void syncGatewayProviders?.();
    },
  };

  // Connectors: connect a source (credential → keychain, never the repo) and sync it (files under
  // sources/<name>/ via the read-only-by-construction runner, then commit). sources/ lives in the
  // team brain - the first writable (non-core) root. (`keychain` is created above, before regenConfig.)
  const sourcesRepo = config.roots.find((r) => r.name !== "core") ?? config.roots[0];
  const connectorHub: ConnectorControl | undefined = sourcesRepo
    ? (() => {
        const hub = new ConnectorHub({
          repoDir: sourcesRepo.dir,
          keychain,
          now: Date.now,
          ...(config.connectorsOAuth ? { oauthClients: config.connectorsOAuth } : {}),
          ...(config.connectorsRedirectBase ? { redirectBase: config.connectorsRedirectBase } : {}),
        });
        return {
          catalog: () => hub.catalog(),
          connect: (name, credential) => hub.connect(name, credential),
          disconnect: (name) => hub.disconnect(name),
          sync: async (name) => {
            const r = await hub.sync(name);
            scheduler.touch(sourcesRepo.dir); // schedule a commit of the newly filed material
            return r;
          },
          // File-connector OAuth: present only when clients are configured; else stays apikey.
          ...(config.connectorsOAuth
            ? {
                beginAuth: (name: string) => hub.beginAuth(name),
                finishAuth: (name: string, code: string, state: string) => hub.finishAuth(name, code, state),
              }
            : {}),
        };
      })()
    : undefined;

  // The OAuth+MCP connector gateway - opt-in. Host BuildEx's gateway over loopback HTTP so the
  // operator's agent reaches it via .mcp.json; providers connect over OAuth (real provider apps are
  // founder config). Fully gated on config.connectorsMcp: off → none of this runs, zero impact.
  let gatewayView: ConnectorGatewayView | undefined;
  if (config.connectorsMcp && sourcesRepo) {
    const gwPort = config.connectorsMcp.gatewayPort ?? 4318;
    // The gateway bearer token (A3): minted fresh each daemon boot and handed to the agent through
    // the .mcp.json registration headers. A web page can't read local files, so a DNS-rebound or
    // cross-origin request arrives without it and gets 401 at the gateway host.
    const gatewayToken = randomBytes(24).toString("base64url");
    const gatewayUrl = `http://127.0.0.1:${gwPort}/mcp`;
    const gatewayHeaders = { Authorization: `Bearer ${gatewayToken}` };
    const hub = new ConnectorGatewayHub({
      broker,
      store: keychain,
      // Write the gateway's `buildex-connectors` entry into the SAME .mcp.json the agent reads and
      // regenConfig manages - the assembled workspace root - not a repo subdir. Otherwise the gateway's
      // loopback tools never reach the agent (they'd sit in team-<co>/.mcp.json, which it doesn't read).
      workspaceDir: config.workspace,
      gatewayUrl,
      gatewayHeaders,
      redirectBase: config.connectorsMcp.redirectBase ?? "http://127.0.0.1:4317",
      // Real impl opens the operator's browser (Electron shell.openExternal); here we surface the URL.
      openUrl: (u) => { console.log(`[connectors] authorize: ${u.toString()}`); },
    });

    // Provider specs (name/url/scopes + tighten-only policy overrides) persist in the KEYCHAIN via
    // the hub, never in agent-writable space (A2). The legacy workspace file is dead: it is never
    // read back - a hand-edited copy can neither loosen a tool's policy nor redirect a provider URL
    // - and any leftover is removed so nothing can ever trust it again.
    try { rmSync(join(config.workspace, ".connectors-mcp.json"), { force: true }); } catch { /* best-effort */ }

    gatewayView = {
      // Union of live statuses + persisted specs, enriched with url/scopes so the editor can prefill
      // (a spec that failed to connect on boot still appears, so the operator can fix and retry it).
      status: () => {
        const live = new Map(hub.status().map((s) => [s.name, s]));
        const specs = new Map(hub.persistedSpecs().map((s) => [s.name, s]));
        const names = new Set<string>([...live.keys(), ...specs.keys()]);
        return [...names].map((name) => {
          const s = live.get(name);
          const spec = specs.get(name);
          return {
            name,
            connected: s?.connected ?? false,
            needsAuth: s?.needsAuth ?? false,
            tools: s?.tools ?? 0,
            ...(s?.authUrl ? { authUrl: s.authUrl } : {}),
            ...(spec?.url ? { url: spec.url } : {}),
            ...(spec?.scopes ? { scopes: spec.scopes } : {}),
          };
        });
      },
      tools: () => hub.inventory(), // the trust surface: every tool incl. hidden, with baseline
      // The hub persists only after a connect that didn't throw (connected or needs-auth) - a failed
      // add (bad URL, unreachable server) is NOT saved and retried on every restart.
      add: (spec) => hub.connect(spec),
      remove: (name) => hub.remove(name),
      // Reclassify a tool (tighten-only - the hub/engine refuses to un-gate an outward tool). On
      // success the hub folds the new override into the keychain-persisted spec.
      setPolicy: (name, tool, kind) => {
        const r = hub.setPolicy(name, tool, kind);
        return { ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) };
      },
      finishAuth: (name, code, state) => hub.finishAuth(name, code, state),
    };

    // Reconcile the gateway's providers against installed packs: add a provider for every
    // installed pack whose MCP face is gateway-routable (DCR, not `direct`), and drop providers for
    // packs that were uninstalled. Only touches pack-derived providers (tracked in packProviderNames)
    // - source connectors the operator added are never removed here. Called at startup and on every
    // install/uninstall via the late-bound hook above.
    const packProviderNames = new Set<string>();
    syncGatewayProviders = async () => {
      const want = new Map<string, ReturnType<typeof packMcpProvider>>();
      for (const p of listPacks(catalogSource, config.roots)) {
        if (!p.installed) continue;
        if (packApiKeyPin(p, keychain)) continue; // API-key mode: direct-pinned with a Bearer header, not OAuth-routed
        const prov = packMcpProvider(p);
        if (prov) want.set(prov.name, prov);
      }
      const known = new Set(hub.persistedSpecs().map((s) => s.name));
      for (const [name, spec] of want) {
        packProviderNames.add(name);
        if (!known.has(name) && spec) {
          try { await gatewayView!.add(spec); }
          catch (e) { console.warn(`[gateway] pack provider "${name}" connect failed:`, e instanceof Error ? e.message : e); }
        }
      }
      for (const name of [...packProviderNames]) {
        if (!want.has(name)) { gatewayView!.remove(name); packProviderNames.delete(name); }
      }
    };

    // Host the gateway (token-authenticated, loopback-validated). Hand the host promise to the
    // lifecycle hook up front so a multi-org runner can await close() before rebinding this fixed
    // port on the next org. Then (fire-and-forget) refresh the agent's registration with THIS boot's
    // token (so a stale entry never lingers even with zero providers), reconnect keychain-persisted
    // providers, and reconcile pack providers.
    const gatewayHostP = startGatewayHttp(hub.connectorGateway, { port: gwPort, token: gatewayToken });
    config.onGatewayHost?.(gatewayHostP);
    gatewayHostP
      .then(async () => {
        writeGatewayRegistration(config.workspace, { url: gatewayUrl, headers: gatewayHeaders });
        await hub.restore(config.connectorsMcp!.providers);
        await syncGatewayProviders?.();
      })
      .catch(() => { /* host failed to bind - status stays empty */ });
  }

  // First-run welcome wizard: show it until the operator finishes/skips (a workspace-local marker,
  // like .automations.json - never synced), and detect the agent for the "connect your agent" step.
  // Agent detection stays behind the conductor bright-line: driver.detect() only shells `--version`.
  const onboardedMarker = join(config.workspace, ".onboarded");
  const onboarding = {
    state: async () => {
      const d = await driver.detect();
      return { firstRun: !existsSync(onboardedMarker), agent: { available: d.available, ...(d.version ? { version: d.version } : {}) } };
    },
    complete: () => {
      try {
        writeFileSync(onboardedMarker, "onboarded\n");
      } catch {
        /* best-effort - a failed marker just re-shows the wizard, never blocks the app */
      }
    },
  };

  const sessions = new FileSessionStore(join(config.workspace, ".sessions"));
  const projects = new FileProjectStore(join(config.workspace, ".projects.json"));

  // Automations: run a verb on a cadence. Definitions + last-run stamps live in a local file (like
  // the session store), so scheduling never churns the brain. Running a verb streams the agent into a
  // logged "Automations" session, exactly as a chat would - outward actions still hit the gate.
  const autoRoot = config.roots.find((r) => r.name !== "core") ?? config.roots[0];
  const autoYaml = join(autoRoot ? autoRoot.dir : config.workspace, "automations.yaml");
  // One-time lift of the legacy daemon-owned JSON into the committed brain file.
  migrateJsonToYaml(join(config.workspace, ".automations.json"), autoYaml);
  const automationStore = new AutomationDefStore(autoYaml);
  // Local-only run stamps (never committed) so the fallback timer de-dupes without polluting the
  // brain. Cloud-backed mode ignores this - the cloud owns run-state there.
  const localState = new AutomationStateFile(join(config.workspace, ".automations-state.json"));
  // In-flight guard: never let the scheduler tick and a manual "Run now" (or two ticks over a long
  // run) spawn overlapping agent runs of the same automation.
  const running = new Set<string>();
  const runVerbInSession = async (verb: string): Promise<{ sessionId: string }> => {
    const sessionId = sessions.create({ folder: "Automations", title: `Auto · ${verb}` });
    const prompt = "Use the `" + verb + "` skill.";
    sessions.append(sessionId, { kind: "text", text: prompt });
    sessions.setStatus(sessionId, "running");
    try {
      for await (const e of driver.runPrompt({ prompt, workspace: config.workspace, systemPromptAppend: workspaceHint() })) {
        if (e.kind === "done" && e.sessionId) sessions.setClaudeSessionId(sessionId, e.sessionId);
        sessions.append(sessionId, e);
      }
      sessions.setStatus(sessionId, "idle");
    } catch (err) {
      sessions.append(sessionId, { kind: "error", message: err instanceof Error ? err.message : String(err) });
      sessions.setStatus(sessionId, "error");
    }
    return { sessionId };
  };
  const stampIso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());
  const automations: AutomationEngine & { runDue(nowMs: number): Promise<string[]> } = {
    // `list` surfaces the next run from the LOCAL stamp (only meaningful in local-only mode; in
    // cloud mode the durable schedule lives server-side and this is a best-effort local view).
    list: () =>
      automationStore.list().map((d) => {
        const withStamp = { ...d, lastRun: stampIso(localState.get(d.name)) };
        return { ...d, nextRun: nextRunMs(withStamp, Date.now()) };
      }),
    add: (input) =>
      automationStore.add({
        name: input.name,
        verb: input.verb,
        cadence: input.cadence as Cadence,
        catchUp: (input as { catchUp?: CatchUp }).catchUp,
      }),
    toggle: (name) => {
      const a = automationStore.list().find((x) => x.name === name);
      if (!a) throw new Error(`automation not found: ${name}`);
      return automationStore.update(name, { enabled: !a.enabled });
    },
    remove: (name) => automationStore.remove(name),
    runNow: async (name) => {
      const a = automationStore.list().find((x) => x.name === name);
      if (!a) throw new Error(`automation not found: ${name}`);
      if (running.has(a.verb)) throw new Error(`automation already running: ${name}`);
      running.add(a.verb);
      try {
        const r = await runVerbInSession(a.verb);
        localState.set(name, Date.now());
        return r;
      } finally {
        running.delete(a.verb);
      }
    },
    // Local-only fallback timer: run any def whose local stamp says it's due.
    runDue: async (nowMs) => {
      const ran: string[] = [];
      for (const d of automationStore.list()) {
        const withStamp = { ...d, lastRun: stampIso(localState.get(d.name)) };
        if (!isDue(withStamp, nowMs) || running.has(d.verb)) continue;
        running.add(d.verb);
        try {
          await runVerbInSession(d.verb);
          localState.set(d.name, nowMs);
          ran.push(d.name);
        } catch {
          /* a failed run leaves the stamp untouched - it retries next tick */
        } finally {
          running.delete(d.verb);
        }
      }
      return ran;
    },
  };
  // The scheduler: a cloud-backed drain loop when a sync worker is configured, else the local-only
  // fallback timer (opt-in via config; the demo sets one of these, tests omit both so no timer leaks).
  if (config.automationsSync) {
    const client = new AutomationsClient({ baseUrl: config.automationsSync.baseUrl, token: config.automationsSync.token });
    const source: DrainSource = {
      listDue: () => client.listDue(),
      claim: (id) => client.claim(id),
      report: (id, r) => client.report(id, r),
      heartbeat: (id) => client.heartbeat(id),
    };
    const timer = setInterval(
      () => void drainOnce({ source, runVerb: runVerbInSession, running }).catch(() => {}),
      config.drainIntervalMs ?? config.schedulerIntervalMs ?? 60_000,
    );
    timer.unref?.();
  } else if (config.schedulerIntervalMs && config.schedulerIntervalMs > 0) {
    const timer = setInterval(() => void automations.runDue(Date.now()).catch(() => {}), config.schedulerIntervalMs);
    timer.unref?.();
  }
  const fileTree = (): TreeNode[] => config.roots.map((r) => ({ name: r.name, path: r.name, type: "dir" as const, children: treeOf(r.dir, r.name) }));

  // The derived agent surface (Files panel → "Show agent files"). Attribute pack skills by the union
  // of declared skill names across INSTALLED packs, so linked skills that came from an app pack are
  // badged as such. Deterministic (invariant #9); recomputed per request off disk.
  const agentView = () => {
    const packSkills = new Set<string>();
    for (const p of listPacks(catalogSource, config.roots)) if (p.installed && p.skills) for (const s of p.skills) packSkills.add(s);
    return buildAgentView(config.workspace, packSkills);
  };

  // Bottom status strip - the real Claude subscription usage (opt-in; a documented bright-line
  // exception, see usage.ts). Cached 15 min; `force` (the manual-refresh button) bypasses it.
  // Anthropic's usage window only moves slowly, so we refresh rarely rather than poll.
  const usageConfigDir = config.agentConfigDir ?? join(homedir(), ".claude");
  const usageReader = nodeTokenReader(usageConfigDir);
  const usageCall = anthropicUsageCall();
  const USAGE_TTL_MS = 15 * 60_000;
  let usageCache: UsageReport | null = null;
  let usageInFlight: Promise<UsageReport> | null = null;
  const usageFn = async (force = false): Promise<UsageReport> => {
    if (!config.usageOAuth) return { segments: [], at: Date.now(), ok: false, note: "Usage read-out is off" };
    if (!force && usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache;
    if (usageInFlight) return usageInFlight; // collapse concurrent refreshes
    usageInFlight = fetchUsage({ readToken: usageReader, call: usageCall, now: Date.now })
      .then((r) => {
        usageCache = r;
        return r;
      })
      .finally(() => {
        usageInFlight = null;
      });
    return usageInFlight;
  };

  return createDaemon({
    workspace: config.workspace,
    roots: config.roots,
    gate,
    broker,
    appBus,
    appCatalog,
    appStore,
    packStore,
    appServe: (urlPath) => serveApp(config.roots, urlPath),
    appData: (r) => brokerData(config.roots, r),
    usageFn,
    vault,
    saveDoc,
    catalog,
    skillEditor,
    automations,
    connectorHub,
    ...(gatewayView ? { gatewayView } : {}),
    sessions,
    projects,
    fileTree,
    agentView,
    onboarding,
    ...(config.company ? { company: config.company } : {}),
    ...(config.webRoot ? { webRoot: config.webRoot } : {}),
    runPrompt: (opts) =>
      touchAfterRun(
        driver.runPrompt({
          prompt: applyEffort(opts.prompt, opts.effort),
          workspace: config.workspace,
          // The workspace map is always appended; a client-supplied append (e.g. "you're working with
          // the Protocol app - its tools + skills are loaded") is added after it, invisibly - it steers
          // the turn without appearing as a user message in the transcript.
          systemPromptAppend: [workspaceHint(), opts.systemPromptAppend].filter(Boolean).join("\n\n"),
          ...(opts.resume ? { resume: opts.resume } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
      ),
    buildMap: () => buildGraph(config.roots),
    // "Learning" surface for the Brain view: recent commits in the writable brain repo (the
    // decisions accruing over time). Read-only; falls back to the first root if none is writable.
    recentChanges: () => {
      const root = config.roots.find((r) => r.name !== "core") ?? config.roots[0];
      return root ? recentChanges(root.dir, 12) : [];
    },
    // Manual/forced sync (POST /api/sync) - flush the whole loop now (regen + every writable repo).
    syncFn: async () => {
      const s = await scheduler.flushNow();
      return s === "needs-help" ? "needs-help" : s === "queued" ? "queued" : s === "local" ? "local" : "ok";
    },
    // The dot's live status (GET /api/sync) - "local" (no account yet) / "queued" (offline) /
    // "needs-help" (conflict backed up).
    syncStatus: () => lastSyncStatus,
  });
}

/** Map a composer "effort" choice to a thinking directive appended to the prompt. Claude Code has no
 *  effort flag; the honest lever is the thinking keywords it recognizes ("think" / "think harder"). */
function applyEffort(prompt: string, effort?: string): string {
  if (effort === "think") return `${prompt}\n\nThink about this carefully before you answer.`;
  if (effort === "think-harder") return `${prompt}\n\nThink harder - reason very thoroughly before you answer.`;
  return prompt;
}

/** The starter local app - a minimal dashboard that reads a workspace file via the buildex bridge. */
function starterAppHtml(title: string): string {
  const e = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return `<!doctype html><meta charset="utf-8"><title>${e(title)}</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;color:#1a1a1a}h1{font-size:1.4rem}pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow:auto}</style>
<h1>${e(title)}</h1>
<p>This is a starter app. It reads a file from your workspace through the buildex bridge:</p>
<pre id="out">loading…</pre>
<script>
  buildex.read("README.md").then(t => { document.getElementById("out").textContent = t || "(no README.md yet)"; })
    .catch(e => { document.getElementById("out").textContent = "read failed: " + e; });
</script>`;
}

/** Resolve a workspace-relative doc path, refusing anything that escapes the workspace.
 *  Confinement (separator-safe, symlink-safe) lives in lib/confine-path - the one implementation. */
function resolveInWorkspace(workspace: string, path: string): string {
  const full = confinePath(workspace, path);
  if (full === null) throw new Error(`path escapes workspace: ${path}`);
  return full;
}

/** Resolve `rel` inside `dir`, refusing anything that escapes it (path-traversal guard). */
function resolveWithin(dir: string, rel: string): string {
  const full = confinePath(dir, rel);
  if (full === null) throw new Error(`path escapes repo: ${rel}`);
  return full;
}

/** Map "team/notes.md" → the repo dir for "team" + the in-repo relative path. */
function splitRepoPath(roots: Root[], path: string): { repoDir?: string; rel: string } {
  const slash = path.indexOf("/");
  if (slash === -1) return { rel: path };
  const rootName = path.slice(0, slash);
  const rel = path.slice(slash + 1);
  const root = roots.find((r) => r.name === rootName);
  return root && existsSync(root.dir) ? { repoDir: root.dir, rel } : { rel };
}

const TREE_IGNORE = new Set([".git", ".conflicts", ".sessions", ".agent", ".claude", "node_modules"]);

/** Build a file tree for a repo, prefixing paths with the root name (matches the vault's ids). */
function treeOf(dir: string, prefix: string): TreeNode[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || TREE_IGNORE.has(name)) continue;
    const abs = join(dir, name);
    const rel = `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) {
      nodes.push({ name, path: rel, type: "dir", children: treeOf(abs, rel) });
    } else {
      nodes.push({ name, path: rel, type: "file" });
    }
  }
  // dirs first, then files, each alphabetical
  return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

/** The verbs available in the workspace, read from the generated .claude/skills links. */
function listSkills(skillsDir: string): { name: string; description: string }[] {
  if (!existsSync(skillsDir)) return [];
  const out: { name: string; description: string }[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const md = join(skillsDir, name, "SKILL.md");
    if (!existsSync(md)) continue;
    const fm = readFileSync(md, "utf8").match(/^---\n([\s\S]*?)\n---/);
    const desc = fm ? (fm[1]!.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "") : "";
    out.push({ name, description: desc });
  }
  return out;
}

/** Connectors filing into the workspace, discovered from sources/<name>/ with freshness from STATUS.md. */
function listConnectors(roots: Root[]): { name: string; status: string; lastSync?: string }[] {
  const out: { name: string; status: string; lastSync?: string }[] = [];
  for (const root of roots) {
    const sourcesDir = join(root.dir, "sources");
    if (!existsSync(sourcesDir)) continue;
    for (const name of readdirSync(sourcesDir).sort()) {
      const dir = join(sourcesDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const statusPath = join(dir, "STATUS.md");
      let lastSync: string | undefined;
      if (existsSync(statusPath)) {
        lastSync = readFileSync(statusPath, "utf8").match(/Last sync:\s*(.+)/)?.[1]?.trim();
      }
      out.push({ name, status: lastSync ? "synced" : "filed", ...(lastSync ? { lastSync } : {}) });
    }
  }
  return out;
}
