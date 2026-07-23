import { describe, it, expect } from "vitest";
import { createDaemon } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

// Build a minimal daemon over a given broker + runPrompt (the two things these tests drive). Wide-open
// policy so nothing gates unexpectedly; the tests raise cards on the broker directly.
function daemonWith(broker: ApprovalBroker, runPrompt: () => AsyncIterable<UiEvent>) {
  return createDaemon({
    workspace: "/ws",
    roots: [],
    gate: new Gate(new PolicyEngine({ allow: [], ask: [], deny: [], default: "allow" }), broker),
    broker,
    runPrompt,
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
  });
}

const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Read one `data: {...}\n\n` SSE frame and return its parsed JSON.
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>, dec = new TextDecoder()): Promise<unknown> {
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended before a full frame");
    buf += dec.decode(value, { stream: true });
    const i = buf.indexOf("\n\n");
    if (i >= 0) {
      const frame = buf.slice(0, i);
      return JSON.parse(frame.slice(frame.indexOf("{")));
    }
  }
}

describe("active origin around a prompt run", () => {
  it("attributes a card raised mid-run to the running chat session", async () => {
    let n = 0;
    const broker = new ApprovalBroker({ idFactory: () => `c${++n}`, now: () => 0 });
    let originDuringRun: unknown = "unset";
    const app = daemonWith(broker, async function* () {
      // Stand in for a mid-turn gated tool (e.g. a Stripe charge through the connector gateway).
      originDuringRun = broker.request({ name: "mcp:stripe.charge", input: {} }).card.origin;
      yield { kind: "done" } as UiEvent;
    });

    const res = await app(post("/api/prompt", { prompt: "hi", sessionId: "s1" }));
    await res.text(); // drive the stream (and thus runPrompt) to completion

    expect(originDuringRun).toEqual({ kind: "chat", sessionId: "s1" });
    // once the run ends the origin is popped, so a later card is unattributed (tray/company only)
    expect(broker.request({ name: "x", input: {} }).card.origin).toBeUndefined();
  });
});

describe("GET /api/approvals/stream", () => {
  it("streams an open event then a resolve event", async () => {
    const broker = new ApprovalBroker({ idFactory: () => "card1", now: () => 0 });
    const app = daemonWith(broker, async function* () {
      yield { kind: "done" } as UiEvent;
    });

    const res = await app(new Request("http://127.0.0.1/api/approvals/stream"));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();

    const { card } = broker.request({ name: "mcp:stripe.charge", input: { args: { amount: 120 } } });
    expect(await readFrame(reader)).toMatchObject({ type: "open", card: { id: "card1", tool: { name: "mcp:stripe.charge" } } });

    broker.resolve(card.id, "approve");
    expect(await readFrame(reader)).toEqual({ type: "resolve", id: "card1", verdict: "approve", reason: "operator" });

    await reader.cancel(); // unsubscribes (cancel() → unsub)
  });

  it("replays already-open cards to a fresh subscriber (catch-up snapshot)", async () => {
    const broker = new ApprovalBroker({ idFactory: () => "card9", now: () => 0 });
    const app = daemonWith(broker, async function* () {
      yield { kind: "done" } as UiEvent;
    });
    broker.request({ name: "mcp:gmail.send", input: {} }); // opened BEFORE anyone subscribes

    const res = await app(new Request("http://127.0.0.1/api/approvals/stream"));
    const reader = res.body!.getReader();
    expect(await readFrame(reader)).toMatchObject({ type: "open", card: { id: "card9" } });
    await reader.cancel();
  });
});
