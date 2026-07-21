// Sync acceptance - two things the definition of done requires:
//   (A) the PERMISSION-MATRIX INVARIANT SUITE (a release gate), and
//   (B) the scripted dogfood: provision a company end-to-end, then clone×3 → push team →
//       push core rejected → refresh → revoke.
// Git data movement here uses git's fs-only file:// transport (fast + sandbox-safe); all
// auth/permission/provision/refresh/revoke decisions run through the real HTTP handler, which is where
// enforcement lives. The SAME flow over a real HTTP socket (a genuine `git clone`/`push` child process
// against the Node adapter) is covered by `http/git-socket.test.ts`, which runs wherever inter-process
// loopback TCP is available (CI Linux runners, dev machines) and self-skips in sandboxes that block it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ControlPlaneStore } from "./store/store.js";
import { EmbeddedGitService } from "./git/service.js";
import { ProvisioningService } from "./provisioning/service.js";
import { ScheduleStore } from "./automations/schedule-store.js";
import { createApp, type Handler } from "./http/app.js";

const SERVICE_KEY = "svc-key";
let dir: string;
let store: ControlPlaneStore;
let schedules: ScheduleStore;
let git: EmbeddedGitService;
let app: Handler;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "buildex-sync-acc-"));
  store = new ControlPlaneStore(join(dir, "control.db"));
  git = new EmbeddedGitService({ reposRoot: join(dir, "repos") });
  let n = 0;
  const provisioning = new ProvisioningService({ store, git, idFactory: () => `m${++n}` });
  await provisioning.ensureCoreRepo();
  schedules = new ScheduleStore(join(dir, "schedules.db"));
  app = createApp({ store, provisioning, git, schedules, serviceKey: SERVICE_KEY, publicBaseUrl: "https://sync.test" });
});
afterEach(() => {
  store.close();
  schedules.close();
  rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "op", GIT_AUTHOR_EMAIL: "op@acme.com",
  GIT_COMMITTER_NAME: "op", GIT_COMMITTER_EMAIL: "op@acme.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
} as NodeJS.ProcessEnv;
const g = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
const fileUrl = (repo: string) => `file://${git.repoDir(repo)}`;

const s2s = (path: string, b: unknown) =>
  new Request(`https://sync.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-service-key": SERVICE_KEY },
    body: JSON.stringify(b),
  });
const post = (path: string, b: unknown) =>
  new Request(`https://sync.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
const infoRefs = (repo: string, service: string, token?: string) =>
  new Request(`https://sync.test/git/${repo}.git/info/refs?service=${service}`, {
    headers: token ? { authorization: "Basic " + Buffer.from(`x:${token}`).toString("base64") } : {},
  });

interface Creds {
  machineToken: string;
  refreshToken: string;
  repos: { core: string; team: string; private: string };
}

/** The full provisioning path a fresh company walks (S2S create → mint → provision). */
async function provisionCompany(): Promise<Creds> {
  await app(s2s("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }));
  await app(s2s("/s2s/operators", { id: "o1", companyId: "c1", email: "a@acme.com" }));
  const { setupToken } = (await (await app(s2s("/s2s/setup-tokens", { operatorId: "o1" }))).json()) as {
    setupToken: string;
  };
  return (await (await app(post("/provision", { setupToken, machineName: "laptop" }))).json()) as Creds;
}

describe("PERMISSION-MATRIX INVARIANT SUITE [release-gate:permission-matrix]", () => {
  it("a non-admin push to core is rejected server-side", async () => {
    const { machineToken } = await provisionCompany();
    const res = await app(infoRefs("core", "git-receive-pack", machineToken));
    expect(res.status).toBe(403);
  });

  it("a revoked machine loses read AND write within one request", async () => {
    const { machineToken } = await provisionCompany();
    // before revoke: read core works
    expect((await app(infoRefs("core", "git-upload-pack", machineToken))).status).toBe(200);
    await app(s2s("/s2s/revoke", { operatorId: "o1" }));
    // after revoke, in the very next request: both read and write are 401
    expect((await app(infoRefs("core", "git-upload-pack", machineToken))).status).toBe(401);
    expect((await app(infoRefs("team-acme", "git-receive-pack", machineToken))).status).toBe(401);
  });
});

describe("DOGFOOD e2e: provision → clone×3 → push team → push core rejected → refresh → revoke", () => {
  it("walks the whole lifecycle end-to-end", async () => {
    // 1. provision a fresh company
    const creds = await provisionCompany();
    expect(creds.repos.team).toBe("https://sync.test/git/team-acme.git");

    // 2. clone all three repos (fs transport)
    for (const repo of ["core", "team-acme", "private-o1"]) {
      g(["clone", fileUrl(repo), join(dir, `clone-${repo}`)], dir);
    }

    // 3. push a doc to the team repo, then re-clone and see it
    const team = join(dir, "clone-team-acme");
    writeFileSync(join(team, "conventions.md"), "# Acme conventions\n");
    g(["add", "."], team);
    g(["commit", "-m", "seed conventions"], team);
    g(["push", "origin", "HEAD:main"], team);
    g(["clone", "--branch", "main", fileUrl("team-acme"), join(dir, "team-verify")], dir);
    expect(execFileSync("cat", [join(dir, "team-verify", "conventions.md")], { encoding: "utf8" })).toContain("Acme conventions");

    // 4. a push to core is rejected (enforced by the handler's permission matrix)
    expect((await app(infoRefs("core", "git-receive-pack", creds.machineToken))).status).toBe(403);

    // 5. refresh rotates credentials; the old machine token stops authorizing
    const rotated = (await (await app(post("/token/refresh", { refreshToken: creds.refreshToken }))).json()) as Creds;
    expect(rotated.machineToken).not.toBe(creds.machineToken);
    expect((await app(infoRefs("core", "git-upload-pack", creds.machineToken))).status).toBe(401);
    expect((await app(infoRefs("core", "git-upload-pack", rotated.machineToken))).status).toBe(200);

    // 6. revoke ends access entirely
    await app(s2s("/s2s/revoke", { operatorId: "o1" }));
    expect((await app(infoRefs("core", "git-upload-pack", rotated.machineToken))).status).toBe(401);
  });
});
