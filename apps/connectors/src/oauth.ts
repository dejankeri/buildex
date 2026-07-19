// OAuth for connectors - a keychain-backed OAuthClientProvider for the MCP SDK. All persisted
// state (access + refresh tokens, dynamic client registration, PKCE verifier) lives ONLY in the
// keychain seam, namespaced per connector, never in a repo/log/synced file (secrets invariant). The
// SDK drives the actual authorization-code + refresh dance through these methods; we supply storage
// and an injected browser-opener (no ambient side effects - testable).
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { generateState } from "./rest-oauth.js";

/** The minimal secret store the provider needs - the client's Keychain satisfies it structurally. */
export interface SecretStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface KeychainOAuthOptions {
  connector: string;
  store: SecretStore;
  /** Loopback redirect the provider's app is registered with. */
  redirectUrl: string;
  clientName?: string;
  scopes?: string[];
  /** Open the authorization URL for the operator (injected - real impl opens the browser). */
  openUrl: (url: URL) => void | Promise<void>;
  /** Injected clock for the CSRF state TTL (default Date.now) - hermetic tests fake time. */
  now?: () => number;
  /** Injected state randomness (default crypto-random) - hermetic tests pin the value. */
  randomState?: () => string;
}

/** How long a minted CSRF state stays valid (invariant 7 - one-time, short TTL). */
const STATE_TTL_MS = 10 * 60 * 1000;

export class KeychainOAuthProvider implements OAuthClientProvider {
  constructor(private readonly o: KeychainOAuthOptions) {}

  private key(slot: "tokens" | "client" | "verifier" | "state"): string {
    return `connector:${this.o.connector}:oauth:${slot}`;
  }

  get redirectUrl(): string {
    return this.o.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      // Plain ASCII: some DCR endpoints (e.g. Calendly) restrict client_name to alphanumerics,
      // hyphens, and spaces - an em-dash gets the whole registration rejected as invalid metadata.
      client_name: this.o.clientName ?? `buildex ${this.o.connector}`,
      redirect_uris: [this.o.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.o.scopes?.length ? { scope: this.o.scopes.join(" ") } : {}),
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = this.readJson<OAuthClientInformationMixed>("client");
    if (!info) return undefined;
    // A DCR client is bound to the exact redirect_uri(s) it registered with. If our redirect changed
    // since - 127.0.0.1→localhost, or a different daemon port - reusing the cached client makes the
    // provider reject authorize with `invalid_redirect_uri`. Detect the drift and drop the stale
    // client (+ its tokens) so the SDK re-registers cleanly with the current redirect.
    const uris = (info as { redirect_uris?: unknown }).redirect_uris;
    if (Array.isArray(uris) && uris.length > 0 && !uris.includes(this.o.redirectUrl)) {
      this.invalidateCredentials("all");
      return undefined;
    }
    return info;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.o.store.set(this.key("client"), JSON.stringify(info));
  }

  tokens(): OAuthTokens | undefined {
    return this.readJson<OAuthTokens>("tokens");
  }
  saveTokens(tokens: OAuthTokens): void {
    this.o.store.set(this.key("tokens"), JSON.stringify(tokens));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.o.openUrl(url);
  }

  /** SDK hook: mint the CSRF `state` the authorize URL carries. Persisted one-time with a short TTL
   *  so the loopback callback can prove the redirect belongs to an authorization WE started
   *  (invariant 7 - state one-time, short TTL; same lifecycle as the file-connector flow). */
  state(): string {
    const value = (this.o.randomState ?? generateState)();
    const expiresAt = (this.o.now ?? Date.now)() + STATE_TTL_MS;
    this.o.store.set(this.key("state"), JSON.stringify({ value, expiresAt }));
    return value;
  }

  /** Validate + consume the callback's `state` - single-use, ALWAYS consumed (even on mismatch, so a
   *  wrong guess can't be retried against the same pending record). Throws on missing/mismatch/expired. */
  consumeState(state: string): void {
    const raw = this.o.store.get(this.key("state"));
    if (!raw) throw new Error("no authorization in progress");
    this.o.store.delete(this.key("state")); // single-use, always consumed
    const st = JSON.parse(raw) as { value: string; expiresAt: number };
    if (st.value !== state) throw new Error("authorization state mismatch");
    if ((this.o.now ?? Date.now)() > st.expiresAt) throw new Error("authorization expired - please try again");
  }

  saveCodeVerifier(verifier: string): void {
    this.o.store.set(this.key("verifier"), verifier);
  }
  codeVerifier(): string {
    const v = this.o.store.get(this.key("verifier"));
    if (!v) throw new Error(`no PKCE code verifier stored for connector "${this.o.connector}"`);
    return v;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this.o.store.delete(this.key("tokens"));
    if (scope === "all" || scope === "client") this.o.store.delete(this.key("client"));
    if (scope === "all" || scope === "verifier") this.o.store.delete(this.key("verifier"));
    if (scope === "all") this.o.store.delete(this.key("state"));
  }

  private readJson<T>(slot: "tokens" | "client"): T | undefined {
    const raw = this.o.store.get(this.key(slot));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
}
