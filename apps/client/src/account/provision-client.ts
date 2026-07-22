// The two calls the client makes to the sync server. Injected fetch keeps this hermetic. The server
// contract is fixed (apps/sync/src/http/app.ts:82-91): both endpoints take a JSON body and return
// { machineToken, refreshToken, repos:{core,team,private} }. A rejected setup token is a 401.
export interface ProvisionResult {
  machineToken: string;
  refreshToken: string;
  repos: { core: string; team: string; private: string };
}

export class ProvisionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProvisionError";
  }
}

interface Deps {
  fetch: typeof fetch;
  baseUrl: string;
}

function isResult(v: unknown): v is ProvisionResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const repos = r.repos as Record<string, unknown> | undefined;
  return (
    typeof r.machineToken === "string" &&
    typeof r.refreshToken === "string" &&
    !!repos &&
    typeof repos.core === "string" &&
    typeof repos.team === "string" &&
    typeof repos.private === "string"
  );
}

async function post(deps: Deps, path: string, body: unknown): Promise<ProvisionResult> {
  const url = deps.baseUrl.replace(/\/+$/, "") + path; // one join, no doubled slash
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Offline / DNS / connection refused - surfaced as a 0-status ProvisionError so callers can tell
    // "server said no" (401) from "could not reach the server" (0).
    throw new ProvisionError(e instanceof Error ? e.message : "network error", 0);
  }
  if (!res.ok) {
    let msg = `sync server returned ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body - keep the status message */
    }
    throw new ProvisionError(msg, res.status);
  }
  let parsed: unknown;
  try {
    parsed = (await res.json()) as unknown;
  } catch {
    // An unparseable 200 body is as malformed as a missing field - symmetric with the error path,
    // so it too surfaces as a typed ProvisionError, never a raw SyntaxError escaping the module.
    throw new ProvisionError("sync server returned a malformed credential response", res.status);
  }
  if (!isResult(parsed)) throw new ProvisionError("sync server returned a malformed credential response", res.status);
  return parsed;
}

export function provision(deps: Deps, input: { setupToken: string; machineName: string }): Promise<ProvisionResult> {
  return post(deps, "/provision", { setupToken: input.setupToken, machineName: input.machineName });
}

export function refresh(deps: Deps, refreshToken: string): Promise<ProvisionResult> {
  return post(deps, "/token/refresh", { refreshToken });
}
