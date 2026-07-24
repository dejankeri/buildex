// The sandbox lifecycle client - the engine side of the sandbox face (docs/sandbox-face.md).
// Mints, seeds, and destroys THROWAWAY provider workspaces for e2e runs. A client, not a faucet:
// the provider's server decides who may mint. Fetch is injected so the module is hermetic; the
// minted credential is returned to the caller and never persisted here.
import type { PackSandbox } from "./catalog.js";
import { dig } from "./provision.js";

export const SANDBOX_AUTH_HEADER = "x-sandbox-key";

export interface SandboxDeps {
  /** Injected so tests never touch the network. */
  fetch: typeof globalThis.fetch;
}

export interface SandboxWorkspace {
  id: string;
  /** Workspace-scoped API key; rides the pack's mcp-bearer api-key path for the run's duration. */
  key: string;
  /** Workspace-specific MCP url, when the provider's sandbox lives on a different host. */
  mcpUrl?: string;
}

function authHeaders(s: PackSandbox, secret: string): Record<string, string> {
  return { [s.authHeader ?? SANDBOX_AUTH_HEADER]: secret };
}

/** A rejected fetch (DNS, refused connection, TLS) must read as a sandbox problem, not a bare
 *  "fetch failed" - the operator's next move (is the provider up? is the url right?) should be in
 *  the message. */
async function reach(what: "create" | "destroy" | "seed", call: () => Promise<Response>): Promise<Response> {
  try {
    return await call();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not reach the provider's sandbox ${what} endpoint: ${msg}`);
  }
}

/** Mint a throwaway workspace. Throws operator-readably on every failure path; never returns a
 *  partial workspace (an id without a key is useless, a key without an id is undestroyable). */
export async function createSandboxWorkspace(
  s: PackSandbox,
  secret: string,
  opts: { name: string; host: string },
  deps: SandboxDeps,
): Promise<SandboxWorkspace> {
  const res = await reach("create", () =>
    deps.fetch(s.createUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(s, secret) },
      body: JSON.stringify({ name: opts.name, host: opts.host }),
    }),
  );
  if (!res.ok) throw new Error(`the provider refused to mint a sandbox workspace (HTTP ${res.status})`);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error("the provider's sandbox response was not valid JSON");
  }
  const id = dig(parsed, s.idPath);
  const key = dig(parsed, s.keyPath);
  if (typeof id !== "string" || !id.trim() || typeof key !== "string" || !key.trim()) {
    throw new Error("the provider's sandbox response did not contain a workspace id and key");
  }
  const mcpUrl = s.mcpUrlPath ? dig(parsed, s.mcpUrlPath) : undefined;
  return { id, key, ...(typeof mcpUrl === "string" && mcpUrl.trim() ? { mcpUrl } : {}) };
}

/** Destroy a workspace. Idempotent by contract: 404 means "already gone", which is success - the
 *  engine calls this unconditionally (including after crashes), so a repeat must never throw. Any
 *  other failure throws, because a silently leaked workspace is worse than a loud one. */
export async function destroySandboxWorkspace(s: PackSandbox, secret: string, id: string, deps: SandboxDeps): Promise<void> {
  const res = await reach("destroy", () =>
    deps.fetch(s.destroyUrl.replace("{id}", encodeURIComponent(id)), {
      method: "DELETE",
      headers: authHeaders(s, secret),
    }),
  );
  if (!res.ok && res.status !== 404) throw new Error(`the provider refused to destroy sandbox workspace ${id} (HTTP ${res.status})`);
}

/** Bulk-load a seed document. Only for faces that declare `seedUrl`; when absent, the engine seeds
 *  through the provider's normal MCP/API surface instead (the real write path), so calling this
 *  without the endpoint is a programming error, not a fallback. */
export async function seedSandboxWorkspace(s: PackSandbox, secret: string, id: string, seed: unknown, deps: SandboxDeps): Promise<void> {
  const seedUrl = s.seedUrl;
  if (!seedUrl) throw new Error("this pack's sandbox face declares no seed endpoint");
  const res = await reach("seed", () =>
    deps.fetch(seedUrl.replace("{id}", encodeURIComponent(id)), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(s, secret) },
      body: JSON.stringify(seed),
    }),
  );
  if (!res.ok) throw new Error(`the provider refused the sandbox seed for workspace ${id} (HTTP ${res.status})`);
}
