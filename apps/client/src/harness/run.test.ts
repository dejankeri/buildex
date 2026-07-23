import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDeterministicTrack, type RunDeps } from "./run.js";
import { resolveCorePackDir } from "../provision/core-pack.js";
import type { Args } from "./cli-args.js";
import type { AgentDriver, RunPromptOpts, UiEvent } from "../agent/types.js";
import type { PackManifest } from "../brain/catalog.js";
import type { CatalogSource } from "../brain/catalog-source.js";

// The composition suite: real provision/install/regen/pin against the repo's real core pack,
// with only the outward seams faked (agent driver, fetch, env) - per the repo's DI rule.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CORE = resolveCorePackDir({ repoRoot: REPO });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const M: PackManifest = {
  id: "acme", name: "Acme",
  app: { url: "https://app.example.com" },
  mcp: { kind: "http", url: "https://api.example.com/mcp" },
  apiKey: { transport: "mcp-bearer", docsUrl: "https://help.example.com/k" },
  sandbox: {
    createUrl: "https://api.example.com/v1/sb",
    destroyUrl: "https://api.example.com/v1/sb/{id}",
    idPath: "data.id", keyPath: "data.key",
    docsUrl: "https://help.example.com/sb",
  },
  skills: ["acme-howto"],
};

function sourceWith(m: PackManifest): CatalogSource {
  const dir = tmp("cat-");
  const packDir = join(dir, m.id);
  mkdirSync(join(packDir, "skills", "acme-howto"), { recursive: true });
  writeFileSync(join(packDir, "pack.json"), JSON.stringify(m));
  writeFileSync(join(packDir, "skills", "acme-howto", "SKILL.md"), "# acme-howto\n");
  return { ids: () => [m.id], dir: (id) => (id === m.id ? packDir : undefined) };
}

function fakeDriver(events?: UiEvent[]): { driver: AgentDriver; seen: RunPromptOpts[] } {
  const seen: RunPromptOpts[] = [];
  const driver = {
    detect: async () => ({ available: true }),
    // eslint-disable-next-line @typescript-eslint/require-await
    runPrompt: async function* (o: RunPromptOpts) {
      seen.push(o);
      for (const e of events ?? ([{ kind: "text", text: "hi" }, { kind: "done" }] as unknown as UiEvent[])) yield e;
    },
  } as unknown as AgentDriver;
  return { driver, seen };
}

const res = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const mintBody = { data: { id: "ws_9", key: "sb_minted_key_9" } };

const localArgs: Args = { pack: "acme", sandbox: false, agent: true, mcpUrl: "http://localhost:9/mcp", prompt: undefined };
const sandboxArgs: Args = { pack: "acme", sandbox: true, agent: true, mcpUrl: undefined, prompt: undefined };
const plumbingArgs: Args = { pack: "acme", sandbox: false, agent: false, mcpUrl: undefined, prompt: undefined };

function depsWith(over: Partial<RunDeps>): RunDeps {
  return {
    source: sourceWith(M),
    corePackDir: CORE,
    baseDir: tmp("e2e-"),
    driver: fakeDriver().driver,
    fetch: (async () => res(500)) as unknown as typeof globalThis.fetch,
    env: {},
    now: () => new Date("2026-07-23T12:00:00Z"),
    log: () => {},
    ...over,
  };
}

describe("runDeterministicTrack - the composition", () => {
  it("local lane: pins the caller's url+key, grants the server rule to the drive, scrubs the key from the env, redacts it from the transcript, exit 0", async () => {
    const { driver, seen } = fakeDriver([
      { kind: "text", text: "key is pk_local_secret_1 hah" } as unknown as UiEvent,
      { kind: "done" } as unknown as UiEvent,
    ]);
    const env: Record<string, string | undefined> = { BUILDEX_LOCAL_MCP_KEY: "pk_local_secret_1", BUILDEX_SANDBOX_SECRET: "sb_admin" };
    let pinnedAtDrive: unknown;
    let envAtDrive: (string | undefined)[] | undefined;
    const origRunPrompt = driver.runPrompt.bind(driver);
    driver.runPrompt = (o: RunPromptOpts) => {
      pinnedAtDrive = JSON.parse(readFileSync(join(o.workspace, ".mcp.json"), "utf8"));
      envAtDrive = [env.BUILDEX_LOCAL_MCP_KEY, env.BUILDEX_SANDBOX_SECRET];
      return origRunPrompt(o);
    };

    const deps = depsWith({ driver, env });
    const out = await runDeterministicTrack(localArgs, deps);

    expect(out.exitCode).toBe(0);
    // Pin was live during the drive, with the caller's url and key:
    expect((pinnedAtDrive as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }).mcpServers["buildex-pack:acme"]).toEqual({
      type: "http", url: "http://localhost:9/mcp", headers: { Authorization: "Bearer pk_local_secret_1" },
    });
    // The spawn got exactly the pack's server rule:
    expect(seen[0]!.allowedTools).toEqual(["mcp__buildex-pack_acme"]);
    // Both secrets scrubbed from the env BEFORE the drive (the child must not inherit them):
    expect(envAtDrive).toEqual([undefined, undefined]);
    // The surviving transcript never contains the key:
    const transcript = readFileSync(join(out.runDir, "transcripts", "smoke-1.json"), "utf8");
    expect(transcript).not.toContain("pk_local_secret_1");
    // results.json written; workspace torn down, artifacts survive:
    expect(existsSync(join(out.runDir, "results.json"))).toBe(true);
    expect(existsSync(join(out.runDir, "workspace"))).toBe(false);
  });

  it("local lane: refuses to start without BUILDEX_LOCAL_MCP_KEY - nothing touches disk", async () => {
    const baseDir = tmp("e2e-");
    await expect(runDeterministicTrack(localArgs, depsWith({ baseDir, env: {} }))).rejects.toThrow(/BUILDEX_LOCAL_MCP_KEY/);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it("sandbox lane: mints, drives with the minted key redacted, destroys, records minted+destroyed", async () => {
    const calls: string[] = [];
    const fetch = (async (u: string | URL | Request, i?: RequestInit) => {
      calls.push(`${i?.method} ${u}`);
      return i?.method === "DELETE" ? res(204) : res(201, mintBody);
    }) as unknown as typeof globalThis.fetch;
    const { driver } = fakeDriver([
      { kind: "text", text: "minted sb_minted_key_9 spotted" } as unknown as UiEvent,
      { kind: "done" } as unknown as UiEvent,
    ]);
    const out = await runDeterministicTrack(sandboxArgs, depsWith({ driver, fetch, env: { BUILDEX_SANDBOX_SECRET: "sb_admin" } }));

    expect(out.exitCode).toBe(0);
    expect(calls.some((c) => c.startsWith("POST"))).toBe(true);
    expect(calls.some((c) => c.startsWith("DELETE") && c.includes("ws_9"))).toBe(true);
    const results = JSON.parse(readFileSync(join(out.runDir, "results.json"), "utf8"));
    expect(results.sandbox).toEqual({ minted: true, destroyed: true });
    const transcript = readFileSync(join(out.runDir, "transcripts", "smoke-1.json"), "utf8");
    expect(transcript).not.toContain("sb_minted_key_9");
  });

  it("sandbox lane: refuses to start without BUILDEX_SANDBOX_SECRET - nothing touches disk", async () => {
    const baseDir = tmp("e2e-");
    await expect(runDeterministicTrack(sandboxArgs, depsWith({ baseDir, env: {} }))).rejects.toThrow(/BUILDEX_SANDBOX_SECRET/);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it("destroy failure AFTER a successful drive still writes results.json and tears down, then rethrows (loud leak)", async () => {
    const fetch = (async (u: string | URL | Request, i?: RequestInit) =>
      i?.method === "DELETE" ? res(500) : res(201, mintBody)) as unknown as typeof globalThis.fetch;
    const baseDir = tmp("e2e-");
    await expect(
      runDeterministicTrack(sandboxArgs, depsWith({ baseDir, fetch, env: { BUILDEX_SANDBOX_SECRET: "sb_admin" } })),
    ).rejects.toThrow(/destroy/i);
    const runDir = join(baseDir, readdirSync(baseDir)[0]!);
    expect(existsSync(join(runDir, "results.json"))).toBe(true);
    const results = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8"));
    expect(results.sandbox).toEqual({ minted: true, destroyed: false });
    expect(existsSync(join(runDir, "workspace"))).toBe(false);
  });

  it("plumbing run (--no-sandbox --no-agent): exit 0, no drives, results written, stray secrets still scrubbed", async () => {
    const env: Record<string, string | undefined> = { BUILDEX_SANDBOX_SECRET: "stray", BUILDEX_LOCAL_MCP_KEY: "stray2" };
    const out = await runDeterministicTrack(plumbingArgs, depsWith({ env }));
    expect(out.exitCode).toBe(0);
    const results = JSON.parse(readFileSync(join(out.runDir, "results.json"), "utf8"));
    expect(results.drives).toEqual([]);
    expect(results.install.ok).toBe(true);
    expect(env.BUILDEX_SANDBOX_SECRET).toBeUndefined();
    expect(env.BUILDEX_LOCAL_MCP_KEY).toBeUndefined();
  });

  it("unknown pack: rejected before anything touches disk", async () => {
    const baseDir = tmp("e2e-");
    await expect(
      runDeterministicTrack({ ...plumbingArgs, pack: "ghost" }, depsWith({ baseDir })),
    ).rejects.toThrow(/unknown pack/);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it("a drive that errors makes the run exit non-zero", async () => {
    const { driver } = fakeDriver([{ kind: "error", message: "agent exploded" } as unknown as UiEvent]);
    const env = { BUILDEX_LOCAL_MCP_KEY: "pk_x" };
    const out = await runDeterministicTrack(localArgs, depsWith({ driver, env }));
    expect(out.exitCode).toBe(1);
    expect(existsSync(join(out.runDir, "results.json"))).toBe(true);
  });
});
