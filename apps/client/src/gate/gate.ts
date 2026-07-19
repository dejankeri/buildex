// The gate - one abstraction above policy + human approval (invariant 5). The
// PreToolUse hook (wired in the daemon) calls `evaluate` for every tool the agent wants to run:
// allow/deny resolve immediately; "ask" opens an approval card and blocks on the operator's tap.
// This is the net-new layer that did not exist in the prototype.
import { PolicyEngine, type ToolInvocation, type PolicyPreset } from "./policy.js";
import { ApprovalBroker } from "./approval.js";

export type GateResult = "allow" | "deny";

export class Gate {
  constructor(
    private policy: PolicyEngine,
    private readonly broker: ApprovalBroker,
  ) {}

  /** Swap the policy in place - used after a pack install changes the effective preset, so the
   *  runtime gate and the generated settings.json stay in agreement. */
  setPreset(preset: PolicyPreset): void {
    this.policy = new PolicyEngine(preset);
  }

  /** Decide whether a tool call may proceed. "ask"-tier calls await an operator approval card. */
  async evaluate(tool: ToolInvocation): Promise<GateResult> {
    const decision = this.policy.decide(tool);
    if (decision === "allow") return "allow";
    if (decision === "deny") return "deny";

    const { decision: verdict } = this.broker.request(tool);
    return (await verdict) === "approve" ? "allow" : "deny";
  }
}
