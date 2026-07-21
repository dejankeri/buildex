// Live smoke ("live dogfood as the e2e lane"). Drives the REAL `claude` CLI
// against a seeded workspace and exercises the core end-to-end: the map lights up from real stream
// events, a real tool invocation round-trips through the gate + an approval card, and a forced
// conflict preserves the operator's version in backup. Run: `npx tsx scripts/live-smoke.ts`.
// (Not part of `task ci` - it spends real Claude usage and is non-deterministic.)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { ClaudeCodeDriver } from "../src/agent/claude-driver.js";
import { nodeSpawnAgent } from "../src/agent/node-spawn.js";
import { buildGraph } from "../src/brain/graph.js";
import { Gate } from "../src/gate/gate.js";
import { PolicyEngine } from "../src/gate/policy.js";
import { ApprovalBroker } from "../src/gate/approval.js";
import { SyncEngine } from "../src/sync/engine.js";
import { startDaemon } from "../src/server-main.js";
import type { UiEvent } from "../src/agent/types.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "op", GIT_AUTHOR_EMAIL: "op@x", GIT_COMMITTER_NAME: "op", GIT_COMMITTER_EMAIL: "op@x" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });
let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗ FAIL:"} ${msg}`);
  if (!cond) failures++;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await delay(50);
  }
  return false;
}

const base = mkdtempSync(join(tmpdir(), "buildex-live-"));
try {
  // --- seed a workspace: a bare remote + a team clone with one doc ---
  const remote = join(base, "remote.git");
  git(["init", "--bare", "--initial-branch=main", remote], base);
  const team = join(base, "team");
  git(["clone", `file://${remote}`, team], base);
  writeFileSync(join(team, "notes.md"), "Our Q3 goal is to ship BuildEx to the first design partner.\n");
  git(["add", "."], team);
  git(["commit", "-m", "seed"], team);
  git(["push", "origin", "HEAD:main"], team);

  // ============================================================
  console.log("\n[1] REAL AGENT → the map lights up from real stream events");
  // ============================================================
  const driver = new ClaudeCodeDriver({ spawn: nodeSpawnAgent, bin: "claude" });
  const detect = await driver.detect();
  check(detect.available, `claude detected (${detect.version ?? "?"})`);

  const events: UiEvent[] = [];
  const prompt = "Read the file notes.md in the current directory and reply with a one-sentence summary of its contents. Do not create or modify any files.";
  console.log(`  → prompt: ${prompt}`);
  for await (const e of driver.runPrompt({ prompt, workspace: team })) {
    events.push(e);
    if (e.kind === "tool") console.log(`    · tool: ${e.name}${e.path ? ` (${e.path})` : ""}`);
    else if (e.kind === "text") console.log(`    · text: ${e.text.slice(0, 80).replace(/\n/g, " ")}${e.text.length > 80 ? "…" : ""}`);
    else if (e.kind === "error") console.log(`    · error: ${e.message}`);
  }

  const toolEvents = events.filter((e) => e.kind === "tool");
  const textEvents = events.filter((e) => e.kind === "text");
  check(textEvents.length > 0, "agent produced a text response");
  check(events.some((e) => e.kind === "done"), "turn ended with a done event");
  check(toolEvents.some((e) => e.kind === "tool" && /notes\.md/.test(e.path ?? "")), "a real tool event referenced notes.md (the map's touched node)");

  const graph = buildGraph([{ name: "team", dir: team }]);
  check(graph.nodes.some((n) => n.id === "team/notes.md"), `map rendered ${graph.nodes.length} node(s), incl. team/notes.md`);

  // ============================================================
  console.log("\n[2] a REAL tool invocation round-trips through the gate + an approval card");
  // ============================================================
  const realTool = toolEvents.find((e): e is Extract<UiEvent, { kind: "tool" }> => e.kind === "tool");
  const invocation = realTool
    ? { name: realTool.name, input: (realTool.input as Record<string, unknown>) ?? {} }
    : { name: "Read", input: { file_path: "notes.md" } };
  let n = 0;
  const broker = new ApprovalBroker({
    idFactory: () => `card${++n}`,
    now: () => 0,
    onCard: (c) => console.log(`    · approval card raised: ${c.tool.name} (id ${c.id}) → surfaced in Pending tray`),
  });
  // a preset that marks the agent's real tool as ask-tier, so it must round-trip through a human
  const gate = new Gate(new PolicyEngine({ allow: [], ask: [invocation.name], deny: [], default: "ask" }), broker);
  const verdictP = gate.evaluate(invocation);
  await delay(20);
  check(broker.pending().length === 1, `gate opened an approval card for the real ${invocation.name} invocation`);
  console.log("    · operator taps Approve…");
  broker.resolve(broker.pending()[0]!.id, "approve");
  check((await verdictP) === "allow", "approve → the gate resolved allow (round-trip complete)");

  // ============================================================
  console.log("\n[3] a forced conflict preserves the operator's version in backup");
  // ============================================================
  const op1 = join(base, "op1");
  const op2 = join(base, "op2");
  git(["clone", `file://${remote}`, op1], base);
  git(["clone", `file://${remote}`, op2], base);
  writeFileSync(join(op1, "notes.md"), "op1: rewrote the goal\n");
  const r1 = await new SyncEngine({ now: () => 1, actor: "op1" }).publish(op1);
  check(r1 === "ok", "op1's edit synced (ok)");
  const precious = "op2: my precious unsynced edit\n";
  writeFileSync(join(op2, "notes.md"), precious);
  const r2 = await new SyncEngine({ now: () => 1700000000000, actor: "op2" }).publish(op2);
  check(r2 === "needs-help", "op2 hit a conflict → needs-help (never a merge prompt)");
  const backup = join(op2, ".conflicts", "1700000000000", "notes.md");
  check(existsSync(backup) && readFileSync(backup, "utf8") === precious, "op2's version preserved byte-for-byte in .conflicts/<ts>/");
  check(existsSync(join(op2, ".sync-needs-help")), "a needs-attention marker was written");

  // ============================================================
  console.log("\n[4] the approval-card gate fires through the REAL daemon + the shipped PreToolUse hook");
  // ============================================================
  // No `claude` needed here: we drive the actual gate-hook.mjs (what Claude Code runs as a PreToolUse
  // hook) against a real daemon over loopback, exactly as the running app does. This proves the whole
  // B1 wiring - settings.json carries the hook, the hook POSTs /api/gate, an ask-tier tool raises a
  // Pending card, the hook BLOCKS until the operator taps, and approve resolves it to "allow".
  const hookPath = join(dirname(fileURLToPath(import.meta.url)), "gate-hook.mjs");
  const gateWs = join(base, "gate-ws");
  mkdirSync(gateWs, { recursive: true });
  const daemon = await startDaemon({
    workspace: gateWs,
    roots: [{ name: "team", dir: team }],
    preset: { allow: ["Read"], ask: ["SendEmail"], deny: [], default: "ask" },
    claudeBin: "claude",
    gateCommand: `node "${hookPath}" http://127.0.0.1:0`, // URL rewritten per-spawn below; only its shape is asserted
    port: 0,
  });
  try {
    // (a) the generated settings.json actually wires the hook (+ a timeout, so a stalled card denies
    //     cleanly before Claude's hook timeout - see GATE_HOOK_TIMEOUT_SECS).
    const settings = JSON.parse(readFileSync(join(gateWs, ".claude", "settings.json"), "utf8"));
    const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0];
    check(typeof hook?.command === "string" && hook.command.includes("gate-hook.mjs"), "settings.json wires the PreToolUse gate hook");
    check(typeof hook?.timeout === "number" && hook.timeout > 0, `the gate hook carries a timeout (${hook?.timeout}s)`);

    // (b) run the REAL hook against the REAL daemon, feeding it an ask-tier tool payload on stdin.
    const child = spawn("node", [hookPath, daemon.url], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const exited = new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
    child.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "SendEmail", tool_input: { to: "board@acme.co", subject: "July update" } }));
    child.stdin.end();

    // (c) the ask-tier tool surfaces as exactly one Pending card, and the hook stays blocked meanwhile.
    const carded = await pollUntil(async () => ((await (await fetch(`${daemon.url}/api/pending`)).json()) as { cards: unknown[] }).cards.length === 1, 5000);
    const pending = (await (await fetch(`${daemon.url}/api/pending`)).json()) as { cards: { id: string; tool: { name: string } }[] };
    check(carded && pending.cards.length === 1, "the ask-tier SendEmail raised ONE approval card via the daemon gate");
    check(pending.cards[0]?.tool.name === "SendEmail", "the card names the real tool the hook forwarded");
    check(out === "", "the hook is still blocked - no decision emitted until the operator taps");

    // (d) operator approves from the tray → the hook unblocks and emits an ALLOW decision.
    console.log("    · operator taps Approve in the Pending tray…");
    await fetch(`${daemon.url}/api/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: pending.cards[0]!.id, verdict: "approve" }) });
    const code = await exited;
    check(code === 0, "the hook exited 0 (its JSON decision governs, never a nonzero fail-open)");
    let decision = "";
    try {
      decision = JSON.parse(out).hookSpecificOutput.permissionDecision;
    } catch {
      /* leaves decision "" → the check below fails with a clear message */
    }
    check(decision === "allow", "approve → the hook emitted permissionDecision 'allow' (full round-trip through the real app)");
  } finally {
    await daemon.close();
  }

  console.log(`\n${failures === 0 ? "✅ LIVE SMOKE PASSED" : `❌ LIVE SMOKE FAILED (${failures} check(s))`}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
