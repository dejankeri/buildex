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
      connectors: () => [{ name: "gmail", status: "synced", lastSync: "2026-07-16T10:00:00Z" }],
      routines: () => [],
    },
  });
}

describe("catalog routes", () => {
  it("lists skills", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/skills"));
    const body = (await res.json()) as { skills: { name: string }[] };
    expect(body.skills[0]!.name).toBe("tidy");
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
});
