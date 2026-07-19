import { describe, it, expect } from "vitest";
import { createDaemon, type DaemonDeps } from "./daemon.js";
import { AppBus } from "../miniapp/app-bus.js";

function makeHandler() {
  let n = 0;
  const appBus = new AppBus({ idFactory: () => `f${++n}` });
  const deps = {
    workspace: "/tmp",
    roots: [],
    gate: {} as never,
    broker: { pending: () => [] } as never,
    runPrompt: (() => (async function* () {})()) as never,
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
    appBus,
  } as DaemonDeps;
  return { handler: createDaemon(deps), appBus };
}

describe("/api/app-subscribe - lets the app pane register as the bus host", () => {
  it("send() fast-fails before subscribe and succeeds after", async () => {
    const { handler, appBus } = makeHandler();
    // before subscribe: control fast-fails with 409
    const pre = await handler(new Request("http://x/api/app-control", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "d", op: "read", selector: "#m" }),
    }));
    expect(pre.status).toBe(409);

    // subscribe
    const sub = await handler(new Request("http://x/api/app-subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    const { token } = (await sub.json()) as { token: string };
    expect(token).toBeTruthy();

    // now a command queues (resolve it so the promise settles)
    const ctl = handler(new Request("http://x/api/app-control", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "d", op: "read", selector: "#m" }),
    }));
    // Request#json() reads the body via a stream and settles on a macrotask, not a microtask -
    // give it one tick so the command is queued before we drain (avoids a false-empty race).
    await new Promise((r) => setTimeout(r, 0));
    const frames = appBus.drain();
    expect(frames).toHaveLength(1);
    appBus.resolve(frames[0]!.id, { ok: true, result: "42" });
    expect((await (await ctl).json())).toEqual({ ok: true, result: "42" });

    // unsubscribe → back to fast-fail
    await handler(new Request("http://x/api/app-unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }));
    const post = await handler(new Request("http://x/api/app-control", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "d", op: "read", selector: "#m" }),
    }));
    expect(post.status).toBe(409);
  });
});
