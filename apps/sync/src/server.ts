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

  // Both stores open a real SQLite handle in their constructor, before this function has anything
  // to return. If construction after that point throws - most realistically ensureCoreRepo()
  // below, which shells out to `git init --bare` and can fail on a missing git binary, a
  // permissions problem, or a full disk - the caller never receives `close()`, so the handle
  // would otherwise leak for the life of the process (same defect class as ee770eb, reached via
  // a construction failure instead of a missing close call). Track what has been opened so far
  // and close it before rethrowing; do not "simplify" this away.
  const opened: Array<{ close: () => void }> = [];
  let store: ControlPlaneStore;
  let schedules: ScheduleStore;
  let git: EmbeddedGitService;
  let provisioning: ProvisioningService;
  try {
    store = new ControlPlaneStore(join(config.dataDir, "control.db"));
    opened.push(store);
    schedules = new ScheduleStore(join(config.dataDir, "schedules.db"));
    opened.push(schedules);
    git = new EmbeddedGitService({ reposRoot });
    provisioning = new ProvisioningService({ store, git, idFactory: () => randomUUID() });

    // `ensureCoreRepo` is documented as "call at boot": core is the one repo not created by a
    // provision, so without this the first operator's clone of core would 404.
    await provisioning.ensureCoreRepo();
  } catch (err) {
    for (const s of opened) {
      try {
        s.close();
      } catch {
        // Best-effort: the original construction failure is what the caller needs to see, not a
        // secondary error from closing an already-broken handle.
      }
    }
    throw err;
  }

  const handler = createApp({
    store,
    provisioning,
    git,
    schedules,
    serviceKey: config.serviceKey,
    publicBaseUrl: config.publicBaseUrl,
  });

  // BOTH stores must close, even if the first throws - otherwise the second handle leaks, which
  // is exactly what blocked cleanup before ee770eb.
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      store.close();
    } finally {
      schedules.close();
    }
  };

  return { handler, close };
}
