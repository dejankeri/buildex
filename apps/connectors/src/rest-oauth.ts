// REST OAuth for file connectors - the piece the MCP SDK can't give us. Real Google/Slack/
// Notion use STATIC client registration (a pre-registered client_id + known authorize/token URLs),
// not the MCP SDK's dynamic client registration, so file connectors need their own authorization-code
// + PKCE client. Pure and fetch-injected so it's hermetically testable; all persisted token state
// lives only in the injected SecretStore (the keychain seam), namespaced connector:<name>:oauth:*
// (secrets invariant 4). No send/egress here - this only obtains tokens the read-only list() uses.
import { createHash, randomBytes } from "node:crypto";

/** Public, committed per-provider metadata - no secrets (client_id/secret are runtime-injected).
 *  The optional knobs encode documented per-provider quirks so ONE client covers Google/Slack/Notion. */
export interface OAuthProviderSpec {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  usesPkce: boolean;
  /** Provider-specific authorize params, e.g. Google's access_type=offline & prompt=consent. */
  extraAuthorizeParams?: Record<string, string>;
  /** The authorize param carrying scopes. Default "scope"; Slack user tokens use "user_scope". */
  scopeParam?: string;
  /** How scopes are joined. Default " " (Google); Slack uses ",". */
  scopeSeparator?: string;
  /** Token-endpoint client auth. Default "body" (client_id/secret in the body); Notion uses "basic". */
  tokenAuth?: "body" | "basic";
  /** Token-endpoint body encoding. Default "form"; Notion uses "json". */
  tokenBodyFormat?: "form" | "json";
  /** Dot-path to the access token in the token response. Default "access_token"; Slack user tokens
   *  live at "authed_user.access_token". */
  accessTokenPath?: string;
}

/** Tokens as we persist them - accessToken + optional refreshToken + absolute expiry (epoch ms). */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
}

/** The minimal fetch shape we depend on (the platform fetch and test fakes both satisfy it). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** The minimal secret store - the client's Keychain satisfies it structurally (same as oauth.ts). */
export interface SecretStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const b64url = (b: Buffer): string => b.toString("base64url");

/** A PKCE verifier + its S256 challenge (RFC 7636). */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** A random, url-safe CSRF state value (validated one-time on the callback - invariant 7). */
export function generateState(): string {
  return b64url(randomBytes(24));
}

export function buildAuthorizeUrl(o: {
  spec: OAuthProviderSpec;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge?: string;
}): string {
  const u = new URL(o.spec.authorizeUrl);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("response_type", "code");
  if (o.spec.scopes.length) u.searchParams.set(o.spec.scopeParam ?? "scope", o.spec.scopes.join(o.spec.scopeSeparator ?? " "));
  u.searchParams.set("state", o.state);
  if (o.spec.usesPkce && o.challenge) {
    u.searchParams.set("code_challenge", o.challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(o.spec.extraAuthorizeParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

/** Read a dot-path (e.g. "authed_user.access_token") out of a JSON object. */
function getPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === "string" ? cur : undefined;
}

async function tokenRequest(
  spec: OAuthProviderSpec,
  params: Record<string, string>,
  clientId: string,
  clientSecret: string | undefined,
  fetch: FetchLike,
  now: () => number,
): Promise<StoredTokens> {
  const headers: Record<string, string> = { accept: "application/json" };
  if ((spec.tokenAuth ?? "body") === "basic") {
    // Notion: client creds go in an HTTP Basic header, not the body.
    headers["authorization"] = "Basic " + Buffer.from(`${clientId}:${clientSecret ?? ""}`).toString("base64");
  } else {
    params["client_id"] = clientId;
    if (clientSecret) params["client_secret"] = clientSecret;
  }
  let body: string;
  if ((spec.tokenBodyFormat ?? "form") === "json") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(params);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }
  const res = await fetch(spec.tokenUrl, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`${spec.name} token endpoint returned ${res.status}`);
  const j = (await res.json()) as { refresh_token?: string; expires_in?: number; scope?: string };
  const accessToken = getPath(j, spec.accessTokenPath ?? "access_token");
  if (!accessToken) throw new Error(`${spec.name} token response had no access token`);
  const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 3600;
  return {
    accessToken,
    ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
    expiresAt: now() + expiresIn * 1000,
    ...(j.scope ? { scope: j.scope } : {}),
  };
}

export function exchangeCode(
  o: { spec: OAuthProviderSpec; clientId: string; clientSecret?: string; code: string; verifier?: string; redirectUri: string },
  fetch: FetchLike,
  now: () => number = Date.now,
): Promise<StoredTokens> {
  const params: Record<string, string> = { grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri };
  if (o.verifier) params["code_verifier"] = o.verifier;
  return tokenRequest(o.spec, params, o.clientId, o.clientSecret, fetch, now);
}

export async function refresh(
  o: { spec: OAuthProviderSpec; clientId: string; clientSecret?: string; refreshToken: string },
  fetch: FetchLike,
  now: () => number = Date.now,
): Promise<StoredTokens> {
  const t = await tokenRequest(o.spec, { grant_type: "refresh_token", refresh_token: o.refreshToken }, o.clientId, o.clientSecret, fetch, now);
  // Providers (Google) typically omit refresh_token on a refresh - keep the one we already have.
  if (!t.refreshToken) t.refreshToken = o.refreshToken;
  return t;
}

/** How long before expiry we proactively refresh (clock-skew + request latency headroom). */
const SKEW_MS = 60_000;

/** Reads/refreshes the connector's token from the keychain seam, keeping a valid access token on hand. */
export class TokenManager {
  constructor(
    private readonly o: {
      connector: string;
      spec: OAuthProviderSpec;
      clientId: string;
      clientSecret?: string;
      store: SecretStore;
      fetch: FetchLike;
      now?: () => number;
    },
  ) {}

  private get key(): string {
    return `connector:${this.o.connector}:oauth:tokens`;
  }

  read(): StoredTokens | undefined {
    const raw = this.o.store.get(this.key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return undefined;
    }
  }

  save(t: StoredTokens): void {
    this.o.store.set(this.key, JSON.stringify(t));
  }

  /** A valid access token, refreshing when stale (or when forced, e.g. after a 401). */
  async getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    let t = this.read();
    if (!t) throw new Error(`connector "${this.o.connector}" is not authorized`);
    const stale = t.expiresAt - now <= SKEW_MS;
    if (opts.forceRefresh || stale) {
      if (!t.refreshToken) {
        if (opts.forceRefresh) throw new Error(`connector "${this.o.connector}" has no refresh token - re-authorize`);
        return t.accessToken; // stale but unrefreshable - let the caller try and surface a 401
      }
      t = await refresh({ spec: this.o.spec, clientId: this.o.clientId, ...(this.o.clientSecret ? { clientSecret: this.o.clientSecret } : {}), refreshToken: t.refreshToken }, this.o.fetch, this.o.now ?? Date.now);
      this.save(t);
    }
    return t.accessToken;
  }
}
