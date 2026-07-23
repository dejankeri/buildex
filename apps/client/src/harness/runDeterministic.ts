// tsx CLI shell - parses argv, builds the real seams, and hands off to run.ts (the testable
// composition). Usage:
//   npx tsx src/harness/runDeterministic.ts --pack acme [--mcp-url <url>] [--prompt <text>] [--no-sandbox] [--no-agent]
//   --mcp-url:    the LOCAL lane - pin this url with the key from env BUILDEX_LOCAL_MCP_KEY and
//                 skip mint/destroy entirely. For providers running on this machine before they
//                 have sandbox endpoints; clean slate = reset that local instance.
//   --prompt:     override the built-in smoke prompt for this run's drive case
//   --no-sandbox: skip mint/pin/destroy (no admin secret on this machine)
//   --no-agent:   skip the drive step (plumbing-only run)
// Secrets come from env - BUILDEX_SANDBOX_SECRET (sandbox lane) / BUILDEX_LOCAL_MCP_KEY (local
// lane). The keychain read belongs to the daemon; a CLI run takes the env-var lane so it works
// headless and in CI. run.ts scrubs both vars from process.env before the agent spawns.
//
// A hard kill (Ctrl+C) is interrupt-safe: the SIGINT/SIGTERM handler below runs the cleanup
// registry, which deletes the run's workspace - and the pinned .mcp.json holding the provider key
// with it - before exiting. (The deterministic sandbox lane's provider destroy still unwinds inside
// withSandbox and, failing that, relies on the provider's TTL; the local lane's key never lands
// anywhere but the workspace, which the registry always removes.)
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCatalogSource } from "../brain/catalog-source.js";
import { resolveCorePackDir } from "../provision/core-pack.js";
import { ClaudeCodeDriver } from "../agent/claude-driver.js";
import { nodeSpawnAgent } from "../agent/node-spawn.js";
import { parseArgs } from "./cli-args.js";
import { runDeterministicTrack } from "./run.js";
import { CleanupRegistry } from "./cleanup.js";

// Repo root, from this file's location (apps/client/src/harness/runDeterministic.ts → up four).
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corePackDir = resolveCorePackDir({ repoRoot: REPO });
  const cleanup = new CleanupRegistry();

  // A hard kill can't run the track's own finally, so unwind through the same registry directly,
  // then exit with the POSIX signal convention (128 + signal number). Safe if the finally already
  // ran (runAll is idempotent - entries run at most once).
  const onSignal = (code: number) => () => void cleanup.runAll(console.log).then(() => process.exit(code));
  process.on("SIGINT", onSignal(130)); // 128 + SIGINT(2)
  process.on("SIGTERM", onSignal(143)); // 128 + SIGTERM(15)

  const outcome = await runDeterministicTrack(args, {
    source: bundleCatalogSource(join(corePackDir, "catalog")),
    corePackDir,
    baseDir: join(homedir(), ".buildex-e2e", "runs"),
    driver: new ClaudeCodeDriver({ spawn: nodeSpawnAgent, bin: "claude" }),
    fetch: globalThis.fetch,
    env: process.env,
    cleanup,
  });
  process.exitCode = outcome.exitCode;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
