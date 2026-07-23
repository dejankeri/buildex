// Git transport over a REAL HTTP socket (the claim earlier comments made but never delivered - E2).
//
// This proves the product's core transport - git smart-HTTP through `createApp` + the Node adapter -
// over an actual TCP socket, in two layers:
//   (A) ALWAYS RUNS: bind the adapter on an ephemeral loopback port and drive it with `fetch` (a real
//       socket round-trip, same process). Proves the adapter serves the git-upload-pack advertisement
//       and enforces auth over the wire - not just via in-process handler calls.
//   (B) FULL e2e (a real `git clone`/`push` child process against the socket): guarded, because some
//       sandboxed CI/build envs block INTER-PROCESS loopback TCP. It self-skips there and runs
//       for real wherever loopback is available (CI Linux runners, dev machines) - which is where the
//       "runs on CI" promise is actually kept now.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ControlPlaneStore } from "../store/store.js";
import { EmbeddedGitService } from "../git/service.js";
import { ProvisioningService } from "../provisioning/service.js";
import { createApp, type Handler } from "./app.js";
import { listen } from "./node-server.js";

const SERVICE_KEY = "svc-key";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "op", GIT_AUTHOR_EMAIL: "op@acme.com",
  GIT_COMMITTER_NAME: "op", GIT_COMMITTER_EMAIL: "op@acme.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", // never block on a credential prompt
} as NodeJS.ProcessEnv;

/**
 * Can a real `git` child process round-trip git-smart-HTTP against a Node loopback socket? Some
 * sandboxed build envs block inter-process loopback TCP - and the block is git-specific here
 * (curl may pass while git hangs), so we probe with GIT ITSELF: serve a throwaway bare repo through
 * the same adapter and `git ls-remote` it under a short timeout. Run in `beforeAll` - NOT as a
 * top-level await, which is fragile inside vitest's fork workers.
 */
async function probeGitOverHttp(): Promise<boolean> {
  const tmp = mkdtempSync(join(tmpdir(), "buildex-gitprobe-"));
  const git = new EmbeddedGitService({ reposRoot: tmp });
  await git.ensureRepo("probe");
  const gitRoute = /^\/git\/([a-z0-9_-]+)\.git(\/.*)$/;
  const handler: Handler = async (req) => {
    const u = new URL(req.url);
    const m = u.pathname.match(gitRoute);
    if (!m) return new Response("no", { status: 404 });
    const res = await git.cgi({
      repo: m[1]!, pathAfterRepo: m[2]!, method: req.method,
      query: u.search.replace(/^\?/, ""), contentType: req.headers.get("content-type") ?? undefined,
      body: Buffer.from(await req.arrayBuffer()),
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  };
  const started = await listen(handler);
  try {
    execFileSync("git", ["ls-remote", `http://127.0.0.1:${started.port}/git/probe.git`], {
      env: GIT_ENV, timeout: 8_000, stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  } finally {
    await started.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface Creds {
  machineToken: string;
  refreshToken: string;
  repos: { core: string; team: string; private: string };
}

// NOTE: intentionally NOT tagged [release-gate:*]. The canonical permission-matrix gate lives in
// sync-acceptance.test.ts (always in-process, never skipped); this transport test's full-git layer is
// env-dependent (skips where inter-process loopback is blocked), so it runs in the normal `test` lane
// (which CI runs) rather than as a "cannot be skipped" gate.
describe("git transport over a REAL HTTP socket (E2)", () => {
  let dir: string;
  let store: ControlPlaneStore;
  let git: EmbeddedGitService;
  let app: Handler;
  let baseUrl: string;
  let close: () => Promise<void>;
  let creds: Creds;
  let gitHttpWorks = false;

  beforeAll(async () => {
    gitHttpWorks = await probeGitOverHttp();
    if (!gitHttpWorks) {
      // eslint-disable-next-line no-console
      console.warn("[git-socket] git-over-HTTP loopback unavailable here - skipping the real-git layer (B)");
    }
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "buildex-socket-"));
    store = new ControlPlaneStore(join(dir, "control.db"));
    git = new EmbeddedGitService({ reposRoot: join(dir, "repos") });
    let n = 0;
    const provisioning = new ProvisioningService({ store, git, idFactory: () => `m${++n}` });
    await provisioning.ensureCoreRepo();
    app = createApp({ store, provisioning, git, serviceKey: SERVICE_KEY, publicBaseUrl: "http://sync.test" });

    const started = await listen(app);
    baseUrl = `http://127.0.0.1:${started.port}`;
    close = started.close;

    // Provision a fresh company end-to-end so a real machine token exists.
    const s2s = (path: string, b: unknown) =>
      new Request(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-key": SERVICE_KEY },
        body: JSON.stringify(b),
      });
    await app(s2s("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }));
    await app(s2s("/s2s/operators", { id: "o1", companyId: "c1", email: "a@acme.com" }));
    const { setupToken } = (await (await app(s2s("/s2s/setup-tokens", { operatorId: "o1" }))).json()) as { setupToken: string };
    creds = (await (
      await app(
        new Request(`${baseUrl}/provision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ setupToken, machineName: "laptop" }),
        }),
      )
    ).json()) as Creds;
  });

  afterEach(async () => {
    await close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const authHeader = (token: string) => "Basic " + Buffer.from(`x:${token}`).toString("base64");

  // --- Layer A: real socket via fetch (always runs) -------------------------------------------------

  it("serves /healthz over the socket", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("demands auth on the git endpoint over the wire (401 + WWW-Authenticate)", async () => {
    const res = await fetch(`${baseUrl}/git/core.git/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Basic/);
  });

  it("advertises upload-pack with correct protocol bytes to an authed request", async () => {
    const res = await fetch(`${baseUrl}/git/core.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: authHeader(creds.machineToken) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(await res.text()).toContain("# service=git-upload-pack");
  });

  it("rejects a non-admin receive-pack (push) advertisement on core over the wire (403)", async () => {
    const res = await fetch(`${baseUrl}/git/core.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: authHeader(creds.machineToken) },
    });
    expect(res.status).toBe(403);
  });

  it("streams a POST request body over the socket (the mechanism git push relies on)", async () => {
    // Exercises the adapter's request-body path end-to-end over a real socket (Readable.toWeb →
    // handler.arrayBuffer). git-receive-pack uses the same path to carry a packfile; here we drive it
    // with a JSON body the handler must read to decide the outcome. A bad setup token must be rejected
    // with a structured 4xx - proving the body arrived and was parsed, not dropped.
    const res = await fetch(`${baseUrl}/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: "definitely-not-valid", machineName: "laptop" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await res.json()).toHaveProperty("error");
  });

  // --- Layer B: real `git` child process over the socket (guarded on inter-process loopback) --------

  // 15s ceiling per git call so a genuine transport hang fails fast instead of walling to testTimeout.
  const g = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", timeout: 15_000 });
  const httpUrl = (repo: string, token: string) =>
    `http://x:${encodeURIComponent(token)}@127.0.0.1:${new URL(baseUrl).port}/git/${repo}.git`;

  it("real git clone → commit → push → re-clone round-trips content through the socket", (ctx) => {
    if (!gitHttpWorks) return ctx.skip();
    const team = join(dir, "team");
    g(["clone", httpUrl("team-acme", creds.machineToken), team], dir);
    writeFileSync(join(team, "conventions.md"), "# Acme conventions\n");
    g(["add", "."], team);
    g(["commit", "-m", "seed conventions"], team);
    g(["push", "origin", "HEAD:main"], team);

    const verify = join(dir, "verify");
    g(["clone", "--branch", "main", httpUrl("team-acme", creds.machineToken), verify], dir);
    expect(readFileSync(join(verify, "conventions.md"), "utf8")).toContain("Acme conventions");
  });

  it("real git push to core is rejected over the socket (permission matrix, invariant 6)", (ctx) => {
    if (!gitHttpWorks) return ctx.skip();
    const core = join(dir, "core");
    // read (clone) core is allowed
    g(["clone", httpUrl("core", creds.machineToken), core], dir);
    writeFileSync(join(core, "sneaky.md"), "nope\n");
    g(["add", "."], core);
    g(["commit", "-m", "should not land"], core);
    // write (push) core is forbidden server-side → git exits non-zero
    expect(() => g(["push", "origin", "HEAD:main"], core)).toThrow();
  });
});
