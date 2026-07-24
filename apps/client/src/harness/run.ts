// The deterministic track for one pack, end to end - the composition the CLI shell invokes.
// Extracted from the CLI so the whole lane wiring (env guards, pin, grants, exit code, teardown
// ordering, the always-write-results contract) is testable with only the outward seams faked
// (driver, fetch, env) - per the repo's DI rule.
import { hostname } from "node:os";
import { join } from "node:path";
import { readPack } from "../brain/catalog.js";
import { PACK_KEY_PREFIX } from "@buildex/connectors";
import type { CatalogSource } from "../brain/catalog-source.js";
import type { AgentDriver } from "../agent/types.js";
import type { SandboxWorkspace } from "../brain/sandbox.js";
import { provisionRunContext, teardownRunContext } from "./run-context.js";
import { installPackHeadless, regenAgentConfig, verifyInstall } from "./install-step.js";
import { pinKey, withSandbox } from "./sandbox-step.js";
import { driveCase, type DriveResult } from "./drive-step.js";
import { collectResults, writeResults } from "./results.js";
import { redactText } from "./redact.js";
import type { Args } from "./cli-args.js";
import type { CleanupRegistry } from "./cleanup.js";

const SMOKE_PROMPT = "List the skills available in this workspace and confirm which app tools you can reach.";

export interface RunDeps {
  source: CatalogSource;
  corePackDir: string;
  /** Parent of all run dirs (the CLI passes ~/.buildex-e2e/runs). */
  baseDir: string;
  driver: AgentDriver;
  fetch: typeof globalThis.fetch;
  /** The environment secrets are READ from - and SCRUBBED from, in place, before the agent spawns
   *  (the CLI passes process.env, so the child never inherits an admin secret or provider key). */
  env: Record<string, string | undefined>;
  /** Interrupt-safe teardown: the run's throwaway workspace registers its teardown here as soon as
   *  it is provisioned, so a hard kill mid-run (the CLI shell's SIGINT/SIGTERM handler) can still
   *  delete it - and the pinned .mcp.json holding the provider key with it. Runs on normal completion
   *  too; the registry is idempotent, so the signal path and the finally never double-delete. */
  cleanup: CleanupRegistry;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RunOutcome {
  exitCode: number;
  runDir: string;
  resultsPath: string;
}

/** yyyy-mm-dd-hhmmss in local time - readable at a glance in a directory listing, and seconds-
 *  granular so two runs of the same pack started within the same minute don't collide. Exported:
 *  the proof track (proof.ts) reuses it verbatim for its own run-dir slug, rather than forking a
 *  second copy of the same formatting rule. */
export function slugTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export async function runDeterministicTrack(args: Args, deps: RunDeps): Promise<RunOutcome> {
  const { pack, sandbox: sandboxEnabled, agent: agentEnabled, mcpUrl, prompt } = args;
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());

  // Read the lane secrets, then scrub them from the env IN PLACE - always, used or stray - so the
  // spawned agent's process can never inherit them into a transcript.
  const localKey = deps.env["BUILDEX_LOCAL_MCP_KEY"];
  const sandboxSecret = deps.env["BUILDEX_SANDBOX_SECRET"];
  delete deps.env["BUILDEX_LOCAL_MCP_KEY"];
  delete deps.env["BUILDEX_SANDBOX_SECRET"];
  // Scrub these from any error that escapes the track (see the redacting rethrow below) - a
  // lower-level error can quote a secret verbatim even though the drive already redacts its transcript.
  const knownSecrets = [localKey, sandboxSecret].filter((s): s is string => !!s);

  // Every refusal below happens BEFORE anything touches disk.
  if (mcpUrl !== undefined && !localKey) {
    throw new Error("BUILDEX_LOCAL_MCP_KEY is not set - export the provider api key the local lane (--mcp-url) should pin.");
  }
  if (mcpUrl === undefined && sandboxEnabled && !sandboxSecret) {
    throw new Error(
      "BUILDEX_SANDBOX_SECRET is not set - export the sandbox admin secret, or pass --no-sandbox to skip mint/pin/destroy.",
    );
  }
  // `pack` is a raw CLI arg, and both provisionRunContext (mkdir + seed under the run dir) and
  // teardown (rmSync) key a path off it. readPack NAME_RE-validates via parsePack, so a
  // hostile/typo'd id (e.g. "../../..") is rejected here, before it can steer provisioning +
  // deletion at a real directory.
  const m = readPack(deps.source, pack);
  if (!m) throw new Error(`unknown pack: ${pack}`);

  const slug = `${slugTimestamp(now())}-${pack}`;
  const ctx = provisionRunContext({ baseDir: deps.baseDir, corePackDir: deps.corePackDir, slug });
  // Register teardown the moment the workspace exists, so the CLI shell's SIGINT/SIGTERM handler can
  // delete it (and the pinned .mcp.json holding the provider key) even on a hard kill - not only on
  // the normal/thrown paths the finally covers.
  deps.cleanup.push("run-teardown", () => teardownRunContext(ctx));
  log(`run dir: ${ctx.runDir}`);

  try {
    const install = installPackHeadless(deps.source, ctx.roots, pack);
    log(`installed ${install.id} → ${install.target} (rules: ${install.rulesTarget ?? install.target})`);
    const check = verifyInstall(deps.source, ctx.roots, pack);

    // Mirror the product's post-install sync: re-link the pack's skills into .claude/skills and
    // recompose settings.json - with the pinned server allowed whenever this run pins one. The
    // composed allow tier also rides --allowedTools on the spawn: a fresh run workspace is never
    // folder-trusted, so the settings file alone cannot grant the tools to a headless session -
    // --allowedTools is the only thing that binds, so it must carry the WHOLE allow tier
    // (Read/Write/Edit/Bash + the pinned server), not just the server.
    const willPin = mcpUrl !== undefined || sandboxEnabled;
    const { allow: driveAllow } = regenAgentConfig({
      workspace: ctx.workspace,
      roots: ctx.roots,
      corePackDir: deps.corePackDir,
      ...(willPin ? { allowMcpServer: `${PACK_KEY_PREFIX}${pack}` } : {}),
    });

    const sandboxResult = { minted: false, destroyed: false };
    const drives: DriveResult[] = [];

    // Every secret this run knows is scrubbed from the persisted transcript.
    const driveIfEnabled = async (extraRedact: string[] = []): Promise<void> => {
      if (!agentEnabled) return;
      const redact = [localKey, sandboxSecret, ...extraRedact].filter((s): s is string => !!s);
      const drive = await driveCase(deps.driver, {
        workspace: ctx.workspace,
        prompt: prompt ?? SMOKE_PROMPT,
        runDir: ctx.runDir,
        caseId: "smoke-1",
        redact,
        allowedTools: driveAllow,
        // When pinning, the workspace .mcp.json holds only the pack under test; strict-mcp against
        // it (mcpConfigPath) keeps the operator's claude.ai connectors out of the driven agent.
        ...(willPin ? { mcpConfigPath: join(ctx.workspace, ".mcp.json") } : {}),
      });
      drives.push(drive);
    };

    // The lanes may fail late (a destroy failure after a successful drive is still an error), but
    // whatever happened up to that point MUST land in results.json - the run's one surviving
    // artifact. So: capture the lane error, always collect+write, then rethrow.
    let laneError: unknown;
    try {
      if (mcpUrl !== undefined) {
        pinKey(m, { workspace: ctx.workspace, url: mcpUrl, key: localKey! });
        log(`pinned ${pack} → ${mcpUrl} (local lane - no mint/destroy)`);
        await driveIfEnabled();
      } else if (sandboxEnabled) {
        const host = hostname().replace(/[^A-Za-z0-9-]/g, "-");
        await withSandbox(m, sandboxSecret!, { workspace: ctx.workspace, runName: slug, host }, { fetch: deps.fetch }, async (ws: SandboxWorkspace) => {
          sandboxResult.minted = true;
          await driveIfEnabled([ws.key]);
        });
        sandboxResult.destroyed = true;
      } else {
        await driveIfEnabled();
      }
    } catch (e) {
      laneError = e;
    }

    const results = collectResults({ pack, ctx, install: check, sandbox: sandboxResult, drives, ...(deps.now ? { now: deps.now } : {}) });
    const resultsPath = writeResults(ctx.runDir, results);

    // Redact before rethrowing - the backstop for a laneError that carries a secret verbatim (the
    // generator/judge/drive paths already scrub their own; this covers a lower-level error).
    if (laneError) throw new Error(redactText(String((laneError as Error)?.stack ?? laneError), knownSecrets));

    const anyErrored = drives.some((d) => d.errored);
    log(`\nresults: ${resultsPath}`);
    log(
      `pack=${pack} install.ok=${check.ok} sandbox={minted:${sandboxResult.minted},destroyed:${sandboxResult.destroyed}} drives=${drives.length} errored=${anyErrored}`,
    );

    return { exitCode: !check.ok || anyErrored ? 1 : 0, runDir: ctx.runDir, resultsPath: resultsPath };
  } finally {
    // Runs the registered "run-teardown" (idempotent - if the signal handler already ran it, this
    // is a no-op). Never rethrows, so it can't mask a laneError propagating out of the try.
    await deps.cleanup.runAll(log);
  }
}
