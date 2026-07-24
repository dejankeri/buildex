// The client composition root (the single place every module is wired together - the pattern the
// prototype called buildDeps). Both the headless entry and the Electron shell build the daemon
// through this, so there is one assembly of driver + gate + sync + brain + mini-apps.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { confinePath } from "./lib/confine-path.js";
import { createDaemon, type Handler, type VaultReader, type Catalog, type TreeNode, type SkillEditor, type LoopsEngineControl, type ConnectorControl, type ConnectorGatewayView } from "./daemon/daemon.js";
import { startGatewayHttp, writeGatewayRegistration, writeMcpEntries } from "@buildex/connectors";
import { ConnectorGatewayHub, brokerApprover } from "./brain/connector-gateway.js";
import { readSkill, writeSkillFile, composeSkill, validateSkill, skillTemplate, originOf } from "./brain/skills.js";
import { listApps, writeAppManifest, type AppManifest } from "./brain/apps.js";
import { reconciledPackMcpEntries, composePreset } from "./brain/pack-config.js";
import { listPacks, installPack, uninstallPack, packMcpProvider, packApiKeyPin, apiKeyKeychainKey, provisionKeychainKey, provisionBaseKeychainKey, provisionAuthHeaders, slotOf, type InstallDeps } from "./brain/catalog.js";
import { ProvisionFlow } from "./brain/provision.js";
import { startProvisionProxy } from "./brain/provision-proxy.js";
import { emptyCatalogSource, type CatalogSource } from "./brain/catalog-source.js";
import { buildAgentView } from "./brain/agent-view.js";
import { ActivityLedger } from "./brain/ledger.js";
import { serveApp, brokerData } from "./server/app-serve.js";
import { brokerAppFetch, setAppSecret } from "./server/app-fetch.js";
import { LoopDefStore, LoopStateFile, migrateAutomationsYaml, parseScheduleInput, type LoopDef, type LoopSchedule } from "./brain/loops.js";
import { LoopsEngine, type StartedRun, type RunOutcome } from "./brain/loops-engine.js";
import { LoopRunsFile } from "./brain/loops-runs.js";
import { ConnectorHub } from "./brain/connectors.js";
import { createKeychain } from "./keychain/keychain.js";
import { FileSessionStore } from "./daemon/sessions.js";
import { FileProjectStore } from "./daemon/projects.js";
import { Gate } from "./gate/gate.js";
import { PolicyEngine, type PolicyPreset } from "./gate/policy.js";
import { ApprovalBroker, GATE_CARD_TTL_MS, type ApprovalCard, type CardOrigin } from "./gate/approval.js";
import { describeTool } from "./gate/describe.js";
import { ClaudeCodeDriver, type SpawnAgent } from "./agent/claude-driver.js";
import { nodeSpawnAgent } from "./agent/node-spawn.js";
import type { UiEvent } from "./agent/types.js";
import { buildGraph, type Root } from "./brain/graph.js";
import { recentChanges } from "./brain/history.js";
import { fileHistory, fileAtCommit } from "./brain/history.js";
import { SyncEngine } from "./sync/engine.js";
import { Conflicts } from "./sync/conflicts.js";
import {
  SyncScheduler,
  saveResultStatus,
  type Clock,
  type TimerHandle,
  type SyncStatus,
} from "./sync/scheduler.js";
import { unsavedAcross, isStale } from "./sync/unsaved.js";
import { generateAgentConfig } from "./brain/agent-config.js";
import { AppBus } from "./miniapp/app-bus.js";
import { fetchUsage, nodeTokenReader, anthropicUsageCall, type UsageReport } from "./brain/usage.js";
import { AccountStore } from "./account/account-store.js";
import { makeTokenProvider } from "./account/token-provider.js";
import { gitAuthEnv } from "./account/credentials.js";
import { openAccount as runOpenAccount, persistAndAttach } from "./account/open-account.js";
import { disconnect as runDisconnect } from "./account/disconnect.js";
import { signIn as runSignIn } from "./account/sign-in.js";
import { signUpAnonymous } from "./account/anonymous.js";
import { postSession } from "./account/session-client.js";
import { openBrowser, realLoopbackServer, realSupabaseAuthClient, randomState, pkce } from "./account/real-seams.js";

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
  /** If set (>0), start the loop scheduler on this interval (ms). Omit in tests - no timer leaks. */
  schedulerIntervalMs?: number;
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
  /** Lifecycle hook for the provision-proxy loopback host (the sibling of `onGatewayHost` above):
   *  called (once, synchronously) with a promise for the running host as soon as it's launched, so a
   *  runner can await it (tests) or `close()` it on teardown. The promise rejects if the host fails
   *  to bind; the caller catches. Only fires when the catalogue ships a pack with an escape-hatch
   *  (provision) face - most boots wire none and start no host at all. */
  onProvisionHost?: (host: Promise<{ url: string; close: () => Promise<void> }>) => void;
  /** Injected agent spawn (defaults to the real node process spawn). The seam that lets a test
   *  capture the exact environment the agent is started with, hermetically - no child process runs. */
  spawnAgent?: SpawnAgent;
  /** Lifecycle hook for the approval broker: called (once, synchronously) with the broker the moment
   *  it's built. The demo runner uses it to seed one real outward-action card in-process - exactly the
   *  path the connector gateway takes for a gated send - so the flagship human gate (invariant 5) is
   *  visible the instant the demo opens. Omit everywhere else; nothing in production seeds cards. */
  onBroker?: (broker: ApprovalBroker) => void;
  /** Per-connector OAuth client credentials for the FILE connectors, runtime-injected from env
   *  (e.g. BUILDEX_GMAIL_CLIENT_ID) and NEVER committed. Absent → that connector stays fixture/apikey. */
  connectorsOAuth?: Record<string, { clientId: string; clientSecret?: string }>;
  /** Keychain backend. "memory" (default) - ephemeral, for tests/embedders; "auto" - persist to
   *  the OS keychain on macOS when available, else in-memory; "system" - require the OS keychain. */
  keychainMode?: "auto" | "system" | "memory";
  /** Daemon base URL for the file-connector OAuth loopback redirect. Default http://127.0.0.1:4317. */
  connectorsRedirectBase?: string;
  /** The active org's id. Present together with `orgDir` only once an org exists to hold an account
   *  (see orgs/router.ts) - both absent means a local-only boot (most tests, the demo), which builds
   *  the sync engine with no `auth` at all, exactly as before this seam existed. */
  orgId?: string;
  /** The active org's own directory (holds `account.json`; see account/account-store.ts). */
  orgDir?: string;
  /** Injected fetch for the account seam's provision/refresh calls - defaults to global `fetch` so
   *  tests can hand in a fake and stay hermetic (no real network in unit lanes). */
  fetch?: typeof fetch;
  /** Whether the active org is the local-only demo sandbox - it can never attach an account
   *  (see account/attach.ts). Populated from `org.sandbox` in orgs/router.ts. */
  sandbox?: boolean;
  /** Supabase project config for the browser OAuth sign-in seam (Task 10). Absent is the DEFAULT
   *  today (the owner hasn't configured Supabase yet) - it keeps `signIn` unwired and
   *  `POST /api/signin` dormant (501), exactly like an absent `orgId`/`orgDir` keeps `openAccount`
   *  unwired. `url`/`anonKey` are the Supabase project's OAuth endpoint + public anon key (anon keys
   *  are public by Supabase's design - RLS enforces access - so this is not a secret); `baseUrl` is
   *  BuildEx's OWN sync server, the same one `/api/account`'s setup-token flow talks to (its
   *  `POST /session` trades the Supabase JWT for the machineToken/refreshToken/repos triple). */
  supabase?: { url: string; anonKey: string; baseUrl: string };
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
  // The company activity ledger (invariant 5): every gated moment the broker below resolves -
  // approve, deny, TTL auto-deny - is appended to activity/YYYY-MM.md in the TEAM brain, so it
  // commits and syncs like any other brain file. Optional like the other team-root-scoped deps: a
  // boot without a team root (most unit tests) builds no ledger and the broker records nothing.
  // The touch schedules the debounced commit; it runs only at resolution time, well after the
  // scheduler below is assigned (the same late-reference pattern saveDoc uses).
  const ledgerRoot = config.roots.find((r) => slotOf(r.name) === "team");
  const ledger = ledgerRoot ? new ActivityLedger({ dir: ledgerRoot.dir, now: Date.now }) : undefined;
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
    ...(ledger && ledgerRoot
      ? { ledger: { record: (e) => { ledger.record(e); scheduler.touch(ledgerRoot.dir); } } }
      : {}),
  });
  config.onBroker?.(broker);
  const gate = new Gate(new PolicyEngine(composePreset(config.preset, config.roots)), broker);
  // Allowlist the model aliases the composer can request (the --model security boundary), and pin
  // Sonnet 5 as BuildEx's default so an unspecified model never falls through to the `claude` CLI's
  // own default. The CLI resolves each alias to its current release (sonnet ⇒ Sonnet 5, etc.).
  // Late-bound so the driver can be built here while the keychain + catalog are wired below. Read
  // fresh on every run, so a credential the operator provisions mid-session works without a restart.
  let provisionedEnv: () => NodeJS.ProcessEnv = () => ({});
  const driver = new ClaudeCodeDriver({ spawn: config.spawnAgent ?? nodeSpawnAgent, bin: config.claudeBin, allowedModels: ["opus", "sonnet", "haiku", "fable"], defaultModel: "sonnet", extraEnv: () => provisionedEnv(), ...(config.agentConfigDir ? { configDir: config.agentConfigDir } : {}) });
  const appBus = new AppBus({ idFactory: randomUUID });
  // The writable (non-core) repo dirs - the only roots the sync loop may commit to (core is read-only).
  const writableDirs = (): string[] => config.roots.filter((r) => slotOf(r.name) !== "core").map((r) => r.dir);
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

  // --- The Files panel's create/delete surface -------------------------------------------------
  // The operator organises their own brain from the console: new folder, new document, upload, and
  // delete. Every op resolves through the SAME confinement as reads (splitRepoPath + resolveWithin)
  // and then commits via the scheduler, so a file created here is a git commit like any other.
  //
  // Three refusals, all deliberate:
  //  - `core` is the shared BuildEx library: it ships with the app and is regenerated, so a write
  //    there would be silently reverted. Better to say no than to lose the operator's work.
  //  - a repo root itself is never deletable - that's an org-level act, not a file-manager one.
  //  - names starting with "." are refused: the tree hides dotfiles, so such a file would vanish
  //    the instant it was created (invariant #8 - never leave the operator's work invisible).
  const fsTarget = (docPath: string): { repoDir: string; rel: string; full: string } => {
    const { repoDir, rel } = splitRepoPath(config.roots, docPath);
    if (!repoDir) throw new Error(`path must be inside a repo (e.g. team/notes.md): ${docPath}`);
    if (!rel) throw new Error("that is a repo, not a file or folder inside one");
    if (docPath.split("/")[0] === "core") throw new Error("the shared BuildEx library is read-only");
    if (rel.split("/").some((seg) => seg.startsWith("."))) throw new Error("names cannot start with a dot");
    return { repoDir, rel, full: resolveWithin(repoDir, rel) };
  };
  const fsOps = {
    /** Create a folder. A `.gitkeep` goes with it: git tracks files, not directories, so without one
     *  an empty folder would exist locally and be gone on the next machine that syncs. */
    mkdir: (path: string): void => {
      const { repoDir, full } = fsTarget(path);
      if (existsSync(full)) throw new Error("that already exists");
      mkdirSync(full, { recursive: true });
      writeFileSync(join(full, ".gitkeep"), "");
      scheduler.touch(repoDir);
    },
    /** Create a file. Refuses to overwrite - creating is never destructive; editing is a separate act.
     *  `base64` carries an upload's bytes; otherwise `content` is written as text. */
    create: (path: string, content: string, base64?: string): void => {
      const { repoDir, full } = fsTarget(path);
      if (existsSync(full)) throw new Error("that already exists");
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, base64 != null ? Buffer.from(base64, "base64") : content);
      scheduler.touch(repoDir);
    },
    /** Delete a file or a whole folder. The commit that follows is the undo: the content stays in
     *  git history, so "delete" here is never the last copy going away. */
    remove: (path: string): void => {
      const { repoDir, full } = fsTarget(path);
      if (!existsSync(full)) throw new Error("that no longer exists");
      rmSync(full, { recursive: true, force: true });
      scheduler.touch(repoDir);
    },
  };

  const catalog: Catalog = {
    skills: () => listSkills(config.workspace, config.roots),
    rules: () => listRules(config.roots),
    connectors: () => listConnectors(config.roots),
  };

  // Keychain (created before regenConfig so pack MCP re-pinning can read stored API keys). Persistence
  // is opt-in via config so tests/embedders never touch the real OS keychain; the demo sets
  // keychainMode:"auto" so a real authorization survives a daemon restart.
  const keychain = createKeychain({ mode: config.keychainMode ?? "memory", workspace: config.workspace });

  // The account seam: an AccountStore only exists once the active org has both an id and a dir (see
  // orgs/router.ts) - most boots (unit tests, the demo, an org that hasn't opened an account yet)
  // supply neither, so `account`/`tokenProvider`/`engineAuth` stay undefined and the engine below is
  // built LOCAL-ONLY, exactly as it was before this seam existed. `fetchImpl` isolates the injected
  // fetch (tests hand in a fake) from the global one (production).
  const fetchImpl = config.fetch ?? fetch;
  const account =
    config.orgId && config.orgDir ? new AccountStore({ orgId: config.orgId, orgDir: config.orgDir, keychain }) : undefined;
  const tokenProvider = account ? makeTokenProvider({ store: account, fetch: fetchImpl }) : undefined;
  const engineAuth = tokenProvider
    ? {
        headerEnv: () => {
          const t = tokenProvider.current();
          return t ? gitAuthEnv(t) : undefined;
        },
        onAuthError: () => tokenProvider.rotate(),
      }
    : undefined;
  // Moved here (was constructed right after appBus, before the keychain existed) so the engine can
  // carry `auth` from day one instead of being retrofitted after the fact - nothing between the old
  // and new construction points reads `sync` before this line.
  const sync = new SyncEngine({ now: Date.now, actor, ...(engineAuth ? { auth: engineAuth } : {}) });

  // Daemon deps for the account seam - assembled here (needs `account`/`sync`/`fetchImpl`, all just
  // built above) so Task 8's daemon routes have a ready provision→attach flow and state reader to
  // plug in. NOT yet passed to createDaemon below: DaemonDeps gains `openAccount`/`accountState` in
  // Task 8 alongside the /api/account routes that consume them - adding the keys here without the
  // matching DaemonDeps fields would fail the strict object-literal excess-property check against
  // daemon.ts's current (pre-Task-8) shape. Harmless either way: unused until Task 8 wires them in.
  const openAccount = account
    ? (input: { baseUrl: string; setupToken: string }): Promise<{ state: "connected" | "needs-help" }> =>
        runOpenAccount(
          { fetch: fetchImpl, account, engine: sync, roots: config.roots, sandbox: config.sandbox ?? false, machineName: hostname() },
          input,
        )
    : undefined;
  const accountState = (): { state: "local" | "connected"; operatorId?: string; companySlug?: string; remotes?: { core: string; team: string; private: string } } => {
    const a = account?.load();
    return a ? { state: "connected", operatorId: a.operatorId, companySlug: a.companySlug, remotes: a.repos } : { state: "local" };
  };
  // Local disconnect (Task 2): the reverse of openAccount - detach every root's remote and clear the
  // account store, reverting to a clean local-only state while keeping git history (invariant 8).
  // Gated identically to openAccount/accountState (an account store must exist - absent for the
  // sandbox, which has nothing to disconnect), reusing the SAME `sync` engine and `account` store
  // those closures already read from above. Absent, `logout` stays undefined and `POST /api/logout`
  // is simply unwired (falls through to the daemon's terminal 404) - a normal boot is unaffected.
  const logout = account
    ? (): Promise<{ state: "local" }> => runDisconnect({ engine: sync, account, roots: config.roots })
    : undefined;
  // The browser sign-in→attach chain (Task 10): system-browser OAuth via Supabase (sign-in.ts), then
  // the SAME postSession→persistAndAttach tail the setup-token flow above ends in. Gated on an account
  // seam (org id+dir - openAccount's own precondition), a Supabase project config, AND a non-sandbox
  // org - absent any, `signIn` stays undefined and `/api/signin` stays dormant (501). The sandbox gate
  // matters because `signInAvailable` (the console's sign-in CTAs) is exactly `!!deps.signIn`: without
  // it a Supabase-configured build would advertise sign-in on the local-only sandbox and then throw at
  // call time (the sandbox can never attach). This is the DEFAULT today when Supabase is unconfigured,
  // so a normal boot is unaffected. Captured into local consts (`acc`/`supabaseCfg`) once, here, rather
  // than re-checked inside the closure - the one narrowing TypeScript can't carry through a later-called
  // async closure.
  const signIn: (() => Promise<{ state: "connected" | "needs-help" }>) | undefined = (() => {
    if (!account || !config.supabase || config.sandbox) return undefined;
    const acc = account;
    const supabaseCfg = config.supabase;
    return async (): Promise<{ state: "connected" | "needs-help" }> => {
      // Refuse a sandbox org BEFORE ever opening the OAuth browser. persistAndAttach below also
      // self-guards, but only after a real browser round-trip and a spent authorization code; failing
      // here is cheaper and a sandbox org never even sees a browser window launch (see open-account.ts
      // for why persist-then-attach itself guards this early too - belt and suspenders).
      if (config.sandbox) throw new Error("the sandbox org is local-only and cannot attach an account");
      const { jwt } = await runSignIn(
        {
          openBrowser,
          loopback: realLoopbackServer(),
          supabase: realSupabaseAuthClient({ supabaseUrl: supabaseCfg.url, anonKey: supabaseCfg.anonKey, fetch: fetchImpl }),
          now: Date.now,
          randomState,
          pkce,
        },
        {},
      );
      const result = await postSession({ fetch: fetchImpl, baseUrl: supabaseCfg.baseUrl }, { jwt, machineName: hostname() });
      return persistAndAttach(
        { account: acc, engine: sync, roots: config.roots, sandbox: config.sandbox ?? false },
        supabaseCfg.baseUrl,
        result,
      );
    };
  })();
  // Anonymous onboarding (Task 4): the operator never leaves the app - an anonymous Supabase user is
  // minted no-browser (signUpAnonymous), then handed to the SAME postSession→persistAndAttach tail as
  // `signIn` above. Gated identically (account seam + Supabase project config + non-sandbox org);
  // absent any, `onboard` stays undefined and `/api/onboard` stays dormant (501) - the default today.
  // The sandbox gate keeps the local-only Acme sandbox from firing the onboarding dialog it can't fulfil.
  const onboard: ((input: { companyName: string }) => Promise<{ state: "connected" | "needs-help" }>) | undefined = (() => {
    if (!account || !config.supabase || config.sandbox) return undefined;
    const acc = account;
    const supabaseCfg = config.supabase;
    return (input: { companyName: string }): Promise<{ state: "connected" | "needs-help" }> =>
      signUpAnonymous(
        {
          supabase: realSupabaseAuthClient({ supabaseUrl: supabaseCfg.url, anonKey: supabaseCfg.anonKey, fetch: fetchImpl }),
          account: acc,
          engine: sync,
          roots: config.roots,
          sandbox: config.sandbox ?? false,
          fetch: fetchImpl,
          baseUrl: supabaseCfg.baseUrl,
          machineName: hostname(),
        },
        input,
      );
  })();
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

  // Kept-work recovery: the surface over the engine's `.conflicts/<stamp>/` backups, scoped to the
  // writable roots (core is reset without backup - it has no operator work to keep).
  const conflicts = new Conflicts({
    roots: config.roots.filter((r) => slotOf(r.name) !== "core").map((r) => ({ name: r.name, dir: r.dir })),
  });

  // Now that regenConfig exists, build the background sync loop and hand it to the runner (start/stop).
  // The latest status drives the header dot via GET /api/sync (needs-help when a conflict was backed up).
  // Seeded from the on-disk attention marker, not a blank "ok": a conflict kept before the last
  // shutdown must still show as needing help on the next boot - the marker is what persists it.
  let lastSyncStatus: SyncStatus = conflicts.hasAttention() ? "needs-help" : "ok";
  scheduler = new SyncScheduler({
    engine: sync,
    writableRoots: writableDirs,
    readonlyRoots: () => config.roots.filter((r) => slotOf(r.name) === "core").map((r) => r.dir),
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
      // A local app's manifest declares no grants: reads are its own folder (always), egress and
      // secrets start closed - the author adds `origins`/`secrets` when the app needs them.
      const manifest: AppManifest =
        input.kind === "external"
          ? { ...(input.title ? { name: input.title } : {}), ...(input.icon ? { icon: input.icon } : {}), kind: "external", url: input.url ?? "" }
          : { ...(input.title ? { name: input.title } : {}), ...(input.icon ? { icon: input.icon } : {}), kind: "local" };
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
  /** Schedule a commit+push for each named root (real repo names, duplicates and absentees ignored). */
  const touchRoots = (...names: Array<string | undefined>): void => {
    for (const name of [...new Set(names)]) {
      const root = name ? config.roots.find((r) => r.name === name) : undefined;
      if (root) scheduler.touch(root.dir);
    }
  };
  // Late-bound (assigned in the connector-gateway block below, which is set up after packStore): when
  // a pack with a gateway-routable MCP face is installed/removed, reconcile the gateway's providers so
  // its tools connect (or leave) immediately. Undefined when the gateway is off - then packs fall back
  // to the direct pin, unchanged.
  let syncGatewayProviders: (() => void | Promise<void>) | undefined;
  // The escape-hatch flow: a browser round-trip that mints a credential the MCP connection can't carry.
  // Never runs at install - the operator grants it when the work needs it (see PackProvision).
  const provisionFlow = new ProvisionFlow({
    fetch: (...a: Parameters<typeof fetch>) => fetchImpl(...a),
    host: () => hostname().replace(/[^A-Za-z0-9-]/g, "-"),
  });
  const provisionRedirectBase = config.connectorsMcp?.redirectBase ?? "http://127.0.0.1:4317";
  // The provision proxy: the daemon keeps custody of every provisioned credential and the agent
  // calls THROUGH it. Handing the key itself to the agent's environment would let any shelled
  // process read it and call the provider directly - past the approval gate that makes wide
  // autonomy safe (invariant 5) - so the key never leaves the keychain except here, per request,
  // after the gate. Same hardening as the connector gateway host (per-boot bearer, loopback
  // Host/Origin); reads pass, every other method raises the same approval card a gated gateway
  // tool does (brokerApprover). Ephemeral port: the URL rides the agent's per-run env (below),
  // never a config file, so nothing needs it stable across boots. Only started when the catalogue
  // ships a provision-capable pack - most boots (and almost all tests) start no host at all.
  let provisionProxy: { url: string; token: string } | undefined;
  if (listPacks(catalogSource, config.roots).some((p) => p.provision)) {
    const provisionToken = randomBytes(24).toString("base64url");
    const provisionHostP = startProvisionProxy({
      token: provisionToken,
      fetch: fetchImpl,
      approve: brokerApprover(broker),
      // Resolved per request, so a fresh grant (or a revoke) takes effect on the next call. The
      // forwarding base is the API base the provider issued alongside the key (stored beside it in
      // the keychain); without one there is nowhere to forward, so the pack 404s at the proxy.
      resolve: (id) => {
        const p = listPacks(catalogSource, config.roots).find((x) => x.id === id);
        if (!p?.provision || !p.installed) return undefined;
        const key = keychain.get(provisionKeychainKey(id));
        const base = keychain.get(provisionBaseKeychainKey(id));
        if (!key || !base) return undefined;
        return { baseUrl: base, headers: provisionAuthHeaders(p.provision, key) };
      },
    });
    config.onProvisionHost?.(provisionHostP);
    provisionHostP
      .then((h) => { provisionProxy = { url: h.url, token: provisionToken }; })
      .catch(() => { /* host failed to bind - the env simply never points at a proxy */ });
  }
  // The environment a provisioned pack contributes to the agent - and what it deliberately does
  // NOT contribute: the credential itself never appears here (the daemon attaches it at the proxy
  // above). The agent gets the non-secret API base plus where the proxy is - BUILDEX_PROVISION_URL
  // and the per-boot BUILDEX_PROVISION_TOKEN, which grants only gated proxy access (the same trust
  // class as the gateway bearer in .mcp.json). Read from the keychain on each call so a fresh grant
  // (or a revoke) takes effect on the next prompt, not the next restart.
  provisionedEnv = () => {
    const env: NodeJS.ProcessEnv = {};
    let provisioned = false;
    for (const p of listPacks(catalogSource, config.roots)) {
      if (!p.provision || !p.installed) continue;
      if (!keychain.get(provisionKeychainKey(p.id))) continue;
      provisioned = true;
      const base = p.provision.envBase ? keychain.get(provisionBaseKeychainKey(p.id)) : undefined;
      if (p.provision.envBase && base) env[p.provision.envBase] = base;
    }
    if (provisioned && provisionProxy) {
      env["BUILDEX_PROVISION_URL"] = provisionProxy.url;
      env["BUILDEX_PROVISION_TOKEN"] = provisionProxy.token;
    }
    return env;
  };
  const packStore = {
    list: () => listPacks(catalogSource, config.roots).map((p) => ({
      ...p,
      ...(p.apiKey && keychain.get(apiKeyKeychainKey(p.id)) ? { apiKeyConnected: true } : {}),
      ...(p.provision && keychain.get(provisionKeychainKey(p.id)) ? { provisioned: true } : {}),
    })),
    /** Start the escape-hatch grant: mint a one-time state and hand back the provider's consent URL
     *  plus what the operator is about to grant. Nothing is stored until the callback completes. */
    beginProvision: (id: string) => {
      const pack = listPacks(catalogSource, config.roots).find((p) => p.id === id);
      if (!pack?.provision) throw new Error(`pack "${id}" has no escape-hatch connection`);
      if (!pack.installed) throw new Error(`install "${id}" before granting it extra access`);
      return provisionFlow.begin(id, pack.provision, provisionRedirectBase);
    },
    /** Finish it from the loopback callback: validate + consume the state, exchange the single-use
     *  code server-to-server, and store the credential in the keychain (never the repo). */
    finishProvision: async (id: string, params: URLSearchParams) => {
      const pack = listPacks(catalogSource, config.roots).find((p) => p.id === id);
      if (!pack?.provision) throw new Error(`pack "${id}" has no escape-hatch connection`);
      const res = await provisionFlow.finish(id, pack.provision, params);
      keychain.set(provisionKeychainKey(id), res.key);
      if (res.apiBase) keychain.set(provisionBaseKeychainKey(id), res.apiBase);
      return { id, name: pack.name };
    },
    /** Drop a provisioned credential locally. The provider's own key is NOT revoked - say so in the UI
     *  rather than implying this undoes the grant. */
    clearProvision: (id: string) => {
      keychain.delete(provisionKeychainKey(id));
      keychain.delete(provisionBaseKeychainKey(id));
    },
    install: (id: string) => {
      const res = installPack(catalogSource, config.roots, { id }, installDeps);
      regenConfig();
      void syncGatewayProviders?.(); // register the pack's MCP as a gateway provider
      // An install now writes to TWO roots (the app face to private, the company rules to team), so
      // both are scheduled. Match on the REAL root names installPack returns, never on the slot the
      // caller used: a provisioned workspace names its roots "team-acme"/"private-you", so a slot
      // lookup found nothing and the install silently missed its commit+push until the next pull tick.
      touchRoots(res.target, res.rulesTarget); // debounced commit+push of the new app/skill/policy files
      return res;
    },
    uninstall: (id: string, target: string) => {
      const res = uninstallPack(catalogSource, config.roots, { id, target }, installDeps);
      regenConfig();
      void syncGatewayProviders?.(); // drop the pack's gateway provider
      touchRoots(res.target);
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
        if (!spec) continue;
        if (known.has(name)) {
          // Already connected: re-apply the catalog's current baseline. The baseline is never
          // persisted, so this is the path by which a pack update that TIGHTENS a gate reaches a
          // provider the operator connected before the update - a security fix must not wait for a
          // reconnect. The operator's own overrides are untouched.
          hub.setBasePolicy(name, spec.basePolicy);
          continue;
        }
        try { await gatewayView!.add(spec); }
        catch (e) { console.warn(`[gateway] pack provider "${name}" connect failed:`, e instanceof Error ? e.message : e); }
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

  // Loops: a prompt (or a verb) the operator schedules to run on its own. Definitions live in a
  // COMMITTED loops.yaml (invariant 2); run stamps live in a local file beside the workspace, so
  // scheduling churn never touches the brain. A firing loop streams the agent into an ordinary
  // logged session - exactly as a chat does, so outward actions still hit the gate.
  const loopsRoot = config.roots.find((r) => r.name !== "core") ?? config.roots[0];
  const loopsYaml = join(loopsRoot ? loopsRoot.dir : config.workspace, "loops.yaml");
  // One-time lift of the legacy automations.yaml. The old file is left where it is (invariant 8).
  migrateAutomationsYaml(join(loopsRoot ? loopsRoot.dir : config.workspace, "automations.yaml"), loopsYaml);
  const loopDefs = new LoopDefStore(loopsYaml);
  const loopState = new LoopStateFile(join(config.workspace, ".loops-state.json"));
  // What each loop actually did - the ring behind the history strip. Local and uncommitted like the
  // stamps beside it: one machine's runs are not another's.
  const loopRuns = new LoopRunsFile(join(config.workspace, ".loops-runs.json"));

  /** Start a loop's agent run. Returns as soon as the session exists so "Run now" answers the
   *  operator immediately; the run itself finishes behind the returned `done`.
   *
   *  `done` resolves with `blockedOn` when the run hit the gate and NOBODY was there to tap: the
   *  card TTL-denied (see GATE_CARD_TTL_MS - a card cannot wait longer, or the PreToolUse hook
   *  outlives Claude Code's timeout and the tool would proceed ungated). That is what the Loops
   *  panel renders as "needed you", with one tap to run it again with the operator present.
   *  Attribution is best-effort by session id: with several runs overlapping the broker leaves a
   *  card's origin undefined, and the loop simply records an ordinary finish. */
  const runLoop = async (loop: LoopDef): Promise<StartedRun> => {
    const sessionId = sessions.create({ folder: "Loops", title: loop.title });
    const prompt = loop.prompt ?? "Use the `" + loop.verb + "` skill.";
    sessions.append(sessionId, { kind: "text", text: prompt });
    sessions.setStatus(sessionId, "running");

    const origin: CardOrigin = { kind: "automation", sessionId };
    const cards = new Map<string, ApprovalCard>();
    let blockedOn: string | undefined;
    const unsubscribe = broker.subscribe((ev) => {
      if (ev.type === "open") {
        if (ev.card.origin?.sessionId === sessionId) cards.set(ev.card.id, ev.card);
        return;
      }
      const card = cards.get(ev.id);
      cards.delete(ev.id);
      if (card && ev.reason === "timeout") blockedOn ??= describeTool(card.tool);
    });

    const done = (async (): Promise<RunOutcome> => {
      broker.pushOrigin(origin);
      try {
        for await (const e of driver.runPrompt({ prompt, workspace: config.workspace, systemPromptAppend: workspaceHint() })) {
          if (e.kind === "done" && e.sessionId) sessions.setClaudeSessionId(sessionId, e.sessionId);
          sessions.append(sessionId, e);
        }
        sessions.setStatus(sessionId, "idle");
      } catch (err) {
        sessions.append(sessionId, { kind: "error", message: err instanceof Error ? err.message : String(err) });
        sessions.setStatus(sessionId, "error");
        throw err;
      } finally {
        broker.popOrigin(origin);
        unsubscribe();
      }
      return blockedOn === undefined ? {} : { blockedOn };
    })();

    return { sessionId, done };
  };

  const loopsEngine = new LoopsEngine({ defs: loopDefs, state: loopState, runs: loopRuns, now: Date.now, run: runLoop });
  // The clock. One timer, opt-in via config so tests never leak one; the demo and the packaged
  // daemon set it. Loops run while the app is open - there is no cloud half.
  if (config.schedulerIntervalMs && config.schedulerIntervalMs > 0) {
    const timer = setInterval(() => void loopsEngine.tick().catch(() => {}), config.schedulerIntervalMs);
    timer.unref?.();
  }
  /** The wire → engine seam. The console speaks the three flat schedule fields (every / at / days);
   *  the engine speaks a parsed schedule. Converting here keeps the HTTP shape out of the scheduler
   *  and means a malformed schedule is refused once, in one place. */
  const toSchedule = (input: { every?: string; at?: string; days?: string }): LoopSchedule => {
    const schedule = parseScheduleInput(input);
    if (!schedule) throw new Error("a loop needs either `every` (e.g. 30m) or `at` (e.g. 09:00), not both");
    return schedule;
  };
  /** The prompt-xor-verb half of an edit: whichever arrives non-empty wins and clears the other;
   *  an edit that mentions neither leaves the body untouched. */
  const bodyPatch = (b: { prompt?: string; verb?: string }): { prompt?: string; verb?: string } => {
    if (b.prompt?.trim()) return { prompt: b.prompt.trim(), verb: undefined };
    if (b.verb?.trim()) return { verb: b.verb.trim(), prompt: undefined };
    return {};
  };
  const loops: LoopsEngineControl = {
    list: () => loopsEngine.list(),
    add: (b) =>
      loopsEngine.add({
        title: b.title,
        ...(b.prompt ? { prompt: b.prompt } : {}),
        ...(b.verb ? { verb: b.verb } : {}),
        schedule: toSchedule(b),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      }),
    update: (name, b) =>
      loopsEngine.update(name, {
        ...(b.title !== undefined ? { title: b.title } : {}),
        // A loop runs a prompt XOR a verb, so an edit that sets one must CLEAR the other. The
        // console sends both keys with the unused one empty, so emptiness - not presence - is what
        // decides here; keying off `!== undefined` would let a blank prompt beat a real verb.
        ...bodyPatch(b),
        ...(b.every !== undefined || b.at !== undefined ? { schedule: toSchedule(b) } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      }),
    toggle: (name) => loopsEngine.toggle(name),
    setActiveHere: (name, active) => loopsEngine.setActiveHere(name, active),
    remove: (name) => loopsEngine.remove(name),
    runNow: (name) => loopsEngine.runNow(name),
  };
  const fileTree = (): TreeNode[] => config.roots.map((r) => ({ name: r.name, path: r.name, type: "dir" as const, children: treeOf(r.dir, r.name) }));

  // The derived agent surface (Files panel → "Show agent files"). Attribute pack skills by the union
  // of declared skill names across INSTALLED packs, so linked skills that came from an app pack are
  // badged as such. Deterministic (invariant #9); recomputed per request off disk.
  const agentView = () => {
    const packSkills = new Set<string>();
    for (const p of listPacks(catalogSource, config.roots)) if (p.installed && p.skills) for (const s of p.skills) packSkills.add(s);
    return buildAgentView(config.workspace, packSkills, config.roots);
  };
  // Force a config rebuild (re-link skills, re-assemble CLAUDE.md, re-pin MCP) then return the fresh
  // view - the "Regenerate & re-verify" action in the Agent Context viewer, so an operator can PROVE a
  // just-authored verb landed rather than wait for the next sync.
  const agentViewRegen = () => {
    regenConfig();
    return agentView();
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
    // The app fetch broker shares the gateway/provision approver seam, so an app's outbound send
    // raises the same card an MCP send does; the secret itself stays in the keychain (invariant 4).
    appFetch: (r) => brokerAppFetch({ roots: config.roots, fetch: fetchImpl, keychain, approve: brokerApprover(broker) }, r),
    appSecrets: { set: (r) => setAppSecret(config.roots, keychain, r) },
    usageFn,
    openAccount,
    accountState,
    logout,
    signIn,
    onboard,
    vault,
    saveDoc,
    fsOps,
    catalog,
    skillEditor,
    loops,
    connectorHub,
    ...(gatewayView ? { gatewayView } : {}),
    sessions,
    projects,
    fileTree,
    agentView,
    agentViewRegen,
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
    // The company activity ledger for the Brain view's Gate rail - the current + previous month's
    // entries, straight off the committed activity/ files (deterministic, invariant 9). Only wired
    // when a team root exists, exactly like the ledger itself.
    ...(ledger ? { ledgerView: () => ledger.recent() } : {}),
    // "Save now" (POST /api/sync) - the operator's explicit decision to send everything.
    syncFn: async () => saveResultStatus(await scheduler.publishAll()),
    // The dot's live status (GET /api/sync) - "local" (no account yet) / "queued" (offline) /
    // "needs-help" (conflict backed up) / "reconnect" (account revoked - reconnect).
    syncStatus: () => lastSyncStatus,
    // Per-root status of the last publish - lets the console say WHICH root is stuck.
    perRootStatus: () => scheduler.perRoot(),
    // Kept-work recovery (the pending tray's "we kept your version" cards). Restoring is an
    // ordinary edit: the module copies the bytes and the scheduler's touch sends them down the
    // normal checkpoint/save path - no git surgery. Dismissing clears only the attention flag;
    // once no root is flagged any more, the dot's needs-help state retires with it (the backups
    // themselves stay on disk - invariant 8).
    conflicts: {
      list: () => conflicts.list(),
      read: (root, stamp, file) => conflicts.read(root, stamp, file),
      restore: (root, stamp, file) => {
        const r = conflicts.restore(root, stamp, file);
        if (r) scheduler.touch(r.dir);
        return r !== null;
      },
      dismiss: (root, stamp) => {
        const ok = conflicts.dismiss(root, stamp);
        if (ok && lastSyncStatus === "needs-help" && !conflicts.hasAttention()) lastSyncStatus = "ok";
        return ok;
      },
    },
    // What is waiting to be saved, for the pending tray's one card. The staleness comparison
    // happens here, once, against the real clock - the browser is never handed a comparison to make.
    // `connected` is derived from the REPOSITORIES, not from the last sync status: that status
    // initialises to "ok" and only ever moves when the operator publishes, so a fresh install with
    // no account would otherwise read as connected forever - an amber dot, a card offering to save
    // work "to your company" when there is no company, and a Save button that can do nothing.
    // A remote is a local read (`git remote`), so this stays network-free.
    unsavedFn: async () => {
      const dirs = writableDirs();
      const [u, remotes] = await Promise.all([
        unsavedAcross(dirs),
        Promise.all(dirs.map((d) => sync.hasRemote(d).catch(() => false))),
      ]);
      // Assumption: `some(Boolean)` treats the roots as all-or-nothing - true today because
      // provisioning gives every writable root a remote at the same moment. If roots ever go mixed
      // (one writable root with a remote, another without), this reads "connected" while the count
      // still includes the local-only root's files, and the card would keep reporting changes no
      // save can clear. Revisit this derivation (e.g. per-root connected/unsaved) if that happens.
      return { ...u, stale: isStale(u.oldestAt, Date.now()), connected: remotes.some(Boolean) };
    },
  });
}

/** Map a composer "effort" choice to a thinking directive appended to the prompt. Claude Code has no
 *  effort flag; the honest lever is the thinking keywords it recognizes ("think" / "think harder"). */
function applyEffort(prompt: string, effort?: string): string {
  if (effort === "think") return `${prompt}\n\nThink about this carefully before you answer.`;
  if (effort === "think-harder") return `${prompt}\n\nThink harder - reason very thoroughly before you answer.`;
  return prompt;
}

/** The starter local app - a minimal dashboard that reads a file from its OWN folder via the buildex
 *  bridge (an app's reads never leave its folder, so the honest demo reads its own manifest). */
function starterAppHtml(title: string): string {
  const e = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return `<!doctype html><meta charset="utf-8"><title>${e(title)}</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;color:#1a1a1a}h1{font-size:1.4rem}pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow:auto}</style>
<h1>${e(title)}</h1>
<p>This is a starter app. It reads a file from its own folder through the buildex bridge:</p>
<pre id="out">loading…</pre>
<script>
  buildex.read("app.json").then(t => { document.getElementById("out").textContent = t; })
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

/** The verbs available in the workspace, read from the generated .claude/skills links. Each verb
 *  carries `root` - the brain it came from (the origin repo name, precedence-resolved) - so the
 *  console's Brain rail can filter verbs by Company vs Private without lying about ownership. */
function listSkills(workspace: string, roots: Root[]): { name: string; description: string; root: string }[] {
  const skillsDir = join(workspace, ".claude", "skills");
  if (!existsSync(skillsDir)) return [];
  const out: { name: string; description: string; root: string }[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const dir = join(skillsDir, name);
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    const fm = readFileSync(join(dir, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---/);
    const desc = fm ? (fm[1]!.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "") : "";
    out.push({ name, description: desc, root: originOf(workspace, roots, name, dir) });
  }
  return out;
}

/** The always-on operating rules the agent reads every turn: each root's `CLAUDE.md` (core → team →
 *  private), the source layers the workspace `CLAUDE.md` is assembled from. Unlike a skill (reached
 *  for on demand), a rule always applies - so the Brain map surfaces both under "Rules & Skills".
 *  Each carries its `root` (so the rail can scope Company vs Private without lying about ownership)
 *  and a root-relative `path` the doc reader can open. The name is the doc's own H1, so it reads as
 *  itself ("Operating rules", "Team rules") rather than a filename. */
function listRules(roots: Root[]): { name: string; description: string; root: string; path: string }[] {
  const out: { name: string; description: string; root: string; path: string }[] = [];
  for (const root of roots) {
    const src = join(root.dir, "CLAUDE.md");
    if (!existsSync(src)) continue;
    const text = readFileSync(src, "utf8");
    const h1 = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    // First real line (past headings and generated-by comments) as a one-line gloss for the card.
    const desc = text
      .split("\n")
      .find((l) => l.trim() && !l.startsWith("#") && !l.trim().startsWith("<!--")) ?? "";
    out.push({ name: h1 || `${root.name} rules`, description: desc.trim(), root: root.name, path: `${root.name}/CLAUDE.md` });
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
