import { describe, it, expect } from "vitest";
import { createDaemon } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import { AppBus } from "../miniapp/app-bus.js";
import type { UiEvent } from "../agent/types.js";

function makeDaemon() {
  const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
  let n = 0;
  const appBus = new AppBus({ idFactory: () => `f${++n}` });
  const app = createDaemon({
    workspace: "/ws",
    roots: [],
    gate: new Gate(new PolicyEngine({ allow: [], ask: [], deny: [], default: "ask" }), broker),
    broker,
    async *runPrompt() { yield { kind: "done" } as UiEvent; },
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
    appBus,
  });
  return { app, appBus };
}
const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("mini-app control routes", () => {
  it("relays an agent command to the mini-app window and returns its result", async () => {
    const { app, appBus } = makeDaemon();
    appBus.subscribe(); // a mini-app window is open

    const controlP = app(post("/api/app-control", { app: "dashboard", op: "read", selector: "[data-metric]" }));
    await new Promise((r) => setTimeout(r, 5)); // let the control handler parse + queue the frame

    // the browser host polls for frames and reports the result
    const frames = (await (await app(new Request("http://127.0.0.1/api/app-frames"))).json()) as { frames: { id: string }[] };
    expect(frames.frames).toHaveLength(1);
    await app(post("/api/app-result", { id: frames.frames[0]!.id, ok: true, result: "1,200" }));

    expect(await (await controlP).json()).toEqual({ ok: true, result: "1,200" });
  });

  it("fast-fails a command when no mini-app window is open", async () => {
    const { app } = makeDaemon();
    const res = await app(post("/api/app-control", { app: "d", op: "click", selector: "#x" }));
    expect(res.status).toBe(409);
  });
});
