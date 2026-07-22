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
    expect(await tp.rotate()).toBe(true);
    expect(tp.current()).toBe("xmachine_new");
    expect(s.tokens()!.refreshToken).toBe("xrefresh_new");
  });

  it("rotate() returns false and leaves the old token when the server rejects the refresh", async () => {
    const s = store();
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(401, { error: "revoked" }) });
    expect(await tp.rotate()).toBe(false);
    expect(tp.current()).toBe("xmachine_old"); // unchanged - the account is not silently wiped
  });

  it("rotate() returns false with no account rather than throwing", async () => {
    const s = new AccountStore({ orgId: "o", orgDir: dir, keychain: new InMemoryKeychain() });
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(200, ROTATED) });
    expect(await tp.rotate()).toBe(false);
  });
});
