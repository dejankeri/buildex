// Per-provider OAuth + API metadata for the file connectors. PUBLIC ONLY - authorize/token
// URLs and default scopes are not secrets and live in the repo. The client_id / client_secret are
// runtime-injected (env → config), NEVER committed (secrets invariant 4). Gmail is the worked
// reference; Slack/Notion are stubs their live list() plugs into as a follow-on.
import type { OAuthProviderSpec } from "../rest-oauth.js";

export const OAUTH_PROVIDERS: Record<string, OAuthProviderSpec> = {
  gmail: {
    name: "gmail",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Read-only by construction - the connector only files messages; it can never send.
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    usesPkce: true,
    // access_type=offline → a refresh token; prompt=consent → re-issues it on re-auth.
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  slack: {
    name: "slack",
    // Slack OAuth v2: user-token grant. Scopes go in `user_scope` (comma-joined), and the token
    // comes back at authed_user.access_token. Read-only scopes - the connector never posts.
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: ["channels:history", "channels:read"],
    usesPkce: false,
    scopeParam: "user_scope",
    scopeSeparator: ",",
    accessTokenPath: "authed_user.access_token",
  },
  notion: {
    name: "notion",
    // Notion: no scopes/PKCE; the token exchange uses HTTP Basic auth + a JSON body, and the
    // authorize URL carries owner=user. Access is granted per selected pages/databases.
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    usesPkce: false,
    tokenAuth: "basic",
    tokenBodyFormat: "json",
    extraAuthorizeParams: { owner: "user" },
  },
};

/** The base URL each provider's read API is called against (used by the live list()s). */
export const PROVIDER_API_BASE: Record<string, string> = {
  gmail: "https://gmail.googleapis.com",
  slack: "https://slack.com/api",
  notion: "https://api.notion.com",
};
