import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

let webRoot: string;
let app: (req: Request) => Promise<Response>;

beforeEach(() => {
  webRoot = mkdtempSync(join(tmpdir(), "buildex-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>buildex</title><body>console</body>");
  const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
  app = createDaemon({
    workspace: "/ws",
    roots: [],
    gate: new Gate(new PolicyEngine({ allow: [], ask: [], deny: [], default: "ask" }), broker),
    broker,
    async *runPrompt() { yield { kind: "done" } as UiEvent; },
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
    webRoot,
  });
});
afterEach(() => rmSync(webRoot, { recursive: true, force: true }));

describe("daemon static UI", () => {
  it("serves the operator console at / as text/html", async () => {
    const res = await app(new Request("http://127.0.0.1/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("console");
  });

  it("refuses path traversal out of the web root", async () => {
    const res = await app(new Request("http://127.0.0.1/../../etc/passwd"));
    expect(res.status).toBe(404);
  });

  it("refuses a sibling directory that merely shares the web root's name prefix", async () => {
    // `<webRoot>-secrets` starts with the web root path as a string but is NOT under it; a bare
    // startsWith(webRoot) prefix check would leak it, the trailing-separator check refuses it.
    const sibling = webRoot + "-secrets";
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.txt"), "TOP SECRET");
    const rel = "../" + webRoot.split("/").pop() + "-secrets/secret.txt";
    try {
      const res = await app(new Request("http://127.0.0.1/" + rel));
      expect(res.status).toBe(404);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("still serves API routes (static does not shadow them)", async () => {
    const res = await app(new Request("http://127.0.0.1/healthz"));
    expect(await res.json()).toEqual({ ok: true });
  });
});
