import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../store/store.js";
import { ProvisioningService } from "./service.js";
import type { GitService } from "../git/types.js";
import { AuthError } from "../lib/errors.js";
import { hashToken } from "../lib/tokens.js";

// A fake embedded-git service that just records which repos were ensured (the seam we depend on).
class FakeGit implements GitService {
  ensured: string[] = [];
  async ensureRepo(name: string): Promise<void> {
    if (!this.ensured.includes(name)) this.ensured.push(name);
  }
}

let dir: string;
let store: ControlPlaneStore;
let git: FakeGit;
let svc: ProvisioningService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-prov-"));
  let t = 1_700_000_000_000;
  store = new ControlPlaneStore(join(dir, "control.db"), () => t);
  git = new FakeGit();
  svc = new ProvisioningService({ store, git, idFactory: seqIds() });
  store.createCompany({ id: "c1", slug: "acme", name: "Acme" });
  store.createOperator({ id: "o1", companyId: "c1", email: "a@acme.com" });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// Deterministic machine ids for tests (no Math.random in the seam).
function seqIds() {
  let n = 0;
  return () => `m${++n}`;
}

describe("provision", () => {
  it("consumes the setup token and returns credentials + the three repos", async () => {
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 600_000 });
    const creds = await svc.provision({ setupToken: setup, machineName: "laptop" });

    expect(creds.machineToken.startsWith("xmachine_")).toBe(true);
    expect(creds.refreshToken.startsWith("xrefresh_")).toBe(true);
    expect(creds.repos).toEqual({ core: "core", team: "team-acme", private: "private-o1" });
  });

  it("ensures all three bare repos exist", async () => {
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 600_000 });
    await svc.provision({ setupToken: setup, machineName: "laptop" });
    expect(git.ensured.sort()).toEqual(["core", "private-o1", "team-acme"]);
  });

  it("writes the permission matrix: core read, team+private write", async () => {
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 600_000 });
    await svc.provision({ setupToken: setup, machineName: "laptop" });
    expect(store.getAccess("o1", "core")).toBe("read");
    expect(store.getAccess("o1", "team-acme")).toBe("write");
    expect(store.getAccess("o1", "private-o1")).toBe("write");
  });

  it("registers the machine so its access token resolves", async () => {
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 600_000 });
    const creds = await svc.provision({ setupToken: setup, machineName: "laptop" });
    const m = store.findMachineByTokenHash(hashToken(creds.machineToken));
    expect(m).toMatchObject({ operatorId: "o1", name: "laptop" });
  });

  it("records an audit event", async () => {
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 600_000 });
    await svc.provision({ setupToken: setup, machineName: "laptop" });
    expect(store.listAuditEvents("c1").map((e) => e.action)).toContain("provision");
  });

  it("rejects an invalid/consumed setup token", async () => {
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 600_000 });
    await svc.provision({ setupToken: setup, machineName: "laptop" });
    await expect(svc.provision({ setupToken: setup, machineName: "again" })).rejects.toThrow(AuthError);
  });
});

describe("refresh", () => {
  it("rotates to a new pair; the old refresh token stops working", async () => {
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 600_000 });
    const first = await svc.provision({ setupToken: setup, machineName: "laptop" });

    const rotated = await svc.refresh(first.refreshToken);
    expect(rotated.machineToken).not.toBe(first.machineToken);
    expect(store.findMachineByTokenHash(hashToken(first.machineToken))).toBeUndefined();
    expect(store.findMachineByTokenHash(hashToken(rotated.machineToken))).toMatchObject({ operatorId: "o1" });
    await expect(svc.refresh(first.refreshToken)).rejects.toThrow(AuthError);
  });
});

describe("revoke", () => {
  it("kills the machine and strips permissions immediately", async () => {
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 600_000 });
    const creds = await svc.provision({ setupToken: setup, machineName: "laptop" });

    await svc.revoke("o1");
    expect(store.getOperator("o1")).toMatchObject({ status: "revoked" });
    expect(store.findMachineByTokenHash(hashToken(creds.machineToken))).toBeUndefined();
    expect(store.getAccess("o1", "team-acme")).toBe("none");
  });
});
