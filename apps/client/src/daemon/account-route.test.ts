import { describe, it, expect } from "vitest";
import { createDaemon } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine, type PolicyPreset } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

const preset: PolicyPreset = { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" };
function makeDaemon(over: Partial<Parameters<typeof createDaemon>[0]> = {}) {
  const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
  return createDaemon({
    workspace: "/ws", roots: [], gate: new Gate(new PolicyEngine(preset), broker), broker,
    async *runPrompt() { yield { kind: "done", sessionId: "s" } as UiEvent; },
    buildMap: () => ({ nodes: [], edges: [] }), syncFn: async () => "ok", ...over,
  });
}
const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/account", () => {
  it("POST opens an account and returns the resulting state", async () => {
    let seen: unknown;
    const app = makeDaemon({ openAccount: async (i) => { seen = i; return { state: "connected" }; } });
    const res = await app(post("/api/account", { baseUrl: "https://s", setupToken: "xsetup_t" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "connected" });
    expect(seen).toEqual({ baseUrl: "https://s", setupToken: "xsetup_t" });
  });

  it("POST maps a rejected setup token to a terse 400, never a 500", async () => {
    const app = makeDaemon({ openAccount: async () => { throw Object.assign(new Error("invalid setup token"), { status: 401 }); } });
    const res = await app(post("/api/account", { baseUrl: "https://s", setupToken: "bad" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid setup token/);
  });

  it("POST refuses the sandbox org with 409", async () => {
    const app = makeDaemon({ openAccount: async () => { throw new Error("the sandbox org is local-only and cannot attach an account"); } });
    const res = await app(post("/api/account", { baseUrl: "https://s", setupToken: "x" }));
    expect(res.status).toBe(409);
  });

  it("GET reports local before any account is opened", async () => {
    const app = makeDaemon({ accountState: () => ({ state: "local" }) });
    expect(await (await app(new Request("http://127.0.0.1/api/account"))).json()).toEqual({ state: "local" });
  });

  it("GET reports the connected identity once opened", async () => {
    const app = makeDaemon({ accountState: () => ({ state: "connected", operatorId: "o1", companySlug: "acme", remotes: { core: "u", team: "u", private: "u" } }) });
    expect(await (await app(new Request("http://127.0.0.1/api/account"))).json()).toMatchObject({ state: "connected", operatorId: "o1", companySlug: "acme" });
  });
});
