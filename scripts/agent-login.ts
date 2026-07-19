// One-time login for the agent's isolated config dir (CLAUDE_CONFIG_DIR). This gives BuildEx's spawned
// agent a Claude Code home separate from the operator's own - so the operator's global hooks
// (PreToolUse/PermissionRequest) don't gate the agent, and it gets a clean, predictable tool
// set. Same login/account as usual; just a separate config home. Writes a .buildex-ready marker on
// success so the daemon knows to use it. Run: npm run demo:agent-login
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEMO = process.env["BUILDEX_DEMO_DIR"] || join(homedir(), ".buildex-demo");
const dir = join(DEMO, ".claude-agent");
if (!existsSync(dir)) {
  console.error(`No demo yet. Run \`npm run demo:setup\` first (looked in ${dir}).`);
  process.exit(1);
}

console.log(`Logging the buildex agent into its own config home:\n  ${dir}\n`);
const env = { ...process.env, CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
const res = spawnSync("claude", ["/login"], { env, stdio: "inherit" });
if (res.status === 0) {
  writeFileSync(join(dir, ".buildex-ready"), new Date().toISOString() + "\n");
  console.log(`\n✅ Done. The agent will now run with its own tools (no inherited hooks).`);
} else {
  console.error(`\nLogin did not complete (exit ${res.status}). The agent will keep using your default config for now.`);
  process.exit(res.status ?? 1);
}
