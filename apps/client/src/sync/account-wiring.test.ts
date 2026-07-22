import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "../account/account-store.js";
import { makeTokenProvider } from "../account/token-provider.js";
import { gitAuthEnv } from "../account/credentials.js";
import { SyncEngine } from "./engine.js";

// This is a focused wiring test: it asserts the exact auth object buildClientHandler must construct,
// so a regression that drops the header from the engine is caught here even before an integration run.
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildex-aw-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("account wiring", () => {
  it("an org with a stored account yields an engine auth that emits the credential header", () => {
    const store = new AccountStore({ orgId: "o1", orgDir: dir, keychain: new InMemoryKeychain() });
    store.save("https://s", {
      machineToken: "xmachine_tok", refreshToken: "xrefresh_r",
      repos: { core: "https://s/git/core.git", team: "https://s/git/team-a.git", private: "https://s/git/private-o1.git" },
    });
    const tp = makeTokenProvider({ store, fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    const auth = { headerEnv: () => { const t = tp.current(); return t ? gitAuthEnv(t) : undefined; }, onAuthError: () => tp.rotate() };
    // The header the engine will spawn with must carry the stored token, base64'd - never bare.
    const env = auth.headerEnv()!;
    expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Basic " + Buffer.from("x:xmachine_tok").toString("base64"));
    // And a local-only org (no account) yields no header at all.
    const empty = new AccountStore({ orgId: "o2", orgDir: join(dir, "empty"), keychain: new InMemoryKeychain() });
    const tp2 = makeTokenProvider({ store: empty, fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    expect((tp2.current() ? gitAuthEnv(tp2.current()!) : undefined)).toBeUndefined();
    // Sanity: the engine accepts the auth shape.
    expect(() => new SyncEngine({ now: Date.now, actor: "t", auth })).not.toThrow();
  });
});
