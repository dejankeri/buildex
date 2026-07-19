// GATE-1 cross-module smoke. Wires the three core modules (sync service, client, connectors)
// together and walks the whole platform loop:
//   provision (sync service) → client clones + agent edits team repo → sync round-trips to a second
//   machine → a connector files material into sources/ → a gated send is approved from the
//   Pending tray.
// Git data moves over git's fs-only file:// transport (this env blocks inter-process loopback TCP);
// the sync service's permission-matrix enforcement is proven separately in its own invariant suite. Run:
//   npx tsx scripts/cross-module-smoke.ts
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// sync service
import { ControlPlaneStore } from "../apps/sync/src/store/store.js";
import { EmbeddedGitService } from "../apps/sync/src/git/service.js";
import { ProvisioningService } from "../apps/sync/src/provisioning/service.js";
import { createApp } from "../apps/sync/src/http/app.js";
import { ScheduleStore } from "../apps/sync/src/automations/schedule-store.js";
// client
import { SyncEngine } from "../apps/client/src/sync/engine.js";
import { generateAgentConfig } from "../apps/client/src/brain/agent-config.js";
import { buildGraph } from "../apps/client/src/brain/graph.js";
import { Gate } from "../apps/client/src/gate/gate.js";
import { PolicyEngine } from "../apps/client/src/gate/policy.js";
import { ApprovalBroker } from "../apps/client/src/gate/approval.js";
// connectors
import { runConnectorSync } from "../apps/connectors/src/framework.js";
import { createGmailConnector } from "../apps/connectors/src/catalog/gmail.js";

let fails = 0;
const check = (c: boolean, m: string) => { console.log(`  ${c ? "✓" : "✗ FAIL:"} ${m}`); if (!c) fails++; };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base = mkdtempSync(join(tmpdir(), "buildex-x1-"));
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "dan", GIT_AUTHOR_EMAIL: "dan@x", GIT_COMMITTER_NAME: "dan", GIT_COMMITTER_EMAIL: "dan@x" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

try {
  // ============================================================
  console.log("\n[sync service] provision a fresh company through the sync service");
  // ============================================================
  const reposRoot = join(base, "server-repos");
  const store = new ControlPlaneStore(join(base, "control.db"));
  const gitSvc = new EmbeddedGitService({ reposRoot });
  let mid = 0;
  const provisioning = new ProvisioningService({ store, git: gitSvc, idFactory: () => `m${++mid}` });
  await provisioning.ensureCoreRepo();
  const schedules = new ScheduleStore(join(base, "schedules.db"));
  const app = createApp({ store, provisioning, git: gitSvc, schedules, serviceKey: "svc", publicBaseUrl: "https://sync.test" });
  const s2s = (p: string, b: unknown) => new Request(`https://sync.test${p}`, { method: "POST", headers: { "content-type": "application/json", "x-service-key": "svc" }, body: JSON.stringify(b) });
  const post = (p: string, b: unknown) => new Request(`https://sync.test${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  await app(s2s("/s2s/companies", { id: "c1", slug: "northwind", name: "Northwind Labs" }));
  await app(s2s("/s2s/operators", { id: "dan", companyId: "c1", email: "dan@northwind.co" }));
  const { setupToken } = (await (await app(s2s("/s2s/setup-tokens", { operatorId: "dan" }))).json()) as { setupToken: string };
  const creds = (await (await app(post("/provision", { setupToken, machineName: "dan-laptop" }))).json()) as { machineToken: string; repos: { core: string; team: string; private: string } };
  check(creds.machineToken.startsWith("xmachine_"), "provisioned a machine credential");
  const repoNames = { core: "core", team: "team-northwind", private: "private-dan" };
  check(existsSync(join(reposRoot, `${repoNames.team}.git`)), "the team repo exists on the server");

  // ============================================================
  console.log("\n[client] client clones the workspace, the agent edits the team brain, it syncs");
  // ============================================================
  const fileUrl = (n: string) => `file://${join(reposRoot, `${n}.git`)}`;
  const m1 = join(base, "machine1");
  git(["clone", fileUrl(repoNames.core), join(m1, "core")], base);
  git(["clone", fileUrl(repoNames.team), join(m1, "team-northwind")], base);
  git(["clone", fileUrl(repoNames.private), join(m1, "private-dan")], base);
  check(existsSync(join(m1, "team-northwind")), "cloned core + team + private (3 repos)");

  // generate the native agent config at the workspace root
  const roots = [
    { name: "core", dir: join(m1, "core") },
    { name: "team", dir: join(m1, "team-northwind") },
    { name: "private", dir: join(m1, "private-dan") },
  ];
  generateAgentConfig({ workspace: m1, roots, preset: { allow: ["Read", "Edit"], ask: ["SendEmail", "Bash"], deny: [], default: "ask" }, gateCommand: "buildex-gate" });
  check(existsSync(join(m1, ".claude", "settings.json")), "generated native .claude/ agent config");

  // the agent edits the team brain (simulated edit - the real-agent path is proven in the client live smoke)
  writeFileSync(join(m1, "team-northwind", "conventions.md"), "# Northwind conventions\n\nWe ship weekly. Decisions live in decisions/.\n");
  const teamDir = join(m1, "team-northwind");
  const r1 = await new SyncEngine({ now: () => 1, actor: "dan" }).syncWritable(teamDir);
  check(r1 === "ok", "the agent's edit committed + pushed to the team brain");

  // ============================================================
  console.log("\n[client] the change round-trips to a second machine");
  // ============================================================
  const m2 = join(base, "machine2");
  git(["clone", fileUrl(repoNames.team), join(m2, "team-northwind")], base);
  check(readFileSync(join(m2, "team-northwind", "conventions.md"), "utf8").includes("ship weekly"), "machine 2 sees the edit (multi-writer sync round-trip)");

  // ============================================================
  console.log("\n[connectors] a connector files real material into sources/, which also syncs");
  // ============================================================
  const gmail = createGmailConnector({
    list: async () => [
      { id: "g1", threadId: "kickoff", from: "ceo@partner.com", subject: "Kickoff", date: "2026-07-16T10:00:00Z", body: "Excited to start." },
    ],
  });
  await runConnectorSync(gmail, { workspaceDir: teamDir, now: () => Date.parse("2026-07-16T10:05:00Z") });
  check(existsSync(join(teamDir, "sources", "gmail", "kickoff.md")), "connector filed an email under sources/gmail/");
  await new SyncEngine({ now: () => 2, actor: "dan" }).syncWritable(teamDir);
  git(["pull", "--rebase", "origin", "main"], join(m2, "team-northwind"));
  check(existsSync(join(m2, "team-northwind", "sources", "gmail", "kickoff.md")), "machine 2 sees the connector material too");

  const graph = buildGraph([{ name: "team", dir: teamDir }]);
  check(graph.nodes.some((n) => n.id.includes("conventions.md")) && graph.nodes.some((n) => n.id.includes("kickoff.md")), `the map now spans ${graph.nodes.length} docs (brain + connector material)`);

  // ============================================================
  console.log("\n[gate] the agent proposes an outward send - it waits for a human tap");
  // ============================================================
  let n = 0;
  const broker = new ApprovalBroker({ idFactory: () => `card${++n}`, now: () => 0, onCard: (c) => console.log(`    · Pending tray: approval card for ${c.tool.name}`) });
  const gate = new Gate(new PolicyEngine({ allow: ["Read"], ask: ["SendEmail"], deny: [], default: "ask" }), broker);
  const sendVerdict = gate.evaluate({ name: "SendEmail", input: { to: "board@northwind.co", subject: "July update" } });
  await delay(15);
  check(broker.pending().length === 1, "the outward send did NOT fire - it surfaced as an approval card");
  console.log("    · operator taps Approve");
  broker.resolve(broker.pending()[0]!.id, "approve");
  check((await sendVerdict) === "allow", "approved from the Pending tray → the send is allowed to proceed");

  console.log(`\n${fails === 0 ? "✅ GATE-1 CROSS-MODULE SMOKE PASSED" : `❌ FAILED (${fails} check(s))`}`);
  store.close();
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
