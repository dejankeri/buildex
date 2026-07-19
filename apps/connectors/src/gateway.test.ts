import { describe, it, expect, vi } from "vitest";
import { classifyTool, ConnectorGateway, type McpTool, type ProviderConnection, type ApprovalRequest } from "./gateway.js";

const read: McpTool = { name: "search", annotations: { readOnlyHint: true } };
const write: McpTool = { name: "send", annotations: { readOnlyHint: false, destructiveHint: true } };
const unmarked: McpTool = { name: "do_thing" };

describe("classifyTool - default-deny toward the gate", () => {
  it("treats a readOnlyHint tool as a read pass-through", () => {
    expect(classifyTool(read)).toBe("read");
  });
  it("gates a tool with no hint (safe default)", () => {
    expect(classifyTool(unmarked)).toBe("gated");
  });
  it("gates a non-read / destructive tool", () => {
    expect(classifyTool(write)).toBe("gated");
  });
  it("lets an explicit policy.read allowlist promote an unmarked tool", () => {
    expect(classifyTool(unmarked, { read: ["do_thing"] })).toBe("read");
  });
  it("lets policy.gated override a readOnlyHint (gate wins)", () => {
    expect(classifyTool(read, { gated: ["search"] })).toBe("gated");
  });
});

function conn(over: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    name: "gmail",
    tools: [read, write, unmarked, { name: "secret_admin" }],
    policy: { hidden: ["secret_admin"] },
    call: vi.fn(async (tool: string) => ({ content: [{ type: "text" as const, text: `called ${tool}` }] })),
    ...over,
  };
}

describe("ConnectorGateway.listTools", () => {
  it("namespaces tools by connector, drops hidden, and tags each with its kind", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn());
    const names = g.listTools().map((t) => t.name);
    expect(names).toContain("gmail__search");
    expect(names).toContain("gmail__send");
    expect(names).not.toContain("gmail__secret_admin"); // hidden
    const search = g.listTools().find((t) => t.name === "gmail__search")!;
    expect(search.kind).toBe("read");
    expect(g.listTools().find((t) => t.name === "gmail__send")!.kind).toBe("gated");
  });
});

describe("ConnectorGateway.listInventory - the operator's trust surface (includes hidden)", () => {
  it("lists every tool incl. hidden, tagging effective kind and intrinsic baseline", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn());
    const inv = g.listInventory();
    const byTool = Object.fromEntries(inv.map((i) => [i.tool, i]));
    expect(byTool["secret_admin"]!.kind).toBe("hidden"); // hidden IS present here (unlike listTools)
    expect(byTool["search"]).toMatchObject({ kind: "read", baseline: "read" });
    expect(byTool["send"]).toMatchObject({ kind: "gated", baseline: "gated" });
    expect(byTool["do_thing"]).toMatchObject({ kind: "gated", baseline: "gated" });
    expect(byTool["search"]!.name).toBe("gmail__search"); // still qualified + carries connector
    expect(byTool["search"]!.connector).toBe("gmail");
  });
});

describe("ConnectorGateway.setToolPolicy - tighten-only (invariant 5 by construction)", () => {
  it("REFUSES to promote an outward (gated) tool to read - the gate can't be removed", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn({ policy: {} }));
    const r = g.setToolPolicy("gmail", "send", "read");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/gate|outward/i);
    expect(g.listTools().find((t) => t.name === "gmail__send")!.kind).toBe("gated"); // unchanged
  });

  it("allows tightening a read tool to gated", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn({ policy: {} }));
    const r = g.setToolPolicy("gmail", "search", "gated");
    expect(r.ok).toBe(true);
    expect(g.listTools().find((t) => t.name === "gmail__search")!.kind).toBe("gated");
    expect(r.policy?.gated).toContain("search"); // returns the new policy for persistence
  });

  it("allows hiding any tool, and restoring it (read tool back to read)", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn({ policy: {} }));
    expect(g.setToolPolicy("gmail", "search", "hidden").ok).toBe(true);
    expect(g.listTools().find((t) => t.name === "gmail__search")).toBeUndefined(); // hidden from agent
    const restore = g.setToolPolicy("gmail", "search", "read");
    expect(restore.ok).toBe(true);
    expect(g.listTools().find((t) => t.name === "gmail__search")!.kind).toBe("read");
  });

  it("restoring a gated tool to its baseline clears the override (stays gated)", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn({ policy: { hidden: ["send"] } }));
    const r = g.setToolPolicy("gmail", "send", "gated"); // un-hide, back to intrinsic gated
    expect(r.ok).toBe(true);
    expect(r.policy?.hidden ?? []).not.toContain("send");
    expect(g.listTools().find((t) => t.name === "gmail__send")!.kind).toBe("gated");
  });

  it("errors (never throws) on an unknown connector or tool", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn());
    expect(g.setToolPolicy("nope", "x", "gated").ok).toBe(false);
    expect(g.setToolPolicy("gmail", "ghost", "gated").ok).toBe(false);
  });
});

describe("ConnectorGateway.callTool", () => {
  it("passes a read tool straight through - no approval", async () => {
    const approve = vi.fn(async () => ({ approved: true }));
    const c = conn();
    const g = new ConnectorGateway({ approve });
    g.register(c);
    const res = await g.callTool("gmail__search", { q: "x" });
    expect(res.isError).toBeFalsy();
    expect(c.call).toHaveBeenCalledWith("search", { q: "x" });
    expect(approve).not.toHaveBeenCalled();
  });

  it("routes a gated tool through the human approver, then executes on approval", async () => {
    const approve = vi.fn(async (_req: ApprovalRequest) => ({ approved: true }));
    const c = conn();
    const g = new ConnectorGateway({ approve });
    g.register(c);
    const res = await g.callTool("gmail__send", { to: "a@b.co" });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toMatchObject({ connector: "gmail", tool: "send" });
    expect(c.call).toHaveBeenCalledWith("send", { to: "a@b.co" });
    expect(res.isError).toBeFalsy();
  });

  it("does NOT execute a gated tool the human declined", async () => {
    const approve = vi.fn(async () => ({ approved: false, reason: "not now" }));
    const c = conn();
    const g = new ConnectorGateway({ approve });
    g.register(c);
    const res = await g.callTool("gmail__send", { to: "a@b.co" });
    expect(c.call).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/declined|not now/i);
  });

  it("refuses a hidden tool as if it does not exist", async () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn());
    const res = await g.callTool("gmail__secret_admin", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unknown tool/i);
  });

  it("returns an error result (never throws) for an unknown connector", async () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    const res = await g.callTool("nope__x", {});
    expect(res.isError).toBe(true);
  });
});
