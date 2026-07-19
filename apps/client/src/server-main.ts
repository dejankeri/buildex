// Daemon boot entry - binds the client composition root to a real Node http server on loopback.
// Used by the headless demo runner and by the Electron shell (which loads the returned URL). The
// server disables request timeouts (long agent turns stream over SSE) via createNodeServer.
import type { AddressInfo } from "node:net";
import { buildClientHandler, type ClientConfig } from "./wiring.js";
import { createNodeServer } from "./daemon/node-adapter.js";
import type { Root } from "./brain/graph.js";
import { OrgManager } from "./orgs/manager.js";
import { createOrgRouter, type OrgBaseConfig } from "./orgs/router.js";

export interface StartOpts extends ClientConfig {
  /** Loopback port; 0 (default) picks a free one. */
  port?: number;
}

export interface RunningDaemon {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startDaemon(opts: StartOpts): Promise<RunningDaemon> {
  // Capture the background sync loop so we can run its idle pull tick while the daemon is up and do a
  // final flush on shutdown (so a debounced edit made just before quit still commits).
  let scheduler: { start(): void; stop(): void } | null = null;
  const handler = buildClientHandler({ ...opts, onScheduler: (s) => { scheduler = s; s.start(); } });
  const server = createNodeServer(handler);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  // Also serve on the IPv6 loopback (::1) with the SAME handler, so a redirect/client that uses the
  // host `localhost` reaches the daemon even where `localhost` resolves to ::1. Some OAuth providers
  // (e.g. Calendly) require a `localhost` redirect and reject `127.0.0.1`; the callback then arrives on
  // ::1. Best-effort and loopback-only - if ::1 is unavailable (IPv6 disabled), 127.0.0.1 still serves.
  const server6 = createNodeServer(handler);
  await new Promise<void>((resolve) => {
    server6.once("error", () => resolve()); // bind failed (no IPv6) - carry on with 127.0.0.1 only
    server6.listen(port, "::1", () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        try { server6.close(); } catch { /* may not have bound */ }
        server.close(() => {
          scheduler?.stop();
          resolve();
        });
      }),
  };
}

export interface StartOrgOpts {
  /** Where the org registry lives (see orgs/roots.ts resolveOrgsRoot). */
  orgsRoot: string;
  /** The daemon config shared by every org (everything except per-org workspace/roots/company). */
  base: OrgBaseConfig;
  /** Seed a fresh real org's workspace (default caller: the local-workspace provisioner). */
  seedReal: (workspace: string) => Root[];
  /** Seed the demo SANDBOX org's workspace (rich Acme brain, NO remotes → never syncs). */
  seedDemo: (workspace: string) => Root[];
  /** Loopback port; 0 (default) picks a free one. */
  port?: number;
}

/** Boot the multi-org daemon (B2a): serve the org router (list/create/switch + delegation) on
 *  loopback. Mirrors startDaemon's binding (127.0.0.1 + best-effort ::1), but the served handler
 *  swaps its underlying single-workspace handler as the active org changes. */
export async function startOrgDaemon(opts: StartOrgOpts): Promise<RunningDaemon> {
  const manager = new OrgManager({ orgsRoot: opts.orgsRoot, seedReal: opts.seedReal, seedDemo: opts.seedDemo });
  const router = createOrgRouter({ manager, baseConfig: opts.base });

  const server = createNodeServer(router.handler);
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const server6 = createNodeServer(router.handler);
  await new Promise<void>((resolve) => {
    server6.once("error", () => resolve());
    server6.listen(port, "::1", () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        try { server6.close(); } catch { /* may not have bound */ }
        server.close(() => {
          router.close();
          resolve();
        });
      }),
  };
}
