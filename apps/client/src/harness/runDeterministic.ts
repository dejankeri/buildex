// tsx CLI - the deterministic track for one pack, end to end. Real seams, real agent optional.
// Usage: npx tsx src/harness/runDeterministic.ts --pack acme [--no-sandbox] [--no-agent]
//   --no-sandbox: skip mint/pin/destroy (no admin secret on this machine)
//   --no-agent:   skip the drive step (plumbing-only run)
// Secret comes from env BUILDEX_SANDBOX_SECRET (the keychain read belongs to the daemon; a CLI run
// takes the env-var lane so it works headless and in CI).
//
// Known gap, deliberate for now: a hard kill (Ctrl+C) during the drive skips both the provider
// destroy and local teardown - the minted key and workspace linger under ~/.buildex-e2e until the
// next manual sweep. Providers reap via TTL (docs/sandbox-face.md recommends expiresAt); an
// interrupt-safe destroy lane lands with the proof track.
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPack } from "../brain/catalog.js";
import { bundleCatalogSource } from "../brain/catalog-source.js";
import { resolveCorePackDir } from "../provision/core-pack.js";
import { ClaudeCodeDriver } from "../agent/claude-driver.js";
import { nodeSpawnAgent } from "../agent/node-spawn.js";
import { provisionRunContext, teardownRunContext } from "./run-context.js";
import { installPackHeadless, verifyInstall } from "./install-step.js";
import { withSandbox } from "./sandbox-step.js";
import { driveCase } from "./drive-step.js";
import { collectResults, writeResults } from "./results.js";
import type { DriveResult } from "./drive-step.js";

const SMOKE_PROMPT = "List the skills available in this workspace and confirm which app tools you can reach.";

// Repo root, from this file's location (apps/client/src/harness/runDeterministic.ts → up four).
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface Args {
  pack: string;
  sandbox: boolean;
  agent: boolean;
}

const VALID_FLAGS = ["--pack", "--no-sandbox", "--no-agent"] as const;

function parseArgs(argv: string[]): Args {
  let pack: string | undefined;
  let sandbox = true;
  let agent = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pack") pack = argv[++i];
    else if (a === "--no-sandbox") sandbox = false;
    else if (a === "--no-agent") agent = false;
    else throw new Error(`unknown flag: ${a} (valid: ${VALID_FLAGS.join(", ")})`);
  }
  if (!pack) throw new Error("usage: runDeterministic.ts --pack <id> [--no-sandbox] [--no-agent]");
  return { pack, sandbox, agent };
}

/** yyyy-mm-dd-hhmmss in local time - readable at a glance in a directory listing, and seconds-
 *  granular so two runs of the same pack started within the same minute don't collide. */
function slugTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main(): Promise<void> {
  const { pack, sandbox: sandboxEnabled, agent: agentEnabled } = parseArgs(process.argv.slice(2));

  const corePackDir = resolveCorePackDir({ repoRoot: REPO });
  const source = bundleCatalogSource(join(corePackDir, "catalog"));

  // Validate BEFORE anything touches disk: `pack` is a raw CLI arg, and both provisionRunContext
  // (mkdir + seed under the run dir) and teardown (rmSync) key a path off it. readPack
  // NAME_RE-validates via parsePack, so a hostile/typo'd id (e.g. "../../..") is rejected here,
  // before it can steer provisioning + deletion at a real directory.
  const m = readPack(source, pack);
  if (!m) throw new Error(`unknown pack: ${pack}`);

  const baseDir = join(homedir(), ".buildex-e2e", "runs");
  const slug = `${slugTimestamp(new Date())}-${pack}`;
  const ctx = provisionRunContext({ baseDir, corePackDir, slug });

  console.log(`run dir: ${ctx.runDir}`);

  try {
    const install = installPackHeadless(source, ctx.roots, pack);
    console.log(`installed ${install.id} → ${install.target} (rules: ${install.rulesTarget ?? install.target})`);
    const check = verifyInstall(source, ctx.roots, pack);

    const sandboxResult = { minted: false, destroyed: false };
    const drives: DriveResult[] = [];

    const driveIfEnabled = async (): Promise<void> => {
      if (!agentEnabled) return;
      const driver = new ClaudeCodeDriver({ spawn: nodeSpawnAgent, bin: "claude" });
      const drive = await driveCase(driver, {
        workspace: ctx.workspace,
        prompt: SMOKE_PROMPT,
        runDir: ctx.runDir,
        caseId: "smoke-1",
      });
      drives.push(drive);
    };

    if (sandboxEnabled) {
      const secret = process.env["BUILDEX_SANDBOX_SECRET"];
      if (!secret) {
        throw new Error(
          "BUILDEX_SANDBOX_SECRET is not set - export the sandbox admin secret, or pass --no-sandbox to skip mint/pin/destroy.",
        );
      }
      const host = hostname().replace(/[^A-Za-z0-9-]/g, "-");
      await withSandbox(m, secret, { workspace: ctx.workspace, runName: slug, host }, { fetch: globalThis.fetch }, async () => {
        sandboxResult.minted = true;
        await driveIfEnabled();
      });
      sandboxResult.destroyed = true;
    } else {
      await driveIfEnabled();
    }

    const results = collectResults({ pack, ctx, install: check, sandbox: sandboxResult, drives });
    const resultsPath = writeResults(ctx.runDir, results);

    const anyErrored = drives.some((d) => d.errored);
    console.log(`\nresults: ${resultsPath}`);
    console.log(
      `pack=${pack} install.ok=${check.ok} sandbox={minted:${sandboxResult.minted},destroyed:${sandboxResult.destroyed}} drives=${drives.length} errored=${anyErrored}`,
    );

    process.exitCode = !check.ok || anyErrored ? 1 : 0;
  } finally {
    teardownRunContext(ctx);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
