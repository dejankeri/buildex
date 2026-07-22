import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore, machineTokenKey, refreshTokenKey } from "./account-store.js";

const RESULT = {
  machineToken: "xmachine_" + "a".repeat(48),
  refreshToken: "xrefresh_" + "b".repeat(48),
  repos: {
    core: "https://sync.test/git/core.git",
    team: "https://sync.test/git/team-acme.git",
    private: "https://sync.test/git/private-o1.git",
  },
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildex-acct-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make() {
  const keychain = new InMemoryKeychain();
  return { keychain, store: new AccountStore({ orgId: "org1", orgDir: dir, keychain }) };
}

describe("AccountStore", () => {
  it("keys the token pair per-org, exactly", () => {
    expect(machineTokenKey("org1")).toBe("org:org1:machine-token");
    expect(refreshTokenKey("org1")).toBe("org:org1:refresh-token");
  });

  it("writes non-secrets to account.json and the tokens ONLY to the keychain", () => {
    const { keychain, store } = make();
    const acct = store.save("https://sync.test", RESULT);
    expect(acct.operatorId).toBe("o1");     // parsed from private-o1.git
    expect(acct.companySlug).toBe("acme");  // parsed from team-acme.git
    expect(acct.repos).toEqual(RESULT.repos);

    const raw = readFileSync(join(dir, "account.json"), "utf8");
    expect(raw).not.toContain("xmachine_"); // NO token on disk
    expect(raw).not.toContain("xrefresh_");
    expect(JSON.parse(raw).baseUrl).toBe("https://sync.test");

    expect(keychain.get("org:org1:machine-token")).toBe(RESULT.machineToken);
    expect(keychain.get("org:org1:refresh-token")).toBe(RESULT.refreshToken);
  });

  it("round-trips: load() and tokens() return what save() stored", () => {
    const { store } = make();
    store.save("https://sync.test", RESULT);
    expect(store.connected()).toBe(true);
    expect(store.load()).toMatchObject({ baseUrl: "https://sync.test", operatorId: "o1", companySlug: "acme" });
    expect(store.tokens()).toEqual({ machineToken: RESULT.machineToken, refreshToken: RESULT.refreshToken });
  });

  it("reports not-connected before any save", () => {
    const { store } = make();
    expect(store.connected()).toBe(false);
    expect(store.load()).toBeNull();
    expect(store.tokens()).toBeNull();
  });

  it("reads a corrupt account.json as not-connected rather than crashing the daemon", () => {
    // The daemon calls load() on every status poll; a truncated or garbage file (a crash mid-write,
    // a bad edit) must degrade to "no account" (invariant: never 500 the poll), never throw.
    const { store } = make();
    writeFileSync(join(dir, "account.json"), "{ this is not valid json");
    expect(store.load()).toBeNull();
    expect(store.connected()).toBe(false);
  });

  it("setTokens rotates the keychain pair without rewriting account.json", () => {
    const { keychain, store } = make();
    store.save("https://sync.test", RESULT);
    store.setTokens({ machineToken: "xmachine_new", refreshToken: "xrefresh_new" });
    expect(keychain.get("org:org1:machine-token")).toBe("xmachine_new");
    expect(existsSync(join(dir, "account.json"))).toBe(true);
  });
});
