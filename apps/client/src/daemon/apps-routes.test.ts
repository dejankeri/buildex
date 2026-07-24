import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "./daemon.js";
import { listApps, writeAppManifest } from "../brain/apps.js";
import { serveApp, brokerData } from "../server/app-serve.js";
import type { Root } from "../brain/graph.js";
import type { DaemonDeps } from "./daemon.js";

let dir: string;
let roots: Root[];
let handler: (req: Request) => Promise<Response>;

// A minimal deps object - only the app surface is exercised here. appFetch/appSecrets are recording
// fakes: the brokers themselves are covered in server/app-fetch.test.ts; these routes are about
// body validation and status/error relay.
let fetchReqs: unknown[];
let secretSets: unknown[];
function makeDeps(): DaemonDeps {
  return {
    workspace: dir,
    roots,
    gate: {} as never,
    broker: { pending: () => [] } as never,
    runPrompt: (() => (async function* () {})()) as never,
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
    appCatalog: { list: () => listApps(roots) },
    appStore: {
      create: (input) => {
        const manifest = input.kind === "external"
          ? { name: input.title, icon: input.icon, kind: "external" as const, url: input.url }
          : { name: input.title, icon: input.icon, kind: "local" as const };
        writeAppManifest(roots, { repo: input.repo, name: input.name, manifest, ...(input.kind === "local" ? { starter: "<h1>New app</h1>" } : {}) });
        return { name: input.name };
      },
    },
    appServe: (urlPath: string) => serveApp(roots, urlPath),
    appData: (req) => brokerData(roots, req),
    appFetch: async (req) => {
      fetchReqs.push(req);
      return { ok: true, result: { status: 200, body: "pong" }, status: 200 };
    },
    appSecrets: {
      set: (req) => {
        secretSets.push(req);
        return { ok: true, status: 200 };
      },
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-approutes-"));
  mkdirSync(join(dir, "team"), { recursive: true });
  roots = [{ name: "team", dir: join(dir, "team") }];
  fetchReqs = [];
  secretSets = [];
  handler = createDaemon(makeDeps());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("/api/apps", () => {
  it("GET returns the (initially empty) app list", async () => {
    const res = await handler(new Request("http://x/api/apps"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apps: [] });
  });

  it("POST creates an external app that then appears in GET", async () => {
    const post = await handler(new Request("http://x/api/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "team", name: "protocol", kind: "external", title: "Protocol", icon: "🌐", url: "https://app.protocolcrm.com" }),
    }));
    expect(await post.json()).toEqual({ ok: true, name: "protocol" });
    const list = (await (await handler(new Request("http://x/api/apps"))).json()) as { apps: { name: string; kind: string; url?: string }[] };
    expect(list.apps[0]).toMatchObject({ name: "protocol", kind: "external", url: "https://app.protocolcrm.com" });
  });

  it("POST rejects a bad name with 400", async () => {
    const res = await handler(new Request("http://x/api/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "team", name: "Bad Name", kind: "local", title: "X" }),
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/kebab/i);
  });

  it("POST rejects a non-http(s) external app url with 400", async () => {
    const res = await handler(new Request("http://x/api/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "team", name: "bad-ext", kind: "external", title: "X", url: "javascript:alert(1)" }),
    }));
    expect(res.status).toBe(400);
  });
});

describe("/apps-api/data body validation", () => {
  it("400s an unknown op before it reaches the broker", async () => {
    const res = await handler(new Request("http://x/apps-api/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "nuke", repo: "team", name: "crm-demo", path: "notes.md" }),
    }));
    expect(res.status).toBe(400);
  });

  it("400s a request that does not identify the calling app", async () => {
    const res = await handler(new Request("http://x/apps-api/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "read", path: "notes.md" }),
    }));
    expect(res.status).toBe(400);
  });

  it("400s malformed JSON instead of raising a raw 500", async () => {
    const res = await handler(new Request("http://x/apps-api/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    }));
    expect(res.status).toBe(400);
  });
});

describe("/apps-api/fetch + /api/apps/secret", () => {
  const post = (path: string, b: unknown) =>
    handler(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

  it("relays a well-formed brokered fetch and returns the broker's result", async () => {
    const res = await post("/apps-api/fetch", { repo: "team", name: "crm-demo", secret: "api-key", url: "https://api.example.com/ping" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { status: 200, body: "pong" } });
    expect(fetchReqs).toEqual([{ repo: "team", name: "crm-demo", secret: "api-key", url: "https://api.example.com/ping" }]);
  });

  it("400s a brokered fetch missing its secret or url before it reaches the broker", async () => {
    expect((await post("/apps-api/fetch", { repo: "team", name: "crm-demo", url: "https://x.example.com" })).status).toBe(400);
    expect((await post("/apps-api/fetch", { repo: "team", name: "crm-demo", secret: "api-key" })).status).toBe(400);
    expect(fetchReqs).toHaveLength(0);
  });

  it("stores a secret value (trimmed) and clears on an empty value", async () => {
    const res = await post("/api/apps/secret", { repo: "team", name: "crm-demo", secret: "api-key", value: " v1 " });
    expect(await res.json()).toEqual({ ok: true, stored: true });
    const cleared = await post("/api/apps/secret", { repo: "team", name: "crm-demo", secret: "api-key", value: "" });
    expect(await cleared.json()).toEqual({ ok: true, stored: false });
    expect(secretSets).toEqual([
      { repo: "team", name: "crm-demo", secret: "api-key", value: "v1" },
      { repo: "team", name: "crm-demo", secret: "api-key", value: null },
    ]);
  });
});

describe("/apps-serve/*", () => {
  it("GET serves a local app's HTML with the opaque-origin + closed-egress security headers", async () => {
    const appDir = join(dir, "team", "apps", "crm-demo");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "app.json"), JSON.stringify({ name: "CRM", kind: "local" }));
    writeFileSync(join(appDir, "index.html"), "<head></head><body><h1>hi</h1></body>");

    const res = await handler(new Request("http://x/apps-serve/team/crm-demo/index.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups; connect-src 'self'");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET widens connect-src with the manifest's declared origins", async () => {
    const appDir = join(dir, "team", "apps", "crm-demo");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "app.json"), JSON.stringify({ name: "CRM", kind: "local", origins: ["https://api.example.com"] }));
    writeFileSync(join(appDir, "index.html"), "<head></head><body><h1>hi</h1></body>");

    const res = await handler(new Request("http://x/apps-serve/team/crm-demo/index.html"));
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups; connect-src 'self' https://api.example.com",
    );
  });
});
