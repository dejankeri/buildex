// tsx CLI shell - parses argv, builds the real seams, and hands off to proof.ts (the testable
// composition). Usage:
//   npx tsx src/harness/runProof.ts --pack acme [--mcp-url <url>] [--cases <1-20>] [--baseline <path>]
//   --mcp-url:  the LOCAL lane - pin this url with the key from env BUILDEX_LOCAL_MCP_KEY, no mint.
//               Omitted = the sandbox lane - mint/pin/destroy via the pack's sandbox face, using
//               env BUILDEX_SANDBOX_SECRET.
//   --cases:    number of day-in-the-life cases to generate (default 5).
//   --baseline: a prior run's surface.json to diff drift against (fail-soft if unreadable).
// Secrets come from env, exactly like runDeterministic.ts - proof.ts scrubs both vars from
// process.env before the agent's first spawn (the generator's).
//
// Interrupt safety (closes the gap runDeterministic.ts's header comment names as deliberate-for-now
// there): a CleanupRegistry is built here and threaded into proof.ts, which registers the discovery
// clean-room, the minted sandbox (if any), and every case clean-room's teardown as each is acquired.
// On SIGINT/SIGTERM we run that registry directly - proof.ts's own `finally` never gets to run when
// the process is killed mid-await, so the CLI owns catching the signal and unwinding whatever has
// been registered so far, then exits 130 (the POSIX "terminated by SIGINT" convention). Safe even if
// proof.ts's own finally already ran first (CleanupRegistry.runAll is idempotent - entries already
// run are skipped).
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCatalogSource } from "../brain/catalog-source.js";
import { resolveCorePackDir } from "../provision/core-pack.js";
import { ClaudeCodeDriver } from "../agent/claude-driver.js";
import { nodeSpawnAgent } from "../agent/node-spawn.js";
import { parseProofArgs } from "./cli-args.js";
import { runProofTrack } from "./proof.js";
import { CleanupRegistry } from "./cleanup.js";

// Repo root, from this file's location (apps/client/src/harness/runProof.ts → up four).
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function main(): Promise<void> {
  const args = parseProofArgs(process.argv.slice(2));
  const corePackDir = resolveCorePackDir({ repoRoot: REPO });
  const cleanup = new CleanupRegistry();

  process.on("SIGINT", () => {
    void cleanup.runAll(console.log).then(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    void cleanup.runAll(console.log).then(() => process.exit(130));
  });

  const outcome = await runProofTrack(args, {
    source: bundleCatalogSource(join(corePackDir, "catalog")),
    corePackDir,
    baseDir: join(homedir(), ".buildex-e2e", "proof-runs"),
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
