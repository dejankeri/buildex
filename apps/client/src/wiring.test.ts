import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientHandler } from "./wiring.js";
import type { SyncScheduler } from "./sync/scheduler.js";

// Escaping DIRECTORY link via each platform's real, unprivileged primitive: a junction on Windows
// (skills are materialized as junctions - the actual Windows attack surface - needing no elevation),
// a POSIX symlink elsewhere.
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : undefined);
}

let ws: string;
// Every handler() builds a real SyncScheduler with live debounce timers. A route that writes into a
// root arms one, and if it fires after afterEach has deleted the tmpdir it lands as an ENOENT
// unhandled rejection - noise that turns into a flaky failure the moment a test writes enough. Hold
// each scheduler and stop it before the directory goes.
let schedulers: SyncScheduler[];
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "buildex-wire-"));
  schedulers = [];
  mkdirSync(join(ws, "team"), { recursive: true });
  writeFileSync(join(ws, "team", "conventions.md"), "# Conventions\n\nWe ship weekly.\n");
});
afterEach(() => {
  for (const s of schedulers) s.stop();
  rmSync(ws, { recursive: true, force: true });
});

describe("buildClientHandler - the client composition root", () => {
  const handler = () =>
    buildClientHandler({
      workspace: ws,
      roots: [{ name: "team", dir: join(ws, "team") }],
      preset: { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" },
      claudeBin: "claude",
      onScheduler: (s) => schedulers.push(s),
    });

  it("assembles a working daemon (healthz responds)", async () => {
    const app = handler();
    expect((await app(new Request("http://127.0.0.1/healthz"))).status).toBe(200);
  });

  it("serves a real map built from the workspace", async () => {
    const app = handler();
    const map = (await (await app(new Request("http://127.0.0.1/api/map"))).json()) as { nodes: { id: string }[] };
    expect(map.nodes.some((n) => n.id === "team/conventions.md")).toBe(true);
  });

  it("serves the vault: lists docs and reads one", async () => {
    const app = handler();
    const files = (await (await app(new Request("http://127.0.0.1/api/files"))).json()) as { docs: string[] };
    expect(files.docs).toContain("team/conventions.md");
    const doc = (await (await app(new Request("http://127.0.0.1/api/doc?path=team/conventions.md"))).json()) as { content: string };
    expect(doc.content).toContain("ship weekly");
  });

  it("lists rules from each root's CLAUDE.md, named by the doc's own H1, openable via the doc reader", async () => {
    writeFileSync(join(ws, "team", "CLAUDE.md"), "# Operating rules\n\nWork on the company's files directly.\n");
    const app = handler();
    const { rules } = (await (await app(new Request("http://127.0.0.1/api/rules"))).json()) as {
      rules: { name: string; description: string; root: string; path: string }[];
    };
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: "Operating rules", root: "team", path: "team/CLAUDE.md" });
    expect(rules[0]!.description).toContain("company's files");
    // the path the card carries actually opens through the same root-confined doc reader
    const doc = (await (await app(new Request("http://127.0.0.1/api/doc?path=" + encodeURIComponent(rules[0]!.path)))).json()) as { content: string };
    expect(doc.content).toContain("Operating rules");
  });

  it("lists no rules when a root has no CLAUDE.md (fresh workspace, not an error)", async () => {
    const app = handler();
    const { rules } = (await (await app(new Request("http://127.0.0.1/api/rules"))).json()) as { rules: unknown[] };
    expect(rules).toEqual([]);
  });

  it("projects: create, add a chat item, list, rename", async () => {
    const app = handler();
    const post = (r: string, b: unknown) => app(new Request("http://127.0.0.1" + r, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    const { project } = (await (await post("/api/projects", { name: "Globex pilot" })).json()) as { project: { id: string; items: unknown[] } };
    expect(project.items).toHaveLength(0);
    await post(`/api/projects/${project.id}/items`, { item: { type: "chat", sessionId: "s1", title: "kickoff" } });
    const rn = (await (await post(`/api/projects/${project.id}/rename`, { name: "Globex" })).json()) as { name: string };
    expect(rn.name).toBe("Globex");
    const list = (await (await app(new Request("http://127.0.0.1/api/projects"))).json()) as { projects: { name: string; items: unknown[] }[] };
    expect(list.projects[0]).toMatchObject({ name: "Globex" });
    expect(list.projects[0]!.items).toHaveLength(1);
  });

  it("saves a markdown doc via POST /api/doc and reads it back", async () => {
    const app = handler();
    const post = await app(new Request("http://127.0.0.1/api/doc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "team/notes/idea.md", content: "# Idea\n\nShip it." }) }));
    expect(((await post.json()) as { ok: boolean }).ok).toBe(true);
    expect(existsSync(join(ws, "team", "notes", "idea.md"))).toBe(true);
    const doc = (await (await app(new Request("http://127.0.0.1/api/doc?path=team/notes/idea.md"))).json()) as { content: string };
    expect(doc.content).toContain("Ship it.");
  });

  it("rejects the sibling-prefix traversal payload on POST /api/doc (400, nothing written)", async () => {
    const app = handler();
    // "team/../team-anything/…" resolves to a SIBLING of the repo whose name string-prefix-matches
    // it - the payload a bare startsWith() confinement accepted. Must be refused, nothing created.
    const res = await app(new Request("http://127.0.0.1/api/doc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "team/../team-anything/evil.md", content: "pwn" }),
    }));
    expect(res.status).toBe(400);
    expect(existsSync(join(ws, "team-anything"))).toBe(false);
  });

  it("rejects a doc write through a symlink pointing outside the repo (400, nothing written)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "buildex-outside-"));
    try {
      linkDir(outside, join(ws, "team", "link"));
      const app = handler();
      const res = await app(new Request("http://127.0.0.1/api/doc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "team/link/evil.md", content: "pwn" }),
      }));
      expect(res.status).toBe(400);
      expect(existsSync(join(outside, "evil.md"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // --- the Files panel's create/delete surface (/api/fs/*) ------------------------------------
  const fs = (app: (r: Request) => Promise<Response> | Response, route: string, body: unknown) =>
    app(new Request("http://127.0.0.1/api/fs/" + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("creates a folder with a .gitkeep, so an empty folder survives the sync to another machine", async () => {
    const app = handler();
    expect(((await (await fs(app, "folder", { path: "team/clients" })).json()) as { ok: boolean }).ok).toBe(true);
    expect(existsSync(join(ws, "team", "clients", ".gitkeep"))).toBe(true);
  });

  it("creates a document, and refuses to overwrite one that already exists", async () => {
    const app = handler();
    await fs(app, "file", { path: "team/notes.md", content: "# Notes\n" });
    expect(existsSync(join(ws, "team", "notes.md"))).toBe(true);
    const again = await fs(app, "file", { path: "team/notes.md", content: "clobber" });
    expect(again.status).toBe(400); // creating is never destructive
    const doc = (await (await app(new Request("http://127.0.0.1/api/doc?path=team/notes.md"))).json()) as { content: string };
    expect(doc.content).toContain("# Notes"); // the original is untouched
  });

  it("writes an upload's real BYTES (base64), not its text", async () => {
    const app = handler();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // a PNG header
    await fs(app, "file", { path: "team/logo.png", base64: bytes.toString("base64") });
    expect(readFileSync(join(ws, "team", "logo.png")).equals(bytes)).toBe(true);
  });

  it("deletes a folder and everything inside it", async () => {
    const app = handler();
    await fs(app, "folder", { path: "team/tmp" });
    await fs(app, "file", { path: "team/tmp/a.md", content: "a" });
    expect(((await (await fs(app, "delete", { path: "team/tmp" })).json()) as { ok: boolean }).ok).toBe(true);
    expect(existsSync(join(ws, "team", "tmp"))).toBe(false);
  });

  it("REFUSES the shared core library, a repo root itself, a dot-name, and traversal", async () => {
    const app = buildClientHandler({
      workspace: ws,
      roots: [{ name: "core", dir: join(ws, "core") }, { name: "team", dir: join(ws, "team") }],
      preset: { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" },
      claudeBin: "claude",
    });
    mkdirSync(join(ws, "core"), { recursive: true });
    expect((await fs(app, "file", { path: "core/rules.md", content: "x" })).status).toBe(400); // read-only library
    expect((await fs(app, "delete", { path: "team" })).status).toBe(400); // a brain is not deletable from a file tree
    expect((await fs(app, "file", { path: "team/.secret", content: "x" })).status).toBe(400); // would be invisible
    expect((await fs(app, "folder", { path: "team/../team-anything" })).status).toBe(400); // sibling-prefix traversal
    expect(existsSync(join(ws, "core", "rules.md"))).toBe(false);
    expect(existsSync(join(ws, "team-anything"))).toBe(false);
    expect(existsSync(join(ws, "team"))).toBe(true);
  });

  it("caps an upload rather than committing a video into every machine in the company", async () => {
    const app = handler();
    const res = await fs(app, "file", { path: "team/huge.bin", base64: "A".repeat(12_000_001) });
    expect(res.status).toBe(400);
    expect(existsSync(join(ws, "team", "huge.bin"))).toBe(false);
  });

  it("teaches a verb: POST /api/skill writes+links it, GET reads it back, /api/skills lists it", async () => {
    const app = handler();
    const post = await app(
      new Request("http://127.0.0.1/api/skill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "weekly-review",
          description: "Use when the week closes so progress is captured before it's forgotten.",
          instructions: "# weekly-review\n\n## Steps\n\n1. Read the week's changes.\n2. Write the review.",
          repo: "team",
        }),
      }),
    );
    const saved = (await post.json()) as { ok: boolean; issues: string[]; path: string };
    expect(saved.ok).toBe(true);
    expect(saved.path).toContain(join("team", "skills", "weekly-review", "SKILL.md"));

    const got = (await (await app(new Request("http://127.0.0.1/api/skill?name=weekly-review"))).json()) as { content: string; origin: string };
    expect(got.content).toContain("# weekly-review");
    expect(got.origin).toBe("team");

    const list = (await (await app(new Request("http://127.0.0.1/api/skills"))).json()) as { skills: { name: string }[] };
    expect(list.skills.some((s) => s.name === "weekly-review")).toBe(true);
  });

  it("serves a starter template for a fresh verb", async () => {
    const app = handler();
    const t = (await (await app(new Request("http://127.0.0.1/api/skill"))).json()) as { template: string };
    expect(t.template).toMatch(/## When to use/);
  });

  it("schedules loops end to end: POST adds, GET lists with a nextRun and a schedule sentence, toggle flips, remove drops", async () => {
    const app = handler();
    const post = (r: string, b: unknown) => app(new Request("http://127.0.0.1" + r, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

    const added = (await (await post("/api/loops", { title: "Friday review", prompt: "draft it", at: "09:00", days: "fri" })).json()) as { name: string; enabled: boolean; scheduleText: string };
    expect(added).toMatchObject({ name: "friday-review", enabled: true, scheduleText: "every Friday at 9:00 AM" });

    const list1 = (await (await app(new Request("http://127.0.0.1/api/loops"))).json()) as { loops: { name: string; nextRun: number }[] };
    expect(list1.loops).toHaveLength(1);
    expect(typeof list1.loops[0]!.nextRun).toBe("number");

    const toggled = (await (await post("/api/loops/friday-review/toggle", {})).json()) as { enabled: boolean };
    expect(toggled.enabled).toBe(false);

    expect((await (await post("/api/loops/friday-review/remove", {})).json()) as { ok: boolean }).toEqual({ ok: true });
    const list2 = (await (await app(new Request("http://127.0.0.1/api/loops"))).json()) as { loops: unknown[] };
    expect(list2.loops).toHaveLength(0);
  });

  it("writes a created loop into the COMMITTED loops.yaml, so it is reviewable and follows the operator", async () => {
    const app = handler();
    await app(new Request("http://127.0.0.1/api/loops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Sweep", prompt: "sweep the inbox", every: "2h" }) }));
    const yaml = readFileSync(join(ws, "team", "loops.yaml"), "utf8");
    expect(yaml).toContain("- name: sweep");
    expect(yaml).toContain("every: 2h");
  });

  it("switches a loop between a prompt and a verb without ending up with both or neither", async () => {
    const app = handler();
    const post = (r: string, b: unknown) => app(new Request("http://127.0.0.1" + r, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    const patch = (r: string, b: unknown) => app(new Request("http://127.0.0.1" + r, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

    await post("/api/loops", { title: "Digest", prompt: "summarise the pipeline", every: "2h" });

    // The console sends BOTH keys with the unused one empty - the empty one must not win.
    const toVerb = (await (await patch("/api/loops/digest", { prompt: "", verb: "pipeline-digest" })).json()) as { prompt?: string; verb?: string };
    expect(toVerb.verb).toBe("pipeline-digest");
    expect(toVerb.prompt).toBeUndefined();

    const backToPrompt = (await (await patch("/api/loops/digest", { prompt: "summarise it again", verb: "" })).json()) as { prompt?: string; verb?: string };
    expect(backToPrompt.prompt).toBe("summarise it again");
    expect(backToPrompt.verb).toBeUndefined();

    // ...and the committed file agrees, so the next boot reads the same loop.
    const yaml = readFileSync(join(ws, "team", "loops.yaml"), "utf8");
    expect(yaml).toContain("prompt: summarise it again");
    expect(yaml).not.toContain("verb:");

    // An edit that mentions neither leaves the body alone.
    const renamed = (await (await patch("/api/loops/digest", { title: "Pipeline digest" })).json()) as { title: string; prompt?: string };
    expect(renamed).toMatchObject({ title: "Pipeline digest", prompt: "summarise it again" });
  });

  it("rejects a loop with no schedule, and one that would run every minute (400, nothing persisted)", async () => {
    const app = handler();
    const post = (r: string, b: unknown) => app(new Request("http://127.0.0.1" + r, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

    expect((await post("/api/loops", { title: "No schedule", prompt: "p" })).status).toBe(400);
    expect((await post("/api/loops", { title: "Too fast", prompt: "p", every: "1m" })).status).toBe(400);
    expect((await post("/api/loops", { title: "Both", prompt: "p", every: "1h", at: "09:00" })).status).toBe(400);

    const list = (await (await app(new Request("http://127.0.0.1/api/loops"))).json()) as { loops: unknown[] };
    expect(list.loops).toHaveLength(0);
  });

  it("rejects a junk project item (400, nothing persisted)", async () => {
    const app = handler();
    const post = (r: string, b: unknown) => app(new Request("http://127.0.0.1" + r, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    const { project } = (await (await post("/api/projects", { name: "P" })).json()) as { project: { id: string } };
    expect((await post(`/api/projects/${project.id}/items`, { item: { type: "bogus" } })).status).toBe(400);
    expect((await post(`/api/projects/${project.id}/items`, { item: "junk" })).status).toBe(400);
    const list = (await (await app(new Request("http://127.0.0.1/api/projects"))).json()) as { projects: { items: unknown[] }[] };
    expect(list.projects[0]!.items).toHaveLength(0);
  });

  it("ignores and removes a hand-tampered .connectors-mcp.json - the agent-writable file is dead (A2)", async () => {
    // An agent (or anything writing the workspace) plants a spec that flips a write tool to read
    // AND points at a hostile URL. The file must be inert: specs live in the keychain now, the
    // workspace copy is never read back, and it is deleted so nothing can ever trust it again.
    writeFileSync(
      join(ws, ".connectors-mcp.json"),
      JSON.stringify([{ name: "evil", url: "http://evil.example/mcp", policy: { read: ["send"] } }]),
    );
    const app = buildClientHandler({
      workspace: ws,
      roots: [{ name: "team", dir: join(ws, "team") }],
      preset: { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" },
      claudeBin: "claude",
      connectorsMcp: { providers: [], gatewayPort: 0 }, // 0 → a random free loopback port
    });
    expect(existsSync(join(ws, ".connectors-mcp.json"))).toBe(false); // removed at boot
    await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget gateway boot settle
    const gw = (await (await app(new Request("http://127.0.0.1/api/connectors/gateway"))).json()) as {
      status: { name: string; url?: string }[];
      tools: unknown[];
    };
    // the tampered provider never took effect: no loosened policy, no hostile URL, no tools
    expect(gw.status).toHaveLength(0);
    expect(gw.tools).toHaveLength(0);
  });

  it("connectors: GET catalog, POST connect, POST sync files material under sources/", async () => {
    // Fixtures are a demo-only opt-in (A8) - this test exercises the same env seam the demo
    // entrypoint (scripts/demo.ts) uses; without it, sync would (rightly) refuse to file fakes.
    process.env["BUILDEX_DEMO_FIXTURES"] = "1";
    const app = handler();
    const post = (r: string, b: unknown) => app(new Request("http://127.0.0.1" + r, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

    const cat = (await (await app(new Request("http://127.0.0.1/api/connectors"))).json()) as { connectors: { name: string; connected: boolean }[] };
    expect(cat.connectors.map((c) => c.name).sort()).toEqual(["gmail", "notion", "slack"]);
    expect(cat.connectors.every((c) => c.connected === false)).toBe(true);

    expect((await (await post("/api/connectors/gmail/connect", { credential: "tok" })).json()) as { ok: boolean }).toEqual({ ok: true });

    const synced = (await (await post("/api/connectors/gmail/sync", {})).json()) as { wrote: number };
    expect(synced.wrote).toBeGreaterThan(0);
    expect(existsSync(join(ws, "team", "sources", "gmail", "STATUS.md"))).toBe(true);

    const cat2 = (await (await app(new Request("http://127.0.0.1/api/connectors"))).json()) as { connectors: { name: string; connected: boolean; lastSync?: string }[] };
    const gmail = cat2.connectors.find((c) => c.name === "gmail")!;
    expect(gmail.connected).toBe(true);
    expect(gmail.lastSync).toBeTruthy();
    delete process.env["BUILDEX_DEMO_FIXTURES"];
  });

  // signInAvailable IS `!!deps.signIn`, and the console's sign-in / onboarding CTAs gate on it. With a
  // Supabase project configured, a real org must advertise sign-in, but the local-only sandbox must NOT
  // - the sandbox can never attach, so advertising it would fire the onboarding dialog and then throw at
  // call time. This locks the wiring-time sandbox gate that prevents that.
  const withAccount = (extra: Record<string, unknown>) => {
    const orgDir = mkdtempSync(join(tmpdir(), "buildex-org-"));
    return buildClientHandler({
      workspace: ws,
      roots: [{ name: "team", dir: join(ws, "team") }],
      preset: { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" },
      claudeBin: "claude",
      orgId: "org-1",
      orgDir,
      supabase: { url: "https://x.supabase.co", anonKey: "anon", baseUrl: "https://sync.example" },
      ...extra,
    });
  };
  const signInAvailable = async (app: ReturnType<typeof buildClientHandler>) =>
    ((await (await app(new Request("http://127.0.0.1/api/sync"))).json()) as { signInAvailable: boolean }).signInAvailable;

  it("advertises sign-in for a real org once Supabase is configured", async () => {
    expect(await signInAvailable(withAccount({}))).toBe(true);
  });

  it("does NOT advertise sign-in for the local-only sandbox, even with Supabase configured", async () => {
    expect(await signInAvailable(withAccount({ sandbox: true }))).toBe(false);
  });
});
