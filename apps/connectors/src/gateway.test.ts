import { describe, it, expect, vi } from "vitest";
import { classifyTool, classifyCall, hasConditionalGate, ConnectorGateway, type ConnectorPolicy, type McpTool, type ProviderConnection, type ApprovalRequest } from "./gateway.js";

const read: McpTool = { name: "search", annotations: { readOnlyHint: true } };
const write: McpTool = { name: "send", annotations: { readOnlyHint: false, destructiveHint: true } };
const unmarked: McpTool = { name: "do_thing" };

describe("classifyTool - default pass-through, gate by intent", () => {
  it("treats a readOnlyHint tool as a read pass-through", () => {
    expect(classifyTool(read)).toBe("read");
  });
  it("runs an unmarked, non-outward tool autonomously (wide by default)", () => {
    expect(classifyTool(unmarked)).toBe("read");
  });
  it("gates a destructiveHint tool", () => {
    expect(classifyTool(write)).toBe("gated");
  });

  it("gates money / outbound / publish / destroy tools by name", () => {
    for (const name of [
      "send",
      "sendMessage",
      "send_email",
      "message",
      "post_to_instagram",
      "publish-brand-template",
      "create_charge",
      "refund",
      "issue_payout",
      "delete_client",
      "archive_thread",
      "cancel_subscription",
    ]) {
      expect(classifyTool({ name })).toBe("gated");
    }
  });

  it("runs fetch/inspect and neutral write tools autonomously (must NOT gate)", () => {
    for (const name of [
      "search",
      "get_client",
      "get_message_count", // read verb wins over the 'message' token
      "list_invoices", // read verb wins over the 'invoice' token
      "find",
      "build_workout",
      "create_design", // draft creation - not outbound
      "assign_program",
      "record_progress",
    ]) {
      expect(classifyTool({ name })).toBe("read");
    }
  });

  it("lets an explicit policy.read override widen an outward tool (operator owns the risk)", () => {
    expect(classifyTool(write, { read: ["send"] })).toBe("read");
    expect(classifyTool(unmarked, { read: ["do_thing"] })).toBe("read");
  });
  it("lets policy.gated force the gate on an otherwise-autonomous tool (gate wins)", () => {
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
    expect(byTool["do_thing"]).toMatchObject({ kind: "read", baseline: "read" });
    expect(byTool["search"]!.name).toBe("gmail__search"); // still qualified + carries connector
    expect(byTool["search"]!.connector).toBe("gmail");
  });
});

describe("ConnectorGateway.setToolPolicy - operator-adjustable both ways (revised invariant 5)", () => {
  it("lets the operator WIDEN an outward (gated) tool to read - autonomy is configurable", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(conn({ policy: {} }));
    const r = g.setToolPolicy("gmail", "send", "read");
    expect(r.ok).toBe(true);
    expect(r.policy?.read).toContain("send"); // records the widen for persistence
    expect(g.listTools().find((t) => t.name === "gmail__send")!.kind).toBe("read");
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

// ---- Argument-conditional gating (intent-verb servers) --------------------------------------------
// Modelled on Protocol, whose whole surface is 18 fat verbs: `schedule` both books an appointment
// (routine) and fires a reminder at a real client (outward), decided by its `action` argument. Gating
// by name alone would either put every booking behind a tap or let reminders out unattended.
describe("argument-conditional gating", () => {
  const schedule: McpTool = { name: "schedule" };
  const automations: McpTool = { name: "manage_automations" };
  const message: McpTool = { name: "message" }; // read-only in Protocol, but gates on the name alone
  const packPolicy: ConnectorPolicy = {
    read: ["message"],
    gated: [
      { tool: "schedule", when: { action: ["send_reminder", "reminder"] } },
      { tool: "manage_automations", when: { action: ["run"] } },
    ],
  };

  it("gates only the argument values the rule names, and passes the rest through", () => {
    expect(classifyCall(schedule, { action: "send_reminder" }, undefined, packPolicy)).toBe("gated");
    expect(classifyCall(schedule, { action: "reminder" }, undefined, packPolicy)).toBe("gated");
    expect(classifyCall(schedule, { action: "cancel" }, undefined, packPolicy)).toBe("read"); // never notifies the client
    expect(classifyCall(schedule, { action: "create" }, undefined, packPolicy)).toBe("read");
    expect(classifyCall(schedule, { action: "booking_config" }, undefined, packPolicy)).toBe("read");
    expect(classifyCall(automations, { action: "run" }, undefined, packPolicy)).toBe("gated");
    expect(classifyCall(automations, { action: "create" }, undefined, packPolicy)).toBe("read");
  });

  it("widens a tool the name heuristic over-gates (Protocol's `message` only reads)", () => {
    expect(classifyTool(message)).toBe("gated"); // intrinsic: the 'message' token
    expect(classifyCall(message, { clientId: "c1" }, undefined, packPolicy)).toBe("read");
  });

  it("fails CLOSED when a conditional gate cannot be evaluated", () => {
    // No args object in hand → the outward rule is treated as matching. A spurious approval is the
    // safe direction; silently dispatching to a real person is not.
    expect(classifyCall(schedule, undefined, undefined, packPolicy)).toBe("gated");
    expect(classifyCall(schedule, "not-an-object", undefined, packPolicy)).toBe("gated");
    // The mirror image: an unevaluable conditional WIDENING must not widen.
    const widen: ConnectorPolicy = { read: [{ tool: "send_email", when: { draft: [true] } }] };
    expect(classifyCall({ name: "send_email" }, undefined, undefined, widen)).toBe("gated");
    expect(classifyCall({ name: "send_email" }, { draft: true }, undefined, widen)).toBe("read");
  });

  it("ANDs multiple argument conditions and ORs values within one", () => {
    const t: McpTool = { name: "update_widget" }; // intrinsically read: no read verb, no outward token
    const rule: ConnectorPolicy = { gated: [{ tool: "update_widget", when: { target: ["public", "world"], confirm: [true] } }] };
    expect(classifyCall(t, { target: "public", confirm: true }, undefined, rule)).toBe("gated");
    expect(classifyCall(t, { target: "world", confirm: true }, undefined, rule)).toBe("gated");
    expect(classifyCall(t, { target: "public", confirm: false }, undefined, rule)).toBe("read"); // AND fails
    expect(classifyCall(t, { target: "private", confirm: true }, undefined, rule)).toBe("read"); // AND fails
  });

  it("shows a conditionally-gated tool conservatively on the static surfaces", () => {
    // No args exist at list time, so display must not imply the tool is safe.
    expect(classifyTool(schedule, undefined, packPolicy)).toBe("gated");
    expect(hasConditionalGate(schedule, undefined, packPolicy)).toBe(true);
    // An UNCONDITIONAL gate is not "conditional" - the flag distinguishes "some calls" from "all".
    expect(hasConditionalGate(schedule, { gated: ["schedule"] }, packPolicy)).toBe(false);
  });

  it("lets an operator override beat the pack baseline for that tool only", () => {
    const override: ConnectorPolicy = { read: ["schedule"] }; // operator owns the risk
    expect(classifyCall(schedule, { action: "send_reminder" }, override, packPolicy)).toBe("read");
    // …while every other tool keeps the pack's baseline.
    expect(classifyCall(automations, { action: "run" }, override, packPolicy)).toBe("gated");
  });

  it("enforces the condition end to end: the approver sees the outward call only", async () => {
    const approve = vi.fn(async (_req: ApprovalRequest) => ({ approved: true }));
    const call = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const g = new ConnectorGateway({ approve });
    g.register({ name: "protocol", tools: [schedule], basePolicy: packPolicy, call });

    await g.callTool("protocol__schedule", { action: "create", clientId: "c1" });
    expect(approve).not.toHaveBeenCalled(); // routine booking runs autonomously
    expect(call).toHaveBeenCalledTimes(1);

    await g.callTool("protocol__schedule", { action: "send_reminder", clientId: "c1" });
    expect(approve).toHaveBeenCalledTimes(1); // the reminder waits for a human
    expect(approve.mock.calls[0]![0]).toMatchObject({ connector: "protocol", tool: "schedule" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("does not run the outward call when the human declines it", async () => {
    const call = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const g = new ConnectorGateway({ approve: async () => ({ approved: false }) });
    g.register({ name: "protocol", tools: [schedule], basePolicy: packPolicy, call });
    const res = await g.callTool("protocol__schedule", { action: "send_reminder" });
    expect(call).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });

  it("keeps a pack gate when the operator restores a tool to its default", () => {
    // "Back to default" must mean the pack's shipped intent, not the bare name heuristic under it -
    // otherwise the reset would silently drop a security gate the pack added.
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register({ name: "protocol", tools: [schedule], basePolicy: packPolicy, call: async () => ({ content: [] }) });
    g.setToolPolicy("protocol", "schedule", "read"); // operator widens
    expect(g.listInventory()[0]!.kind).toBe("read");
    g.setToolPolicy("protocol", "schedule", "gated"); // …then restores
    const item = g.listInventory()[0]!;
    expect(item.kind).toBe("gated");
    expect(item.baseline).toBe("gated"); // the floor is the pack's gate
  });

  it("never writes the pack baseline into the operator's persisted overrides", () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register({ name: "protocol", tools: [schedule, message], basePolicy: packPolicy, call: async () => ({ content: [] }) });
    const r = g.setToolPolicy("protocol", "message", "gated");
    expect(r.ok).toBe(true);
    // Only the operator's own decision is returned for persistence - the pack's rules stay in the
    // catalog, so a later pack update that tightens a gate still reaches this connected provider.
    expect(JSON.stringify(r.policy)).not.toContain("send_reminder");
    expect(r.policy?.gated).toEqual(["message"]);
  });
});
