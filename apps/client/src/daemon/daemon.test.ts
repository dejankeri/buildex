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

  it("GET /api/catalog returns the pack list", async () => {
    const { app } = makeDaemon({
      packStore: {
        list: () => [{ id: "notion", name: "Notion", installed: false, faces: { app: true, mcp: true, skills: 1 } }],
        install: okResult,
        uninstall: okResult,
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
    let got: [string, string] | undefined;
    const { app, broker } = makeDaemon({
      packStore: {
        list: () => [],
        uninstall: okResult,
        install: (id, t) => { got = [id, t]; return okResult(id, t); },
      },
    });
    const p = app(post("/api/catalog/install", { id: "notion", target: "team" }));
    await settle(broker, "approve");
    const res = await p;
    expect(res.status).toBe(200);
    expect(got).toEqual(["notion", "team"]);
    expect(((await res.json()) as { did: { mcp: boolean } }).did.mcp).toBe(true);
  });

  it("POST /api/catalog/install returns 403 when the operator denies", async () => {
    let called = false;
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], uninstall: okResult, install: (id, t) => { called = true; return okResult(id, t); } },
    });
    const p = app(post("/api/catalog/install", { id: "notion", target: "team" }));
    await settle(broker, "deny");
    const res = await p;
    expect(res.status).toBe(403);
    expect(called).toBe(false); // never ran the install
  });

  it("POST /api/catalog/install rejects a bad target with 400 (before any approval card)", async () => {
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], install: okResult, uninstall: okResult },
    });
    const res = await app(post("/api/catalog/install", { id: "notion", target: "core" }));
    expect(res.status).toBe(400);
    expect(broker.pending()).toHaveLength(0); // validation fails fast, no card opened
  });

  it("POST /api/catalog/install returns 404 for an unknown pack id (after approval)", async () => {
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], install: () => { throw new Error("unknown pack: ghost"); }, uninstall: okResult },
    });
    const p = app(post("/api/catalog/install", { id: "ghost", target: "team" }));
    await settle(broker, "approve");
    const res = await p;
    expect(res.status).toBe(404);
  });

  it("POST /api/catalog/uninstall routes to uninstall after approval", async () => {
    let called = false;
    const { app, broker } = makeDaemon({
      packStore: { list: () => [], install: okResult, uninstall: (id, t) => { called = true; return okResult(id, t); } },
    });
    const p = app(post("/api/catalog/uninstall", { id: "notion", target: "private" }));
    await settle(broker, "approve");
    const res = await p;
    expect(res.status).toBe(200);
    expect(called).toBe(true);
  });
});
