// @buildex/connectors - the connector framework + catalog. Runs inside the client (the daemon imports
// it to sync sources). Read-only by construction: see framework.ts for the load-bearing guarantee.
export const appName = "@buildex/connectors" as const;

export function describe(): string {
  return "buildex - connector framework + catalog (runs inside the client)";
}

export { runConnectorSync } from "./framework.js";
export type { Connector, SourceContext, Provenance, RunOpts, RunResult } from "./framework.js";
export { createGmailConnector } from "./catalog/gmail.js";
export type { GmailMessage, GmailDeps } from "./catalog/gmail.js";
export { createSlackConnector } from "./catalog/slack.js";
export type { SlackMessage, SlackDeps } from "./catalog/slack.js";
export { createNotionConnector } from "./catalog/notion.js";
export type { NotionPage, NotionDeps } from "./catalog/notion.js";

// The OAuth+MCP gateway: buildex proxies provider MCP servers to the agent, passing reads through
// and routing writes/sends through the human gate. Kernel is transport-free + hermetically tested.
export { ConnectorGateway, classifyTool, classifyCall, hasConditionalGate, entryTool } from "./gateway.js";
export type {
  McpTool,
  ToolKind,
  ConnectorPolicy,
  PolicyEntry,
  ToolRule,
  McpToolResult,
  ApprovalRequest,
  Approver,
  ProviderConnection,
  GatewayToolInfo,
  GatewayInventoryItem,
  ToolState,
} from "./gateway.js";
export { providerFromClient } from "./mcp-client.js";
export { createGatewayServer } from "./gateway-server.js";
export { startGatewayHttp } from "./gateway-http.js";
export type { GatewayHttp } from "./gateway-http.js";
export { KeychainOAuthProvider } from "./oauth.js";
export type { SecretStore, KeychainOAuthOptions } from "./oauth.js";
export { openProvider, completeAuth } from "./mcp-transport.js";
export type { ProviderServerConfig, OpenDeps, OpenResult } from "./mcp-transport.js";
export {
  GATEWAY_SERVER_KEY,
  PACK_KEY_PREFIX,
  renderMcpJson,
  renderMcpEntries,
  writeMcpEntries,
  writeGatewayRegistration,
  removeGatewayRegistration,
} from "./mcp-registration.js";
export type { GatewayRegistration, McpServerConfig } from "./mcp-registration.js";

// Live OAuth for file connectors: a static-registration authorization-code + PKCE client
// (Google/Slack/Notion don't do MCP-style dynamic registration), a public provider registry, and the
// live Gmail read API. Client IDs/secrets are runtime-injected - the registry holds only public URLs.
export { generatePkce, generateState, buildAuthorizeUrl, exchangeCode, refresh, TokenManager } from "./rest-oauth.js";
export type { OAuthProviderSpec, StoredTokens, FetchLike } from "./rest-oauth.js";
export { OAUTH_PROVIDERS, PROVIDER_API_BASE } from "./catalog/oauth-registry.js";
export { createGmailApi } from "./catalog/gmail-api.js";
export type { GmailApiDeps } from "./catalog/gmail-api.js";
export { createSlackApi } from "./catalog/slack-api.js";
export type { SlackApiDeps } from "./catalog/slack-api.js";
export { createNotionApi } from "./catalog/notion-api.js";
export type { NotionApiDeps } from "./catalog/notion-api.js";
