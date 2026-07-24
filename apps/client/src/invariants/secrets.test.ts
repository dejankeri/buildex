// SECRETS INVARIANT SUITE (release gate): no keychain value ever appears in a
// repo, a generated config file, a session file, or a synced path (and no token is embedded in a
// git remote URL - a harden over the prototype, which put the token in the origin URL). This drives
// a full workspace lifecycle (secret in keychain → config-gen → real sync → a chat session) and
// scans every artifact for the secret.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { generateAgentConfig, type Root } from "../brain/agent-config.js";
import { SyncEngine } from "../sync/engine.js";
import { FileSessionStore } from "../daemon/sessions.js";
import type { PolicyPreset } from "../gate/policy.js";
import { buildClientHandler } from "../wiring.js";
import type { SpawnAgent } from "../agent/claude-driver.js";
import type { SyncScheduler } from "../sync/scheduler.js";

const SECRET = "gmail-oauth-super-secret-value-DO-NOT-LEAK";
// Built by concatenation so this fake fixture doesn't itself trip the machine-token secret-scan
// pattern (the runtime value is still a realistic `xmachine_…` token for the leak assertions below).
const TOKEN = "xmachine_" + "deadbeef".repeat(6);
const preset: PolicyPreset = { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" };
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let base: string;
let ws: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "buildex-secrets-"));
  ws = join(base, "ws");
  mkdirSync(ws, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Collect the text of every artifact that must NOT contain a secret. */
function scanTargets(teamDir: string): string[] {
  const texts: string[] = [];
  // committed files in the team repo
  for (const f of git(["ls-files"], teamDir).split("\n").map((s) => s.trim()).filter(Boolean)) {
    texts.push(readFileSync(join(teamDir, f), "utf8"));
  }
  // the git config (must not embed a token in the remote URL)
  texts.push(readFileSync(join(teamDir, ".git", "config"), "utf8"));
  // generated agent config at the workspace root
  texts.push(readFileSync(join(ws, "CLAUDE.md"), "utf8"));
  texts.push(readFileSync(join(ws, ".claude", "settings.json"), "utf8"));
  // session files
  const sessDir = join(ws, ".sessions");
  try {
    for (const f of readdirSync(sessDir)) texts.push(readFileSync(join(sessDir, f), "utf8"));
  } catch {
    /* no sessions dir */
  }
  return texts;
}

describe("SECRETS INVARIANT [release-gate:secrets]: keychain values never leak into synced/committed/config/session artifacts", () => {
  // Generous timeout: this lifecycle spins up a bare remote + working clone with real git (~5s on its
  // own), but runs alongside the rest of a large, git- and jsdom-heavy suite. Under that parallel load
  // the real-git I/O is starved well past the 5s default, so we allow ample wall-clock. The assertion
  // set (a full secret scan of every artifact) is unchanged - only the time budget is relaxed.
  it("holds across a full workspace lifecycle", async () => {
    // a bare remote + a team working clone (the synced repo)
    const remote = join(base, "remote.git");
    git(["init", "--bare", "--initial-branch=main", remote], base);
    const seed = join(base, "seed");
    git(["clone", `file://${remote}`, seed], base);
    writeFileSync(join(seed, "readme.md"), "seed\n");
    git(["add", "."], seed);
    git(["commit", "-m", "seed"], seed);
    git(["push", "origin", "HEAD:main"], seed);

    const team = join(ws, "team");
    git(["clone", `file://${remote}`, team], ws);

    // secrets live ONLY in the keychain
    const keychain = new InMemoryKeychain();
    keychain.set("connector:gmail", SECRET);
    keychain.set("org:demo:machine-token", TOKEN);

    // a core root with rules (no secret) + generate the native agent config at the workspace root
    const core = join(base, "core");
    mkdirSync(join(core, "skills", "tidy"), { recursive: true });
    writeFileSync(join(core, "CLAUDE.md"), "core rules\n");
    writeFileSync(join(core, "skills", "tidy", "SKILL.md"), "tidy\n");
    const roots: Root[] = [
      { name: "core", dir: core },
      { name: "team", dir: team },
      { name: "private", dir: join(base, "private") },
    ];
    mkdirSync(roots[2]!.dir, { recursive: true });
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "buildex-gate --port 7777" });

    // the operator does real work and it syncs
    writeFileSync(join(team, "conventions.md"), "# our conventions\n");
    await new SyncEngine({ now: () => 1, actor: "operator" }).publish(team);

    // a chat session records agent events (never secrets)
    const sessions = new FileSessionStore(join(ws, ".sessions"));
    const sid = sessions.create();
    sessions.append(sid, { kind: "text", text: "drafting the plan" });
    sessions.append(sid, { kind: "tool", id: "t1", name: "Read", input: { file_path: "conventions.md" } });
    sessions.setClaudeSessionId(sid, "claude-session-xyz");

    // NOTHING anywhere contains the secret or the token
    for (const text of scanTargets(team)) {
      expect(text.includes(SECRET)).toBe(false);
      expect(text.includes(TOKEN)).toBe(false);
    }
    // and the remote URL is a plain file:// (no token embedded - the harden)
    expect(readFileSync(join(team, ".git", "config"), "utf8")).not.toContain("@");
  }, 60000);
});

// The custody half of the same invariant: a keychain-held credential must never enter the spawned
// AGENT's environment either. An env var is readable by anything the agent shells, so a provisioned
// key there would let a direct provider call slip past the approval gate; instead the daemon keeps
// the key and the agent calls through the loopback provision proxy, which attaches it per request.
// This drives the REAL wiring end to end - install → grant (injected fetch) → an agent run (injected
// spawn capturing env) → a proxied provider call - and asserts the credential appears nowhere in the
// captured environment while the proxy round-trip still reaches the provider with the key attached.
describe("SECRETS INVARIANT [release-gate:secrets]: a provisioned credential never enters the agent's environment", () => {
  const PROVISION_SECRET = "pk-example-provisioned-secret-DO-NOT-LEAK";

  it("holds across grant → agent run → proxied provider call", async () => {
    // A catalogue shipping one pack with an escape-hatch (provision) face.
    const packDir = join(base, "catalog", "example");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "pack.json"), JSON.stringify({
      id: "example",
      name: "Example",
      app: { url: "https://app.example.com" },
      provision: {
        authorizeUrl: "https://app.example.com/connect?redirect_uri={redirect_uri}&state={state}",
        exchangeUrl: "https://auth.example.com/exchange",
        keyPath: "data.key",
        apiBasePath: "data.base",
        envKey: "EXAMPLE_API_KEY",
        envBase: "EXAMPLE_API_URL",
        grants: "Full access to the whole Example account over its REST API - broader than MCP.",
        docsUrl: "https://example.com/docs",
      },
    }));
    const catalogSource = { ids: () => ["example"], dir: (id: string) => (id === "example" ? packDir : undefined) };
    const roots: Root[] = [
      { name: "team", dir: join(base, "team") },
      { name: "private", dir: join(base, "private") },
    ];
    for (const r of roots) mkdirSync(r.dir, { recursive: true });

    // Injected fetch: the grant's code exchange hands out the credential; every provider call is
    // recorded with the headers it arrived with. No network anywhere.
    const providerCalls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://auth.example.com/exchange") {
        return new Response(JSON.stringify({ data: { key: PROVISION_SECRET, base: "https://api.example.com" } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://api.example.com/")) {
        providerCalls.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // Injected spawn: captures the exact environment the agent would start with; no child runs.
    const spawnedEnvs: NodeJS.ProcessEnv[] = [];
    const fakeSpawn: SpawnAgent = (spec) => {
      spawnedEnvs.push(spec.env ?? {});
      return { stdout: Readable.from([]), exit: Promise.resolve(0), kill: () => {} };
    };

    const schedulers: SyncScheduler[] = [];
    let proxyHostP: Promise<{ url: string; close: () => Promise<void> }> | undefined;
    const app = buildClientHandler({
      workspace: ws,
      roots,
      catalogSource,
      preset,
      claudeBin: "claude",
      fetch: fakeFetch,
      spawnAgent: fakeSpawn,
      onScheduler: (s) => schedulers.push(s),
      onProvisionHost: (h) => { proxyHostP = h; },
    });
    const post = (route: string, b: unknown) =>
      app(new Request("http://127.0.0.1" + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

    try {
      // Install the pack (approving its card - installs are human-gated like any pack mutation).
      const installP = post("/api/catalog/install", { id: "example" });
      let cards: { id: string }[] = [];
      while (cards.length === 0) {
        cards = ((await (await app(new Request("http://127.0.0.1/api/pending"))).json()) as { cards: { id: string }[] }).cards;
        if (cards.length === 0) await new Promise((r) => setTimeout(r, 5));
      }
      await post("/api/approve", { id: cards[0]!.id, verdict: "approve" });
      expect((await installP).status).toBe(200);

      // Grant the escape-hatch credential through the real begin → callback → exchange path. The
      // key lands in the (in-memory) keychain and NOWHERE else.
      const { authorizeUrl } = (await (await post("/api/catalog/provision", { id: "example" })).json()) as { authorizeUrl: string };
      const state = new URL(authorizeUrl).searchParams.get("state")!;
      const cb = await app(new Request(`http://127.0.0.1/oauth/provision/example/callback?code=c1&state=${encodeURIComponent(state)}`));
      expect(cb.status).toBe(200);

      // An agent run. The captured environment must carry pointers only - never the credential.
      await (await post("/api/prompt", { prompt: "hello" })).text();
      expect(spawnedEnvs).toHaveLength(1);
      const env = spawnedEnvs[0]!;
      for (const [k, v] of Object.entries(env)) {
        expect(String(v).includes(PROVISION_SECRET), `env var ${k} leaks the provisioned credential`).toBe(false);
      }
      expect(Object.keys(env)).not.toContain("EXAMPLE_API_KEY");
      expect(env["EXAMPLE_API_URL"]).toBe("https://api.example.com");
      expect(env["BUILDEX_PROVISION_URL"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/provision$/);
      expect(env["BUILDEX_PROVISION_TOKEN"]).toBeTruthy();

      // The proxy round-trip still reaches the provider WITH the key attached (custody, not loss of
      // capability): a real loopback call with the env's pointers, the daemon adding the credential.
      const read = await fetch(`${env["BUILDEX_PROVISION_URL"]}/example/v1/clients?limit=1`, {
        headers: { authorization: `Bearer ${env["BUILDEX_PROVISION_TOKEN"]}` },
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ ok: true });
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0]).toMatchObject({ url: "https://api.example.com/v1/clients?limit=1", method: "GET" });
      expect(providerCalls[0]!.headers["authorization"]).toBe(`Bearer ${PROVISION_SECRET}`);

      // And the proxy bearer is a real gate: without it, nothing goes through.
      expect((await fetch(`${env["BUILDEX_PROVISION_URL"]}/example/v1/clients`)).status).toBe(401);
    } finally {
      for (const s of schedulers) s.stop();
      if (proxyHostP) await proxyHostP.then((h) => h.close()).catch(() => {});
    }
  }, 60000);
});
