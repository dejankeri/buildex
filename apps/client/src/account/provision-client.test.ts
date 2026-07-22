import { describe, it, expect } from "vitest";
import { provision, refresh, ProvisionError } from "./provision-client.js";

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

describe("provision", () => {
  it("posts setupToken + machineName to /provision and returns the credentials", async () => {
    let seenUrl = "", seenBody = "";
    const f = fakeFetch(200, OK, (u, i) => { seenUrl = u; seenBody = String(i.body); });
    const r = await provision({ fetch: f, baseUrl: "https://sync.test" }, { setupToken: "xsetup_t", machineName: "laptop" });
    expect(seenUrl).toBe("https://sync.test/provision");
    expect(JSON.parse(seenBody)).toEqual({ setupToken: "xsetup_t", machineName: "laptop" });
    expect(r).toEqual(OK);
  });

  it("does not put a trailing-slash baseUrl into a doubled path", async () => {
    let seenUrl = "";
    const f = fakeFetch(200, OK, (u) => { seenUrl = u; });
    await provision({ fetch: f, baseUrl: "https://sync.test/" }, { setupToken: "x", machineName: "m" });
    expect(seenUrl).toBe("https://sync.test/provision");
  });

  it("raises a typed ProvisionError carrying the status when the token is rejected", async () => {
    const f = fakeFetch(401, { error: "invalid setup token" });
    await expect(provision({ fetch: f, baseUrl: "https://sync.test" }, { setupToken: "bad", machineName: "m" }))
      .rejects.toMatchObject({ status: 401 });
    await expect(provision({ fetch: f, baseUrl: "https://sync.test" }, { setupToken: "bad", machineName: "m" }))
      .rejects.toBeInstanceOf(ProvisionError);
  });

  it("rejects a 200 whose body is missing a token, rather than returning a half-formed account", async () => {
    const f = fakeFetch(200, { repos: OK.repos }); // no machineToken
    await expect(refresh({ fetch: f, baseUrl: "https://sync.test" }, "xrefresh_x")).rejects.toBeInstanceOf(ProvisionError);
  });

  it("rejects an unparseable 200 body as a ProvisionError, not a raw SyntaxError", async () => {
    // Symmetric with the error path, which already guards res.json(). A garbage 200 must not escape
    // the module as a SyntaxError - callers only handle ProvisionError.
    const f = (async () => new Response("this is not json{", { status: 200 })) as unknown as typeof fetch;
    await expect(provision({ fetch: f, baseUrl: "https://sync.test" }, { setupToken: "x", machineName: "m" }))
      .rejects.toBeInstanceOf(ProvisionError);
  });
});

describe("refresh", () => {
  it("posts refreshToken to /token/refresh and returns the rotated pair", async () => {
    let seenUrl = "", seenBody = "";
    const f = fakeFetch(200, OK, (u, i) => { seenUrl = u; seenBody = String(i.body); });
    const r = await refresh({ fetch: f, baseUrl: "https://sync.test" }, "xrefresh_old");
    expect(seenUrl).toBe("https://sync.test/token/refresh");
    expect(JSON.parse(seenBody)).toEqual({ refreshToken: "xrefresh_old" });
    expect(r.machineToken).toBe(OK.machineToken);
  });
});
