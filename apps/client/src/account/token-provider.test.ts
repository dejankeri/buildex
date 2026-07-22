import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "./account-store.js";
import { makeTokenProvider } from "./token-provider.js";

const RESULT = {
  machineToken: "xmachine_old", refreshToken: "xrefresh_old",
  repos: { core: "https://s/git/core.git", team: "https://s/git/team-acme.git", private: "https://s/git/private-o1.git" },
};
const ROTATED = { ...RESULT, machineToken: "xmachine_new", refreshToken: "xrefresh_new" };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildex-tp-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store() {
  const s = new AccountStore({ orgId: "o", orgDir: dir, keychain: new InMemoryKeychain() });
  s.save("https://s", RESULT);
  return s;
}
const fetchWith = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("token-provider", () => {
  it("hands out the stored machine token", () => {
    const tp = makeTokenProvider({ store: store(), fetch: fetchWith(200, ROTATED) });
    expect(tp.current()).toBe("xmachine_old");
  });

  it("undefined when there is no account", () => {
    const s = new AccountStore({ orgId: "o", orgDir: dir, keychain: new InMemoryKeychain() });
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(200, ROTATED) });
    expect(tp.current()).toBeUndefined();
  });

  it("rotate() refreshes, persists the new pair, and current() reflects it", async () => {
    const s = store();
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(200, ROTATED) });
    expect(await tp.rotate()).toBe("rotated");
    expect(tp.current()).toBe("xmachine_new");
    expect(s.tokens()!.refreshToken).toBe("xrefresh_new");
  });

  it("rotate() reports revoked and leaves the old token when the server rejects the refresh", async () => {
    const s = store();
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(401, { error: "revoked" }) });
    expect(await tp.rotate()).toBe("revoked");
    expect(tp.current()).toBe("xmachine_old"); // unchanged - the account is not silently wiped
  });

  it("rotate() reports offline with no account rather than throwing", async () => {
    const s = new AccountStore({ orgId: "o", orgDir: dir, keychain: new InMemoryKeychain() });
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(200, ROTATED) });
    expect(await tp.rotate()).toBe("offline");
  });

  it("rotate() reports offline (transient) when the refresh cannot reach the server", async () => {
    const s = store();
    const throwing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const tp = makeTokenProvider({ store: s, fetch: throwing });
    expect(await tp.rotate()).toBe("offline"); // network failure is NOT a revocation
    expect(tp.current()).toBe("xmachine_old"); // pair left in place
  });

  it("rotate() reports offline (transient), not revoked, on a 5xx", async () => {
    const s = store();
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(503, { error: "down" }) });
    expect(await tp.rotate()).toBe("offline");
    expect(tp.current()).toBe("xmachine_old");
  });
});
