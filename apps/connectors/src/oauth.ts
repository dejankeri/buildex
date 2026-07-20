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

/** Namespaced, non-spec marker folded into the persisted client blob: the loopback redirect we
 *  registered this DCR client with. Lets clientInformation() detect a genuine redirect drift without
 *  trusting the server to faithfully echo our redirect_uris (some DCR endpoints don't). Stripped
 *  before the record is handed back to the SDK. */
const REGISTERED_REDIRECT_KEY = "__buildexRegisteredRedirect";

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
    const raw = this.readJson<Record<string, unknown>>("client");
    if (!raw) return undefined;
    // A DCR client is bound to the redirect it registered with. If OUR redirect changed since -
    // 127.0.0.1→localhost, or a different daemon port - reusing the cached client makes the provider
    // reject authorize with `invalid_redirect_uri`, so we drop it and let the SDK re-register.
    // We measure that drift against the redirect WE registered with (stamped at save time), NOT the
    // server's echoed `redirect_uris`: some DCR endpoints (e.g. HeyGen) ignore the requested
    // redirect_uris and echo a fixed allowlist that never contains ours - which would otherwise trip
    // this guard on every token exchange and strand the connector at needs-auth.
    const registeredWith = raw[REGISTERED_REDIRECT_KEY];
    if (typeof registeredWith === "string") {
      if (registeredWith !== this.o.redirectUrl) {
        this.invalidateCredentials("all");
        return undefined;
      }
      const info = { ...raw };
      delete info[REGISTERED_REDIRECT_KEY];
      return info as OAuthClientInformationMixed;
    }
    // Legacy client persisted before we stamped the redirect: fall back to the server-echoed
    // redirect_uris comparison so a real host/port drift is still caught.
    const uris = (raw as { redirect_uris?: unknown }).redirect_uris;
    if (Array.isArray(uris) && uris.length > 0 && !uris.includes(this.o.redirectUrl)) {
      this.invalidateCredentials("all");
      return undefined;
    }
    return raw as OAuthClientInformationMixed;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    // Stamp the redirect we registered with so clientInformation() can detect a genuine redirect
    // drift without depending on the server faithfully echoing our redirect_uris.
    this.o.store.set(this.key("client"), JSON.stringify({ ...info, [REGISTERED_REDIRECT_KEY]: this.o.redirectUrl }));
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
