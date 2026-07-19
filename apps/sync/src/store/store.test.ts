import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "./store.js";
import { AuthError } from "../lib/errors.js";
import { hashToken } from "../lib/tokens.js";

// A mutable fake clock so TTL/expiry are tested without real waits (clock DI).
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

let dir: string;
let clock: ReturnType<typeof fakeClock>;
let store: ControlPlaneStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-store-"));
  clock = fakeClock();
  store = new ControlPlaneStore(join(dir, "control.db"), clock.now);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("companies & operators", () => {
  it("round-trips a company and an operator", () => {
    store.createCompany({ id: "c1", slug: "acme", name: "Acme Inc" });
    store.createOperator({ id: "o1", companyId: "c1", email: "a@acme.com" });

    expect(store.getCompany("c1")).toMatchObject({ id: "c1", slug: "acme", name: "Acme Inc", status: "active" });
    expect(store.getOperator("o1")).toMatchObject({ id: "o1", companyId: "c1", email: "a@acme.com", status: "active" });
  });

  it("returns undefined for unknown ids", () => {
    expect(store.getCompany("nope")).toBeUndefined();
    expect(store.getOperator("nope")).toBeUndefined();
  });
});

describe("setup tokens (one-time, TTL)", () => {
  beforeEach(() => {
    store.createCompany({ id: "c1", slug: "acme", name: "Acme" });
    store.createOperator({ id: "o1", companyId: "c1", email: "a@acme.com" });
  });

  it("mints a token, consumes it once, and binds it to the operator", () => {
    const raw = store.mintSetupToken({ operatorId: "o1", ttlMs: 10 * 60_000 });
    expect(raw.startsWith("xsetup_")).toBe(true);
    expect(store.consumeSetupToken(raw)).toEqual({ operatorId: "o1" });
  });

  it("rejects a second consumption (one-time)", () => {
    const raw = store.mintSetupToken({ operatorId: "o1", ttlMs: 10 * 60_000 });
    store.consumeSetupToken(raw);
    expect(() => store.consumeSetupToken(raw)).toThrow(AuthError);
  });

  it("rejects an expired token", () => {
    const raw = store.mintSetupToken({ operatorId: "o1", ttlMs: 60_000 });
    clock.advance(60_001);
    expect(() => store.consumeSetupToken(raw)).toThrow(AuthError);
  });

  it("rejects an unknown token", () => {
    expect(() => store.consumeSetupToken("xsetup_" + "0".repeat(48))).toThrow(AuthError);
  });
});

describe("machines & refresh rotation", () => {
  beforeEach(() => {
    store.createCompany({ id: "c1", slug: "acme", name: "Acme" });
    store.createOperator({ id: "o1", companyId: "c1", email: "a@acme.com" });
  });

  it("registers a machine and finds it by its access-token hash", () => {
    store.registerMachine({
      id: "m1", operatorId: "o1", name: "laptop",
      tokenHash: hashToken("xmachine_aaa"), refreshTokenHash: hashToken("xrefresh_aaa"),
    });
    const found = store.findMachineByTokenHash(hashToken("xmachine_aaa"));
    expect(found).toMatchObject({ id: "m1", operatorId: "o1" });
  });

  it("rotates tokens: the old refresh hash stops working, the new pair is stored", () => {
    store.registerMachine({
      id: "m1", operatorId: "o1", name: "laptop",
      tokenHash: hashToken("xmachine_old"), refreshTokenHash: hashToken("xrefresh_old"),
    });
    const m = store.rotateMachineTokens({
      refreshTokenHash: hashToken("xrefresh_old"),
      newTokenHash: hashToken("xmachine_new"),
      newRefreshTokenHash: hashToken("xrefresh_new"),
    });
    expect(m.id).toBe("m1");
    // old access token no longer resolves; new one does
    expect(store.findMachineByTokenHash(hashToken("xmachine_old"))).toBeUndefined();
    expect(store.findMachineByTokenHash(hashToken("xmachine_new"))).toMatchObject({ id: "m1" });
    // rotating again with the old refresh hash fails
    expect(() =>
      store.rotateMachineTokens({
        refreshTokenHash: hashToken("xrefresh_old"),
        newTokenHash: hashToken("x"), newRefreshTokenHash: hashToken("y"),
      }),
    ).toThrow(AuthError);
  });
});

describe("repo permission matrix", () => {
  beforeEach(() => {
    store.createCompany({ id: "c1", slug: "acme", name: "Acme" });
    store.createOperator({ id: "o1", companyId: "c1", email: "a@acme.com" });
  });

  it("stores and resolves access; unknown pairs are 'none'", () => {
    store.setRepoPermission({ principal: "o1", repo: "core", access: "read" });
    store.setRepoPermission({ principal: "o1", repo: "team-acme", access: "write" });
    expect(store.getAccess("o1", "core")).toBe("read");
    expect(store.getAccess("o1", "team-acme")).toBe("write");
    expect(store.getAccess("o1", "team-other")).toBe("none");
  });
});

describe("revoke - loses read+write within one request", () => {
  beforeEach(() => {
    store.createCompany({ id: "c1", slug: "acme", name: "Acme" });
    store.createOperator({ id: "o1", companyId: "c1", email: "a@acme.com" });
    store.registerMachine({
      id: "m1", operatorId: "o1", name: "laptop",
      tokenHash: hashToken("xmachine_aaa"), refreshTokenHash: hashToken("xrefresh_aaa"),
    });
    store.setRepoPermission({ principal: "o1", repo: "core", access: "read" });
    store.setRepoPermission({ principal: "o1", repo: "team-acme", access: "write" });
  });

  it("drops the operator's machines and permissions immediately", () => {
    store.revokeOperator("o1");
    expect(store.getOperator("o1")).toMatchObject({ status: "revoked" });
    expect(store.findMachineByTokenHash(hashToken("xmachine_aaa"))).toBeUndefined();
    expect(store.getAccess("o1", "core")).toBe("none");
    expect(store.getAccess("o1", "team-acme")).toBe("none");
  });
});

describe("audit events", () => {
  it("appends events with the injected clock's timestamp", () => {
    store.createCompany({ id: "c1", slug: "acme", name: "Acme" });
    store.addAuditEvent({ actor: "fde", companyId: "c1", action: "provision" });
    const events = store.listAuditEvents("c1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "fde", companyId: "c1", action: "provision", at: clock.now() });
  });
});

describe("secrets invariant: hash-at-rest", () => {
  it("never writes a raw token to the database file", () => {
    store.createCompany({ id: "c1", slug: "acme", name: "Acme" });
    store.createOperator({ id: "o1", companyId: "c1", email: "a@acme.com" });
    const setup = store.mintSetupToken({ operatorId: "o1", ttlMs: 60_000 });
    store.registerMachine({
      id: "m1", operatorId: "o1", name: "laptop",
      tokenHash: hashToken("xmachine_secret"), refreshTokenHash: hashToken("xrefresh_secret"),
    });
    // Force a WAL checkpoint so all bytes are on disk, then scan the raw file.
    store.checkpoint();
    const bytes = readFileSync(join(dir, "control.db"), "latin1");
    expect(bytes).not.toContain(setup);
    expect(bytes).not.toContain("xmachine_secret");
    expect(bytes).not.toContain("xrefresh_secret");
  });
});

describe("persistence across reopen", () => {
  it("survives a close and reopen", () => {
    store.createCompany({ id: "c1", slug: "acme", name: "Acme" });
    store.close();
    const reopened = new ControlPlaneStore(join(dir, "control.db"), clock.now);
    expect(reopened.getCompany("c1")).toMatchObject({ slug: "acme" });
    reopened.close();
  });
});
