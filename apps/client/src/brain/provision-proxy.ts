// The provision proxy - the loopback host the agent calls INSTEAD of holding a provisioned
// credential. A pack's escape-hatch key is the broadest credential BuildEx ever custodies, and an
// env var is readable by anything the agent shells; put the key there and every consequential REST
// call slips past the approval gate. So the key stays with the daemon: the agent is handed only this
// proxy's URL and a per-boot bearer, the daemon looks the key up per request and attaches the
// provider's auth header on the way through. Reads (GET/HEAD) pass silently; every other method
// waits on the same approver the connector gateway uses, so a REST send raises the same card an MCP
// send does (invariant 5).
//
// Hardening mirrors the connector gateway's HTTP host (apps/connectors/gateway-http.ts): loopback
// binding alone is not enough - a hostile page can reach 127.0.0.1 via DNS rebinding or a plain
// cross-origin fetch. Every request must (1) present a loopback Host and, when a browser sends one,
// a loopback Origin, and (2) carry the daemon-minted bearer (hashed constant-time compare). The
// upstream transport is injected so the whole host tests hermetically.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ApprovalRequest } from "@buildex/connectors";

const PACK_ID_RE = /^[a-z][a-z0-9-]*$/; // must match catalog.ts NAME_RE

/** Where a pack's provisioned calls go, resolved per request so a fresh grant (or a revoke) takes
 *  effect immediately. `headers` carries the provider auth header - attached HERE, never earlier. */
export interface ProvisionTarget {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface ProvisionProxyHost {
  /** The base the agent calls: `http://127.0.0.1:<port>/provision` (append `/<packId>/<path>`). */
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface ProvisionProxyOptions {
  /** The bearer every request must present. Minted per boot by the daemon and handed to the agent
   *  via its environment - it grants only gated proxy access, never the provider key itself. */
  token: string;
  /** Upstream transport - injected so tests never touch the network. */
  fetch: typeof globalThis.fetch;
  /** Resolve a pack id to its forwarding target, or undefined when the pack is unknown, not
   *  installed, or has no provisioned credential (→ 404, indistinguishable on purpose). */
  resolve: (packId: string) => ProvisionTarget | undefined;
  /** The human gate for non-GET/HEAD methods - the SAME approver seam the connector gateway bridges
   *  to the ApprovalBroker (brokerApprover), so approve/deny/TTL semantics are identical. */
  approve: (req: ApprovalRequest) => Promise<{ approved: boolean; reason?: string }>;
  port?: number;
}

export async function startProvisionProxy(opts: ProvisionProxyOptions): Promise<ProvisionProxyHost> {
  const prefix = "/provision";
  const httpServer = createServer((req, res) => {
    void handle(req, res, opts, prefix).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, "127.0.0.1", resolve));
  // The daemon's own http server keeps the process alive; this host never should (same as the
  // gateway host - lets test processes exit cleanly).
  httpServer.unref();
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    port,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: ProvisionProxyOptions, prefix: string): Promise<void> {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  if (u.pathname !== prefix && !u.pathname.startsWith(prefix + "/")) {
    res.writeHead(404).end();
    return;
  }
  // Host/Origin must be loopback - checked before auth so a rebound page learns nothing (see
  // gateway-http.ts for the full argument; the rules are identical).
  if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
    res.writeHead(403).end();
    return;
  }
  if (!tokenOk(req.headers.authorization, opts.token)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    return;
  }

  const rest = u.pathname.slice(prefix.length + 1); // "<packId>/<provider path>"
  const slash = rest.indexOf("/");
  const packId = slash === -1 ? rest : rest.slice(0, slash);
  const providerPath = slash === -1 ? "" : rest.slice(slash + 1);
  const target = PACK_ID_RE.test(packId) ? opts.resolve(packId) : undefined;
  if (!target) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `no provisioned connection for "${packId}"` }));
    return;
  }

  const method = req.method ?? "GET";
  // Reads pass silently; everything else is a consequential REST call and waits for the human tap -
  // the same card, approver, and TTL auto-deny a gated gateway tool gets.
  if (method !== "GET" && method !== "HEAD") {
    const path = `/${providerPath}${u.search}`;
    const verdict = await opts.approve({
      connector: packId,
      tool: `${method} /${providerPath}`,
      args: { method, path },
      summary: `${packId}: ${method} ${path}`,
    });
    if (!verdict.approved) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: verdict.reason ?? "the operator did not approve this call" }));
      return;
    }
  }

  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
  // Only the content-negotiation headers cross; the incoming Authorization is the PROXY's bearer and
  // must never reach the provider - the provider's own header comes from the resolved target.
  const headers: Record<string, string> = {};
  if (typeof req.headers["content-type"] === "string") headers["content-type"] = req.headers["content-type"];
  if (typeof req.headers["accept"] === "string") headers["accept"] = req.headers["accept"];
  Object.assign(headers, target.headers);

  const upstreamUrl = `${target.baseUrl.replace(/\/+$/, "")}/${providerPath}${u.search}`;
  let upstream: Response;
  try {
    upstream = await opts.fetch(upstreamUrl, { method, headers, ...(body && body.length > 0 ? { body } : {}) });
  } catch {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "the provider could not be reached" }));
    return;
  }
  const ct = upstream.headers.get("content-type");
  res.writeHead(upstream.status, ct ? { "content-type": ct } : {});
  if (upstream.body && method !== "HEAD") {
    for await (const chunk of upstream.body) res.write(chunk);
  }
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isLoopbackName(name: string): boolean {
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}

/** The Host header must name loopback (with or without a port). Missing Host → reject. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return isLoopbackName(host.replace(/:\d+$/, ""));
}

/** A present Origin must be a loopback URL; absent Origin (non-browser client - the agent's curl)
 *  is fine. "null" and unparseable origins are foreign by definition. */
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
