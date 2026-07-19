// The sync HTTP surface - a web-standard (Request → Response) handler, so it runs behind any Node
// server adapter and is testable in-process without a socket. It exposes: healthz, the S2S
// provisioning API (service-key gated, timing-safe - the primary provisioning surface),
// operator provision/refresh, and the embedded git smart-HTTP endpoints guarded by the
// permission matrix. No knowledge APIs exist here (sync syncs; it does not think).
import type { ControlPlaneStore } from "../store/store.js";
import type { ProvisioningService, Credentials } from "../provisioning/service.js";
import type { EmbeddedGitService } from "../git/service.js";
import { timingSafeEqualStr, hashToken } from "../lib/tokens.js";
import { AuthError, ValidationError } from "../lib/errors.js";
import { authorizeGit, opForService, type GitOp } from "./authorize.js";
import { handleAutomationRoutes, type Caller } from "../automations/routes.js";
import type { ScheduleStore } from "../automations/schedule-store.js";

export interface AppDeps {
  store: ControlPlaneStore;
  provisioning: ProvisioningService;
  git: EmbeddedGitService;
  schedules: ScheduleStore;
  serviceKey: string;
  publicBaseUrl: string;
}

export type Handler = (req: Request) => Promise<Response>;

export function createApp(deps: AppDeps): Handler {
  return async (req: Request): Promise<Response> => {
    try {
      return await route(deps, req);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, 401);
      if (e instanceof ValidationError) return json({ error: e.message }, 400);
      return json({ error: "internal error" }, 500);
    }
  };
}

const GIT_ROUTE = /^\/git\/([a-z0-9_-]+)\.git(\/.*)$/;

async function route(deps: AppDeps, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && path === "/healthz") return json({ ok: true });

  // --- durable automations (authed per machine token → own company) ---
  const auto = await handleAutomationRoutes(
    { schedules: deps.schedules, resolve: (t) => resolveCaller(deps.store, t) },
    req,
    url,
  );
  if (auto) return auto;

  // --- S2S provisioning API (service-key gated) ---
  if (path.startsWith("/s2s/")) {
    requireServiceKey(req, deps.serviceKey);
    if (method === "POST" && path === "/s2s/companies") {
      const b = await body<{ id: string; slug: string; name: string; mirrorRemotes?: string[] }>(req);
      deps.store.createCompany({ id: b.id, slug: b.slug, name: b.name, mirrorRemotes: b.mirrorRemotes });
      return json({ ok: true }, 201);
    }
    if (method === "POST" && path === "/s2s/operators") {
      const b = await body<{ id: string; companyId: string; email: string }>(req);
      deps.store.createOperator({ id: b.id, companyId: b.companyId, email: b.email });
      return json({ ok: true }, 201);
    }
    if (method === "POST" && path === "/s2s/setup-tokens") {
      const b = await body<{ operatorId: string; ttlMs?: number }>(req);
      const setupToken = deps.store.mintSetupToken({ operatorId: b.operatorId, ttlMs: b.ttlMs ?? 10 * 60_000 });
      return json({ setupToken });
    }
    if (method === "POST" && path === "/s2s/revoke") {
      const b = await body<{ operatorId: string }>(req);
      await deps.provisioning.revoke(b.operatorId);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  // --- operator provisioning (auth = the token in the body) ---
  if (method === "POST" && path === "/provision") {
    const b = await body<{ setupToken: string; machineName: string }>(req);
    const creds = await deps.provisioning.provision({ setupToken: b.setupToken, machineName: b.machineName });
    return json(withCloneUrls(deps, creds));
  }
  if (method === "POST" && path === "/token/refresh") {
    const b = await body<{ refreshToken: string }>(req);
    const creds = await deps.provisioning.refresh(b.refreshToken);
    return json(withCloneUrls(deps, creds));
  }

  // --- embedded git smart-HTTP ---
  const gitMatch = path.match(GIT_ROUTE);
  if (gitMatch) return handleGit(deps, req, url, gitMatch[1]!, gitMatch[2]!);

  return json({ error: "not found" }, 404);
}

async function handleGit(
  deps: AppDeps,
  req: Request,
  url: URL,
  repo: string,
  rest: string,
): Promise<Response> {
  // Determine the git service and the access op it requires.
  let op: GitOp;
  if (req.method === "GET" && rest === "/info/refs") {
    const service = url.searchParams.get("service");
    if (!service) return json({ error: "missing service" }, 400);
    op = opForService(service);
  } else if (req.method === "POST" && rest === "/git-upload-pack") {
    op = "read";
  } else if (req.method === "POST" && rest === "/git-receive-pack") {
    op = "write";
  } else {
    return json({ error: "unsupported git route" }, 400);
  }

  const token = basicPassword(req.headers.get("authorization"));
  if (!token) {
    return new Response("authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="buildex"' },
    });
  }

  const authz = authorizeGit(deps.store, hashToken(token), repo, op);
  if (!authz.ok) return new Response(authz.status === 401 ? "unauthorized" : "forbidden", { status: authz.status });

  const bodyBuf = Buffer.from(await req.arrayBuffer());
  const res = await deps.git.cgi({
    repo,
    pathAfterRepo: rest,
    method: req.method,
    query: url.search.replace(/^\?/, ""),
    contentType: req.headers.get("content-type") ?? undefined,
    body: bodyBuf,
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

// --- helpers ---

/** Map a raw machine token to { companyId, machineId } (invariant 6), or null if unknown/revoked. */
function resolveCaller(store: ControlPlaneStore, token: string): Caller | null {
  const machine = store.findMachineByTokenHash(hashToken(token));
  if (!machine) return null;
  const op = store.getOperator(machine.operatorId);
  return op ? { companyId: op.companyId, machineId: machine.id } : null;
}

function requireServiceKey(req: Request, expected: string): void {
  const provided = req.headers.get("x-service-key") ?? "";
  if (!timingSafeEqualStr(provided, expected)) throw new AuthError("bad service key");
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ValidationError("invalid JSON body");
  }
}

/** Extract the password field of an HTTP Basic Authorization header (git sends the token there). */
function basicPassword(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    return idx === -1 ? null : decoded.slice(idx + 1);
  } catch {
    return null;
  }
}

function withCloneUrls(deps: AppDeps, creds: Credentials): {
  machineToken: string;
  refreshToken: string;
  repos: { core: string; team: string; private: string };
} {
  const url = (name: string) => `${deps.publicBaseUrl}/git/${name}.git`;
  return {
    machineToken: creds.machineToken,
    refreshToken: creds.refreshToken,
    repos: { core: url(creds.repos.core), team: url(creds.repos.team), private: url(creds.repos.private) },
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
