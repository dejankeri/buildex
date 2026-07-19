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
  it("binds loopback, serves /healthz, and first-run lands in the operator's own org with the Acme sandbox alongside", async () => {
    // appDataDir stands in for Electron's userData; the org registry lands under <tmp>/orgs.
    daemon = await startPackagedDaemon({ port: 0, appDataDir: tmp });

    expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(daemon.url + "/healthz")).status).toBe(200);

    const orgs = (await (await fetch(daemon.url + "/api/orgs")).json()) as {
      orgs: { id: string; name: string; sandbox: boolean }[];
      activeId: string;
    };
    const demo = orgs.orgs.find((o) => o.id === "demo");
    expect(demo).toMatchObject({ name: "Acme Labs", sandbox: true }); // the sandbox exists to explore...
    const active = orgs.orgs.find((o) => o.id === orgs.activeId);
    expect(active).toMatchObject({ name: "My Organization", sandbox: false }); // ...but a fresh install lands in the operator's own empty org, not the demo
  });

  it("widens PATH on boot so a Finder-launched app can still find the agent CLI", async () => {
    // Regression guard for the `spawn claude ENOENT` crash: booting from a bare PATH (what Finder
    // hands a .app) must leave the common install dirs reachable, or every agent spawn fails.
    const savedPath = process.env["PATH"];
    process.env["PATH"] = "/usr/bin:/bin"; // simulate the stripped GUI-launch PATH
    try {
      daemon = await startPackagedDaemon({ port: 0, appDataDir: tmp });
      const dirs = (process.env["PATH"] ?? "").split(":");
      expect(dirs).toContain("/opt/homebrew/bin");
      expect(dirs.some((d) => d.endsWith("/.local/bin"))).toBe(true);
      expect(dirs).toContain("/usr/bin"); // the inherited entries are preserved, not replaced
    } finally {
      process.env["PATH"] = savedPath;
    }
  });
});
