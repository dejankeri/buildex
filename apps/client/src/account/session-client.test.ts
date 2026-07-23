import { describe, it, expect } from "vitest";
import { postSession } from "./session-client.js";
import { ProvisionError } from "./provision-client.js";

const OK = {
  machineToken: "xmachine_" + "a".repeat(48),
  refreshToken: "xrefresh_" + "b".repeat(48),
  repos: {
    core: "https://sync.test/git/core.git",
    team: "https://sync.test/git/team-acme.git",
    private: "https://sync.test/git/private-o1.git",
  },
};

function fakeFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("postSession", () => {
  it("posts jwt + machineName to /session and returns the credentials", async () => {
    let seenUrl = "", seenBody = "";
    const f = fakeFetch(200, OK, (u, i) => { seenUrl = u; seenBody = String(i.body); });
    const r = await postSession({ fetch: f, baseUrl: "https://sync.test" }, { jwt: "xjwt_t", machineName: "laptop" });
    expect(seenUrl).toBe("https://sync.test/session");
    expect(JSON.parse(seenBody)).toEqual({ jwt: "xjwt_t", machineName: "laptop" });
    expect(r).toEqual(OK);
  });

  it("does not put a trailing-slash baseUrl into a doubled path", async () => {
    let seenUrl = "";
    const f = fakeFetch(200, OK, (u) => { seenUrl = u; });
    await postSession({ fetch: f, baseUrl: "https://sync.test/" }, { jwt: "xjwt_t", machineName: "laptop" });
    expect(seenUrl).toBe("https://sync.test/session");
  });

  it("raises a typed ProvisionError carrying the status when the jwt is rejected", async () => {
    const f = fakeFetch(401, { error: "invalid or expired session" });
    await expect(postSession({ fetch: f, baseUrl: "https://sync.test" }, { jwt: "bad", machineName: "laptop" }))
      .rejects.toMatchObject({ status: 401 });
    await expect(postSession({ fetch: f, baseUrl: "https://sync.test" }, { jwt: "bad", machineName: "laptop" }))
      .rejects.toBeInstanceOf(ProvisionError);
  });

  it("rejects an unparseable 200 body as a ProvisionError, not a raw SyntaxError", async () => {
    const f = (async () => new Response("this is not json{", { status: 200 })) as unknown as typeof fetch;
    await expect(postSession({ fetch: f, baseUrl: "https://sync.test" }, { jwt: "xjwt_t", machineName: "laptop" }))
      .rejects.toBeInstanceOf(ProvisionError);
  });

  it("raises a typed ProvisionError with status 0 when the network call throws", async () => {
    const f = (async () => { throw new Error("getaddrinfo ENOTFOUND sync.test"); }) as unknown as typeof fetch;
    await expect(postSession({ fetch: f, baseUrl: "https://sync.test" }, { jwt: "xjwt_t", machineName: "laptop" }))
      .rejects.toMatchObject({ status: 0 });
    await expect(postSession({ fetch: f, baseUrl: "https://sync.test" }, { jwt: "xjwt_t", machineName: "laptop" }))
      .rejects.toBeInstanceOf(ProvisionError);
  });
});
