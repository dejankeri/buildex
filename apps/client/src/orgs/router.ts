// The org router (B2a): a thin layer ABOVE the single-workspace daemon handler. It owns the small
// `/api/orgs` surface (list / create / switch) and delegates every other request to the handler of
// whichever org is currently active. Switching orgs rebuilds the handler for the new org's workspace
// (buildClientHandler is a pure function of config), so no daemon subsystem has to learn about
// multiple orgs - the whole existing single-workspace stack is reused unchanged.
//
// v1 limitation (documented): the base config passed here must NOT include `connectorsMcp`. The
// connector gateway binds a fixed loopback port and exposes no teardown, so rebuilding on switch would
// leak/conflict it. File connectors (sources/) work per-org regardless. Per-org live gateways are a
// follow-up that needs buildClientHandler to return a disposable.
import { buildClientHandler, type ClientConfig } from "../wiring.js";
import type { Handler } from "../daemon/daemon.js";
import { OrgManager, type Org } from "./manager.js";
import type { SyncScheduler } from "../sync/scheduler.js";

/** Everything the daemon handler needs EXCEPT what varies per org (workspace/roots/company) and the
 *  scheduler hook (the router owns lifecycle). Deliberately excludes connectorsMcp for v1. */
export type OrgBaseConfig = Omit<ClientConfig, "workspace" | "roots" | "company" | "onScheduler" | "connectorsMcp">;

export interface OrgRouterDeps {
  manager: OrgManager;
  baseConfig: OrgBaseConfig;
  /** Injectable for hermetic tests; defaults to the real buildClientHandler. */
  buildHandler?: (config: ClientConfig) => Handler;
}

export interface OrgRouter {
  handler: Handler;
  /** Stop the active org's background sync loop (called on daemon shutdown). */
  close: () => void;
  /** The currently-active org id (for tests / diagnostics). */
  activeId: () => string;
}

export function createOrgRouter(deps: OrgRouterDeps): OrgRouter {
  const build = deps.buildHandler ?? buildClientHandler;
  let current: { org: Org; handler: Handler; scheduler: SyncScheduler | null } | null = null;

  function activate(org: Org): void {
    current?.scheduler?.stop(); // tear down the previous org's sync loop before rebuilding
    let scheduler: SyncScheduler | null = null;
    const config: ClientConfig = {
      ...deps.baseConfig,
      workspace: org.workspace,
      roots: org.roots,
      company: { name: org.name },
      onScheduler: (s) => {
        scheduler = s;
        s.start();
      },
    };
    const handler = build(config);
    current = { org, handler, scheduler };
  }

  // Boot: guarantee the demo sandbox exists, then activate the persisted (or fallback) active org.
  deps.manager.ensureDemo();
  const active = deps.manager.active() ?? deps.manager.ensureDemo();
  deps.manager.setActive(active.id); // persist the resolved choice so it's stable next boot
  activate(active);

  const view = (org: Org) => ({ id: org.id, name: org.name, sandbox: org.sandbox });

  const handler: Handler = async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/orgs" && req.method === "GET") {
      return json({ orgs: deps.manager.list().map(view), activeId: current!.org.id });
    }

    if (path === "/api/orgs/switch" && req.method === "POST") {
      const body = await readJson<{ id?: string }>(req);
      const id = body?.id;
      if (!id || typeof id !== "string") return json({ error: "id required" }, 400);
      const org = deps.manager.get(id);
      if (!org) return json({ error: "unknown org" }, 404);
      deps.manager.setActive(id);
      activate(org);
      return json({ ok: true, activeId: id });
    }

    if (path === "/api/orgs/create" && req.method === "POST") {
      const body = await readJson<{ name?: string }>(req);
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return json({ error: "name required" }, 400);
      const org = deps.manager.create({ name }); // seeds + sets active
      activate(org);
      return json({ id: org.id, name: org.name }, 201);
    }

    return current!.handler(req);
  };

  return {
    handler,
    close: () => current?.scheduler?.stop(),
    activeId: () => current!.org.id,
  };
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
