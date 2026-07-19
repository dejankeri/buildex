// Bind the web-standard daemon handler to a Node http server. Critically, it disables request and
// headers timeouts: an agent turn streams over SSE with multi-minute silent gaps between tool calls,
// and any timeout in the path would sever it (the forced-60s-gap verification
// item). Loopback-bound by default (the daemon is local-only).
//
// Loopback binding alone does NOT make the daemon private: the daemon runs the agent, reads/writes
// the whole workspace, and resolves approval cards, so any web page the operator visits could drive
// it via DNS rebinding (a hostile Host that resolves to 127.0.0.1) or a cross-origin fetch. So every
// request must present a loopback Host, and any Origin it carries must be loopback too. A browser
// always attaches Origin to state-changing requests (POST/PUT/PATCH/DELETE) and to cross-origin GETs,
// so a cross-origin page is rejected on Origin and a DNS-rebound page on Host; an ABSENT Origin is
// allowed for the daemon's legitimate non-browser callers (the PreToolUse gate hook, top-level OAuth
// redirect navigations, the agent's mini-app bridge). This mirrors the connector gateway's guard
// (apps/connectors gateway-http.ts) and the MCP spec's Origin-validation requirement for local
// servers. No bearer token is added here: unlike the gateway (whose legitimate client sends no
// Origin), the daemon's mutating clients are browser fetches that always carry one.
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

export type Handler = (req: Request) => Promise<Response>;

function isLoopbackName(name: string): boolean {
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}

/** The Host header must name loopback (with or without a port). Missing Host → reject. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return isLoopbackName(host.replace(/:\d+$/, ""));
}

/** A present Origin must be a loopback URL; absent Origin (non-browser caller) is fine.
 *  "null" (a sandboxed/opaque origin) and unparseable origins are foreign by definition. */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return isLoopbackName(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function createNodeServer(handler: Handler): Server {
  const server = createServer((nodeReq, nodeRes) => {
    void (async () => {
      // DNS-rebinding / cross-origin guard: reject before the request reaches any route so a rebound
      // or cross-origin page learns nothing about the daemon's surface.
      if (!hostAllowed(nodeReq.headers.host) || !originAllowed(nodeReq.headers.origin)) {
        nodeRes.writeHead(403, { "content-type": "application/json" });
        nodeRes.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      const url = `http://${nodeReq.headers.host ?? "127.0.0.1"}${nodeReq.url ?? "/"}`;
      const method = nodeReq.method ?? "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(nodeReq.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const hasBody = method !== "GET" && method !== "HEAD";
      const request = new Request(url, {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(nodeReq) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
      } as RequestInit);

      try {
        const response = await handler(request);
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
          source.pipe(nodeRes);
          // If the client goes away mid-stream (tab closed during a long agent turn), destroy the
          // source so the underlying web stream's `cancel()` fires - that's what aborts the agent
          // turn instead of leaving its child process orphaned. Node's pipe alone does NOT do this on
          // a premature destination close; without it the turn would run on with no reader.
          nodeRes.on("close", () => {
            if (!nodeRes.writableFinished) source.destroy();
          });
        } else {
          nodeRes.end();
        }
      } catch (err) {
        nodeRes.writeHead(500, { "content-type": "application/json" });
        nodeRes.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
      }
    })();
  });

  // Never sever a long agent turn: no request/idle timeout on any route.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return server;
}
