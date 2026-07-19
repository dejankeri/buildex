import { describe, it, expect } from "vitest";
import { opForService, authorizeGit, type AuthzStore } from "./authorize.js";
import { hashToken } from "../lib/tokens.js";

describe("opForService", () => {
  it("maps git services to read/write ops", () => {
    expect(opForService("git-upload-pack")).toBe("read");
    expect(opForService("git-receive-pack")).toBe("write");
  });
  it("rejects unknown services", () => {
    expect(() => opForService("git-evil-pack")).toThrow();
  });
});

// A tiny fake store exposing just what the authorizer needs.
function fakeStore(machines: Record<string, string>, perms: Record<string, Record<string, string>>): AuthzStore {
  return {
    findMachineByTokenHash: (h) => (machines[h] ? { operatorId: machines[h]! } : undefined),
    getAccess: (p, r) => (perms[p]?.[r] as "read" | "write" | undefined) ?? "none",
  };
}

const MTOK = "xmachine_" + "a".repeat(48);
const store = fakeStore(
  { [hashToken(MTOK)]: "o1" },
  { o1: { core: "read", "team-acme": "write" } },
);

describe("authorizeGit - the permission-matrix invariant", () => {
  it("allows an operator to READ core", () => {
    expect(authorizeGit(store, hashToken(MTOK), "core", "read")).toEqual({ ok: true, principal: "o1" });
  });

  it("REJECTS a non-admin push to core (403)", () => {
    expect(authorizeGit(store, hashToken(MTOK), "core", "write")).toEqual({ ok: false, status: 403 });
  });

  it("allows an operator to WRITE their team repo", () => {
    expect(authorizeGit(store, hashToken(MTOK), "team-acme", "write")).toEqual({ ok: true, principal: "o1" });
  });

  it("rejects access to a repo with no permission (403)", () => {
    expect(authorizeGit(store, hashToken(MTOK), "team-other", "read")).toEqual({ ok: false, status: 403 });
  });

  it("rejects an unknown/revoked machine token (401)", () => {
    // A revoked machine is absent from the store → its token no longer resolves.
    expect(authorizeGit(store, hashToken("xmachine_revoked"), "core", "read")).toEqual({ ok: false, status: 401 });
  });
});
