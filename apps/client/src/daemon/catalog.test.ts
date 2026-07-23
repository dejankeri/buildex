import { describe, it, expect } from "vitest";
import { createDaemon } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

function makeDaemon() {
  const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
  return createDaemon({
    workspace: "/ws",
    roots: [],
    gate: new Gate(new PolicyEngine({ allow: [], ask: [], deny: [], default: "ask" }), broker),
    broker,
    async *runPrompt() { yield { kind: "done" } as UiEvent; },
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
    catalog: {
      skills: () => [{ name: "tidy", description: "Use when the workspace drifts.", root: "team" }],
      rules: () => [{ name: "Operating rules", description: "how we run", root: "team", path: "team/CLAUDE.md" }],
      connectors: () => [{ name: "gmail", status: "synced", lastSync: "2026-07-16T10:00:00Z" }],
      routines: () => [],
    },
    agentView: () => ({ summary: { claudeMdOk: true }, tree: [], discrepancies: [] }),
    agentViewRegen: () => { regenCalls++; return { summary: { claudeMdOk: true }, tree: [], discrepancies: [{ kind: "policy-missing", message: "x" }] }; },
  });
}

let regenCalls = 0;

describe("catalog routes", () => {
  it("lists skills", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/skills"));
    const body = (await res.json()) as { skills: { name: string }[] };
    expect(body.skills[0]!.name).toBe("tidy");
  });
  it("lists rules (the always-on CLAUDE.md layers), each with an openable path", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/rules"));
    const body = (await res.json()) as { rules: { name: string; path: string }[] };
    expect(body.rules[0]).toMatchObject({ name: "Operating rules", path: "team/CLAUDE.md" });
  });
  it("returns an empty rules list when the catalog predates the rules() method", async () => {
    const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
    const daemon = createDaemon({
      workspace: "/ws", roots: [],
      gate: new Gate(new PolicyEngine({ allow: [], ask: [], deny: [], default: "ask" }), broker), broker,
      async *runPrompt() { yield { kind: "done" } as UiEvent; },
      buildMap: () => ({ nodes: [], edges: [] }), syncFn: async () => "ok",
      // A legacy catalog with no rules() method — the route must still answer, not 500.
      catalog: { skills: () => [], connectors: () => [], routines: () => [] },
    });
    const res = await daemon(new Request("http://127.0.0.1/api/rules"));
    expect(await res.json()).toEqual({ rules: [] });
  });
  it("lists connectors with status", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/connectors"));
    const body = (await res.json()) as { connectors: { name: string; status: string }[] };
    expect(body.connectors[0]).toMatchObject({ name: "gmail", status: "synced" });
  });
  it("lists routines (empty in v1)", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/routines"));
    expect(await res.json()).toEqual({ routines: [] });
  });

  it("serves the agent view, and regen forces a rebuild before returning the fresh view", async () => {
    const daemon = makeDaemon();
    const before = regenCalls;
    const view = await (await daemon(new Request("http://127.0.0.1/api/agent-view"))).json() as { discrepancies: unknown[] };
    expect(view.discrepancies).toEqual([]); // GET reflects current state, no rebuild
    expect(regenCalls).toBe(before);
    const regen = await (await daemon(new Request("http://127.0.0.1/api/agent-view/regen", { method: "POST" }))).json() as { discrepancies: { kind: string }[] };
    expect(regenCalls).toBe(before + 1); // the POST forced a rebuild
    expect(regen.discrepancies[0]!.kind).toBe("policy-missing"); // and returned the fresh view
  });
});
