// The headless daemon (the client's separable core). A web-standard
// (Request → Response) handler wiring the driver, gate, sync, and renderers. The /api/prompt route
// streams the agent turn as SSE and must survive multi-minute silent gaps - the Node adapter
// (node-adapter.ts) disables request/idle timeouts (the forced-60s-gap verification item).
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Gate } from "../gate/gate.js";
import type { ApprovalBroker, ApprovalEvent } from "../gate/approval.js";
import type { ToolInvocation } from "../gate/policy.js";
import type { UiEvent } from "../agent/types.js";
import type { Graph, Root } from "../brain/graph.js";
import type { AppMeta } from "../brain/apps.js";
import type { PackMeta, InstallResult } from "../brain/catalog.js";
import type { UsageReport } from "../brain/usage.js";
import type { HistoryEntry, ChangeEntry } from "../brain/history.js";
import type { AppBus, AppCommand } from "../miniapp/app-bus.js";
import type { SessionMeta, SessionStatus, StoredEvent } from "./sessions.js";
import type { Project, ProjectItem } from "./projects.js";

/** Task containers holding a mix of tabs (chats, browsers, docs) - the console's left rail. */
export interface ProjectStore {
  list(): Project[];
  create(name: string): Project;
  addItem(id: string, item: ProjectItem): Project;
  removeItem(id: string, index: number): Project;
  rename(id: string, name: string): Project;
  remove(id: string): void;
}

/** The console's conversation store (left-rail projects panel + persisted chat). */
export interface SessionStore {
  list(): SessionMeta[];
  create(meta?: { folder?: string; title?: string }): string;
  read(id: string): SessionMeta & { events: StoredEvent[] };
  append(id: string, e: StoredEvent): void;
  setStatus(id: string, s: SessionStatus): void;
  setTitle(id: string, title: string): void;
  getClaudeSessionId(id: string): string | undefined;
  setClaudeSessionId(id: string, sid: string): void;
}

/** Read-only vault surface (deterministic - trust surfaces render from repo state). */
export interface VaultReader {
  listDocs(): string[];
  readDoc(path: string): string;
  history(path: string): HistoryEntry[];
  /** The document's content at a specific commit - powers one-tap history restore (POST
   *  /api/doc/restore). Optional so lightweight vault mocks need not implement it. */
  readDocAt?(path: string, sha: string): string;
}

/** The workspace catalog - the verbs and connectors the operator surfaces render. */
export interface Catalog {
  skills(): { name: string; description: string; root: string }[];
  /** The always-on operating rules (each root's CLAUDE.md layer). Optional so lightweight catalog
   *  mocks predating the Rules & Skills stage still satisfy the interface. */
  rules?(): { name: string; description: string; root: string; path: string }[];
  connectors(): { name: string; status: string; lastSync?: string }[];
}

/** A connector as the console renders it - catalog metadata + whether it's connected/last synced. */
export interface ConnectorInfo {
  name: string;
  auth: string;
  cadence: string;
  description: string;
  connected: boolean;
  /** OAuth connector configured but not yet authorized - the operator must sign in. */
  needsAuth?: boolean;
  lastSync?: string;
}

/** Connect a source (credential → keychain) and sync it (files under sources/<name>/ + commits). */
export interface ConnectorControl {
  catalog(): ConnectorInfo[];
  connect(name: string, credential: string): void;
  disconnect(name: string): void;
  sync(name: string): Promise<{ wrote: number }>;
  /** Start OAuth for a file connector - returns the provider authorize URL. Optional: only
   *  present when OAuth clients are configured; absent → the connector is apikey-only. */
  beginAuth?(name: string): { authorizeUrl: string };
  /** Finish OAuth from the loopback callback (validate one-time state, exchange code, store token). */
  finishAuth?(name: string, code: string, state: string): Promise<void>;
}

/** Control surface for the OAuth+MCP connector gateway - add/remove providers, finish OAuth. */
export interface ConnectorGatewayView {
  status(): { name: string; connected: boolean; needsAuth: boolean; tools: number; authUrl?: string; url?: string; scopes?: string[] }[];
  /** The operator's trust surface: every tool incl. hidden, with effective state + intrinsic baseline. */
  tools(): { name: string; kind: string; description?: string; baseline?: string }[];
  add(spec: { name: string; url: string; scopes?: string[] }): Promise<{ name: string; connected: boolean; needsAuth: boolean; tools: number; authUrl?: string }>;
  remove(name: string): void;
  /** Reclassify a tool (tighten-only - the engine refuses to un-gate an outward tool). */
  setPolicy(name: string, tool: string, kind: "read" | "gated" | "hidden"): { ok: boolean; reason?: string };
  /** Finish OAuth from the loopback callback (validate one-time state, exchange code - invariant 7). */
  finishAuth(name: string, code: string, state: string): Promise<{ connected: boolean; tools: number }>;
}

/** A loop, as the console renders it. `scheduleText` is the schedule in words and `nextRun`/`lastRun`
 *  are ms timestamps - all computed daemon-side so there is exactly one phrasing in the product. */
export interface LoopRecord {
  name: string;
  title: string;
  prompt?: string;
  verb?: string;
  scheduleText: string;
  /** Company-wide: is this loop live at all (loops.yaml, shared with the team). */
  enabled: boolean;
  /** This machine only: does it run HERE. Off by default for anything not created here. */
  activeHere: boolean;
  nextRun: number;
  lastRun?: number;
  status?: string;
  sessionId?: string;
  blockedOn?: string;
  /** The last runs, newest first. Shipped inline so the panel paints a history strip per card
   *  without a request per loop. */
  runs: LoopRunRecord[];
}

/** One past run, as the history strip and the run list render it. */
export interface LoopRunRecord {
  at: number;
  status: string;
  sessionId?: string;
  blockedOn?: string;
}

/** Create, schedule, toggle and run loops. runNow drives the real agent (and returns as soon as the
 *  session exists - the run continues behind it). */
export interface LoopsEngineControl {
  list(): LoopRecord[];
  add(input: LoopInput): LoopRecord;
  update(name: string, patch: Partial<LoopInput>): LoopRecord;
  toggle(name: string): LoopRecord;
  /** Adopt (or drop) a loop on this machine. */
  setActiveHere(name: string, active: boolean): LoopRecord;
  remove(name: string): void;
  runNow(name: string): Promise<{ sessionId: string }>;
}

/** What the console may send when creating or editing a loop. Exactly one of prompt/verb, and
 *  exactly one of every/at - validated by the engine, not just here. */
export interface LoopInput {
  title: string;
  prompt?: string;
  verb?: string;
  every?: string;
  at?: string;
  days?: string;
  enabled?: boolean;
}

/** Read + author verbs from the console (teach-a-verb). Writing validates, links, and commits. */
export interface SkillEditor {
  read(name: string): { name: string; description: string; content: string; origin: string };
  write(input: { name: string; description: string; instructions: string; repo: string }): { ok: boolean; issues: string[]; path: string };
  /** A blank starter body for a fresh verb of the given name (passes the quality check as-is). */
  template(name: string): string;
}

export interface DaemonDeps {
  workspace: string;
  roots: Root[];
  gate: Gate;
  broker: ApprovalBroker;
  runPrompt: (opts: { prompt: string; workspace: string; resume?: string; model?: string; effort?: string; systemPromptAppend?: string; signal?: AbortSignal }) => AsyncIterable<UiEvent>;
  buildMap: () => Graph;
  /** Recent repo-wide commits (newest first) - powers the Brain view's "Learning" surface. Read-only. */
  recentChanges?: () => ChangeEntry[];
  /** The company activity ledger (the gated moments of invariant 5), read for the Brain view's Gate
   *  rail: the current + previous month's entries, current month first. Read-only and deterministic -
   *  straight from the committed activity/ files, zero LLM (invariant 9). */
  ledgerView?: () => { month: string; entries: string[] }[];
  syncFn: () => Promise<string>;
  /** Current background-sync status for the header dot: "ok" | "busy" | "queued" | "needs-help" |
   *  "reconnect" (account revoked - reconnect). */
  syncStatus?: () => string;
  /** Per-root sync status, keyed by root dir - lets the console say WHICH root is stuck, alongside
   *  the collapsed `syncStatus`. Optional: `perRoot` is omitted from `GET /api/sync` entirely when
   *  this is not wired, so existing callers see no shape change. */
  perRootStatus?: () => Record<string, string>;
  /** What is waiting to be saved, for the pending tray's one card. `connected` says whether there is
   *  anywhere to save TO yet (any writable root with a remote): with no account, work waiting is not
   *  a nudge to act, it is a fact to state. Optional, and a throwing implementation degrades to
   *  "nothing waiting" - counting must never be the reason the status poll fails. */
  unsavedFn?: () => Promise<{ files: number; oldestAt: number | null; stale: boolean; connected: boolean; incomplete?: boolean }>;
  /** Clock for the unsaved-count cache TTL. Injected ONLY so the cache's expiry is deterministically
   *  testable; production leaves it unset and it falls back to Date.now. Nothing else in the daemon
   *  needs an injected clock, so this stays scoped to the one place a test must control time. */
  now?: () => number;
  /** Directory of the built operator console (index.html + assets). Served at `/` when set. */
  webRoot?: string;
  /** The read-only vault surface (documents + per-file history). */
  vault?: VaultReader;
  /** Write a markdown doc into the brain (path-guarded) and commit it. Powers the markdown editor. */
  saveDoc?: (path: string, content: string) => void;
  /** Create/delete files and folders from the Files panel (path-guarded, commits like any write).
   *  Each op throws a human-readable Error the route turns into a 400 the panel can show verbatim. */
  fsOps?: {
    mkdir(path: string): void;
    create(path: string, content: string, base64?: string): void;
    remove(path: string): void;
  };
  /** The mini-app bridge - relays agent commands to an open mini-app window. */
  appBus?: AppBus;
  /** The Apps surface catalog - deterministic list rendered from repo state (invariant 9). */
  appCatalog?: { list(): AppMeta[] };
  /** Create an app (writes app.json + a starter for local apps) - powers the "Add app" flow. */
  appStore?: {
    create(input: { repo: string; name: string; kind: "local" | "external"; title?: string; icon?: string; url?: string }): { name: string };
  };
  /** Serve a local app's files (bridge injected into HTML), path-confined. HTML carries its
   *  document CSP (sandbox + connect-src closed to the daemon plus declared origins). */
  appServe?: (urlPath: string) => { body: Buffer | string; contentType: string; csp?: string } | null;
  /** Broker a local app's data op - read/list confined to the app's OWN folder; write refused in v1. */
  appData?: (req: { op: "read" | "list" | "write"; repo: string; name: string; path?: string; glob?: string }) => { ok: boolean; result?: unknown; error?: string; status: number };
  /** Broker a local app's outbound call: the daemon attaches the named keychain secret and gates
   *  non-GET/HEAD methods on the approval broker; only the reply's status/body return to the app. */
  appFetch?: (req: { repo: string; name: string; secret: string; url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; result?: unknown; error?: string; status: number }>;
  /** Store/clear an app's brokered secret in the keychain (console-side, like a pack API key). */
  appSecrets?: { set(req: { repo: string; name: string; secret: string; value: string | null }): { ok: boolean; error?: string; status: number } };
  /** The App Store - the capability-pack catalog + one-click install (composes app/skill/mcp/policy). */
  packStore?: {
    list(): PackMeta[];
    /** Install a pack. No target: the app face goes to the operator's private root, the skills and
     *  policy to the team brain as company rules (see brain/catalog.ts installPack). */
    install(id: string): InstallResult;
    uninstall(id: string, target: string): InstallResult;
    /** Save (key set) or clear (key null) a pack's API key in the keychain and re-pin its MCP entry.
     *  For a `mcp-bearer` pack this switches it between OAuth (gateway) and the pasted-key direct pin. */
    setApiKey(id: string, key: string | null): void;
    /** Start a pack's escape-hatch grant - returns the provider's consent URL and what it grants. */
    beginProvision?(id: string): { authorizeUrl: string; grants: string };
    /** Finish it from the loopback callback (validate + consume state, exchange the code). */
    finishProvision?(id: string, params: URLSearchParams): Promise<{ id: string; name: string }>;
    /** Forget a provisioned credential locally (does NOT revoke it at the provider). */
    clearProvision?(id: string): void;
  };
  /** The workspace catalog (verbs, connectors). */
  catalog?: Catalog;
  /** Author + read verbs from the console. */
  skillEditor?: SkillEditor;
  /** Schedule + run loops (the Loops panel). */
  loops?: LoopsEngineControl;
  /** Connect + sync sources (the Connectors panel). */
  connectorHub?: ConnectorControl;
  gatewayView?: ConnectorGatewayView;
  /** Display info for the console (company name shown in the top bar). */
  company?: { name: string };
  /** First-run welcome wizard: whether to show it, plus agent detection for the "connect your agent"
   *  step, and a way to mark it finished/skipped. */
  onboarding?: OnboardingControl;
  /** Conversation store - persists chats and powers the left rail. */
  sessions?: SessionStore;
  /** Project store - task containers grouping chats/browsers/docs on the left rail. */
  projects?: ProjectStore;
  /** The workspace file tree (for the right-rail file explorer). */
  fileTree?: () => TreeNode[];
  /** The derived agent surface (.claude/skills, .mcp.json, policy, assembled CLAUDE.md) - a health
   *  summary + tree fragment revealed by the Files panel's "Show agent files" toggle. Zero LLM. */
  agentView?: () => { summary: unknown; tree: TreeNode[]; discrepancies?: unknown };
  /** Force a config rebuild (re-link skills, re-assemble CLAUDE.md, re-pin MCP) then return the fresh
   *  agent view - powers the Agent Context viewer's "Regenerate & re-verify" action. */
  agentViewRegen?: () => { summary: unknown; tree: TreeNode[]; discrepancies?: unknown };
  /** Live Claude subscription usage for the bottom status strip. `force` bypasses the cache
   *  (the manual-refresh affordance). */
  usageFn?: (force?: boolean) => Promise<UsageReport> | UsageReport;
  /** Open an account: provision with the pasted token, attach remotes, publish once. */
  openAccount?: (input: { baseUrl: string; setupToken: string }) => Promise<{ state: "connected" | "needs-help" }>;
  /** Current account state for the console. */
  accountState?: () => { state: "local" | "connected"; operatorId?: string; companySlug?: string; remotes?: { core: string; team: string; private: string } };
  /** Run the browser sign-in→attach chain (system browser + PKCE, then session→persist→attach).
   *  Optional: absent whenever no Supabase client config is wired (the default today), so
   *  `POST /api/signin` stays dormant (501) rather than half-working. */
  signIn?: () => Promise<{ state: "connected" | "needs-help" }>;
  /** Anonymous onboarding: mint an anonymous account no-browser and attach it under the given company
   *  name. Optional: absent whenever no Supabase client config is wired (the same gate as `signIn`),
   *  so `POST /api/onboard` stays dormant (501) rather than half-working. */
  onboard?: (input: { companyName: string }) => Promise<{ state: "connected" | "needs-help" }>;
  /** Local disconnect of the active org (Task 1's disconnect.ts): detach every root's remote and
   *  clear the account store, reverting to a clean local-only state - git history is kept
   *  (invariant 8). Optional and gated exactly like `openAccount`/`accountState` (an account store
   *  must exist - e.g. absent for the sandbox), so `POST /api/logout` simply isn't wired for an org
   *  with nothing to disconnect and the request falls through to the daemon's terminal 404. */
  logout?: () => Promise<{ state: "local" }>;
  /** Kept-work recovery (sync/conflicts.ts): the backups the sync engine takes when the team's
   *  version wins, surfaced so the operator can see, compare, copy back, and dismiss from the
   *  console. Contract: null/false means "no such kept version" (the routes' 404); a throw means
   *  the request itself was bad - above all a path trying to escape (400). `restore` is an ordinary
   *  workspace edit (it flows through the normal checkpoint/save path); `dismiss` clears only the
   *  attention flag - a backup is never deleted. */
  conflicts?: {
    list(): { root: string; stamp: string; at: number; files: { path: string; differs: boolean }[] }[];
    read(root: string, stamp: string, file: string): { kept: string; current: string | null } | null;
    restore(root: string, stamp: string, file: string): boolean;
    dismiss(root: string, stamp: string): boolean;
  };
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
  /** Optional badge (e.g. a skill's origin root, or "N MCP servers") for derived/agent-surface nodes. */
  note?: string;
  /** Render this directory collapsed by default (e.g. a skill folder, so a long list stays tidy). */
  collapsed?: boolean;
}

export interface OnboardingControl {
  /** First-run + agent-detection state for the welcome wizard. Agent detection is async (it shells the
   *  CLI's `--version`), so this returns a promise. */
  state(): Promise<{ firstRun: boolean; agent: { available: boolean; version?: string } }>;
  /** Mark the wizard finished (or skipped) so it doesn't show again on the next launch. */
  complete(): void;
}

export type Handler = (req: Request) => Promise<Response>;

/** How long an unsaved count is reused before it is recomputed. Two console pollers (the tray, 4s;
 *  the left rail, 5s) hit GET /api/sync, and counting runs several git processes PER ROOT - roughly
 *  ten short-lived processes every couple of seconds on the operator's laptop, forever. A short TTL
 *  collapses that to one count per window without the number ever looking stale to a human. */
const UNSAVED_TTL_MS = 2000;
const NOTHING_UNSAVED = { files: 0, oldestAt: null, stale: false, connected: false } as const;

export function createDaemon(deps: DaemonDeps): Handler {
  const appSubs = new Map<string, () => void>(); // token → unsubscribe (mini-app host registration)
  const now = deps.now ?? Date.now;
  // The wire shape the poll returns: the freshly-counted `incomplete` flag is a decision input for the
  // cache, never part of what the console sees.
  type UnsavedWire = Omit<Awaited<ReturnType<NonNullable<DaemonDeps["unsavedFn"]>>>, "incomplete">;
  let unsavedAt = -Infinity;
  let unsavedValue: UnsavedWire = { ...NOTHING_UNSAVED };
  let unsavedInFlight: Promise<UnsavedWire> | null = null;
  /** The cached count. Concurrent pollers collapse onto one in-flight count; a throw degrades to
   *  "nothing waiting" (the dep's documented contract) rather than 500-ing the status poll. */
  const unsavedCached = async (): Promise<UnsavedWire> => {
    if (!deps.unsavedFn) return { ...NOTHING_UNSAVED };
    if (now() - unsavedAt < UNSAVED_TTL_MS) return unsavedValue;
    if (unsavedInFlight) return unsavedInFlight;
    unsavedInFlight = deps
      .unsavedFn()
      .then(({ incomplete, ...wire }) => {
        // A count that could not be fully taken (a transient git index.lock race on one root) must
        // never blank a real number into "nothing waiting" (invariant 8). Keep the last good count
        // and leave the TTL expired, so the very next poll re-attempts a clean count. The one
        // exception is the first-ever count, where there is no prior value to keep.
        if (incomplete && unsavedAt !== -Infinity) return unsavedValue;
        unsavedValue = wire;
        unsavedAt = now();
        return wire;
      })
      .catch(() => ({ ...NOTHING_UNSAVED }))
      .finally(() => {
        unsavedInFlight = null;
      });
    return unsavedInFlight;
  };
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "GET" && path === "/healthz") return json({ ok: true });
    if (method === "GET" && path === "/api/config") {
      return json({ company: deps.company ?? { name: "buildex" }, roots: deps.roots.map((r) => ({ name: r.name })) });
    }
    if (deps.onboarding) {
      if (method === "GET" && path === "/api/onboarding") return json(await deps.onboarding.state());
      if (method === "POST" && path === "/api/onboarding/complete") {
        deps.onboarding.complete();
        return json({ ok: true });
      }
    }
    if (method === "GET" && path === "/api/map") return json(deps.buildMap());
    if (method === "GET" && deps.recentChanges && path === "/api/changes")
      return json({ changes: deps.recentChanges() });
    if (method === "GET" && deps.ledgerView && path === "/api/ledger")
      return json({ months: deps.ledgerView() });
    if (method === "GET" && path === "/api/pending") return json({ cards: deps.broker.pending() });
    // Live approval feed (SSE). The console opens one EventSource and routes each event to the chat
    // whose session matches the card's origin (inline approval), while the tray still lists them all.
    if (method === "GET" && path === "/api/approvals/stream") {
      const enc = new TextEncoder();
      let unsub: (() => void) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (ev: ApprovalEvent) => {
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
            } catch {
              /* client gone - the cancel() below unsubscribes */
            }
          };
          // Replay open cards first so a fresh (or reconnected) subscriber catches up, then stream live.
          for (const card of deps.broker.pending()) send({ type: "open", card });
          unsub = deps.broker.subscribe(send);
        },
        cancel() {
          unsub?.();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    if (deps.sessions) {
      if (method === "GET" && path === "/api/sessions") return json({ sessions: deps.sessions.list() });
      if (method === "POST" && path === "/api/sessions") {
        const b = await body<{ folder?: string; title?: string }>(req, { folder: "string", title: "string" });
        return json({ id: deps.sessions.create(b) });
      }
      const m = path.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
      if (method === "GET" && m) {
        try {
          return json(deps.sessions.read(m[1]!));
        } catch {
          return json({ error: "not found" }, 404);
        }
      }
    }
    if (deps.projects) {
      if (method === "GET" && path === "/api/projects") return json({ projects: deps.projects.list() });
      if (method === "POST" && path === "/api/projects") {
        const b = await body<{ name?: string }>(req, { name: "string" });
        return json({ project: deps.projects.create(b.name ?? "") });
      }
      const pm = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/(items|rename|remove-item|delete)$/);
      if (method === "POST" && pm) {
        const [, id, action] = pm;
        try {
          if (action === "items") {
            const { item } = await body<{ item: ProjectItem }>(req, { item: "object!" });
            checkBody(item, PROJECT_ITEM_SHAPE, "item");
            return json(deps.projects.addItem(id!, item));
          }
          if (action === "rename") return json(deps.projects.rename(id!, (await body<{ name: string }>(req, { name: "string!" })).name));
          if (action === "remove-item") return json(deps.projects.removeItem(id!, (await body<{ index: number }>(req, { index: "number!" })).index));
          deps.projects.remove(id!);
          return json({ ok: true });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "project error" }, 400);
        }
      }
    }
    if (method === "GET" && deps.fileTree && path === "/api/tree") return json({ tree: deps.fileTree() });
    if (method === "GET" && deps.agentView && path === "/api/agent-view") return json(deps.agentView());
    if (method === "POST" && deps.agentViewRegen && path === "/api/agent-view/regen") {
      // regenConfig() mutates disk (re-links skills, rewrites CLAUDE.md/.mcp.json, reads the keychain)
      // and CAN throw - keep the "never a raw 500 for a user-triggered mutation" contract the rest of
      // the API holds: surface a terse, showable error the viewer already handles (it checks r.error).
      try {
        return json(deps.agentViewRegen());
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "regenerate failed" }, 400);
      }
    }
    if (method === "GET" && deps.usageFn && path === "/api/usage")
      return json(await deps.usageFn(url.searchParams.get("refresh") === "1"));

    if (method === "GET" && deps.catalog && path === "/api/skills") return json({ skills: deps.catalog.skills() });
    if (method === "GET" && deps.catalog && path === "/api/rules") return json({ rules: deps.catalog.rules ? deps.catalog.rules() : [] });
    if (deps.skillEditor) {
      if (method === "GET" && path === "/api/skill") {
        const name = url.searchParams.get("name");
        if (name === null) return json({ template: deps.skillEditor.template(url.searchParams.get("template") ?? "") });
        try {
          return json(deps.skillEditor.read(name));
        } catch {
          return json({ error: "not found" }, 404);
        }
      }
      if (method === "POST" && path === "/api/skill") {
        const b = await body<{ name: string; description: string; instructions: string; repo: string }>(req, {
          name: "string!", description: "string!", instructions: "string!", repo: "string!",
        });
        try {
          return json(deps.skillEditor.write(b));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "write failed" }, 400);
        }
      }
    }
    if (method === "GET" && deps.appCatalog && path === "/api/apps") {
      return json({ apps: deps.appCatalog.list() });
    }
    if (method === "POST" && deps.appStore && path === "/api/apps") {
      const b = await body<{ repo: string; name: string; kind: "local" | "external"; title?: string; icon?: string; url?: string }>(req, {
        repo: "string!", name: "string!", kind: { enum: ["local", "external"], required: true }, title: "string", icon: "string", url: "string",
      });
      try {
        return json({ ok: true, name: deps.appStore.create(b).name });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "create failed" }, 400);
      }
    }
    if (method === "GET" && deps.packStore && path === "/api/catalog") {
      return json({ packs: deps.packStore.list() });
    }
    if (method === "POST" && deps.packStore && (path === "/api/catalog/install" || path === "/api/catalog/uninstall")) {
      const b = await body<{ id?: string; target?: string }>(req, { id: "string", target: "string" });
      const installing = path.endsWith("/install");
      // Install takes NO target: the scope is fixed by the model, not chosen per install (the app face
      // is yours, the skills + policy are the company's - see installPack). Uninstall still names the
      // root to clean, and defaults to the operator's own; "core" stays rejected before any approval.
      const target = b.target ?? "private";
      if (!b.id || (target !== "team" && target !== "private")) {
        return json({ error: installing ? "id required" : "id and target (team|private) required" }, 400);
      }
      // Human-gate every pack mutation through the approval broker (invariant 5) - so no loopback
      // caller (incl. the agent) can install/uninstall without the operator's tap in the Pending tray.
      const { decision } = deps.broker.request({
        name: installing ? "Install app pack" : "Uninstall app pack",
        input: installing ? { id: b.id } : { id: b.id, target },
      });
      if ((await decision) !== "approve") return json({ error: installing ? "install declined" : "uninstall declined" }, 403);
      try {
        return json(installing ? deps.packStore.install(b.id) : deps.packStore.uninstall(b.id, target));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "install failed";
        return json({ error: msg }, /^unknown pack:/.test(msg) ? 404 : 400);
      }
    }
    // Save (non-empty key) or clear (empty/absent key) a pack's API key. Local credential storage in
    // the keychain - not an outward/irreversible action, so no approval gate (like OAuth connect, the
    // operator is authorizing their own workspace). The key never touches the repo or a response body.
    if (method === "POST" && deps.packStore && path === "/api/catalog/apikey") {
      const b = await body<{ id?: string; key?: unknown }>(req, { id: "string" });
      if (!b.id) return json({ error: "id required" }, 400);
      const key = typeof b.key === "string" && b.key.trim().length > 0 ? b.key.trim() : null;
      deps.packStore.setApiKey(b.id, key);
      return json({ ok: true, connected: key !== null });
    }
    // Begin an escape-hatch grant. Like OAuth connect and the API-key route, this is the operator
    // authorizing their OWN workspace, so it is not approval-gated - but unlike them it hands back
    // `grants` so the UI states what is being granted BEFORE the browser opens.
    if (method === "POST" && deps.packStore?.beginProvision && path === "/api/catalog/provision") {
      const b = await body<{ id?: string }>(req, { id: "string" });
      if (!b.id) return json({ error: "id required" }, 400);
      try {
        return json(deps.packStore.beginProvision(b.id));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "provision failed" }, 400);
      }
    }
    if (method === "POST" && deps.packStore?.clearProvision && path === "/api/catalog/provision/clear") {
      const b = await body<{ id?: string }>(req, { id: "string" });
      if (!b.id) return json({ error: "id required" }, 400);
      deps.packStore.clearProvision(b.id);
      return json({ ok: true });
    }
    if (deps.gatewayView) {
      const gw = deps.gatewayView;
      if (method === "GET" && path === "/api/connectors/gateway") {
        return json({ status: gw.status(), tools: gw.tools() });
      }
      if (method === "POST" && path === "/api/connectors/gateway") {
        const b = await body<{ name?: string; url?: string; scopes?: string[] }>(req, { name: "string", url: "string", scopes: "string[]" });
        const name = (b.name ?? "").trim().toLowerCase();
        const url = (b.url ?? "").trim();
        if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) return json({ error: "name: lowercase letters/digits/-/_ , 2–32 chars" }, 400);
        if (!/^https?:\/\//.test(url)) return json({ error: "url must start with http(s)://" }, 400);
        const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s) => typeof s === "string") : undefined;
        try {
          return json(await gw.add({ name, url, ...(scopes && scopes.length ? { scopes } : {}) }));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "add failed" }, 400);
        }
      }
      const rm = path.match(/^\/api\/connectors\/gateway\/([a-z0-9_-]+)\/remove$/);
      if (method === "POST" && rm) {
        gw.remove(rm[1]!);
        return json({ ok: true });
      }
      // Reclassify one tool (read/gated/hidden), TIGHTEN-ONLY - the engine refuses to un-gate an
      // outward tool, so the human gate can only be added, never removed (invariant 5).
      const pol = path.match(/^\/api\/connectors\/gateway\/([a-z0-9_-]+)\/policy$/);
      if (method === "POST" && pol) {
        const b = await body<{ tool?: string; kind?: string }>(req, { tool: "string", kind: "string" });
        const tool = (b.tool ?? "").trim();
        const kind = b.kind;
        if (!tool) return json({ error: "tool is required" }, 400);
        if (kind !== "read" && kind !== "gated" && kind !== "hidden") return json({ error: "kind must be read|gated|hidden" }, 400);
        const r = gw.setPolicy(pol[1]!, tool, kind);
        return r.ok ? json({ ok: true }) : json({ error: r.reason ?? "policy update refused" }, 400);
      }
      const cb = path.match(/^\/oauth\/([a-z0-9_-]+)\/callback$/);
      if (method === "GET" && cb) {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        // CSRF: the callback must echo the one-time state minted at authorize time (invariant 7).
        if (!code || !state) return oauthPage("Authorization failed - missing code or state.", 400);
        try {
          await gw.finishAuth(cb[1]!, code, state);
          return oauthPage(`Connected “${cb[1]}” ✓ - you can close this tab and return to buildex.`);
        } catch (e) {
          return oauthPage("Could not complete authorization: " + (e instanceof Error ? e.message : "error"), 400);
        }
      }
    }
    // The escape-hatch loopback callback. Its own /oauth/provision/<id>/ namespace so it can never
    // collide with the MCP gateway's /oauth/<name>/callback or the file connectors'. The one-time
    // state is validated and consumed inside finishProvision before the code is exchanged.
    const pcb = path.match(/^\/oauth\/provision\/([a-z0-9-]+)\/callback$/);
    if (method === "GET" && pcb && deps.packStore?.finishProvision) {
      if (url.searchParams.get("error")) return oauthPage("Connection cancelled - nothing was granted.", 400);
      try {
        const r = await deps.packStore.finishProvision(pcb[1]!, url.searchParams);
        return oauthPage(`Granted extra access to “${r.name}” ✓ - you can close this tab and return to buildex.`);
      } catch (e) {
        return oauthPage("Could not complete the connection: " + (e instanceof Error ? e.message : "error"), 400);
      }
    }
    if (deps.connectorHub) {
      const hub = deps.connectorHub;
      if (method === "GET" && path === "/api/connectors") return json({ connectors: hub.catalog() });
      // Start OAuth for a file connector: mint state/PKCE, return the provider authorize URL.
      const au = path.match(/^\/api\/connectors\/([a-z0-9-]+)\/authorize$/);
      if (method === "POST" && au) {
        if (!hub.beginAuth) return json({ error: "OAuth is not configured for connectors" }, 400);
        try {
          return json(hub.beginAuth(au[1]!));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "authorize failed" }, 400);
        }
      }
      // The loopback OAuth callback for FILE connectors - distinct from the MCP gateway's
      // /oauth/<name>/callback so a "gmail" file connector and a "gmail" MCP provider never collide.
      const fcb = path.match(/^\/oauth\/connector\/([a-z0-9_-]+)\/callback$/);
      if (method === "GET" && fcb) {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return oauthPage("Authorization failed - missing code or state.", 400);
        if (!hub.finishAuth) return oauthPage("OAuth is not configured for connectors.", 400);
        try {
          await hub.finishAuth(fcb[1]!, code, state);
          return oauthPage(`Connected “${fcb[1]}” ✓ - you can close this tab and return to buildex.`);
        } catch (e) {
          return oauthPage(`Authorization failed - ${e instanceof Error ? e.message : "unknown error"}.`, 400);
        }
      }
      const cm = path.match(/^\/api\/connectors\/([a-z0-9-]+)\/(connect|disconnect|sync)$/);
      if (method === "POST" && cm) {
        const [, name, action] = cm;
        try {
          if (action === "connect") {
            const b = await body<{ credential: string }>(req, { credential: "string!" });
            deps.connectorHub.connect(name!, b.credential);
            return json({ ok: true });
          }
          if (action === "disconnect") {
            deps.connectorHub.disconnect(name!);
            return json({ ok: true });
          }
          return json(await deps.connectorHub.sync(name!));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "connector error" }, 400);
        }
      }
    } else if (method === "GET" && deps.catalog && path === "/api/connectors") {
      return json({ connectors: deps.catalog.connectors() });
    }
    if (deps.loops) {
      // One request paints the whole panel: the cards and their histories.
      if (method === "GET" && path === "/api/loops") return json({ loops: deps.loops.list() });
      if (method === "POST" && path === "/api/loops") {
        const b = await body<LoopInput>(req, {
          title: "string!", prompt: "string", verb: "string", every: "string", at: "string", days: "string", enabled: "boolean",
        });
        try {
          return json(deps.loops.add(b));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "add failed" }, 400);
        }
      }
      const lm = /^\/api\/loops\/([a-z0-9-]+)(?:\/(run|toggle|remove|here))?$/.exec(path);
      if (lm) {
        const [, name, action] = lm;
        try {
          if (method === "POST" && action === "run") return json(await deps.loops.runNow(name!));
          if (method === "POST" && action === "toggle") return json(deps.loops.toggle(name!));
          if (method === "POST" && action === "here") {
            const b = await body<{ active?: boolean }>(req, { active: "boolean" });
            return json(deps.loops.setActiveHere(name!, b.active !== false));
          }
          if (method === "POST" && action === "remove") {
            deps.loops.remove(name!);
            return json({ ok: true });
          }
          if (method === "PATCH" && !action) {
            const b = await body<Partial<LoopInput>>(req, {
              title: "string", prompt: "string", verb: "string", every: "string", at: "string", days: "string", enabled: "boolean",
            });
            return json(deps.loops.update(name!, b));
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "action failed" }, 400);
        }
      }
    }

    if (method === "GET" && deps.vault && path === "/api/files") return json({ docs: deps.vault.listDocs() });
    if (method === "GET" && deps.vault && path === "/api/doc") {
      const p = url.searchParams.get("path");
      if (!p) return json({ error: "missing path" }, 400);
      return json({ path: p, content: deps.vault.readDoc(p) });
    }
    if (method === "POST" && deps.saveDoc && path === "/api/doc") {
      const b = await body<{ path: string; content: string }>(req, { path: "string!", content: "string" });
      if (!b.path) return json({ error: "missing path" }, 400);
      try {
        deps.saveDoc(b.path, b.content ?? "");
        return json({ ok: true, path: b.path });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "save failed" }, 400);
      }
    }
    // The Files panel's create/delete surface. One shape for all three: {path} plus, for a new file,
    // either `content` (a new document) or `base64` (an upload). Failures come back as a 400 whose
    // message is written for the operator, because the panel shows it as-is.
    if (method === "POST" && deps.fsOps && (path === "/api/fs/folder" || path === "/api/fs/file" || path === "/api/fs/delete")) {
      const b = await body<{ path: string; content?: string; base64?: string }>(req, { path: "string!", content: "string", base64: "string" });
      // ~9 MB of bytes. A brain is documents; a cap keeps one stray drag-and-drop from committing a
      // video into a repo that syncs to every machine in the company.
      if (b.base64 && b.base64.length > 12_000_000) return json({ error: "that file is too large (9 MB max)" }, 400);
      try {
        if (path === "/api/fs/folder") deps.fsOps.mkdir(b.path);
        else if (path === "/api/fs/file") deps.fsOps.create(b.path, b.content ?? "", b.base64);
        else deps.fsOps.remove(b.path);
        return json({ ok: true, path: b.path });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "failed" }, 400);
      }
    }
    if (method === "GET" && deps.vault && path === "/api/history") {
      const p = url.searchParams.get("path");
      if (!p) return json({ error: "missing path" }, 400);
      return json({ path: p, history: deps.vault.history(p) });
    }
    // One-tap history restore: rewrite a doc to its content at an earlier commit. This
    // is NON-destructive - it writes the old version as a NEW commit (via saveDoc → commit + sync), so
    // the version being replaced is itself preserved in history and a restore can always be undone.
    if (method === "POST" && deps.vault?.readDocAt && deps.saveDoc && path === "/api/doc/restore") {
      const b = await body<{ path: string; sha: string }>(req, { path: "string!", sha: "string!" });
      try {
        const content = deps.vault.readDocAt(b.path, b.sha); // path is repo-confined; sha is validated
        deps.saveDoc(b.path, content);
        return json({ ok: true, path: b.path, content });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "restore failed" }, 400);
      }
    }

    if (method === "POST" && path === "/api/prompt") {
      const { prompt, resume, sessionId, model, effort, systemPromptAppend } = await body<{ prompt: string; resume?: string; sessionId?: string; model?: string; effort?: string; systemPromptAppend?: string }>(req, {
        prompt: "string!", resume: "string", sessionId: "string", model: "string", effort: "string", systemPromptAppend: "string",
      });
      return streamPrompt(deps, prompt, resume, sessionId, model, effort, systemPromptAppend);
    }
    if (method === "POST" && path === "/api/gate") {
      const b = await body<{ name: string; input?: Record<string, unknown> }>(req, { name: "string!", input: "object" });
      const tool: ToolInvocation = { name: b.name, input: b.input ?? {} };
      const decision = await deps.gate.evaluate(tool); // blocks on the approval card for ask-tier
      return json({ decision });
    }
    if (method === "POST" && path === "/api/approve") {
      const { id, verdict } = await body<{ id: string; verdict: "approve" | "deny" }>(req, {
        id: "string!", verdict: { enum: ["approve", "deny"], required: true },
      });
      return json({ ok: deps.broker.resolve(id, verdict) });
    }
    // "Save now" - the operator's explicit decision to send everything. The only path that pushes.
    if (method === "POST" && path === "/api/sync") {
      return json({ result: await deps.syncFn() });
    }
    if (method === "GET" && path === "/api/sync") {
      return json({
        status: deps.syncStatus?.() ?? "ok",
        unsaved: await unsavedCached(),
        // Whether `/api/signin` is anything more than a 501 - the console's sign-in CTAs (the
        // left-rail pill, the pending tray's not-connected card) must not dead-end at a dormant
        // route, so they gate on this rather than inferring availability from `unsaved.connected`.
        signInAvailable: !!deps.signIn,
        ...(deps.perRootStatus ? { perRoot: deps.perRootStatus() } : {}),
      });
    }
    // Kept-work recovery. Wire shape is root/stamp/file throughout; the operator vocabulary ("we
    // kept your version") lives in the console. Not-found → 404; a refused path (the dep throws,
    // e.g. a traversal attempt) → a terse 400, never a raw 500.
    if (deps.conflicts) {
      const conflicts = deps.conflicts;
      const refused = (e: unknown): Response => json({ error: e instanceof Error ? e.message : "refused" }, 400);
      if (method === "GET" && path === "/api/conflicts") {
        return json({ conflicts: conflicts.list() });
      }
      if (method === "GET" && path === "/api/conflicts/file") {
        const root = url.searchParams.get("root");
        const stamp = url.searchParams.get("stamp");
        const file = url.searchParams.get("file");
        if (!root || !stamp || !file) return json({ error: "missing root/stamp/file" }, 400);
        try {
          const r = conflicts.read(root, stamp, file);
          if (!r) return json({ error: "no kept version found" }, 404);
          return json({ root, stamp, file, ...r });
        } catch (e) {
          return refused(e);
        }
      }
      if (method === "POST" && path === "/api/conflicts/restore") {
        const b = await body<{ root: string; stamp: string; file: string }>(req, {
          root: "string!", stamp: "string!", file: "string!",
        });
        try {
          if (!conflicts.restore(b.root, b.stamp, b.file)) return json({ error: "no kept version found" }, 404);
          return json({ ok: true });
        } catch (e) {
          return refused(e);
        }
      }
      if (method === "POST" && path === "/api/conflicts/dismiss") {
        const b = await body<{ root: string; stamp: string }>(req, { root: "string!", stamp: "string!" });
        try {
          if (!conflicts.dismiss(b.root, b.stamp)) return json({ error: "no such backup" }, 404);
          return json({ ok: true });
        } catch (e) {
          return refused(e);
        }
      }
    }
    if (method === "POST" && deps.openAccount && path === "/api/account") {
      const b = await body<{ baseUrl: string; setupToken: string }>(req, { baseUrl: "string!", setupToken: "string!" });
      try {
        return json(await deps.openAccount({ baseUrl: b.baseUrl, setupToken: b.setupToken }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "could not open account";
        // A sandbox refusal is a 409 (conflict with the org's local-only nature); everything else the
        // operator can act on - a bad token, an unreachable server - is a terse 400. Never a raw 500.
        const status = /sandbox/i.test(msg) ? 409 : 400;
        return json({ error: msg }, status);
      }
    }
    if (method === "GET" && deps.accountState && path === "/api/account") {
      return json(deps.accountState());
    }
    // Local disconnect of the active org - the reverse of /api/account: detach every root's remote
    // and clear the account store, keeping git history (invariant 8). Gated exactly like
    // openAccount/accountState (absent whenever there is no account store to clear, e.g. the
    // sandbox), so an unwired org's request simply falls through to the terminal 404 below rather
    // than a dedicated dormant response. Any throw maps to a terse 400, never a raw 500.
    if (method === "POST" && deps.logout && path === "/api/logout") {
      try {
        return json(await deps.logout());
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : "could not log out" }, 400);
      }
    }
    // The browser sign-in→attach chain. Dormant (501) whenever `signIn` isn't wired - the default
    // today, with no Supabase config - so the console can treat "not configured" and "failed" as
    // distinct outcomes. Errors map exactly like /api/account above: sandbox → 409, else 400, never 500.
    if (method === "POST" && path === "/api/signin") {
      if (!deps.signIn) return json({ error: "sign-in not configured" }, 501);
      try {
        return json(await deps.signIn());
      } catch (e) {
        const msg = e instanceof Error ? e.message : "could not sign in";
        const status = /sandbox/i.test(msg) ? 409 : 400;
        return json({ error: msg }, status);
      }
    }
    // Anonymous onboarding: the operator names their company and gets an anonymous account with no
    // browser round-trip. Dormant (501) whenever `onboard` isn't wired - the same gate as `/api/signin`
    // - so the console can treat "not configured" and "failed" as distinct outcomes. Errors map
    // exactly like /api/signin above: sandbox → 409, else 400, never a raw 500.
    if (method === "POST" && path === "/api/onboard") {
      if (!deps.onboard) return json({ error: "sign-in not configured" }, 501);
      const { companyName } = await body<{ companyName?: string }>(req, { companyName: "string" });
      if (!companyName || !companyName.trim()) return json({ error: "companyName is required" }, 400);
      try {
        return json(await deps.onboard({ companyName }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "could not onboard";
        const status = /sandbox/i.test(msg) ? 409 : 400;
        return json({ error: msg }, status);
      }
    }

    // Mini-app bridge: the agent's app-driver MCP posts commands here; the mini-app window
    // polls /api/app-frames and reports results to /api/app-result.
    if (deps.appBus) {
      if (method === "POST" && path === "/api/app-control") {
        const command = await body<AppCommand>(req, {
          app: "string!", op: { enum: ["open", "read", "click", "fill"], required: true }, selector: "string", value: "string",
        });
        try {
          return json(await deps.appBus.send(command));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "no mini-app window" }, 409);
        }
      }
      if (method === "GET" && path === "/api/app-frames") {
        return json({ frames: deps.appBus.drain() });
      }
      if (method === "POST" && path === "/api/app-result") {
        const { id, ok, result, error } = await body<{ id: string; ok: boolean; result?: unknown; error?: string }>(req, {
          id: "string!", ok: "boolean!", error: "string",
        });
        return json({ ok: deps.appBus.resolve(id, { ok, result, error }) });
      }
      if (method === "POST" && path === "/api/app-subscribe") {
        const token = randomToken();
        appSubs.set(token, deps.appBus.subscribe());
        return json({ token });
      }
      if (method === "POST" && path === "/api/app-unsubscribe") {
        const { token } = await body<{ token: string }>(req, { token: "string!" });
        const unsub = appSubs.get(token);
        if (unsub) { unsub(); appSubs.delete(token); }
        return json({ ok: !!unsub });
      }
    }

    if (method === "GET" && deps.appServe && path.startsWith("/apps-serve/")) {
      const served = deps.appServe(path);
      if (served) {
        return new Response(served.body, {
          status: 200,
          headers: {
            "content-type": served.contentType,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            // The document CSP comes from the serve layer for HTML (sandbox forcing an opaque
            // origin even on direct navigation / window.open - mirrors the iframe `sandbox`
            // attribute - plus connect-src closing egress to the daemon + declared origins); other
            // assets carry the bare sandbox directive.
            "content-security-policy": served.csp ?? "sandbox allow-scripts allow-forms allow-popups",
            "cross-origin-resource-policy": "same-origin",
          },
        });
      }
      return json({ error: "app asset not found" }, 404);
    }
    // The app data broker. repo/name identify the CALLING app and come from the trusted parent frame
    // (the console's bridge host), never from inside the sandbox - reads resolve only within that
    // app's own folder.
    if (method === "POST" && deps.appData && path === "/apps-api/data") {
      const b = await body<{ op: "read" | "list" | "write"; repo: string; name: string; path?: string; glob?: string }>(req, {
        op: { enum: ["read", "list", "write"], required: true }, repo: "string!", name: "string!", path: "string", glob: "string",
      });
      const r = deps.appData(b);
      return json(r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error }, r.status);
    }
    // The app fetch broker: the daemon joins the named keychain secret to the outbound request, so
    // the value never enters the sandbox; undeclared slots/origins are refused before any network.
    if (method === "POST" && deps.appFetch && path === "/apps-api/fetch") {
      const b = await body<{ repo: string; name: string; secret: string; url: string; method?: string; headers?: Record<string, string>; body?: string }>(req, {
        repo: "string!", name: "string!", secret: "string!", url: "string!", method: "string", headers: "object", body: "string",
      });
      const r = await deps.appFetch(b);
      return json(r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error }, r.status);
    }
    // Save (non-empty value) or clear (empty/absent value) one of an app's declared secret slots.
    // Local credential storage in the keychain - the same trust shape as /api/catalog/apikey: not an
    // outward/irreversible action, so no approval gate. The value never touches the repo or a
    // response body.
    if (method === "POST" && deps.appSecrets && path === "/api/apps/secret") {
      const b = await body<{ repo: string; name: string; secret: string; value?: unknown }>(req, {
        repo: "string!", name: "string!", secret: "string!",
      });
      const value = typeof b.value === "string" && b.value.trim().length > 0 ? b.value.trim() : null;
      const r = deps.appSecrets.set({ repo: b.repo, name: b.name, secret: b.secret, value });
      return json(r.ok ? { ok: true, stored: value !== null } : { ok: false, error: r.error }, r.status);
    }

    // The operator console (served only when a web root is configured; never shadows API routes).
    if (method === "GET" && deps.webRoot) {
      const asset = serveStatic(deps.webRoot, path);
      if (asset) return asset;
    }

    return json({ error: "not found" }, 404);
  };
  // Every POST route reads its body through body(req, shape); a malformed JSON body or a mis-shaped
  // field raises BodyError anywhere in the chain and maps to a terse 400 here - one wrapper instead
  // of per-route try/catch, and never a raw 500.
  return async (req) => {
    try {
      return await handle(req);
    } catch (e) {
      if (e instanceof BodyError) return json({ error: e.message }, 400);
      throw e;
    }
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

/** Serve a static asset from the web root, refusing any path that escapes it. */
function serveStatic(webRoot: string, urlPath: string): Response | null {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const root = normalize(webRoot);
  const full = normalize(join(webRoot, rel));
  // Confine to the root: allow the root itself, else require a path UNDER it (with a trailing
  // separator) so a sibling whose name merely shares the root's prefix (e.g. `<root>-secrets`) can't
  // slip through a bare startsWith.
  if (full !== root && !full.startsWith(root + sep)) return null; // traversal → not served
  if (!existsSync(full)) return null;
  const ext = full.slice(full.lastIndexOf("."));
  return new Response(readFileSync(full), {
    status: 200,
    headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
  });
}

/**
 * Name a conversation from its first message. A hard slice mid-word ("Can you check whether the Q3
 * inv…") reads like a truncation bug to a non-technical operator, so this takes the first sentence,
 * strips markdown punctuation, and cuts at a word boundary. Deterministic - no model call, in
 * keeping with invariant 9 (trust surfaces render from repo state with zero LLM).
 */
export function sessionTitle(prompt: string): string {
  const clean = prompt.replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0] || clean;
  if (sentence.length <= 48) return sentence || "New chat";
  const cut = sentence.slice(0, 48);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut) + "…";
}

function streamPrompt(deps: DaemonDeps, prompt: string, resume: string | undefined, sessionId?: string, model?: string, effort?: string, systemPromptAppend?: string): Response {
  const enc = new TextEncoder();
  const store = deps.sessions;
  // Resume the underlying claude session if we have one for this conversation.
  const claudeResume = resume ?? (store && sessionId ? store.getClaudeSessionId(sessionId) : undefined);
  if (store && sessionId) {
    // Name the conversation from its first message.
    const s = store.read(sessionId);
    if ((s.title === "New chat" || !s.title) && s.events.length === 0) {
      store.setTitle(sessionId, sessionTitle(prompt));
    }
    // `role: "user"` is what lets the console replay a thread without guessing who said what.
    store.append(sessionId, { kind: "text", text: prompt, role: "user" });
    store.setStatus(sessionId, "running");
  }
  // A turn is cancelled when the client goes away (tab closed / navigated - the node adapter cancels
  // this stream on socket close). Cancelling ABORTS the agent child so it is never orphaned (the old
  // bug: nobody drained it and the turn hung). We keep appending every event we have already received
  // to the session store as it streams, so a mid-turn disconnect still leaves a complete, resumable
  // transcript - and an aborted turn resolves to "idle", never the misleading "error".
  const ac = new AbortController();
  let clientGone = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Enqueue to the client only while it's still connected; once it's gone, enqueue would throw on
      // the closed controller - swallow that and keep persisting server-side.
      const send = (e: UiEvent) => {
        if (clientGone) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          clientGone = true;
        }
      };
      // Mark this chat run in flight so any approval card it raises mid-turn (bash gate, connector
      // gateway, pack install) is attributed to THIS session - which is how the card renders inline in
      // the right chat. Popped in finally so it spans the whole run (incl. cancel/error).
      const origin = sessionId ? { kind: "chat" as const, sessionId } : undefined;
      if (origin) deps.broker.pushOrigin(origin);
      try {
        for await (const e of deps.runPrompt({ prompt, workspace: deps.workspace, signal: ac.signal, ...(claudeResume ? { resume: claudeResume } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(systemPromptAppend ? { systemPromptAppend } : {}) })) {
          send(e);
          if (store && sessionId) {
            if (e.kind === "done" && e.sessionId) store.setClaudeSessionId(sessionId, e.sessionId);
            store.append(sessionId, e); // includes `done` - a turn boundary for replay
          }
        }
        if (store && sessionId) store.setStatus(sessionId, "idle");
      } catch (err) {
        // An abort (client disconnect) is a clean stop, not a failure: leave the session idle and
        // resumable. Only a genuine error marks the session "error".
        if (ac.signal.aborted) {
          if (store && sessionId) store.setStatus(sessionId, "idle");
        } else {
          send({ kind: "error", message: err instanceof Error ? err.message : String(err) });
          if (store && sessionId) store.setStatus(sessionId, "error");
        }
      } finally {
        if (origin) deps.broker.popOrigin(origin);
        try {
          controller.close();
        } catch {
          /* already closed by a cancel - fine */
        }
      }
    },
    cancel() {
      // The client disconnected. Abort the agent turn so its child process is killed rather than
      // orphaned; the start() loop above finishes gracefully and marks the session idle.
      clientGone = true;
      ac.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Rules for the tiny hand-rolled body validator: a primitive type name - append "!" to require the
 *  field - "string[]", or an allowed-literals enum `{ enum: [...], required? }`. Absent optional
 *  fields (and explicit null) pass; a present field must match its rule. No dependencies. */
type BodyRule =
  | "string" | "string!" | "number" | "number!" | "boolean" | "boolean!"
  | "object" | "object!" | "string[]" | "string[]!"
  | { enum: readonly string[]; required?: boolean };
type BodyShape = Record<string, BodyRule>;

/** A malformed or mis-shaped request body. The handler wrapper maps it to a 400 (never a raw 500). */
class BodyError extends Error {}

// Keep in step with ProjectItem (projects.ts) - the daemon depends on that module by interface
// only, so the literal list lives here.
const PROJECT_ITEM_SHAPE: BodyShape = {
  type: { enum: ["chat", "browser", "doc", "map", "app"], required: true },
  sessionId: "string", url: "string", path: "string", title: "string", repo: "string", name: "string", app: "string",
};

/** Parse a JSON request body and (when a shape is given) validate required fields, field types, and
 *  enum membership. Throws BodyError - the route chain's wrapper turns it into a terse 400. */
async function body<T>(req: Request, shape?: BodyShape): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new BodyError("invalid JSON body");
  }
  if (shape) checkBody(parsed, shape);
  return parsed as T;
}

/** Validate one (possibly nested) object against a shape. `label` prefixes nested field names. */
function checkBody(obj: unknown, shape: BodyShape, label = "body"): void {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new BodyError(`${label} must be a JSON object`);
  const rec = obj as Record<string, unknown>;
  for (const [key, rule] of Object.entries(shape)) {
    const v = rec[key];
    const name = label === "body" ? key : `${label}.${key}`;
    if (typeof rule === "object") {
      if (v == null) {
        if (rule.required) throw new BodyError(`${name} must be one of: ${rule.enum.join("|")}`);
      } else if (typeof v !== "string" || !rule.enum.includes(v)) {
        throw new BodyError(`${name} must be one of: ${rule.enum.join("|")}`);
      }
      continue;
    }
    const required = rule.endsWith("!");
    const type = required ? rule.slice(0, -1) : rule;
    if (v == null) {
      if (required) throw new BodyError(`${name} is required`);
    } else if (type === "string[]") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new BodyError(`${name} must be an array of strings`);
    } else if (type === "object") {
      if (typeof v !== "object" || Array.isArray(v)) throw new BodyError(`${name} must be an object`);
    } else if (typeof v !== type) {
      throw new BodyError(`${name} must be a ${type}`);
    }
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Date.now()/Math.random() are fine in the daemon runtime (only forbidden inside Workflow scripts).
function randomToken(): string {
  return "s" + Math.abs(Date.now() ^ (Math.random() * 1e9)).toString(36);
}

/** A tiny self-contained page shown at the end of an OAuth redirect (the connector callback). */
function oauthPage(message: string, status = 200): Response {
  const safe = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const body = `<!doctype html><meta charset="utf-8"><title>buildex - connector</title><body style="font:15px/1.5 ui-sans-serif,system-ui;background:#0a1211;color:#eaf3f1;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:32ch"><div style="width:14px;height:14px;border-radius:4px;background:#2dd4bf;margin:0 auto 16px"></div>${safe}</div></body>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
