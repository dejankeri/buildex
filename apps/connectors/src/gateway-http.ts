// HTTP host for the gateway - binds the buildex gateway MCP server to a loopback Node http server
// so the operator's agent can reach it via the per-workspace .mcp.json ({type:"http", url, headers}).
// Stateless JSON mode with a fresh Server+transport per request (the SDK's stateless pattern), all
// sharing the one ConnectorGateway whose state (registered providers) lives outside the request.
//
// Loopback binding alone is NOT enough (A3): any web page the operator visits could drive the
// gateway via DNS rebinding (a hostile Host resolving to 127.0.0.1) or a plain cross-origin fetch.
// So every /mcp request must (1) carry the daemon-minted bearer token - delivered to the agent
// through .mcp.json, which a web page cannot read - and (2) present a loopback Host and, when a
// browser sends one, a loopback Origin (the MCP spec requires Origin validation for local servers).
import { createServer, type IncomingMessage } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createGatewayServer } from "./gateway-server.js";
import type { ConnectorGateway } from "./gateway.js";

export interface GatewayHttp {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface GatewayHttpOptions {
  /** The bearer token every /mcp request must present (`Authorization: Bearer <token>`). Minted by
   *  the daemon and handed to the agent via the .mcp.json registration - never optional, so an
   *  unauthenticated gateway cannot be started by accident. */
  token: string;
  port?: number;
  path?: string;
}

export async function startGatewayHttp(gateway: ConnectorGateway, opts: GatewayHttpOptions): Promise<GatewayHttp> {
  const path = opts.path ?? "/mcp";
  const httpServer = createServer(async (req, res) => {
    if (!(req.url ?? "").startsWith(path)) {
      res.writeHead(404).end();
      return;
    }
    // Host/Origin must be loopback: a DNS-rebound page carries its own hostname in Host, and a
    // cross-origin browser fetch carries a foreign Origin. A missing Origin is fine - the agent's
    // MCP client is not a browser. Checked before auth so a rebound page learns nothing.
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
      res.writeHead(403).end();
      return;
    }
    if (!tokenOk(req.headers.authorization, opts.token)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
      return;
    }
    try {
      const body = await readJson(req);
      const server = createGatewayServer(gateway);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, "127.0.0.1", resolve));
  // The daemon's own http server is what keeps the process alive; the gateway host never should
  // (mirrors the unref'd timers in the client wiring, and lets test processes exit cleanly).
  httpServer.unref();
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    port,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function isLoopbackName(name: string): boolean {
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}

/** The Host header must name loopback (with or without a port). Missing Host → reject. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return isLoopbackName(host.replace(/:\d+$/, ""));
}

/** A present Origin must be a loopback URL; absent Origin (non-browser client - the agent) is fine.
 *  "null" and unparseable origins are foreign by definition. */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return isLoopbackName(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Constant-time bearer check (hash both sides so length differences leak nothing). */
function tokenOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
