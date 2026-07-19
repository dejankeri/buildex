// Transport factory - open a live connection to a provider MCP server over streamable HTTP,
// authenticated with the connector's keychain-backed OAuth provider. Kept thin and injectable: the
// transport is a seam so the wiring is testable in-memory, and the real path is a plain
// StreamableHTTPClientTransport construction. On a server that demands OAuth, the SDK invokes the
// provider's redirectToAuthorization (opens the browser) and connect throws UnauthorizedError - we
// surface that as "needs-auth" so the caller can finish the code exchange and reopen.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { providerFromClient } from "./mcp-client.js";
import type { ConnectorPolicy, ProviderConnection } from "./gateway.js";

export interface ProviderServerConfig {
  name: string;
  /** The provider's MCP endpoint (streamable HTTP). */
  url: string;
  policy?: ConnectorPolicy;
  authProvider?: OAuthClientProvider;
}

export interface OpenDeps {
  makeTransport?: (config: ProviderServerConfig) => Transport;
  makeClient?: () => Client;
}

export type OpenResult =
  | { status: "connected"; connection: ProviderConnection; transport: Transport }
  | { status: "needs-auth"; transport: Transport };

export async function openProvider(config: ProviderServerConfig, deps: OpenDeps = {}): Promise<OpenResult> {
  const transport = (deps.makeTransport ?? defaultTransport)(config);
  const client = (deps.makeClient ?? (() => new Client({ name: "buildex-gateway", version: "0.0.0" })))();
  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError) return { status: "needs-auth", transport };
    throw e;
  }
  const connection = await providerFromClient(config.name, client, config.policy);
  return { status: "connected", connection, transport };
}

function defaultTransport(config: ProviderServerConfig): Transport {
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.authProvider ? { authProvider: config.authProvider } : undefined,
  );
}

/** Finish the OAuth code exchange (the loopback callback carries the code), then open a FRESH
 *  connection with the now-authorized provider and wrap it. A new transport is required: the transport
 *  from the needs-auth attempt was already `start()`ed by the initial `client.connect()`, and the SDK
 *  refuses to start a transport twice ("StreamableHTTPClientTransport already started"). The code
 *  exchange uses the authProvider's keychain-stored PKCE verifier + client, so a fresh transport
 *  completes it cleanly. */
export async function completeAuth(
  config: ProviderServerConfig,
  code: string,
  deps: OpenDeps = {},
): Promise<ProviderConnection> {
  const transport = (deps.makeTransport ?? defaultTransport)(config);
  await (transport as StreamableHTTPClientTransport).finishAuth(code);
  const client = (deps.makeClient ?? (() => new Client({ name: "buildex-gateway", version: "0.0.0" })))();
  await client.connect(transport);
  return providerFromClient(config.name, client, config.policy);
}
