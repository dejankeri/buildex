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

// A minimal deps object - only the app surface is exercised here.
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
          : { name: input.title, icon: input.icon, kind: "local" as const, data: { read: true } };
        writeAppManifest(roots, { repo: input.repo, name: input.name, manifest, ...(input.kind === "local" ? { starter: "<h1>New app</h1>" } : {}) });
        return { name: input.name };
      },
    },
    appServe: (urlPath: string) => serveApp(roots, urlPath),
    appData: (req) => brokerData(roots, req),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-approutes-"));
  mkdirSync(join(dir, "team"), { recursive: true });
  roots = [{ name: "team", dir: join(dir, "team") }];
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
      body: JSON.stringify({ op: "nuke", path: "notes.md" }),
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

describe("/apps-serve/*", () => {
  it("GET serves a local app's HTML with the opaque-origin security headers", async () => {
    const appDir = join(dir, "team", "apps", "crm-demo");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "app.json"), JSON.stringify({ name: "CRM", kind: "local", data: { read: true } }));
    writeFileSync(join(appDir, "index.html"), "<head></head><body><h1>hi</h1></body>");

    const res = await handler(new Request("http://x/apps-serve/team/crm-demo/index.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
