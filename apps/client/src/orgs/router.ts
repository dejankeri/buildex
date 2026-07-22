// The org router (B2a): a thin layer ABOVE the single-workspace daemon handler. It owns the small
// `/api/orgs` surface (list / create / switch) and delegates every other request to the handler of
// whichever org is currently active. Switching orgs rebuilds the handler for the new org's workspace
// (buildClientHandler is a pure function of config), so no daemon subsystem has to learn about
// multiple orgs - the whole existing single-workspace stack is reused unchanged.
//
// The connector gateway IS per-org: the base config may include `connectorsMcp`, and each org gets its
// own live gateway (its own OAuth/MCP status). Because the gateway binds a FIXED loopback port, a
// switch must fully tear down the previous org's gateway before rebinding for the next - so the router
// captures each org's gateway host (via the onGatewayHost hook) and awaits its close() before building
// the next org's handler. File connectors (sources/) work per-org regardless.
import { buildClientHandler, type ClientConfig } from "../wiring.js";
import type { Handler } from "../daemon/daemon.js";
import { OrgManager, type Org } from "./manager.js";
import type { SyncScheduler } from "../sync/scheduler.js";

/** Everything the daemon handler needs EXCEPT what varies per org (workspace/roots/company) and the
 *  lifecycle hooks the router owns (scheduler + gateway host). `connectorsMcp` IS allowed - it's shared
 *  by every org, and the router manages the per-org gateway lifecycle around it. `orgId`/`orgDir`/
 *  `sandbox`/`fetch` are ALSO allowed through (not excluded): `activate()` below always sets
 *  orgId/orgDir/sandbox from the org being activated, overriding anything a caller put in baseConfig,
 *  so leaving them in the type is harmless - and `fetch` is a shared injected test seam, same as
 *  connectorsMcp. */
export type OrgBaseConfig = Omit<ClientConfig, "workspace" | "roots" | "company" | "onScheduler" | "onGatewayHost">;

export interface OrgRouterDeps {
  manager: OrgManager;
  baseConfig: OrgBaseConfig;
  /** Injectable for hermetic tests; defaults to the real buildClientHandler. */
  buildHandler?: (config: ClientConfig) => Handler;
}

export interface OrgRouter {
  handler: Handler;
  /** Release the active org's background resources - sync loop + connector-gateway host (called on
   *  daemon shutdown). Async: awaits the gateway host's close so the port is freed. */
  close: () => Promise<void>;
  /** The currently-active org id (for tests / diagnostics). */
  activeId: () => string;
}

type GatewayHost = { close: () => Promise<void> };

export function createOrgRouter(deps: OrgRouterDeps): OrgRouter {
  const build = deps.buildHandler ?? buildClientHandler;
  let current: {
    org: Org;
    handler: Handler;
    scheduler: SyncScheduler | null;
    gatewayHostP: Promise<GatewayHost> | null;
  } | null = null;

  // Tear down the currently-active org's background resources: stop its sync loop and CLOSE its
  // connector-gateway HTTP host, awaiting the close so the fixed gateway port is free before the next
  // org rebinds it. Safe to call with no active org. A gateway that failed to bind (rejected promise)
  // is swallowed - there is nothing to close.
  async function teardownCurrent(): Promise<void> {
    if (!current) return;
    current.scheduler?.stop();
    if (current.gatewayHostP) {
      try {
        const host = await current.gatewayHostP;
        await host.close();
      } catch {
        /* host never bound (or already gone) - nothing to close */
      }
    }
  }

  // Build + install the handler for `org` and record its lifecycle handles. SYNCHRONOUS: it must not
  // await, so the boot path can return a ready router. Any teardown of a PREVIOUS org happens before
  // this is called (see teardownCurrent) - here `current` is always either null or already torn down.
  function activate(org: Org): void {
    let scheduler: SyncScheduler | null = null;
    let gatewayHostP: Promise<GatewayHost> | null = null;
    const config: ClientConfig = {
      ...deps.baseConfig,
      workspace: org.workspace,
      roots: org.roots,
      company: { name: org.name },
      // The account seam: `org.dir` (not `org.workspace`) is the org's own top-level directory - see
      // OrgManager.orgDir/resolve - where account.json lives, sibling to (not inside) the workspace.
      orgId: org.id,
      orgDir: org.dir,
      sandbox: org.sandbox,
      onScheduler: (s) => {
        scheduler = s;
        s.start();
      },
      onGatewayHost: (hostP) => {
        gatewayHostP = hostP;
        // Own the promise's rejection now: if the host never binds, teardownCurrent's later await is
        // the only other consumer, and until then this keeps a bind failure from surfacing as an
        // unhandled rejection.
        hostP.catch(() => {});
      },
    };
    const handler = build(config);
    current = { org, handler, scheduler, gatewayHostP };
  }

  // Switch the active org: fully release the previous org's gateway/sync BEFORE building the next
  // (the gateway port is fixed, so the close must complete first), then activate the new one.
  async function switchTo(org: Org): Promise<void> {
    await teardownCurrent();
    activate(org);
  }

  // Boot: on first run this stands up the operator's own empty org (active) alongside the Acme
  // sandbox; on later boots it resolves the persisted active org. First activation has nothing to tear
  // down, so it's a plain synchronous activate - the router is returned ready.
  activate(deps.manager.bootstrap());

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
      await switchTo(org);
      return json({ ok: true, activeId: id });
    }

    if (path === "/api/orgs/create" && req.method === "POST") {
      const body = await readJson<{ name?: string }>(req);
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return json({ error: "name required" }, 400);
      const org = deps.manager.create({ name }); // seeds + sets active
      await switchTo(org);
      return json({ id: org.id, name: org.name }, 201);
    }

    // Clear every org's stored credentials from the OS vault - the honest "remove all data" before an
    // uninstall (macOS runs no code on drag-to-Trash, so nothing else can reach the vault). Workspace
    // FILES are left intact (invariant 8); only the connector tokens / git credentials are wiped.
    if (path === "/api/orgs/forget-secrets" && req.method === "POST") {
      return json({ ok: true, cleared: deps.manager.forgetAllSecrets() });
    }

    return current!.handler(req);
  };

  return {
    handler,
    close: () => teardownCurrent(),
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
