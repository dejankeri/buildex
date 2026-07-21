// The composition root: turns a validated config into a live request handler by wiring the four
// services that already exist. It deliberately knows nothing about sockets, signals, or process exit -
// that is main.ts - so the wiring stays testable in-process against a temp directory.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlaneStore } from "./store/store.js";
import { ScheduleStore } from "./automations/schedule-store.js";
import { EmbeddedGitService } from "./git/service.js";
import { ProvisioningService } from "./provisioning/service.js";
import { createApp, type Handler } from "./http/app.js";
import type { SyncConfig } from "./config.js";

export interface Services {
  handler: Handler;
  /** Release every SQLite handle. Idempotent: shutdown can race a signal with an error path. */
  close: () => void;
}

export async function createServices(config: SyncConfig): Promise<Services> {
  const reposRoot = join(config.dataDir, "repos");
  mkdirSync(reposRoot, { recursive: true }); // also creates dataDir - first boot on a fresh volume

  const store = new ControlPlaneStore(join(config.dataDir, "control.db"));
  const schedules = new ScheduleStore(join(config.dataDir, "schedules.db"));
  const git = new EmbeddedGitService({ reposRoot });
  const provisioning = new ProvisioningService({ store, git, idFactory: () => randomUUID() });

  // `ensureCoreRepo` is documented as "call at boot": core is the one repo not created by a
  // provision, so without this the first operator's clone of core would 404.
  await provisioning.ensureCoreRepo();

  const handler = createApp({
    store,
    provisioning,
    git,
    schedules,
    serviceKey: config.serviceKey,
    publicBaseUrl: config.publicBaseUrl,
  });

  // BOTH stores must close. Leaving either open is what blocked cleanup before ee770eb.
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    store.close();
    schedules.close();
  };

  return { handler, close };
}
