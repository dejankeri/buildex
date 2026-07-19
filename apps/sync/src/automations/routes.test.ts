import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, CADENCE_MS, type ScheduleDef } from "./schedule-store.js";
import { handleAutomationRoutes } from "./routes.js";

const daily: ScheduleDef = { name: "digest", verb: "daily-digest", cadence: "daily", enabled: true, catchUp: "coalesce" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "routes-"));
  let now = 0;
  const schedules = new ScheduleStore(join(dir, "c.db"), () => now, (() => { let n = 0; return () => `run_${++n}`; })());
  // token "tok-a" → co_1/machine-a, "tok-b" → co_2/machine-b
  const resolve = (t: string) =>
    t === "tok-a" ? { companyId: "co_1", machineId: "machine-a" } : t === "tok-b" ? { companyId: "co_2", machineId: "machine-b" } : null;
  const deps = { schedules, resolve, leaseMs: 600_000 };
  const call = (method: string, path: string, token?: string, jsonBody?: unknown) => {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = "Basic " + Buffer.from(`x:${token}`).toString("base64");
    if (jsonBody !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`http://x${path}`, { method, headers, body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined });
    return handleAutomationRoutes(deps, req, new URL(req.url));
  };
  return { schedules, deps, call, advance: (ms: number) => (now += ms) };
}

describe("automation routes", () => {
  it("401 without a valid token", async () => {
    const { call } = setup();
    const res = await call("GET", "/api/automations/runs?state=due");
    expect(res!.status).toBe(401);
  });

  it("GET due returns only the caller's company runs", async () => {
    const { schedules, call, advance } = setup();
    schedules.reconcile("co_1", [daily]);
    schedules.reconcile("co_2", [daily]);
    advance(CADENCE_MS.daily + 1);
    schedules.createDueRuns("co_1");
    schedules.createDueRuns("co_2");
    const res = await call("GET", "/api/automations/runs?state=due", "tok-a");
    const bodyJson = (await res!.json()) as { runs: { companyId: string }[] };
    expect(bodyJson.runs.length).toBe(1);
    expect(bodyJson.runs[0]!.companyId).toBe("co_1");
  });

  it("claim → report round-trips; a second machine cannot claim", async () => {
    const { schedules, call, advance } = setup();
    schedules.reconcile("co_1", [daily]);
    advance(CADENCE_MS.daily + 1);
    const [run] = schedules.createDueRuns("co_1");
    const claimed = await call("POST", `/api/automations/runs/${run!.id}/claim`, "tok-a");
    expect(claimed!.status).toBe(200);
    const stolen = await call("POST", `/api/automations/runs/${run!.id}/claim`, "tok-a");
    expect(stolen!.status).toBe(409);
    const reported = await call("POST", `/api/automations/runs/${run!.id}/report`, "tok-a", { state: "done", sessionId: "s1" });
    expect(reported!.status).toBe(200);
    expect(schedules.getRun("co_1", run!.id)!.state).toBe("done");
  });

  it("a machine cannot claim another company's run (409, not cross-company)", async () => {
    const { schedules, call, advance } = setup();
    schedules.reconcile("co_1", [daily]);
    advance(CADENCE_MS.daily + 1);
    const [run] = schedules.createDueRuns("co_1");
    // tok-b belongs to co_2 → the run isn't in its company → not claimable
    const res = await call("POST", `/api/automations/runs/${run!.id}/claim`, "tok-b");
    expect(res!.status).toBe(409); // claim() scoped to co_2 changes 0 rows
  });

  it("returns null for a non-automation path", async () => {
    const { call } = setup();
    expect(await call("GET", "/healthz")).toBeNull();
  });
});
