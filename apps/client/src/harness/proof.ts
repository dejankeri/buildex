// The proof track for one pack, end to end - the composition runProof.ts's CLI shell invokes. Where
// run.ts drives one fixed smoke prompt, this track (1) discovers the pack's real surface (skills +
// live mcp tools), (2) asks the agent itself to generate day-in-the-life test cases from that
// surface, (3) drives each case in its own clean-room workspace, (4) judges each driven case with a
// FRESH, context-isolated agent spawn, and (5) always leaves behind a scorecard + report.md - even
// when a step after case-generation blows up midway. Same seam-only-fakeable DI rule as run.ts
// (driver/fetch/env/now/log), plus one more: `cleanup`, an interrupt-safe LIFO registry so a hard
// kill (Ctrl+C) mid-run still destroys a minted sandbox workspace and tears down every clean-room -
// the gap runDeterministic.ts's header comment names as "known, deliberate for now" is closed here.
import { hostname } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { readPack } from "../brain/catalog.js";
import { PACK_KEY_PREFIX } from "@buildex/connectors";
import type { CatalogSource } from "../brain/catalog-source.js";
import type { AgentDriver } from "../agent/types.js";
import { destroySandboxWorkspace, type SandboxWorkspace } from "../brain/sandbox.js";
import { provisionRunContext, teardownRunContext } from "./run-context.js";
import { installPackHeadless, regenAgentConfig, serverAllowRule, verifyInstall } from "./install-step.js";
import { pinKey, mintAndPin } from "./sandbox-step.js";
import { discoverSurface, writeSurface, diffSurface, type Surface } from "./discover.js";
import { generateCases } from "./scenario-step.js";
import { driveCase } from "./drive-step.js";
import { judgeCase, type Verdict } from "./judge-step.js";
import { computeScorecard, renderProofReport, type ProofResults } from "./proof-report.js";
import { renderProofHtmlBundle } from "./proof-report-html.js";
import { CleanupRegistry } from "./cleanup.js";
import type { UiEvent } from "../agent/types.js";
import type { ProofArgs } from "./cli-args.js";
import { slugTimestamp } from "./run.js";
import { redactText } from "./redact.js";

export interface ProofDeps {
  source: CatalogSource;
  corePackDir: string;
  /** Parent of all proof-run dirs (the CLI passes ~/.buildex-e2e/proof-runs). */
  baseDir: string;
  driver: AgentDriver;
  fetch: typeof globalThis.fetch;
  /** The environment secrets are READ from - and SCRUBBED from, in place, before the agent's FIRST
   *  spawn (the generator's) - same contract as run.ts's RunDeps.env. */
  env: Record<string, string | undefined>;
  /** Interrupt-safe teardown registry: the discovery clean-room, the minted sandbox (if any), and
   *  every case clean-room register their teardown here as soon as they're acquired, so a hard kill
   *  mid-run (the CLI's SIGINT/SIGTERM handler) can still unwind everything already created. */
  cleanup: CleanupRegistry;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ProofOutcome {
  exitCode: number;
  runDir: string;
  reportPath: string;
}

export async function runProofTrack(args: ProofArgs, deps: ProofDeps): Promise<ProofOutcome> {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());

  // Read the lane secrets, then scrub them from the env IN PLACE - always, used or stray - so no
  // spawned agent (generator, drive, or judge) can ever inherit them into a transcript.
  const localKey = deps.env["BUILDEX_LOCAL_MCP_KEY"];
  const sandboxSecret = deps.env["BUILDEX_SANDBOX_SECRET"];
  delete deps.env["BUILDEX_LOCAL_MCP_KEY"];
  delete deps.env["BUILDEX_SANDBOX_SECRET"];

  // Every refusal below happens BEFORE anything touches disk. Unlike run.ts, the proof track has no
  // --no-sandbox: it always drives, so whichever lane --mcp-url selects, that lane's secret is
  // mandatory (cli-args.ts's ProofArgs docstring: sandbox-vs-local is decided purely by --mcp-url's
  // presence, resolved here).
  if (args.mcpUrl !== undefined && !localKey) {
    throw new Error("BUILDEX_LOCAL_MCP_KEY is not set - export the provider api key the local lane (--mcp-url) should pin.");
  }
  if (args.mcpUrl === undefined && !sandboxSecret) {
    throw new Error(
      "BUILDEX_SANDBOX_SECRET is not set - export the sandbox admin secret to mint a proof-run workspace, or pass --mcp-url to use the local lane instead.",
    );
  }
  // `pack` is a raw CLI arg, and both provisionRunContext (mkdir under the run dir) and teardown
  // (rmSync) key a path off it - see run.ts's readPack comment for why this must come before any
  // path is touched.
  const m = readPack(deps.source, args.pack);
  if (!m) throw new Error(`unknown pack: ${args.pack}`);

  const runSlug = `${slugTimestamp(now())}-${args.pack}-proof`;
  const runDir = join(deps.baseDir, runSlug);
  const serverRule = serverAllowRule(`${PACK_KEY_PREFIX}${args.pack}`);

  // One shared clean-room discovers the surface AND hosts the generator's spawn (no case is driven
  // here - each case gets its own fresh clean-room below). Registered on the cleanup registry
  // immediately, NOT in a finally: a hard kill between this line and the eventual finally must still
  // tear it down.
  const discoveryCtx = provisionRunContext({ baseDir: runDir, corePackDir: deps.corePackDir, slug: "discovery" });
  deps.cleanup.push("discovery-teardown", () => teardownRunContext(discoveryCtx));
  log(`run dir: ${runDir}`);

  // Set the moment mint succeeds (sandbox lane only) - purely so the leak line below can name the
  // workspace id; unrelated to the "sandbox-destroy" cleanup entry itself.
  let mintedSandboxId: string | undefined;
  // Assigned on every path that reaches the end of the try block below (the only path that does NOT
  // assign it is a rethrown laneError, which propagates out of the whole function before this
  // variable is ever read).
  let outcome!: ProofOutcome;
  let cleanupFailures: string[] = [];

  try {
    const cases: ProofResults["cases"] = [];
    let surface: Surface | undefined;
    let drift: ReturnType<typeof diffSurface> | null = null;

    // The lane may fail at any point past here - mint, discovery, generation, or mid-case - but
    // whatever was produced up to that point MUST still land in the run's two surviving artifacts.
    // So: capture the error, always assemble+write, then rethrow.
    let laneError: unknown;
    let check: ReturnType<typeof verifyInstall> | undefined;
    // Hoisted so a redacting rethrow (below, at `if (laneError)`) has something to scrub against
    // even when laneError is thrown before `allSecrets` is computed (e.g. a broken install) -
    // localKey/sandboxSecret are known from the top of the function; pinnedKey is folded in below,
    // the moment it's known.
    let knownSecrets: string[] = [localKey, sandboxSecret].filter((s): s is string => !!s);
    try {
      const install = installPackHeadless(deps.source, discoveryCtx.roots, args.pack);
      log(`installed ${install.id} → ${install.target} (rules: ${install.rulesTarget ?? install.target})`);
      check = verifyInstall(deps.source, discoveryCtx.roots, args.pack);
      regenAgentConfig({
        workspace: discoveryCtx.workspace,
        roots: discoveryCtx.roots,
        corePackDir: deps.corePackDir,
        allowMcpServer: `${PACK_KEY_PREFIX}${args.pack}`,
      });

      // Provider lane: local pins the caller's url+key directly (no mint/destroy); sandbox mints
      // ONCE for the whole run and every case reuses the same minted key against the same url.
      let effectiveMcpUrl: string;
      let pinnedKey: string;
      if (args.mcpUrl !== undefined) {
        effectiveMcpUrl = args.mcpUrl;
        pinnedKey = localKey!;
        pinKey(m, { workspace: discoveryCtx.workspace, url: effectiveMcpUrl, key: pinnedKey });
        log(`pinned ${args.pack} → ${effectiveMcpUrl} (local lane - no mint/destroy)`);
      } else {
        const host = hostname().replace(/[^A-Za-z0-9-]/g, "-");
        const ws: SandboxWorkspace = await mintAndPin(
          m,
          sandboxSecret!,
          { workspace: discoveryCtx.workspace, runName: runSlug, host },
          { fetch: deps.fetch },
        );
        // Registered IMMEDIATELY after mint succeeds - a mint with no registered destroy would leak
        // silently on any later failure (case loop, judge, teardown).
        mintedSandboxId = ws.id;
        deps.cleanup.push("sandbox-destroy", () => destroySandboxWorkspace(m.sandbox!, sandboxSecret!, ws.id, { fetch: deps.fetch }));
        effectiveMcpUrl = ws.mcpUrl ?? m.mcp!.url!;
        pinnedKey = ws.key;
        log(`minted sandbox workspace ${ws.id} for ${args.pack}`);
      }

      // Every secret this run knows, redacted from any persisted artifact (transcripts, thrown
      // generator/judge errors).
      const allSecrets = [localKey, sandboxSecret, pinnedKey].filter((s): s is string => !!s);
      knownSecrets = allSecrets;

      // Discover the pack's real surface (skills off disk + a live mcp tools/list) - the seam later
      // steps generate cases from instead of hardcoding either half.
      const header = m.apiKey?.header ?? "Authorization";
      const prefix = m.apiKey?.prefix ?? "Bearer ";
      surface = await discoverSurface(
        // packSkills scopes the surface to the pack under test (its declared skills) + core - so the
        // generator only invents scenarios this run has the tools to satisfy.
        { pack: args.pack, roots: discoveryCtx.roots, mcpUrl: effectiveMcpUrl, headers: { [header]: `${prefix}${pinnedKey}` }, packSkills: m.skills ?? [] },
        { fetch: deps.fetch },
      );
      writeSurface(runDir, surface);

      // Surface drift against a prior run's baseline is opportunistic, never fatal: an unreadable or
      // invalid baseline file just means "no drift computed this run", logged as a warning.
      if (args.baseline) {
        try {
          const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as Surface;
          drift = diffSurface(baseline, surface);
        } catch (e) {
          log(`warning: could not read baseline surface at ${args.baseline} (drift not computed): ${e instanceof Error ? e.message : String(e)}`);
          drift = null;
        }
      }

      // The generator runs in its OWN isolated scratch dir, NOT the discovery workspace - it holds
      // no .mcp.json and no pinned key. Its whole input is `surface` (the JSON riding the prompt
      // verbatim, no tools granted), so it never needs, and must never hold, the provider credential
      // the discovery workspace carries.
      const genDir = join(runDir, "generator");
      mkdirSync(genDir, { recursive: true });
      // Empty MCP config the generator's strict-mcp spawn points at - keeps the operator's claude.ai
      // connectors out of the isolated generator. A dedicated name (NOT .mcp.json) preserves the
      // "generator holds no .mcp.json / no pinned credential" invariant; strict-mcp reads it by path.
      const genMcpConfig = join(genDir, "empty.mcp.json");
      writeFileSync(genMcpConfig, JSON.stringify({ mcpServers: {} }));
      const generated = await generateCases(deps.driver, {
        workspace: genDir,
        surface,
        n: args.cases,
        redact: allSecrets,
        mcpConfigPath: genMcpConfig,
      });

      // Each case runs in its OWN fresh clean-room, sequentially - one case's commits/state must
      // never leak into the next. Teardown is registered per case, up front, same reasoning as the
      // discovery context.
      for (const c of generated) {
        const caseCtx = provisionRunContext({ baseDir: join(runDir, "cases"), corePackDir: deps.corePackDir, slug: c.id });
        deps.cleanup.push(`case-${c.id}-teardown`, () => teardownRunContext(caseCtx));

        installPackHeadless(deps.source, caseCtx.roots, args.pack);
        regenAgentConfig({
          workspace: caseCtx.workspace,
          roots: caseCtx.roots,
          corePackDir: deps.corePackDir,
          allowMcpServer: `${PACK_KEY_PREFIX}${args.pack}`,
        });
        pinKey(m, { workspace: caseCtx.workspace, url: effectiveMcpUrl, key: pinnedKey });

        // driveCase never throws (a mid-stream failure becomes an `errored` result, not an
        // exception) - a broken case must not take the whole run down.
        const drive = await driveCase(deps.driver, {
          workspace: caseCtx.workspace,
          prompt: c.prompt,
          runDir: caseCtx.runDir,
          caseId: c.id,
          allowedTools: [serverRule],
          // The pinned workspace .mcp.json holds only the pack under test - strict-mcp against it
          // means the driven agent sees that pack and NOT the operator's claude.ai connectors.
          mcpConfigPath: join(caseCtx.workspace, ".mcp.json"),
          redact: allSecrets,
        });

        // The judge is independent and CAN throw (both its retry attempts failing validation) - a
        // broken judge must not lose the run either. verdict stays null, reported as unjudged.
        let verdict: Verdict | null = null;
        try {
          const scratchDir = join(runDir, "judge", c.id);
          mkdirSync(scratchDir, { recursive: true });
          verdict = await judgeCase(deps.driver, { scratchDir, case: c, transcriptPath: drive.transcriptPath, redact: allSecrets });
        } catch (e) {
          log(`judge failed for case ${c.id} (verdict: unjudged): ${e instanceof Error ? e.message : String(e)}`);
        }

        cases.push({
          case: c,
          drive: { toolCalls: drive.toolCalls, toolFailures: drive.toolFailures, errored: drive.errored },
          verdict,
        });
      }
    } catch (e) {
      laneError = e;
    }

    const results: ProofResults = {
      runAt: now().toISOString(),
      pack: args.pack,
      cases,
      surface: surface ?? { pack: args.pack, skills: [], tools: [] },
      drift,
      // undefined only when installPackHeadless itself threw before verifyInstall ran - renders as
      // not-ok rather than inventing a passing check for a install that was never verified.
      install: check ?? { app: false, skills: [], policyFragment: false, ok: false },
    };
    writeFileSync(join(runDir, "proof-results.json"), JSON.stringify(results, null, 2) + "\n");
    const reportPath = join(runDir, "report.md");
    writeFileSync(reportPath, renderProofReport(results));

    // The analyst-facing HTML bundle, rendered deterministically from the same results plus each
    // case's ALREADY-REDACTED transcript (driveCase scrubbed secrets before writing it to disk), so
    // the bundle inherits report.md's secret hygiene. Written into the run dir like every other
    // artifact - present even on a late laneError, which rethrows just below.
    const transcriptsByCase: Record<string, (UiEvent & { at?: string })[]> = {};
    for (const c of results.cases) {
      try {
        transcriptsByCase[c.case.id] = JSON.parse(readFileSync(join(runDir, "cases", c.case.id, "transcripts", `${c.case.id}.json`), "utf8"));
      } catch {
        transcriptsByCase[c.case.id] = [];
      }
    }
    for (const [rel, content] of Object.entries(renderProofHtmlBundle(results, transcriptsByCase))) {
      const p = join(runDir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }

    if (laneError) {
      // Redact before rethrowing: a laneError can carry a secret verbatim (e.g. a lower-level
      // network error that happened to echo a request header) even though every OTHER thrown-error
      // path in this file (generator/judge) already redacts its own errors - this is the backstop
      // for whatever reaches here unredacted. Preserves the stack's content, just scrubbed.
      throw new Error(redactText(String((laneError as Error)?.stack ?? laneError), knownSecrets));
    }

    const sc = computeScorecard(results);
    const clean = check?.ok === false ? false : sc.fail === 0 && sc.crashed === 0 && sc.unjudged === 0;
    log(`\nreport: ${reportPath}`);
    log(`pack=${args.pack} install.ok=${check?.ok ?? true} cases=${cases.length} strong=${sc.strong} pass=${sc.pass} fail=${sc.fail} unjudged=${sc.unjudged} crashed=${sc.crashed}`);

    outcome = { exitCode: clean ? 0 : 1, runDir, reportPath };
  } finally {
    // Capture, don't rethrow: runAll never throws (SIGINT-safety is the whole point of
    // CleanupRegistry), so the failed labels are the only signal a teardown failure leaves behind.
    cleanupFailures = await deps.cleanup.runAll(log);

    // Logged HERE, inside finally, so it fires on BOTH the normal return path AND the
    // `if (laneError) throw` path above - finally always runs before an exception propagates out of
    // the try block, but code placed AFTER the try/finally (as this used to be) never runs on the
    // throw path. A real billable leak co-occurring with some other mid-run failure must still be
    // reported as loudly as one that happens on an otherwise-clean run.
    if (cleanupFailures.includes("sandbox-destroy")) {
      log(`LEAK: sandbox workspace ${mintedSandboxId ?? "<unknown id>"} for pack ${args.pack} was NOT destroyed - manual cleanup required on the provider side.`);
    }
  }

  // A failed sandbox-destroy is not "just a log line": it is a real, billable workspace left running
  // on the provider's side. Force the exit code to 1 even when every case scored clean, so a proof
  // run can never silently leak infrastructure. Case/discovery clean-room teardown failures stay
  // log-only (runAll already logged them above) - only the sandbox matters enough to flip the exit.
  // Only reached on the normal (non-throw) path - `outcome` is never read on the throw path, since
  // the exception already propagated out of the function by the time control would reach here.
  if (cleanupFailures.includes("sandbox-destroy")) {
    outcome.exitCode = 1;
  }

  return outcome;
}
