import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorHub } from "./connectors.js";
import { InMemoryKeychain } from "../keychain/keychain.js";
import type { FetchLike } from "@buildex/connectors";

// A fake that serves BOTH the OAuth token endpoint and the Gmail read API, so we can exercise the
// whole authorize→callback→token→live-list→file round-trip hermetically (no network).
const fakeFetch: FetchLike = async (url: string) => {
  if (url.includes("oauth2.googleapis.com/token")) {
    return { ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }), text: async () => "" };
  }
  if (url.includes("/messages/")) {
    const id = url.split("/messages/")[1]!.split("?")[0];
    return { ok: true, status: 200, json: async () => ({ id, threadId: `thr-${id}`, internalDate: String(Date.parse("2026-07-16T09:00:00Z")), payload: { headers: [{ name: "From", value: "dana@globex.com" }, { name: "Subject", value: "Live kickoff" }], body: { data: Buffer.from("real body", "utf8").toString("base64url") } } }), text: async () => "" };
  }
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: "gL1" }] }), text: async () => "" }; // messages.list
};

let repo: string, keychain: InMemoryKeychain, clock: number, hub: ConnectorHub;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "buildex-oauth-"));
  keychain = new InMemoryKeychain();
  clock = Date.parse("2026-07-16T12:00:00Z");
  hub = new ConnectorHub({
    repoDir: repo,
    keychain,
    now: () => clock,
    fetch: fakeFetch,
    redirectBase: "http://127.0.0.1:4317",
    oauthClients: { gmail: { clientId: "cid.apps", clientSecret: "secret" } },
    randomState: () => "STATE123",
    randomPkce: () => ({ verifier: "VER", challenge: "CHAL" }),
  });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("ConnectorHub OAuth - begin/finish + invariant 7 (one-time, TTL, validated state)", () => {
  it("beginAuth builds the authorize URL and stashes state + verifier in the keychain", () => {
    const { authorizeUrl } = hub.beginAuth("gmail");
    const u = new URL(authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("state")).toBe("STATE123");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4317/oauth/connector/gmail/callback");
    expect(keychain.get("connector:gmail:oauth:verifier")).toBe("VER");
    expect(hub.catalog().find((c) => c.name === "gmail")).toMatchObject({ connected: false, needsAuth: true });
  });

  it("finishAuth exchanges the code, stores tokens, and flips connected", async () => {
    hub.beginAuth("gmail");
    await hub.finishAuth("gmail", "authcode", "STATE123");
    expect(JSON.parse(keychain.get("connector:gmail:oauth:tokens")!)).toMatchObject({ accessToken: "AT", refreshToken: "RT" });
    expect(keychain.get("connector:gmail:oauth:state")).toBeUndefined(); // one-time - cleared
    expect(keychain.get("connector:gmail:oauth:verifier")).toBeUndefined();
    const gmail = hub.catalog().find((c) => c.name === "gmail")!;
    expect(gmail.connected).toBe(true);
    expect(gmail.needsAuth).toBeFalsy();
  });

  it("rejects a mismatched state and consumes it (single-use - a retry then finds nothing)", async () => {
    hub.beginAuth("gmail");
    await expect(hub.finishAuth("gmail", "authcode", "WRONG")).rejects.toThrow(/state/i);
    await expect(hub.finishAuth("gmail", "authcode", "STATE123")).rejects.toThrow(/no authorization|state/i);
  });

  it("rejects an expired authorization (TTL)", async () => {
    hub.beginAuth("gmail");
    clock += 11 * 60 * 1000; // past the 10-minute TTL
    await expect(hub.finishAuth("gmail", "authcode", "STATE123")).rejects.toThrow(/expire/i);
  });

  it("refuses OAuth for a connector with no client configured", () => {
    const bare = new ConnectorHub({ repoDir: repo, keychain, now: () => clock });
    expect(() => bare.beginAuth("gmail")).toThrow(/not configured|oauth/i);
  });
});

describe("ConnectorHub - once authorized, sync uses the LIVE Gmail API", () => {
  it("files a real (fetched) message under sources/gmail after authorization", async () => {
    hub.beginAuth("gmail");
    await hub.finishAuth("gmail", "authcode", "STATE123");
    const res = await hub.sync("gmail");
    expect(res.wrote).toBe(1);
    const filed = join(repo, "sources", "gmail", "thr-gL1.md");
    expect(existsSync(filed)).toBe(true);
    expect(readFileSync(filed, "utf8")).toContain("# Live kickoff");
    expect(readFileSync(filed, "utf8")).toContain("real body");
  });

  it("falls back to fixtures when no client is configured (demo stays functional)", async () => {
    const demo = new ConnectorHub({
      repoDir: repo, keychain, now: () => clock,
      fixtures: { gmail: [{ id: "fx", threadId: "fxt", from: "a@x", subject: "Fixture", date: "2026-07-16T09:00:00Z", body: "stub" }] },
    });
    const res = await demo.sync("gmail");
    expect(res.wrote).toBe(1);
    expect(readFileSync(join(repo, "sources", "gmail", "fxt.md"), "utf8")).toContain("# Fixture");
  });
});
