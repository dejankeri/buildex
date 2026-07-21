import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "./daemon.js";
import { FileSessionStore } from "./sessions.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine, type PolicyPreset } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

const preset: PolicyPreset = { allow: ["Read"], ask: ["Bash", "WebFetch"], deny: ["Bash(rm:*)"], default: "ask" };

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeDaemon(over: Partial<Parameters<typeof createDaemon>[0]> = {}) {
  let n = 0;
  const broker = new ApprovalBroker({ idFactory: () => `c${++n}`, now: () => 0 });
  const gate = new Gate(new PolicyEngine(preset), broker);
  const app = createDaemon({
    workspace: "/ws",
    roots: [],
    gate,
    broker,
    async *runPrompt() {
      yield { kind: "text", text: "hi" } as UiEvent;
      await delay(10); // a silent gap mid-turn - must not truncate the stream
      yield { kind: "tool", id: "t1", name: "Edit", input: {}, path: "a.md" } as UiEvent;
      yield { kind: "done", sessionId: "s1" } as UiEvent;
    },
    buildMap: () => ({ nodes: [{ id: "team/a.md", kind: "file", label: "a.md" }], edges: [] }),
    syncFn: async () => "ok",
    ...over,
  });
  return { app, broker };
}

const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/onboarding - the first-run welcome wizard", () => {
  it("GET reports first-run state + agent detection", async () => {
    const { app } = makeDaemon({
      onboarding: { state: async () => ({ firstRun: true, agent: { available: true, version: "1.2.3" } }), complete: () => {} },
    });
    const res = await app(new Request("http://127.0.0.1/api/onboarding"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ firstRun: true, agent: { available: true, version: "1.2.3" } });
  });

  it("POST /complete marks the wizard finished so it won't show again", async () => {
    let done = false;
    const { app } = makeDaemon({
      onboarding: { state: async () => ({ firstRun: !done, agent: { available: false } }), complete: () => { done = true; } },
    });
    const res = await app(post("/api/onboarding/complete", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(done).toBe(true);
  });
});

describe("healthz + map", () => {
  it("reports healthy", async () => {
    const { app } = makeDaemon();
    expect((await app(new Request("http://127.0.0.1/healthz"))).status).toBe(200);
  });
  it("serves the deterministic map", async () => {
    const { app } = makeDaemon();
    const map = (await (await app(new Request("http://127.0.0.1/api/map"))).json()) as { nodes: { id: string }[] };
    expect(map.nodes[0]!.id).toBe("team/a.md");
  });
  it("serves recent changes when the dep is wired (Brain view's Learning surface)", async () => {
    const { app } = makeDaemon({
      recentChanges: () => [{ sha: "abc1234", at: 0, author: "Dana", subject: "chose net-30", files: ["decisions/log.md"] }],
    });
    const res = await app(new Request("http://127.0.0.1/api/changes"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: { subject: string; files: string[] }[] };
    expect(body.changes[0]!.subject).toBe("chose net-30");
    expect(body.changes[0]!.files).toEqual(["decisions/log.md"]);
  });
  it("404s /api/changes when the dep is absent (route stays optional)", async () => {
    const { app } = makeDaemon();
    expect((await app(new Request("http://127.0.0.1/api/changes"))).status).toBe(404);
  });
});

describe("/api/prompt - SSE stream survives a mid-turn gap", () => {
  it("streams every UiEvent as an SSE data frame, in order", async () => {
    const { app } = makeDaemon();
    const res = await app(post("/api/prompt", { prompt: "do it" }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter((f) => f.startsWith("data:"))
      .map((f) => JSON.parse(f.slice(f.indexOf("{"))));
    expect(events.map((e) => e.kind)).toEqual(["text", "tool", "done"]);
  });

  it("forwards a client-supplied systemPromptAppend to runPrompt (invisible orienting context)", async () => {
    let seen: { systemPromptAppend?: string } | undefined;
    const { app } = makeDaemon({
      // eslint-disable-next-line require-yield
      async *runPrompt(o: { systemPromptAppend?: string }) {
        seen = o;
        return; // no events - we only care what runPrompt was called with
      },
    });
    await (await app(post("/api/prompt", { prompt: "hi", systemPromptAppend: "You're working with the Protocol app." }))).text();
    expect(seen?.systemPromptAppend).toBe("You're working with the Protocol app.");
  });

  it("omits systemPromptAppend when the client doesn't send one", async () => {
    let seen: { systemPromptAppend?: string } | undefined;
    const { app } = makeDaemon({
      // eslint-disable-next-line require-yield
      async *runPrompt(o: { systemPromptAppend?: string }) {
        seen = o;
        return;
      },
    });
    await (await app(post("/api/prompt", { prompt: "hi" }))).text();
    expect(seen && "systemPromptAppend" in seen ? seen.systemPromptAppend : undefined).toBeUndefined();
  });
});

describe("/api/prompt - a client disconnect cancels the turn (no orphan, no false 'error')", () => {
  // A long turn that streams one event, then blocks until its abort signal fires (or throws if the
  // signal is already aborted). This models a real agent child that runs until killed.
  async function* longTurn(opts: { signal?: AbortSignal }): AsyncIterable<UiEvent> {
    yield { kind: "text", text: "partial" } as UiEvent;
    await new Promise<void>((_resolve, reject) => {
      const s = opts.signal;
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (s?.aborted) return abort();
      s?.addEventListener("abort", abort, { once: true });
    });
  }

  it("aborts the underlying turn and leaves the session idle + its partial transcript intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buildex-cancel-"));
    try {
      const sessions = new FileSessionStore(dir);
      const sid = sessions.create();
      let sawSignal: AbortSignal | undefined;
      const { app } = makeDaemon({
        sessions,
        runPrompt: (o) => {
          sawSignal = o.signal;
          return longTurn(o);
        },
      });

      const res = await app(post("/api/prompt", { prompt: "go", sessionId: sid }));
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("partial");

      // the client goes away (tab closed) → cancel the stream
      await reader.cancel();
      await delay(20);

      expect(sawSignal?.aborted).toBe(true); // the turn was actually aborted, not orphaned
      const s = sessions.read(sid);
      expect(s.status).toBe("idle"); // a clean stop - NOT the old misleading "error"
      expect(s.events.some((e) => e.kind === "text" && e.text === "partial")).toBe(true); // transcript kept
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gate round-trip over HTTP (PreToolUse hook ↔ approval card)", () => {
  it("allow-tier tool resolves immediately", async () => {
    const { app } = makeDaemon();
    const res = await app(post("/api/gate", { name: "Read", input: {} }));
    expect(await res.json()).toEqual({ decision: "allow" });
  });

  it("ask-tier tool blocks until the operator approves the pending card", async () => {
    const { app, broker } = makeDaemon();
    const gatePromise = app(post("/api/gate", { name: "Bash", input: { command: "git push" } }));

    // the card surfaces in the Pending tray
    await delay(5);
    const pending = (await (await app(new Request("http://127.0.0.1/api/pending"))).json()) as { cards: { id: string }[] };
    expect(pending.cards).toHaveLength(1);

    // operator approves → the blocked hook resolves allow
    await app(post("/api/approve", { id: pending.cards[0]!.id, verdict: "approve" }));
    expect(await (await gatePromise).json()).toEqual({ decision: "allow" });
    expect(broker.pending()).toHaveLength(0);
  });

  it("denies a deny-tier tool immediately", async () => {
    const { app } = makeDaemon();
    const res = await app(post("/api/gate", { name: "Bash", input: { command: "rm -rf /" } }));
    expect(await res.json()).toEqual({ decision: "deny" });
  });
});

describe("/api/sync", () => {
  it("triggers a sync and returns the result", async () => {
    let called = false;
    const { app } = makeDaemon({ syncFn: async () => { called = true; return "ok"; } });
    const res = await app(post("/api/sync", {}));
    expect(await res.json()).toEqual({ result: "ok" });
    expect(called).toBe(true);
  });

  it("GET reports the current sync status for the dot (incl. needs-help)", async () => {
    const { app } = makeDaemon({ syncStatus: () => "needs-help" });
    const res = await app(new Request("http://127.0.0.1/api/sync"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "needs-help" });
  });

  it("GET defaults to ok when no status dep is wired", async () => {
    const { app } = makeDaemon();
    const res = await app(new Request("http://127.0.0.1/api/sync"));
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("body validation - malformed input 400s, never a raw 500", () => {
  it("400s unparseable JSON on a POST route", async () => {
    const { app } = makeDaemon();
    const res = await app(new Request("http://127.0.0.1/api/gate", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid JSON/i);
  });

  it("400s a malformed gate invocation without opening a card", async () => {
    const { app, broker } = makeDaemon();
    expect((await app(post("/api/gate", { input: {} }))).status).toBe(400); // missing name
    expect((await app(post("/api/gate", { name: "Bash", input: "rm -rf /" }))).status).toBe(400); // input not an object
    expect(broker.pending()).toHaveLength(0); // never reached the gate
  });

  it("defaults a missing gate input to {} (a hook payload without args still evaluates)", async () => {
    const { app } = makeDaemon();
    expect(await (await app(post("/api/gate", { name: "Read" }))).json()).toEqual({ decision: "allow" });
  });

  it("400s an /api/approve verdict outside approve|deny (card stays pending)", async () => {
    const { app, broker } = makeDaemon();
    const gateP = app(post("/api/gate", { name: "Bash", input: { command: "git push" } }));
    await delay(5);
    const card = broker.pending()[0]!;
    const res = await app(post("/api/approve", { id: card.id, verdict: "maybe" }));
    expect(res.status).toBe(400);
    expect(broker.pending()).toHaveLength(1); // the junk verdict resolved nothing
    broker.resolve(card.id, "deny"); // settle the in-flight gate call
    await gateP;
  });

  it("400s a prompt body without a string prompt (no SSE stream opened)", async () => {
    const { app } = makeDaemon();
    const res = await app(post("/api/prompt", { prompt: 42 }));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("App Store - /api/catalog", () => {
  const okResult = (id: string, target: string) => ({ id, target, did: { app: true, skills: [] as string[], mcp: true, policy: false } });
  // install() takes no target — the app face always lands in the operator's own root.
  const okInstall = (id: string) => okResult(id, "private");

  it("GET /api/catalog returns the pack list", async () => {
    const { app } = makeDaemon({
      packStore: {
        list: () => [{ id: "notion", name: "Notion", installed: false, faces: { app: true, mcp: true, apiKey: false, provision: false, skills: 1 } }],
        install: okInstall,
        uninstall: okInstall,
        setApiKey: () => {},
      },
    });
    const res = await app(new Request("http://127.0.0.1/api/catalog"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { packs: { id: string }[] }).packs[0]!.id).toBe("notion");
  });

  // The install/uninstall routes block on an approval card (invariant 5); resolve the pending card
  // from the broker to let the awaiting request proceed.
  async function settle(broker: ApprovalBroker, verdict: "approve" | "deny") {
    await delay(2);
    const card = broker.pending()[0];
    if (card) broker.resolve(card.id, verdict);
  }

  it("POST /api/catalog/install runs install after the operator approves the card", async () => {
    let got: string | undefined;
    const { app, broker } = makeDaemon({
      packStore: {
        list: () => [],
        uninstall: okInstall,
        install: (id) => { got = id; return okResult(id, "private"); },
        setApiKey: () => {},
      },
    });
    const p = app(post("/api/catalog/install", { id: "notion", target: "team" }));
    await settle(broker, "approve");
    const res = await p;
    expect(res.status).toBe(200);
    expect(got).toBe("notion");
    expect(((await res.json()) as { did: { mcp: boolean } }).did.mcp).toBe(true);
  });

  it("POST /api/catalog/apikey stores a key and reports connected (no approval card - local credential)", async () => {
    let got: [string, string | null] | undefined;
    const { app } = makeDaemon({
      packStore: { list: () => [], install: okInstall, uninstall: okInstall, setApiKey: (id, key) => { got = [id, key]; } },
    });
    const res = await app(post("/api/catalog/apikey", { id: "stripe", key: "  rk_live_9  " }));
    expect(res.status).toBe(200);
    expect(got).toEqual(["stripe", "rk_live_9"]); // trimmed
    expect((await res.json() as { connected: boolean }).connected).toBe(true);
  });

  it("POST /api/catalog/apikey with an empty key clears it (disconnect)", async () => {
    let got: [string, string | null] | undefined;
    const { app } = makeDaemon({
      packStore: { list: () => [], install: okInstall, uninstall: okInstall, setApiKey: (id, key) => { got = [id, key]; } },
    });
    const res = await app(post("/api/catalog/apikey", { id: "stripe", key: "" }));
    expect(res.status).toBe(200);
    expect(got).toEqual(["stripe", null]);
    expect((await res.json() as { connected: boolean }).connected).toBe(false);
  });

  it("POST /api/catalog/install returns 403 when the operator denies", async () => {
    let called = false;
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], uninstall: okInstall, install: (id) => { called = true; return okResult(id, "private"); }, setApiKey: () => {} },
    });
    const p = app(post("/api/catalog/install", { id: "notion", target: "team" }));
    await settle(broker, "deny");
    const res = await p;
    expect(res.status).toBe(403);
    expect(called).toBe(false); // never ran the install
  });

  it("POST /api/catalog/install requires an id, failing fast without opening a card", async () => {
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], install: okInstall, uninstall: okInstall, setApiKey: () => {} },
    });
    const res = await app(post("/api/catalog/install", {}));
    expect(res.status).toBe(400);
    expect(broker.pending()).toHaveLength(0); // validation fails fast, no card opened
  });

  it("POST /api/catalog/uninstall still rejects target 'core' with 400 (before any approval card)", async () => {
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], install: okInstall, uninstall: okInstall, setApiKey: () => {} },
    });
    const res = await app(post("/api/catalog/uninstall", { id: "notion", target: "core" }));
    expect(res.status).toBe(400);
    expect(broker.pending()).toHaveLength(0);
  });

  it("the install approval card carries NO target - install has no scope to choose", async () => {
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], install: okInstall, uninstall: okInstall, setApiKey: () => {} },
    });
    const p = app(post("/api/catalog/install", { id: "notion" }));
    await delay(2);
    const card = broker.pending()[0]!;
    expect(card.tool.input).toEqual({ id: "notion" });
    broker.resolve(card.id, "approve");
    await p;
  });

  it("POST /api/catalog/install returns 404 for an unknown pack id (after approval)", async () => {
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], install: () => { throw new Error("unknown pack: ghost"); }, uninstall: okInstall, setApiKey: () => {} },
    });
    const p = app(post("/api/catalog/install", { id: "ghost" }));
    await settle(broker, "approve");
    const res = await p;
    expect(res.status).toBe(404);
  });

  it("POST /api/catalog/uninstall routes to uninstall after approval", async () => {
    let called = false;
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], install: okInstall, uninstall: (id, t) => { called = true; return okResult(id, t); }, setApiKey: () => {} },
    });
    const p = app(post("/api/catalog/uninstall", { id: "notion", target: "private" }));
    await settle(broker, "approve");
    const res = await p;
    expect(res.status).toBe(200);
    expect(called).toBe(true);
  });
});

// The escape-hatch grant. Unlike install/uninstall this is NOT approval-gated - like OAuth connect and
// the API-key route it is the operator authorizing their own workspace - but it must state what is
// being granted up front, and the callback must never store a credential on a bad state.
describe("App Store - escape-hatch provisioning", () => {
  const okResult = (id: string, target: string) => ({ id, target, did: { app: true, skills: [] as string[], mcp: true, policy: false } });
  // install() takes no target — the app face always lands in the operator's own root.
  const okInstall = (id: string) => okResult(id, "private");
  const base = {
    list: () => [],
    install: okInstall,
    uninstall: okInstall,
    setApiKey: () => {},
  };

  it("POST /api/catalog/provision returns the consent URL and what it grants", async () => {
    const { app } = makeDaemon({
      packStore: {
        ...base,
        beginProvision: (id: string) => ({ authorizeUrl: `https://p.example/c?x=${id}`, grants: "Full account access." }),
      },
    });
    const res = await app(post("/api/catalog/provision", { id: "protocol" }));
    expect(res.status).toBe(200);
    // `grants` rides back with the URL so the UI can say what is being granted BEFORE the browser opens.
    expect(await res.json()).toEqual({ authorizeUrl: "https://p.example/c?x=protocol", grants: "Full account access." });
  });

  it("surfaces a refusal (not installed / no such face) as a 400, not a crash", async () => {
    const { app } = makeDaemon({
      packStore: {
        ...base,
        beginProvision: () => { throw new Error("install \"protocol\" before granting it extra access"); },
      },
    });
    const res = await app(post("/api/catalog/provision", { id: "protocol" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/before granting/i);
  });

  it("requires an id", async () => {
    const { app } = makeDaemon({ packStore: { ...base, beginProvision: () => ({ authorizeUrl: "x", grants: "y" }) } });
    expect((await app(post("/api/catalog/provision", {}))).status).toBe(400);
  });

  it("completes the grant from the loopback callback and confirms in the browser", async () => {
    let got: [string, string | null] | undefined;
    const { app } = makeDaemon({
      packStore: {
        ...base,
        finishProvision: async (id: string, params: URLSearchParams) => {
          got = [id, params.get("code")];
          return { id, name: "Protocol" };
        },
      },
    });
    const res = await app(new Request("http://127.0.0.1/oauth/provision/protocol/callback?code=wsc_1&state=S"));
    expect(res.status).toBe(200);
    expect(got).toEqual(["protocol", "wsc_1"]);
    expect(await res.text()).toMatch(/Protocol/);
  });

  it("reports a failed exchange in the browser instead of throwing", async () => {
    const { app } = makeDaemon({
      packStore: {
        ...base,
        finishProvision: async () => { throw new Error("authorization state did not match - start the connection again"); },
      },
    });
    const res = await app(new Request("http://127.0.0.1/oauth/provision/protocol/callback?code=x&state=BAD"));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/state did not match/i);
  });

  it("treats a provider-side denial as a clean cancel, never an exchange", async () => {
    let called = false;
    const finishProvision = async () => { called = true; return { id: "protocol", name: "Protocol" }; };
    const { app } = makeDaemon({ packStore: { ...base, finishProvision } });
    const res = await app(new Request("http://127.0.0.1/oauth/provision/protocol/callback?error=denied&state=S"));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/cancelled/i);
    expect(called).toBe(false);
  });

  it("POST /api/catalog/provision/clear forgets the credential locally", async () => {
    let cleared: string | undefined;
    const { app } = makeDaemon({ packStore: { ...base, clearProvision: (id: string) => { cleared = id; } } });
    const res = await app(post("/api/catalog/provision/clear", { id: "protocol" }));
    expect(res.status).toBe(200);
    expect(cleared).toBe("protocol");
  });

  it("does not expose the routes at all for a packStore without the face", async () => {
    const { app } = makeDaemon({ packStore: base });
    expect((await app(post("/api/catalog/provision", { id: "protocol" }))).status).toBe(404);
    expect((await app(new Request("http://127.0.0.1/oauth/provision/protocol/callback?code=x&state=S"))).status).toBe(404);
  });
});
