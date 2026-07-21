// Provision a local BuildEx demo environment (single machine, no cloud needed). Creates a workspace of
// three real git repos - core (the product pack), team-acme (a seeded company brain), private-you -
// each with a local file:// remote so sync works, generates the native agent config + a lived-in left
// rail, and writes a demo config. Idempotent: pass --reset to rebuild. Run: npx tsx scripts/demo-setup.ts
//
// The company brain itself (all the Acme Labs content, sessions, projects, automations) lives in the
// shared library apps/client/src/demo/acme-seed.ts - the SINGLE source of truth also used by the
// packaged app's demo sandbox (B2b). This script's only job on top of that is the dev-only scaffolding:
// file:// remotes so the local sync demo works, an isolated agent config dir, and the demo.json runner
// config. Keep those here; keep the brain content in the library.
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCoreContent, writeAcmeContent, writePrivateContent, writeWorkspaceExtras, installDemoPacks } from "../apps/client/src/demo/acme-seed.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_PACK = join(REPO, "packs", "core");
const DEMO = process.env["BUILDEX_DEMO_DIR"] || join(homedir(), ".buildex-demo");
const reset = process.argv.includes("--reset");

const ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "BuildEx demo", GIT_AUTHOR_EMAIL: "demo@buildex.local", GIT_COMMITTER_NAME: "BuildEx demo", GIT_COMMITTER_EMAIL: "demo@buildex.local", PATH: process.env["PATH"] } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] });

// Give one repo a local file:// remote (so the dev sync demo can push/pull) and a working clone to
// lay content into. Content and push are SEPARATE phases: installing a pack writes to two repos at
// once (app face → private, company rules → team), so every clone must exist before anything installs.
function cloneSeed(name: string): string {
  const bare = join(DEMO, "remotes", `${name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git(["init", "--bare", "--initial-branch=main", bare], DEMO);
  const seed = join(DEMO, ".seed", name);
  mkdirSync(seed, { recursive: true });
  git(["clone", `file://${bare}`, seed], DEMO);
  return seed;
}

/** Commit everything laid down in a seed clone and push it to its bare remote. */
function pushSeed(name: string, seed: string) {
  git(["add", "-A"], seed);
  git(["commit", "-m", `seed ${name}`], seed);
  git(["push", "origin", "HEAD:main"], seed);
}

if (reset && existsSync(DEMO)) rmSync(DEMO, { recursive: true, force: true });
if (existsSync(join(DEMO, "workspace"))) {
  console.log(`Demo already set up at ${DEMO}. Re-run with --reset to rebuild.`);
  process.exit(0);
}
mkdirSync(DEMO, { recursive: true });
console.log(`Provisioning the BuildEx demo at ${DEMO} …`);

// The company brain - identical content to the packaged demo sandbox, sourced from the shared library.
const REPOS = ["core", "team-acme", "private-you"] as const;
const seeds = Object.fromEntries(REPOS.map((n) => [n, cloneSeed(n)])) as Record<(typeof REPOS)[number], string>;
writeCoreContent(seeds.core, { corePackDir: CORE_PACK });
writeAcmeContent(seeds["team-acme"], { corePackDir: CORE_PACK });
writePrivateContent(seeds["private-you"]);
// …then the installed stack, which spans the private/team pair (see installDemoPacks).
installDemoPacks(seeds["private-you"], seeds["team-acme"], CORE_PACK);
for (const name of REPOS) pushSeed(name, seeds[name]);

// --- clone the workspace the daemon operates on ---
const ws = join(DEMO, "workspace");
mkdirSync(ws, { recursive: true });
for (const name of ["core", "team-acme", "private-you"] as const) {
  git(["clone", `file://${join(DEMO, "remotes", `${name}.git`)}`, join(ws, name)], DEMO);
}
rmSync(join(DEMO, ".seed"), { recursive: true, force: true });

// Root names MUST equal the on-disk directory names: the map/vault/file-tree display these paths, and
// the agent (cwd = workspace) must be able to open exactly what's shown. Then lay down the daemon-owned
// left rail (agent config, automations, sessions, projects) - the same extras the packaged demo gets.
const preset = JSON.parse(readFileSync(join(CORE_PACK, "policy", "preset.json"), "utf8"));
const roots = [
  { name: "core", dir: join(ws, "core") },
  { name: "team-acme", dir: join(ws, "team-acme") },
  { name: "private-you", dir: join(ws, "private-you") },
];
writeWorkspaceExtras(ws, { roots, preset });

// --- an isolated CLAUDE_CONFIG_DIR for the agent (no inherited hooks from the operator's own
//     Claude Code), so the spawned agent gets a clean, predictable tool set. Opt-in: it only takes
//     effect once logged in (npm run demo:agent-login), which writes the .buildex-ready marker. ---
const agentConfigDir = join(DEMO, ".claude-agent");
mkdirSync(agentConfigDir, { recursive: true });
writeFileSync(
  join(agentConfigDir, "settings.json"),
  JSON.stringify(
    {
      permissions: {
        defaultMode: "acceptEdits",
        allow: ["Read", "Edit", "Write", "Glob", "Grep", "LS", "Bash(ls:*)", "Bash(cat:*)", "Bash(find:*)", "Bash(grep:*)", "Bash(rg:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"],
        deny: ["Bash(rm:*)", "Bash(sudo:*)", "Bash(git push:*)", "Bash(git reset --hard:*)"],
      },
    },
    null,
    2,
  ) + "\n",
);

// --- write the demo config the runner reads ---
const config = {
  workspace: ws,
  roots,
  preset,
  claudeBin: "claude",
  webRoot: join(REPO, "apps", "client", "web"),
  company: { name: "Acme Labs", operator: "you@acme.demo", seats: 1 },
  schedulerIntervalMs: 60000, // check for due automations every minute while the app is open
  agentConfigDir, // used only once logged in (npm run demo:agent-login) - see demo.ts
};
writeFileSync(join(DEMO, "demo.json"), JSON.stringify(config, null, 2));

console.log(`
✅ Demo provisioned.

  Company     Acme Labs   (demo)
  Operator    you@acme.demo
  Workspace   ${ws}
  Repos       core (read-only pack) · team-acme (the brain) · private-you
  Login       none needed - the agent uses YOUR local 'claude' login (the conductor pattern)

Start it:
  npm run demo        # open the console in your browser
  npm run demo:app    # open the native Electron app

Optional - give the agent full shell tools (a config isolated from your own Claude Code, so its
hooks don't gate the agent). One time:
  npm run demo:agent-login
Without it, the agent still reads and writes the brain fine (it's handed the file map).
`);
