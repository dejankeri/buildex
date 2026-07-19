// The connector hub the console drives: connect a source, sync it, see what it filed. The heavy
// lifting is @buildex/connectors - a read-only-by-construction runner that can ONLY write under
// sources/<name>/ (invariant 5, proven by that package's gates test). This hub adds the credential
// handling (via the keychain seam - tokens NEVER touch the repo, invariant 4) and the catalog view.
//
// Fixtures stand in for the provider APIs - but ONLY when explicitly opted in (the `fixtures`
// option, or the demo entrypoint's BUILDEX_DEMO_FIXTURES=1). In production each connector's `list`
// calls the real API with the operator's OAuth token from the keychain; without a live provider
// AND without the opt-in, sync refuses rather than filing fabricated material into a real brain (A8).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  runConnectorSync,
  createGmailConnector,
  createSlackConnector,
  createNotionConnector,
  OAUTH_PROVIDERS,
  TokenManager,
  createGmailApi,
  createSlackApi,
  createNotionApi,
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  generateState,
  type Connector,
  type GmailMessage,
  type SlackMessage,
  type NotionPage,
  type FetchLike,
} from "@buildex/connectors";
import type { Keychain } from "../keychain/keychain.js";

export interface ConnectorInfo {
  name: string;
  auth: string;
  cadence: string;
  description: string;
  connected: boolean;
  /** OAuth connector with a client configured but no token yet - the operator must authorize. */
  needsAuth?: boolean;
  lastSync?: string;
}

/** Runtime-injected OAuth client credentials, never committed (secrets invariant). */
export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

/** How long a pending authorization's state stays valid (invariant 7 - one-time, short TTL). */
const STATE_TTL_MS = 10 * 60 * 1000;

export const CATALOG: { name: string; auth: string; cadence: string; description: string }[] = [
  { name: "gmail", auth: "oauth", cadence: "15m", description: "File email threads into your brain." },
  { name: "slack", auth: "oauth", cadence: "10m", description: "File channel messages into your brain." },
  { name: "notion", auth: "oauth", cadence: "30m", description: "Mirror Notion pages into your brain." },
];

export interface HubFixtures {
  gmail?: GmailMessage[];
  slack?: SlackMessage[];
  notion?: NotionPage[];
}

export interface HubOpts {
  /** The repo that owns sources/ (the team brain). */
  repoDir: string;
  keychain: Keychain;
  now: () => number;
  /** Demo fixture material - an EXPLICIT opt-in, OFF by default (A8). Pass data, or `true` for the
   *  built-in demo set. The demo entrypoint (scripts/demo.ts) opts in via BUILDEX_DEMO_FIXTURES=1
   *  instead, so no production wiring ever enables this. Fixtures never apply to a connector whose
   *  OAuth client is configured - a real provider is never silently stood in for. */
  fixtures?: HubFixtures | true;
  /** Injected fetch (defaults to the platform fetch) - lets tests drive the OAuth + API path. */
  fetch?: FetchLike;
  /** Per-connector OAuth client credentials, runtime-injected (env → config), never committed. */
  oauthClients?: Record<string, OAuthClient>;
  /** Daemon base for the loopback OAuth redirect (default http://127.0.0.1:4317). */
  redirectBase?: string;
  /** Test seams for the CSRF state + PKCE (default: real random). */
  randomState?: () => string;
  randomPkce?: () => { verifier: string; challenge: string };
}

const nodeFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

export class ConnectorHub {
  constructor(private readonly opts: HubOpts) {}

  private get fetch(): FetchLike {
    return this.opts.fetch ?? nodeFetch;
  }

  catalog(): ConnectorInfo[] {
    return CATALOG.map((c) => ({
      ...c,
      connected: this.isConnected(c.name),
      ...(this.needsAuth(c.name) ? { needsAuth: true } : {}),
      ...(this.lastSync(c.name) ? { lastSync: this.lastSync(c.name)! } : {}),
    }));
  }

  isConnected(name: string): boolean {
    if (this.opts.keychain.get(`connector:${name}`) || this.hasTokens(name)) return true;
    // A seeded/previously-filed source counts as connected even without a live token.
    return existsSync(join(this.opts.repoDir, "sources", name));
  }

  private hasTokens(name: string): boolean {
    return !!this.opts.keychain.get(`connector:${name}:oauth:tokens`);
  }

  private oauthClient(name: string): OAuthClient | undefined {
    return OAUTH_PROVIDERS[name] ? this.opts.oauthClients?.[name] : undefined;
  }

  /** True when a connector is OAuth-configured (has a client) but not yet authorized. */
  needsAuth(name: string): boolean {
    return !!this.oauthClient(name) && !this.hasTokens(name);
  }

  private redirectUri(name: string): string {
    return `${this.opts.redirectBase ?? "http://127.0.0.1:4317"}/oauth/connector/${name}/callback`;
  }

  /** Start an OAuth authorization: mint a one-time state + PKCE verifier, return the authorize URL. */
  beginAuth(name: string): { authorizeUrl: string } {
    const spec = OAUTH_PROVIDERS[name];
    const client = this.oauthClient(name);
    if (!spec || !client) throw new Error(`connector "${name}" is not configured for OAuth`);
    const { verifier, challenge } = (this.opts.randomPkce ?? generatePkce)();
    const state = (this.opts.randomState ?? generateState)();
    this.opts.keychain.set(`connector:${name}:oauth:verifier`, verifier);
    this.opts.keychain.set(`connector:${name}:oauth:state`, JSON.stringify({ value: state, expiresAt: this.opts.now() + STATE_TTL_MS }));
    const authorizeUrl = buildAuthorizeUrl({
      spec,
      clientId: client.clientId,
      redirectUri: this.redirectUri(name),
      state,
      ...(spec.usesPkce ? { challenge } : {}),
    });
    return { authorizeUrl };
  }

  /** Finish OAuth from the loopback callback: validate the one-time state, exchange the code, store tokens. */
  async finishAuth(name: string, code: string, state: string): Promise<void> {
    const spec = OAUTH_PROVIDERS[name];
    const client = this.oauthClient(name);
    if (!spec || !client) throw new Error(`connector "${name}" is not configured for OAuth`);
    const raw = this.opts.keychain.get(`connector:${name}:oauth:state`);
    if (!raw) throw new Error("no authorization in progress");
    this.opts.keychain.delete(`connector:${name}:oauth:state`); // single-use, always consumed
    const st = JSON.parse(raw) as { value: string; expiresAt: number };
    if (st.value !== state) throw new Error("authorization state mismatch");
    if (this.opts.now() > st.expiresAt) throw new Error("authorization expired - please try again");
    const verifier = this.opts.keychain.get(`connector:${name}:oauth:verifier`);
    const tokens = await exchangeCode(
      { spec, clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}), code, ...(verifier ? { verifier } : {}), redirectUri: this.redirectUri(name) },
      this.fetch,
      this.opts.now,
    );
    this.opts.keychain.set(`connector:${name}:oauth:tokens`, JSON.stringify(tokens));
    this.opts.keychain.delete(`connector:${name}:oauth:verifier`);
  }

  /** Store the connector's credential in the keychain - never in the repo (secrets invariant). */
  connect(name: string, credential: string): void {
    if (!CATALOG.some((c) => c.name === name)) throw new Error(`unknown connector: ${name}`);
    if (!credential) throw new Error("a credential is required");
    this.opts.keychain.set(`connector:${name}`, credential);
  }

  disconnect(name: string): void {
    this.opts.keychain.delete(`connector:${name}`);
    this.opts.keychain.delete(`connector:${name}:oauth:tokens`);
  }

  async sync(name: string): Promise<{ wrote: number }> {
    const connector = this.build(name);
    if (!connector) throw new Error(`unknown connector: ${name}`);
    const res = await runConnectorSync(connector, { workspaceDir: this.opts.repoDir, now: this.opts.now });
    return { wrote: res.wrote };
  }

  private lastSync(name: string): string | undefined {
    const status = join(this.opts.repoDir, "sources", name, "STATUS.md");
    if (!existsSync(status)) return undefined;
    return readFileSync(status, "utf8").match(/Last sync:\s*(.+)/)?.[1]?.trim();
  }

  /** The active fixture set, or undefined unless EXPLICITLY opted in - via the `fixtures` option
   *  or the demo entrypoint's BUILDEX_DEMO_FIXTURES=1 (scripts/demo.ts). Real installs set neither,
   *  so fabricated demo material can never be filed into a real brain (A8). */
  private fixtureData(): HubFixtures | undefined {
    if (this.opts.fixtures === true) return DEFAULT_FIXTURES;
    if (this.opts.fixtures) return this.opts.fixtures;
    return process.env["BUILDEX_DEMO_FIXTURES"] === "1" ? DEFAULT_FIXTURES : undefined;
  }

  private build(name: string): Connector | undefined {
    if (!CATALOG.some((c) => c.name === name)) return undefined;
    const tm = this.tokenManager(name); // present only when OAuth-configured AND authorized
    // A configured-but-unauthorized provider NEVER falls back to fixtures - filing fabricated
    // material into the operator's real brain would be silent corruption (A8). Surface it instead.
    if (!tm && this.needsAuth(name)) {
      throw new Error(`connector "${name}" is not authorized yet - finish connecting it, then sync`);
    }
    const f = tm ? undefined : this.fixtureData();
    if (!tm && !f) {
      throw new Error(`connector "${name}" has no provider configured - set up its OAuth client to sync real material`);
    }
    if (name === "gmail") {
      const live = tm && createGmailApi({ getAccessToken: (o) => tm.getAccessToken(o), fetch: this.fetch });
      return createGmailConnector({ list: live ? (since) => live.list(since) : async () => f?.gmail ?? [] });
    }
    if (name === "slack") {
      const live = tm && createSlackApi({ getAccessToken: (o) => tm.getAccessToken(o), fetch: this.fetch });
      return createSlackConnector({ list: live ? (since) => live.list(since) : async () => f?.slack ?? [] });
    }
    if (name === "notion") {
      const live = tm && createNotionApi({ getAccessToken: (o) => tm.getAccessToken(o), fetch: this.fetch });
      return createNotionConnector({ list: live ? (since) => live.list(since) : async () => f?.notion ?? [] });
    }
    return undefined;
  }

  /** A TokenManager over the keychain - present only once the connector is OAuth-configured AND
   *  authorized; absent otherwise (build() then requires the explicit fixtures opt-in, or refuses). */
  private tokenManager(name: string): TokenManager | undefined {
    const client = this.oauthClient(name);
    const spec = OAUTH_PROVIDERS[name];
    if (!client || !spec || !this.hasTokens(name)) return undefined;
    return new TokenManager({
      connector: name,
      spec,
      clientId: client.clientId,
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      store: this.opts.keychain,
      fetch: this.fetch,
      now: this.opts.now,
    });
  }
}

// Stand-in provider data for the DEMO ONLY - reachable solely through the explicit fixtures opt-in
// above, never a silent fallback (A8). Kept small and plausible so the demo's "Sync now" visibly
// files new material into the seeded brain.
const DEFAULT_FIXTURES: HubFixtures = {
  gmail: [
    { id: "g-201", threadId: "globex-kickoff", from: "dana@globex.com", subject: "Kickoff logistics", date: "2026-07-15T14:20:00Z", body: "Can you send the data-access checklist before Monday? Also looping in our security lead.", link: "https://mail.google.com/thread-globex-kickoff" },
    { id: "g-202", threadId: "invoice-june", from: "billing@vendor.com", subject: "June invoice", date: "2026-07-14T10:05:00Z", body: "Your June invoice ($480) is attached and due on the 28th." },
  ],
  slack: [
    { id: "s-11", channel: "sales", user: "sam", text: "Globex verbally agreed to the pilot - paperwork this week.", ts: "2026-07-15T16:40:00Z" },
    { id: "s-12", channel: "sales", user: "dana", text: "Nice. I'll prep the order form.", ts: "2026-07-15T16:42:00Z" },
  ],
  notion: [
    { id: "n-roadmap", title: "Q3 Roadmap", markdown: "# Q3 Roadmap\n\n- Land 3 design partners\n- Ship the reporting v2\n- Hire a founding AE", editedAt: "2026-07-13T09:00:00Z", url: "https://notion.so/q3-roadmap" },
  ],
};

/** Discover which connectors have already filed material, across all repos (for read-only listing). */
export function listFiledConnectors(repoDirs: string[]): { name: string; lastSync?: string }[] {
  const out: { name: string; lastSync?: string }[] = [];
  for (const dir of repoDirs) {
    const sources = join(dir, "sources");
    if (!existsSync(sources)) continue;
    for (const name of readdirSync(sources).sort()) {
      if (!statSync(join(sources, name)).isDirectory()) continue;
      const status = join(sources, name, "STATUS.md");
      const lastSync = existsSync(status) ? readFileSync(status, "utf8").match(/Last sync:\s*(.+)/)?.[1]?.trim() : undefined;
      out.push({ name, ...(lastSync ? { lastSync } : {}) });
    }
  }
  return out;
}
