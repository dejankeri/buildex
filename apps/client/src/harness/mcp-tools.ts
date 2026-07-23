// The mcp discovery client - asks a live streamable-http MCP server which tools it serves, so a
// pack's "surface" can be built by discovery instead of hardcoding (docs/sandbox-face.md's sibling
// question: not just "can we mint a workspace" but "what can the agent actually call there"). Fetch
// is injected so the module is hermetic; it composes nothing yet - just the two-call handshake.
export interface McpTool {
  name: string;
  description: string;
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "buildex-e2e", version: "0.0.1" },
};

type What = "initialize" | "tools/list";

/** A rejected fetch (DNS, refused connection, TLS) must read as an mcp-reachability problem, not a
 *  bare "fetch failed" - mirrors brain/sandbox.ts's reach(). */
async function reach(what: What, call: () => Promise<Response>): Promise<Response> {
  try {
    return await call();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not reach the mcp server's ${what} endpoint: ${msg}`);
  }
}

/** A streamable-http MCP response may be plain JSON, or SSE-framed (`event:`/`data:` lines) - only
 *  the concatenated `data:` lines carry the JSON-RPC payload in the SSE case. */
function parseBody(text: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const data = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("");
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

/** One JSON-RPC call over streamable-http. Throws operator-readably on non-2xx and non-JSON,
 *  naming the failing call either way; hands back the parsed result plus any captured session id. */
async function rpcCall(
  url: string,
  what: What,
  params: unknown,
  headers: Record<string, string>,
  deps: { fetch: typeof globalThis.fetch },
): Promise<{ result: unknown; sessionId: string | null }> {
  const res = await reach(what, () =>
    deps.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: what, params }),
    }),
  );
  if (!res.ok) throw new Error(`the mcp server refused the mcp ${what} (HTTP ${res.status})`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = parseBody(text);
  } catch {
    throw new Error(`the mcp server's ${what} response was not valid JSON`);
  }
  return { result: parsed, sessionId: res.headers.get("mcp-session-id") };
}

/**
 * Discover a live MCP server's tool surface: initialize, then tools/list, returning
 * `[{name, description}]` sorted by name. Some servers are stateless; some hand back an
 * `mcp-session-id` on initialize that must ride every later call - both are supported, the
 * session header simply isn't sent when the server never issued one.
 *
 * Fail-soft on individual tool entries (a missing description becomes "", a missing name drops
 * the entry - a name is how the entry gets called, so a nameless tool is unusable, not just
 * under-described) but fail-closed on the surface itself: a `result.tools` that isn't an array at
 * all throws, because that means the server never answered the question. An array that IS present
 * but ends up empty (either because the server said so, or every entry got dropped) is a valid,
 * if uninteresting, empty surface.
 */
export async function listMcpTools(
  opts: { url: string; headers: Record<string, string> },
  deps: { fetch: typeof globalThis.fetch },
): Promise<McpTool[]> {
  const baseHeaders = {
    ...opts.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  const init = await rpcCall(opts.url, "initialize", INITIALIZE_PARAMS, baseHeaders, deps);
  const listHeaders = init.sessionId ? { ...baseHeaders, "mcp-session-id": init.sessionId } : baseHeaders;
  const list = await rpcCall(opts.url, "tools/list", {}, listHeaders, deps);

  const raw = (list.result as { result?: { tools?: unknown } } | undefined)?.result?.tools;
  if (!Array.isArray(raw)) throw new Error("the mcp server's tools/list response did not contain tools");

  const tools: McpTool[] = [];
  for (const t of raw) {
    const name = (t as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !name.trim()) continue; // fail-soft: unnamed tools are uncallable, drop them
    const description = (t as { description?: unknown }).description;
    tools.push({ name, description: typeof description === "string" ? description : "" });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}
