import { describe, it, expect } from "vitest";
import { AutomationsClient } from "./automations-client.js";

function fakeFetch(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input.toString(), init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    const h = routes[key];
    if (!h) return new Response("nope", { status: 404 });
    return h(req);
  };
}

describe("AutomationsClient", () => {
  it("listDue sends Basic auth and parses runs", async () => {
    let sawAuth = "";
    const fetch = fakeFetch({
      "GET /api/automations/runs": (req) => {
        sawAuth = req.headers.get("authorization") ?? "";
        return new Response(JSON.stringify({ runs: [{ id: "r1", scheduleName: "digest", verb: "daily-digest", dueAt: 5 }] }), { status: 200 });
      },
    });
    const c = new AutomationsClient({ baseUrl: "http://sync", token: "tok", fetch });
    const due = await c.listDue();
    expect(due).toEqual([{ id: "r1", scheduleName: "digest", verb: "daily-digest", dueAt: 5 }]);
    expect(sawAuth).toBe("Basic " + Buffer.from("x:tok").toString("base64"));
  });

  it("claim returns the run on 200 and null on 409", async () => {
    const c200 = new AutomationsClient({ baseUrl: "http://sync", token: "tok", fetch: fakeFetch({
      "POST /api/automations/runs/r1/claim": () => new Response(JSON.stringify({ run: { id: "r1", scheduleName: "d", verb: "v", dueAt: 1 } }), { status: 200 }),
    }) });
    expect(await c200.claim("r1")).toMatchObject({ id: "r1" });

    const c409 = new AutomationsClient({ baseUrl: "http://sync", token: "tok", fetch: fakeFetch({
      "POST /api/automations/runs/r1/claim": () => new Response(JSON.stringify({ error: "not claimable" }), { status: 409 }),
    }) });
    expect(await c409.claim("r1")).toBeNull();
  });

  it("report POSTs the outcome body", async () => {
    let body: unknown;
    const c = new AutomationsClient({ baseUrl: "http://sync", token: "tok", fetch: fakeFetch({
      "POST /api/automations/runs/r1/report": async (req) => { body = await req.json(); return new Response("{}", { status: 200 }); },
    }) });
    await c.report("r1", { state: "done", sessionId: "s9" });
    expect(body).toEqual({ state: "done", sessionId: "s9" });
  });
});
