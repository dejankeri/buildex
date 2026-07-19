// Bind the sync service's web-standard handler (`createApp`, a Request → Response function) to a
// real Node http server. The handler itself is transport-agnostic and unit-tested in-process; this
// adapter is the thin glue that puts it on an actual socket - which is exactly what a `git clone
// http://.../git/<repo>.git` needs to reach. It is deliberately minimal: no request/idle timeout is
// disabled here (unlike the client daemon's SSE path) because sync serves bounded request/response
// git-smart-HTTP exchanges, not multi-minute agent streams.
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import type { Handler } from "./app.js";

/** Wrap a web-standard handler in a Node http.Server (not yet listening). */
export function createNodeServer(handler: Handler): Server {
  return createServer((nodeReq, nodeRes) => {
    void (async () => {
      const url = `http://${nodeReq.headers.host ?? "127.0.0.1"}${nodeReq.url ?? "/"}`;
      const method = nodeReq.method ?? "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(nodeReq.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) for (const one of v) headers.append(k, one);
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
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(nodeRes);
        } else {
          nodeRes.end();
        }
      } catch (err) {
        if (!nodeRes.headersSent) nodeRes.writeHead(500, { "content-type": "application/json" });
        nodeRes.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
      }
    })();
  });
}

/** Convenience for callers/tests: start the server and resolve with its bound port + a closer. */
export async function listen(
  handler: Handler,
  opts: { port?: number; host?: string } = {},
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createNodeServer(handler);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const close = () =>
    new Promise<void>((resolve) => {
      // `server.close()` alone waits forever for idle keep-alive sockets (git and undici both keep
      // connections alive), so force them shut - otherwise shutdown hangs.
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { server, port, close };
}
