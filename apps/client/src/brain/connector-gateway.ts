// Client-side wiring of the connector MCP gateway. The gateway's "human tap" for a gated
// (outward) tool call IS the existing ApprovalBroker - so an agent's `gmail__send` raises a real
// approval card, and the send happens only when the operator approves it (revised invariant 5:
// wide autonomy, a few outward actions gated).
//
// The hub is the lifecycle: connect a provider over OAuth+MCP, register its tools into the gateway
// (routine calls pass, outward calls gate by intent), and write the per-workspace .mcp.json so the
// operator's agent picks up the gateway. Transport + OAuth are injected (openProvider) so this is
// hermetically testable.
import {
  completeAuth,
  ConnectorGateway,
  KeychainOAuthProvider,
  openProvider,
  writeGatewayRegistration,
  type ApprovalRequest,
  type Approver,
  type ConnectorPolicy,
  type GatewayInventoryItem,
  type GatewayToolInfo,
  type OpenDeps,
  type OpenResult,
  type ProviderConnection,
  type SecretStore,
  type ToolState,
} from "@buildex/connectors";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createGatewayServer } from "@buildex/connectors";
import type { ApprovalBroker } from "../gate/approval.js";

/** Turn the connector gateway's approver seam into a Pending-tray round-trip through the broker. */
export function brokerApprover(broker: ApprovalBroker): Approver["approve"] {
  return async (req: ApprovalRequest): Promise<{ approved: boolean; reason?: string }> => {
    const { decision } = broker.request({
      name: `mcp:${req.connector}.${req.tool}`,
      input: { connector: req.connector, tool: req.tool, args: req.args as unknown, summary: req.summary },
    });
    const verdict = await decision;
    return { approved: verdict === "approve" };
  };
}

export interface ProviderSpec {
  name: string;
  /** The provider's MCP endpoint (streamable HTTP). */
  url: string;
  scopes?: string[];
  /** The OPERATOR's tighten/widen overrides. Persisted in the keychain (see SPECS_KEY). */
  policy?: ConnectorPolicy;
  /** The pack-shipped classification baseline. Deliberately NOT persisted: it is re-read from the
   *  bundled catalog on every sync, so a pack update that tightens a gate reaches providers that are
   *  already connected instead of being frozen at whatever shipped when the operator first connected. */
  basePolicy?: ConnectorPolicy;
}

export interface ConnectorStatus {
  name: string;
  connected: boolean;
  /** True when the provider demanded OAuth and the browser step is pending. */
  needsAuth: boolean;
  tools: number;
  /** The authorization URL to open when needsAuth (surfaced to the UI). */
  authUrl?: string;
}

export interface GatewayHubDeps {
  broker: ApprovalBroker;
  /** The keychain seam - OAuth token bundles AND the persisted provider specs live here, never in
   *  the repo or any agent-writable file (A2: the workspace is the agent's territory; a spec kept
   *  there could be hand-edited to loosen a tool's policy or redirect a provider URL). */
  store: SecretStore;
  /** The team brain that owns .mcp.json. */
  workspaceDir: string;
  /** Where the daemon hosts the gateway MCP endpoint (written into .mcp.json). */
  gatewayUrl: string;
  /** Headers the agent's MCP client must send to the gateway - the daemon-minted bearer token (A3).
   *  Written into the .mcp.json registration alongside the URL. */
  gatewayHeaders?: Record<string, string>;
  /** Daemon base URL for OAuth callbacks, e.g. http://127.0.0.1:4317. */
  redirectBase: string;
  /** Open the provider's authorization URL for the operator (real impl opens the browser). */
  openUrl: (url: URL) => void | Promise<void>;
  /** Injected for tests; defaults to the real transport factory. */
  open?: (config: Parameters<typeof openProvider>[0], deps?: OpenDeps) => Promise<OpenResult>;
  /** Injected for tests; defaults to the real OAuth code-exchange completion. */
  complete?: typeof completeAuth;
  /** Injected clock (default Date.now) - drives the CSRF state TTL hermetically in tests. */
  now?: () => number;
}

/** The provider config `openProvider`/`completeAuth` take (name/url/policy/authProvider). */
type ProviderConfig = Parameters<typeof openProvider>[0];

/** Keychain key for the persisted provider specs (name/url/scopes + tighten-only policy overrides).
 *  Distinct prefix from KeychainOAuthProvider's `connector:<name>:oauth:*` slots - never collides. */
const SPECS_KEY = "connectors-mcp:specs";

/** Orchestrates the OAuth+MCP connectors: connect providers, register their tools, host the gateway. */
export class ConnectorGatewayHub {
  private readonly gateway: ConnectorGateway;
  private readonly statuses = new Map<string, ConnectorStatus>();
  // The in-flight OAuth config, kept so finishAuth can build a FRESH transport for the code exchange
  // (the needs-auth transport was already started and can't be reused). The keychain-backed auth
  // provider rides along so the callback's CSRF state can be validated + consumed (invariant 7).
  private readonly pending = new Map<string, { config: ProviderConfig; authProvider: KeychainOAuthProvider }>();
  private readonly authUrls = new Map<string, string>();
  // The specs the operator (or founder config / a pack install) actually approved, persisted in the
  // keychain (A2). This - not any workspace file - is the trust root for reconnect-on-restart: an
  // agent-writable file can be hand-edited to flip a write tool to read or redirect a provider URL,
  // so nothing in the workspace is ever read back as policy.
  private readonly specs = new Map<string, ProviderSpec>();

  constructor(private readonly deps: GatewayHubDeps) {
    this.gateway = new ConnectorGateway({ approve: brokerApprover(deps.broker) });
  }

  /** The MCP server the operator's agent connects to (hosted over loopback HTTP by the daemon). */
  gatewayServer(): Server {
    return createGatewayServer(this.gateway);
  }

  /** The underlying gateway - passed to startGatewayHttp for hosting. */
  get connectorGateway(): ConnectorGateway {
    return this.gateway;
  }

  /** Connect/add a provider: OAuth (if needed) → register its tools → register the gateway per-workspace. */
  async connect(spec: ProviderSpec): Promise<ConnectorStatus> {
    const authProvider = new KeychainOAuthProvider({
      connector: spec.name,
      store: this.deps.store,
      redirectUrl: `${this.deps.redirectBase}/oauth/${spec.name}/callback`,
      ...(spec.scopes ? { scopes: spec.scopes } : {}),
      // Capture the auth URL so the UI can offer an "Authorize" link, then defer to the real opener.
      openUrl: (url) => {
        this.authUrls.set(spec.name, url.toString());
        return this.deps.openUrl(url);
      },
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    const open = this.deps.open ?? openProvider;
    const config: ProviderConfig = {
      name: spec.name,
      url: spec.url,
      ...(spec.policy ? { policy: spec.policy } : {}),
      ...(spec.basePolicy ? { basePolicy: spec.basePolicy } : {}),
      authProvider,
    };
    const res = await open(config);

    // A connect that didn't throw (connected or awaiting the browser step) is an approved spec -
    // persist it in the keychain so it reconnects on restart with the operator's tightening intact.
    // A failed add (bad URL, unreachable server) throws above and is never saved.
    this.specs.set(spec.name, { ...spec });
    this.persistSpecs();

    if (res.status === "needs-auth") {
      this.pending.set(spec.name, { config, authProvider });
      const url = this.authUrls.get(spec.name);
      return this.setStatus({ name: spec.name, connected: false, needsAuth: true, tools: 0, ...(url ? { authUrl: url } : {}) });
    }
    return this.register(spec.name, res.connection);
  }

  /** Reconnect every persisted spec (+ `extra` - founder-config providers, which win on a name
   *  clash), sequentially, tolerating per-provider failures: a spec that fails to connect stays
   *  persisted and visible via status() so the operator can fix and retry it. Called once at boot. */
  async restore(extra: ProviderSpec[] = []): Promise<void> {
    for (const s of [...this.loadSpecs(), ...extra]) this.specs.set(s.name, s);
    for (const s of [...this.specs.values()]) {
      try {
        await this.connect(s);
      } catch {
        /* surfaced via status(); the spec stays persisted for a retry */
      }
    }
    this.persistSpecs();
  }

  /** The persisted specs (trust root for reconnects) - lets the console prefill url/scopes even for
   *  a provider that failed to connect on boot. */
  persistedSpecs(): ProviderSpec[] {
    return [...this.specs.values()];
  }

  /** Finish OAuth after the operator authorized (the callback carries code + state), then register
   *  tools. The one-time CSRF state is validated + consumed FIRST - a forged/replayed/expired
   *  callback never reaches the code exchange (invariant 7: state one-time, short TTL).
   *  completeAuth opens a fresh transport with the stored config to run the code exchange + connect. */
  async finishAuth(name: string, code: string, state: string): Promise<ConnectorStatus> {
    const p = this.pending.get(name);
    if (!p) throw new Error(`no pending authorization for connector "${name}"`);
    p.authProvider.consumeState(state);
    const complete = this.deps.complete ?? completeAuth;
    const connection = await complete(p.config, code);
    return this.register(name, connection);
  }

  /** Remove a provider - its tools leave the agent's surface immediately, and its persisted spec
   *  is dropped so it never reconnects. */
  remove(name: string): void {
    this.gateway.unregister(name);
    this.statuses.delete(name);
    this.pending.delete(name);
    this.authUrls.delete(name);
    if (this.specs.delete(name)) this.persistSpecs();
  }

  status(): ConnectorStatus[] {
    return [...this.statuses.values()];
  }

  listTools(): GatewayToolInfo[] {
    return this.gateway.listTools();
  }

  /** The operator's trust surface - every tool incl. hidden, with effective state + intrinsic baseline. */
  inventory(): GatewayInventoryItem[] {
    return this.gateway.listInventory();
  }

  /** Reclassify a tool (operator-adjustable both ways, enforced in the engine). On success the new
   *  override is folded into the persisted spec - in the keychain, never an agent-writable file - so
   *  it survives restart. */
  setPolicy(name: string, tool: string, kind: ToolState): { ok: boolean; reason?: string; policy?: ConnectorPolicy } {
    const r = this.gateway.setToolPolicy(name, tool, kind);
    if (r.ok) {
      const spec = this.specs.get(name);
      if (spec) {
        spec.policy = r.policy ?? {};
        this.persistSpecs();
      }
    }
    return r;
  }

  private register(name: string, connection: ProviderConnection): ConnectorStatus {
    this.gateway.register(connection);
    writeGatewayRegistration(this.deps.workspaceDir, {
      url: this.deps.gatewayUrl,
      ...(this.deps.gatewayHeaders ? { headers: this.deps.gatewayHeaders } : {}),
    });
    this.pending.delete(name);
    this.authUrls.delete(name);
    return this.setStatus({ name, connected: true, needsAuth: false, tools: connection.tools.length });
  }

  private loadSpecs(): ProviderSpec[] {
    try {
      const raw = this.deps.store.get(SPECS_KEY);
      return raw ? (JSON.parse(raw) as ProviderSpec[]) : [];
    } catch {
      return [];
    }
  }

  /** Re-apply a pack's shipped baseline to a live provider (and its in-memory spec). The baseline is
   *  never persisted, so this is how a catalog update reaches an already-connected provider. */
  setBasePolicy(name: string, basePolicy: ConnectorPolicy | undefined): void {
    const spec = this.specs.get(name);
    if (spec) {
      if (basePolicy) spec.basePolicy = basePolicy;
      else delete spec.basePolicy;
    }
    this.gateway.setBasePolicy(name, basePolicy);
  }

  private persistSpecs(): void {
    try {
      // basePolicy is stripped: it belongs to the bundled catalog, not the operator's trust store.
      const persistable = [...this.specs.values()].map(({ basePolicy: _drop, ...s }) => s);
      this.deps.store.set(SPECS_KEY, JSON.stringify(persistable));
    } catch {
      /* best-effort - a failed persist only costs reconnect-on-restart, never the live session */
    }
  }

  private setStatus(status: ConnectorStatus): ConnectorStatus {
    this.statuses.set(status.name, status);
    return status;
  }
}
