// The packaged daemon boot (B2b): starting from the same entry the bundle exposes, the multi-org
// daemon binds loopback, serves /healthz, and first-run shows the "Acme Labs" demo SANDBOX as the
// active org. Same-process fetch against a loopback server (no inter-process network) - the dev
// fallback resolves the repo's own pack in place of the app bundle.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPackagedDaemon } from "./daemon-entry.js";
import type { RunningDaemon } from "./server-main.js";

let tmp: string;
let daemon: RunningDaemon | null;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "buildex-entry-"));
  daemon = null;
});
afterEach(async () => {
  if (daemon) await daemon.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("startPackagedDaemon - the shipped app's boot", () => {
  it("binds loopback, serves /healthz, and first-run offers the demo sandbox as the active org", async () => {
    // appDataDir stands in for Electron's userData; the org registry lands under <tmp>/orgs.
    daemon = await startPackagedDaemon({ port: 0, appDataDir: tmp });

    expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(daemon.url + "/healthz")).status).toBe(200);

    const orgs = (await (await fetch(daemon.url + "/api/orgs")).json()) as {
      orgs: { id: string; name: string; sandbox: boolean }[];
      activeId: string;
    };
    const demo = orgs.orgs.find((o) => o.id === "demo");
    expect(demo).toMatchObject({ name: "Acme Labs", sandbox: true });
    expect(orgs.activeId).toBe("demo"); // a fresh install lands in the play-now sandbox
  });
});
