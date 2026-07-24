import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProofTrack, type ProofDeps } from "./proof.js";
import { CleanupRegistry } from "./cleanup.js";
import { resolveCorePackDir } from "../provision/core-pack.js";
import type { ProofArgs } from "./cli-args.js";
import type { AgentDriver, RunPromptOpts, UiEvent } from "../agent/types.js";
import type { PackManifest } from "../brain/catalog.js";
import type { CatalogSource } from "../brain/catalog-source.js";

// The composition suite: real provision/install/regen/pin against the repo's real core pack, with
// only the outward seams faked (agent driver, fetch, env) - per the repo's DI rule. Modeled on
// run.test.ts, extended for the extra moving parts of the proof track: a scripted driver keyed by
// SPAWN ORDER (generator, then per-case drive, then per-case judge), and a fake fetch that answers
// both the sandbox mint/destroy REST calls and the mcp initialize/tools-list JSON-RPC handshake.
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
  writeFileSync(join(packDir, "skills", "acme-howto", "SKILL.md"), "---\nname: acme-howto\ndescription: how to use acme\n---\n# body\n");
  return { ids: () => [m.id], dir: (id) => (id === m.id ? packDir : undefined) };
}

// ---- fake fetch: sandbox mint/destroy (REST) + mcp initialize/tools-list (JSON-RPC) ------------

const restRes = (status: number, body?: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body ?? {}), headers: { get: () => null } }) as unknown as Response;

const mcpRes = (result: unknown): Response => {
  const payload = { jsonrpc: "2.0", id: 1, result };
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload), headers: { get: () => null } } as unknown as Response;
};

const TOOLS = [{ name: "acme_search", description: "search acme records" }];
const mintBody = { data: { id: "ws_9", key: "sb_minted_key_9" } };

function fakeFetch(calls: string[], opts: { mintBody?: unknown; destroyStatus?: number; mintStatus?: number } = {}): typeof globalThis.fetch {
  return (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    if (method === "DELETE") return restRes(opts.destroyStatus ?? 204);
    if (method === "POST" && url.includes("/v1/sb")) return restRes(opts.mintStatus ?? 201, opts.mintBody ?? mintBody);
    const body = init?.body ? (JSON.parse(String(init.body)) as { method?: string }) : {};
    if (body.method === "tools/list") return mcpRes({ tools: TOOLS });
    return mcpRes({}); // initialize
  }) as unknown as typeof globalThis.fetch;
}

// ---- scripted driver: one entry per actual spawn, in the exact order they occur ------------------

type ScriptEntry = string | UiEvent[];

function scriptedDriver(script: ScriptEntry[]): { driver: AgentDriver; seen: RunPromptOpts[] } {
  const seen: RunPromptOpts[] = [];
  let call = 0;
  const driver = {
    detect: async () => ({ available: true }),
    // eslint-disable-next-line @typescript-eslint/require-await
    runPrompt: async function* (o: RunPromptOpts) {
      // The grounding phase (explore-step) spawns FIRST, before the generator. It is not part of a
      // test's script (which is keyed generator → drives → judges) and is NOT recorded in `seen` -
      // answer it with a canned catalog so every existing script and every seen[] index stays aligned.
      if (o.prompt.includes("cataloging the REAL data")) {
        yield { kind: "text", text: "Clients: Ada Lovelace, Grace Hopper. Templates: Base Plan." } as unknown as UiEvent;
        yield { kind: "done" } as unknown as UiEvent;
        return;
      }
      seen.push(o);
      const entry = script[call];
      if (entry === undefined) throw new Error(`scriptedDriver: ran out of script at call ${call} (workspace=${o.workspace})`);
      call++;
      if (typeof entry === "string") {
        yield { kind: "text", text: entry } as unknown as UiEvent;
        yield { kind: "done" } as unknown as UiEvent;
      } else {
        for (const e of entry) yield e;
      }
    },
  } as unknown as AgentDriver;
  return { driver, seen };
}

const fenced = (v: unknown): string => "```json\n" + JSON.stringify(v, null, 2) + "\n```\n";

const CASES_JSON = [
  {
    id: "happy-case", title: "Happy path", kind: "happy",
    prompt: "Do the normal happy-path thing with acme.",
    expected: "The agent completes the task and reports success.",
    disqualifiers: ["Agent fabricates a result"],
  },
  {
    id: "edge-case", title: "Edge case", kind: "edge",
    prompt: "Try an edge-case scenario with acme.",
    expected: "The agent handles the edge case gracefully.",
    disqualifiers: ["Agent crashes", "Agent invents data"],
  },
];

const verdictFor = (caseId: string, band: "strong" | "pass" | "fail" = "pass") => ({
  caseId, band, reasoning: "Looks fine given the transcript.", evidence: [0], findings: [],
});

function depsWith(over: Partial<ProofDeps> & { driver: AgentDriver }): ProofDeps {
  return {
    source: sourceWith(M),
    corePackDir: CORE,
    baseDir: tmp("e2e-proof-"),
    fetch: (async () => restRes(500)) as unknown as typeof globalThis.fetch,
    env: {},
    cleanup: new CleanupRegistry(),
    now: () => new Date("2026-07-23T12:00:00Z"),
    log: () => {},
    ...over,
  };
}

const localArgs: ProofArgs = { pack: "acme", mcpUrl: "http://localhost:9/mcp", cases: 2, baseline: undefined };
const sandboxArgs: ProofArgs = { pack: "acme", mcpUrl: undefined, cases: 2, baseline: undefined };

describe("runProofTrack - the composition", () => {
  it("local lane happy path: exit 0, report.md + proof-results.json + surface.json + per-case transcripts exist, env scrubbed before first spawn, secrets absent from every persisted artifact", async () => {
    const { driver, seen } = scriptedDriver([
      fenced(CASES_JSON), // generator
      "I used key pk_local_secret_1 to run the happy case.", // happy-case drive
      fenced(verdictFor("happy-case")), // happy-case judge
      "I used key pk_local_secret_1 to run the edge case.", // edge-case drive
      fenced(verdictFor("edge-case")), // edge-case judge
    ]);

    const env: Record<string, string | undefined> = { BUILDEX_LOCAL_MCP_KEY: "pk_local_secret_1", BUILDEX_SANDBOX_SECRET: "sb_admin" };
    let envAtFirstSpawn: (string | undefined)[] | undefined;
    const orig = driver.runPrompt.bind(driver);
    driver.runPrompt = (o: RunPromptOpts) => {
      if (envAtFirstSpawn === undefined) envAtFirstSpawn = [env.BUILDEX_LOCAL_MCP_KEY, env.BUILDEX_SANDBOX_SECRET];
      return orig(o);
    };

    const calls: string[] = [];
    const out = await runProofTrack(localArgs, depsWith({ driver, env, fetch: fakeFetch(calls) }));

    expect(out.exitCode).toBe(0);
    expect(envAtFirstSpawn).toEqual([undefined, undefined]);

    // The three run-level artifacts:
    expect(existsSync(join(out.runDir, "surface.json"))).toBe(true);
    expect(existsSync(join(out.runDir, "proof-results.json"))).toBe(true);
    expect(existsSync(join(out.runDir, "report.md"))).toBe(true);

    // Case isolation: each case drove in its OWN clean-room, and left its OWN transcript.
    expect(seen.length).toBe(5);
    const driveWorkspaces = [seen[1]!.workspace, seen[3]!.workspace];
    expect(driveWorkspaces[0]).not.toBe(driveWorkspaces[1]);

    // The generator (first spawn) runs in an isolated scratch dir - NOT the key-bearing discovery
    // workspace (which holds .mcp.json with the pinned key) and not a case's clean-room either.
    const genWorkspace = seen[0]!.workspace as string;
    expect(genWorkspace.endsWith("generator")).toBe(true);
    expect(genWorkspace).toBe(join(out.runDir, "generator"));
    expect(genWorkspace).not.toBe(join(out.runDir, "discovery", "workspace"));
    expect(existsSync(join(genWorkspace, ".mcp.json"))).toBe(false);
    const happyTranscript = join(out.runDir, "cases", "happy-case", "transcripts", "happy-case.json");
    const edgeTranscript = join(out.runDir, "cases", "edge-case", "transcripts", "edge-case.json");
    expect(existsSync(happyTranscript)).toBe(true);
    expect(existsSync(edgeTranscript)).toBe(true);

    // Results content sanity + exit-code inputs:
    const results = JSON.parse(readFileSync(join(out.runDir, "proof-results.json"), "utf8"));
    expect(results.cases).toHaveLength(2);
    expect(results.cases.map((c: { case: { id: string } }) => c.case.id)).toEqual(["happy-case", "edge-case"]);
    expect(results.cases.every((c: { verdict: unknown }) => c.verdict !== null)).toBe(true);
    expect(results.drift).toBeNull();

    // The HTML report bundle is written alongside report.md, one case page per scenario:
    expect(existsSync(join(out.runDir, "index.html"))).toBe(true);
    expect(existsSync(join(out.runDir, "matrix.html"))).toBe(true);
    expect(existsSync(join(out.runDir, "findings.html"))).toBe(true);
    expect(existsSync(join(out.runDir, "styles.css"))).toBe(true);
    expect(existsSync(join(out.runDir, "cases", "happy-case.html"))).toBe(true);
    expect(existsSync(join(out.runDir, "cases", "edge-case.html"))).toBe(true);

    // No local key anywhere it was persisted - including every page of the HTML bundle:
    const artifacts = [
      join(out.runDir, "surface.json"),
      join(out.runDir, "proof-results.json"),
      join(out.runDir, "report.md"),
      happyTranscript,
      edgeTranscript,
      join(out.runDir, "index.html"),
      join(out.runDir, "matrix.html"),
      join(out.runDir, "findings.html"),
      join(out.runDir, "cases", "happy-case.html"),
      join(out.runDir, "cases", "edge-case.html"),
    ];
    for (const f of artifacts) {
      expect(readFileSync(f, "utf8")).not.toContain("pk_local_secret_1");
    }

    // Workspaces torn down, run artifacts survive:
    expect(existsSync(join(out.runDir, "discovery", "workspace"))).toBe(false);
    expect(existsSync(join(out.runDir, "cases", "happy-case", "workspace"))).toBe(false);
  });

  it("generator hard-failure: still writes proof-results.json + report.md (zero cases) and rethrows", async () => {
    const baseDir = tmp("e2e-proof-");
    const { driver } = scriptedDriver([
      [{ kind: "error", message: "generator crashed" } as unknown as UiEvent],
      [{ kind: "error", message: "generator crashed again" } as unknown as UiEvent],
    ]);
    const env = { BUILDEX_LOCAL_MCP_KEY: "pk_x" };
    const calls: string[] = [];

    await expect(
      runProofTrack(localArgs, depsWith({ driver, env, baseDir, fetch: fakeFetch(calls) })),
    ).rejects.toThrow(/generator crashed/i);

    const runDir = join(baseDir, readdirSync(baseDir)[0]!);
    expect(existsSync(join(runDir, "proof-results.json"))).toBe(true);
    expect(existsSync(join(runDir, "report.md"))).toBe(true);
    const results = JSON.parse(readFileSync(join(runDir, "proof-results.json"), "utf8"));
    expect(results.cases).toEqual([]);
    // surface.json was already written before the generator ran:
    expect(existsSync(join(runDir, "surface.json"))).toBe(true);
    expect(existsSync(join(runDir, "discovery", "workspace"))).toBe(false);
  });

  it("judge failure on one case: verdict null for that case, run continues to the next case, exit 1", async () => {
    const { driver } = scriptedDriver([
      fenced(CASES_JSON), // generator
      "drove the happy case", // happy-case drive
      "not json at all - attempt 1", // happy-case judge attempt 1 (fails)
      "still not json - attempt 2", // happy-case judge attempt 2 (fails, gives up)
      "drove the edge case", // edge-case drive
      fenced(verdictFor("edge-case")), // edge-case judge (succeeds)
    ]);
    const env = { BUILDEX_LOCAL_MCP_KEY: "pk_x" };
    const calls: string[] = [];

    const out = await runProofTrack(localArgs, depsWith({ driver, env, fetch: fakeFetch(calls) }));

    expect(out.exitCode).toBe(1);
    const results = JSON.parse(readFileSync(join(out.runDir, "proof-results.json"), "utf8"));
    const happy = results.cases.find((c: { case: { id: string } }) => c.case.id === "happy-case");
    const edge = results.cases.find((c: { case: { id: string } }) => c.case.id === "edge-case");
    expect(happy.verdict).toBeNull();
    expect(edge.verdict.band).toBe("pass");
    // report.md still renders, naming the unjudged case:
    const report = readFileSync(join(out.runDir, "report.md"), "utf8");
    expect(report).toMatch(/unjudged/);
  });

  it("sandbox lane: mints once, registers destroy, drives+judges both cases, destroy fires exactly once", async () => {
    const { driver } = scriptedDriver([
      fenced(CASES_JSON),
      "drove the happy case with sb_minted_key_9",
      fenced(verdictFor("happy-case")),
      "drove the edge case with sb_minted_key_9",
      fenced(verdictFor("edge-case")),
    ]);
    const calls: string[] = [];
    const out = await runProofTrack(sandboxArgs, depsWith({ driver, env: { BUILDEX_SANDBOX_SECRET: "sb_admin" }, fetch: fakeFetch(calls) }));

    expect(out.exitCode).toBe(0);
    expect(calls.filter((c) => c.startsWith("POST") && c.includes("/v1/sb")).length).toBe(1); // minted ONCE
    const deletes = calls.filter((c) => c.startsWith("DELETE"));
    expect(deletes.length).toBe(1); // destroyed EXACTLY once
    expect(deletes[0]).toContain("ws_9");

    const results = JSON.parse(readFileSync(join(out.runDir, "proof-results.json"), "utf8"));
    for (const f of [join(out.runDir, "proof-results.json"), join(out.runDir, "report.md"), join(out.runDir, "surface.json")]) {
      expect(readFileSync(f, "utf8")).not.toContain("sb_minted_key_9");
      expect(readFileSync(f, "utf8")).not.toContain("sb_admin");
    }
    expect(results.cases).toHaveLength(2);
  });

  it("sandbox lane: destroy fails (DELETE 500) - run RESOLVES (no throw), exit forced to 1, both artifacts exist, loud leak line logged naming the workspace id", async () => {
    const { driver } = scriptedDriver([
      fenced(CASES_JSON),
      "drove the happy case with sb_minted_key_9",
      fenced(verdictFor("happy-case")),
      "drove the edge case with sb_minted_key_9",
      fenced(verdictFor("edge-case")),
    ]);
    const calls: string[] = [];
    const logs: string[] = [];
    const out = await runProofTrack(
      sandboxArgs,
      depsWith({
        driver,
        env: { BUILDEX_SANDBOX_SECRET: "sb_admin" },
        fetch: fakeFetch(calls, { destroyStatus: 500 }),
        log: (l) => logs.push(l),
      }),
    );

    expect(out.exitCode).toBe(1);
    expect(existsSync(join(out.runDir, "proof-results.json"))).toBe(true);
    expect(existsSync(join(out.runDir, "report.md"))).toBe(true);
    const logOutput = logs.join("\n");
    expect(logOutput).toMatch(/leak/i);
    expect(logOutput).toContain("ws_9");
  });

  it("sandbox lane: destroy still fires exactly once even when a case's drive errors", async () => {
    const { driver } = scriptedDriver([
      fenced(CASES_JSON),
      [{ kind: "error", message: "agent exploded mid-drive" } as unknown as UiEvent], // happy-case drive errors (driveCase never throws)
      fenced(verdictFor("happy-case", "fail")), // judge still runs on the crashed transcript
      "drove the edge case",
      fenced(verdictFor("edge-case")),
    ]);
    const calls: string[] = [];
    const out = await runProofTrack(sandboxArgs, depsWith({ driver, env: { BUILDEX_SANDBOX_SECRET: "sb_admin" }, fetch: fakeFetch(calls) }));

    expect(out.exitCode).toBe(1); // crashed drive → non-zero
    expect(calls.filter((c) => c.startsWith("DELETE")).length).toBe(1);
    const results = JSON.parse(readFileSync(join(out.runDir, "proof-results.json"), "utf8"));
    const happy = results.cases.find((c: { case: { id: string } }) => c.case.id === "happy-case");
    expect(happy.drive.errored).toBe(true);
    expect(happy.verdict.band).toBe("fail");
  });

  it("local lane: refuses to start without BUILDEX_LOCAL_MCP_KEY - nothing touches disk", async () => {
    const baseDir = tmp("e2e-proof-");
    const { driver } = scriptedDriver([fenced(CASES_JSON)]);
    await expect(runProofTrack(localArgs, depsWith({ driver, baseDir, env: {} }))).rejects.toThrow(/BUILDEX_LOCAL_MCP_KEY/);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it("sandbox lane: refuses to start without BUILDEX_SANDBOX_SECRET - nothing touches disk", async () => {
    const baseDir = tmp("e2e-proof-");
    const { driver } = scriptedDriver([fenced(CASES_JSON)]);
    await expect(runProofTrack(sandboxArgs, depsWith({ driver, baseDir, env: {} }))).rejects.toThrow(/BUILDEX_SANDBOX_SECRET/);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it("unknown pack: rejected before anything touches disk", async () => {
    const baseDir = tmp("e2e-proof-");
    const { driver } = scriptedDriver([fenced(CASES_JSON)]);
    await expect(
      runProofTrack({ ...localArgs, pack: "ghost" }, depsWith({ driver, baseDir, env: { BUILDEX_LOCAL_MCP_KEY: "pk_x" } })),
    ).rejects.toThrow(/unknown pack/);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it("baseline unreadable: drift stays null, run proceeds to exit 0, and a warning is logged", async () => {
    const { driver } = scriptedDriver([
      fenced(CASES_JSON),
      "drove the happy case",
      fenced(verdictFor("happy-case")),
      "drove the edge case",
      fenced(verdictFor("edge-case")),
    ]);
    const logs: string[] = [];
    const calls: string[] = [];
    const args: ProofArgs = { ...localArgs, baseline: join(tmp("e2e-proof-baseline-"), "does-not-exist.json") };
    const out = await runProofTrack(args, depsWith({ driver, env: { BUILDEX_LOCAL_MCP_KEY: "pk_x" }, log: (l) => logs.push(l), fetch: fakeFetch(calls) }));

    expect(out.exitCode).toBe(0);
    const results = JSON.parse(readFileSync(join(out.runDir, "proof-results.json"), "utf8"));
    expect(results.drift).toBeNull();
    expect(logs.some((l) => /baseline/i.test(l) && /warning/i.test(l))).toBe(true);
  });

  it("broken install (missing skill): exit 1, proof-results.json + report.md exist, install.ok logged", async () => {
    // Source with declared skill but no SKILL.md file (broken install)
    function sourceBrokenInstall(m: PackManifest): CatalogSource {
      const dir = tmp("cat-");
      const packDir = join(dir, m.id);
      // Create skill dir but DO NOT create SKILL.md - simulates broken install
      mkdirSync(join(packDir, "skills", "acme-howto"), { recursive: true });
      writeFileSync(join(packDir, "pack.json"), JSON.stringify(m));
      // Omit the SKILL.md file so verifyInstall reports present:false
      return { ids: () => [m.id], dir: (id) => (id === m.id ? packDir : undefined) };
    }

    const { driver } = scriptedDriver([
      fenced(CASES_JSON),
      "drove the happy case",
      fenced(verdictFor("happy-case")),
      "drove the edge case",
      fenced(verdictFor("edge-case")),
    ]);
    const logs: string[] = [];
    const calls: string[] = [];

    const out = await runProofTrack(localArgs, depsWith({
      driver,
      env: { BUILDEX_LOCAL_MCP_KEY: "pk_x" },
      source: sourceBrokenInstall(M),
      log: (l) => logs.push(l),
      fetch: fakeFetch(calls),
    }));

    // Exit 1 because install.ok is false
    expect(out.exitCode).toBe(1);
    // Both artifacts still exist despite broken install
    expect(existsSync(join(out.runDir, "proof-results.json"))).toBe(true);
    expect(existsSync(join(out.runDir, "report.md"))).toBe(true);
    // Verify install.ok was logged
    const logOutput = logs.join("\n");
    expect(logOutput).toContain("install.ok=false");
    // Verify no throw - run completes gracefully
    const results = JSON.parse(readFileSync(join(out.runDir, "proof-results.json"), "utf8"));
    expect(results.cases).toHaveLength(2);

    // Fix 3: install verification must ALSO survive in both artifacts, not just the log line - an
    // all-green report must never exit 1 with no recorded reason.
    expect(results.install.ok).toBe(false);
    const report = readFileSync(join(out.runDir, "report.md"), "utf8");
    expect(report).toContain("## Install");
    expect(report).toContain("missing skill: acme-howto");
  });

  it("throw after mint + destroy failure: LEAK line still fires on the throw path, and the error propagates", async () => {
    // The generator script is never reached - discovery's mcp handshake throws first.
    const { driver } = scriptedDriver([]);
    const logs: string[] = [];
    const fetchThrowAfterMint = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/v1/sb")) return restRes(201, mintBody);
      if (method === "DELETE") return restRes(500);
      throw new Error("network exploded after mint");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      runProofTrack(
        sandboxArgs,
        depsWith({ driver, env: { BUILDEX_SANDBOX_SECRET: "sb_admin" }, fetch: fetchThrowAfterMint, log: (l) => logs.push(l) }),
      ),
    ).rejects.toThrow(/network exploded after mint/i);

    const logOutput = logs.join("\n");
    expect(logOutput).toMatch(/LEAK/);
    expect(logOutput).toContain("ws_9");
  });

  it("redacts known secrets from any error that escapes the proof track", async () => {
    const { driver } = scriptedDriver([fenced(CASES_JSON)]); // unreachable - discovery throws first
    const fetchLeakingSecret = (async () => {
      throw new Error("connection reset while sending header Authorization: Bearer pk_local_secret_1");
    }) as unknown as typeof globalThis.fetch;

    try {
      await runProofTrack(localArgs, depsWith({ driver, env: { BUILDEX_LOCAL_MCP_KEY: "pk_local_secret_1" }, fetch: fetchLeakingSecret }));
      expect.fail("expected runProofTrack to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("pk_local_secret_1");
      expect(msg).toContain("[REDACTED]");
    }
  });
});
