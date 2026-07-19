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
    vault: {
      listDocs: () => ["team/conventions.md", "team/updates/2026-07.md"],
      readDoc: (p) => (p === "team/conventions.md" ? "# Conventions\n" : ""),
      history: (p) => (p === "team/conventions.md" ? [{ sha: "abc1234", at: 1000, author: "Dan", subject: "seed conventions" }] : []),
    },
  });
}

describe("vault read routes", () => {
  it("lists documents", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/files"));
    expect((await res.json())).toEqual({ docs: ["team/conventions.md", "team/updates/2026-07.md"] });
  });

  it("reads a document's content", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/doc?path=team/conventions.md"));
    expect(await res.json()).toEqual({ path: "team/conventions.md", content: "# Conventions\n" });
  });

  it("returns a document's history", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/history?path=team/conventions.md"));
    const body = (await res.json()) as { history: { subject: string }[] };
    expect(body.history[0]!.subject).toBe("seed conventions");
  });

  it("400s when path is missing", async () => {
    const res = await makeDaemon()(new Request("http://127.0.0.1/api/doc"));
    expect(res.status).toBe(400);
  });
});

describe("vault restore route (one-tap history restore)", () => {
  function make() {
    const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
    const saved: { path: string; content: string }[] = [];
    const app = createDaemon({
      workspace: "/ws",
      roots: [],
      gate: new Gate(new PolicyEngine({ allow: [], ask: [], deny: [], default: "ask" }), broker),
      broker,
      async *runPrompt() { yield { kind: "done" } as UiEvent; },
      buildMap: () => ({ nodes: [], edges: [] }),
      syncFn: async () => "ok",
      vault: {
        listDocs: () => [],
        readDoc: () => "",
        history: () => [],
        readDocAt: (_p, sha) => {
          if (sha === "deadbee") throw new Error("invalid commit id");
          return "# restored @ " + sha + "\n";
        },
      },
      saveDoc: (path, content) => saved.push({ path, content }),
    });
    return { app, saved };
  }
  const post = (p: string, b: unknown) =>
    new Request("http://127.0.0.1" + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  it("reads the doc at the sha, writes it via saveDoc (a new commit), and returns the content", async () => {
    const { app, saved } = make();
    const res = await app(post("/api/doc/restore", { path: "team/notes.md", sha: "abc1234" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: "team/notes.md", content: "# restored @ abc1234\n" });
    expect(saved).toEqual([{ path: "team/notes.md", content: "# restored @ abc1234\n" }]);
  });

  it("400s and writes nothing when the version can't be read (bad sha / absent at that commit)", async () => {
    const { app, saved } = make();
    const res = await app(post("/api/doc/restore", { path: "team/notes.md", sha: "deadbee" }));
    expect(res.status).toBe(400);
    expect(saved).toEqual([]);
  });

  it("400s on a missing sha (body validation)", async () => {
    const { app } = make();
    expect((await app(post("/api/doc/restore", { path: "team/notes.md" }))).status).toBe(400);
  });
});
