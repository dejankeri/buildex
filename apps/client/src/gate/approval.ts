// The approval broker - the human round-trip half of the gate (invariant 5). When policy says
// "ask", a pending approval card is created and surfaced (Pending tray); the operator's approve/deny
// resolves the awaiting decision. Deterministic: id + clock injected, no ambient randomness.
import type { ToolInvocation } from "./policy.js";

export type Verdict = "approve" | "deny";

// How long a pending approval card may wait for the operator before it auto-resolves to DENY. A
// card that no one ever taps must not hang the tool call forever: the PreToolUse gate hook is
// blocked on that decision (POST /api/gate), and if it blocks past Claude Code's own hook timeout,
// Claude treats the timeout as a NON-blocking error and lets the tool proceed UNGATED (fails open) -
// exactly what invariant 5 forbids. So this TTL MUST stay comfortably below GATE_HOOK_TIMEOUT_SECS,
// so the daemon denies *cleanly* and the hook returns a real "deny" before Claude's timeout can fire.
export const GATE_CARD_TTL_MS = 600_000; // 10 minutes
/** The PreToolUse hook timeout (seconds) written into .claude/settings.json - kept above the card
 *  TTL so the operator gate (approve/deny, or the TTL auto-deny) always wins the race. */
export const GATE_HOOK_TIMEOUT_SECS = 660; // 11 minutes

export interface ApprovalCard {
  id: string;
  tool: ToolInvocation;
  createdAt: number;
}

export interface ApprovalBrokerDeps {
  idFactory: () => string;
  now: () => number;
  /** Called when a new card is created - the daemon/UI pushes it to the Pending tray. */
  onCard?: (card: ApprovalCard) => void;
  /** Auto-deny a card no operator resolves within this many ms. Omit (or 0) to disable - the demo
   *  and daemon set it; tests that don't exercise expiry leave it off. Requires `setTimer`. */
  ttlMs?: number;
  /** Timer seam so the TTL is deterministic under test (defaults to none - no timer is armed unless
   *  this is provided). In production the daemon passes an unref'd setTimeout/clearTimeout pair. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PendingEntry {
  card: ApprovalCard;
  resolve: (v: Verdict) => void;
  /** Handle of the TTL auto-deny timer, cleared when the card resolves (undefined if no TTL armed). */
  timer?: unknown;
}

export class ApprovalBroker {
  private readonly open = new Map<string, PendingEntry>();

  constructor(private readonly deps: ApprovalBrokerDeps) {}

  /** Open an approval card and return the card plus a promise for the operator's decision. If a TTL
   *  is configured, arm a timer that auto-resolves the card to "deny" so a tool call never hangs
   *  forever waiting on an operator who never taps (see GATE_CARD_TTL_MS). */
  request(tool: ToolInvocation): { card: ApprovalCard; decision: Promise<Verdict> } {
    const card: ApprovalCard = { id: this.deps.idFactory(), tool, createdAt: this.deps.now() };
    const decision = new Promise<Verdict>((resolve) => {
      const entry: PendingEntry = { card, resolve };
      this.open.set(card.id, entry);
      const { ttlMs, setTimer } = this.deps;
      if (ttlMs && ttlMs > 0 && setTimer) {
        entry.timer = setTimer(() => this.resolve(card.id, "deny"), ttlMs);
      }
    });
    this.deps.onCard?.(card);
    return { card, decision };
  }

  pending(): ApprovalCard[] {
    return [...this.open.values()].map((e) => e.card);
  }

  /** Resolve a pending card; returns false if the id is unknown (idempotent, never throws). Clears
   *  the TTL timer so an operator verdict never races the auto-deny (and vice-versa). */
  resolve(id: string, verdict: Verdict): boolean {
    const entry = this.open.get(id);
    if (!entry) return false;
    this.open.delete(id);
    if (entry.timer !== undefined) this.deps.clearTimer?.(entry.timer);
    entry.resolve(verdict);
    return true;
  }
}
