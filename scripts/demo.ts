// Boot the local BuildEx demo daemon and serve the operator console. Reads the config written by
// demo-setup, binds the daemon on loopback, and keeps running. Open the printed URL in your browser.
// The daemon drives your REAL `claude` CLI against the seeded workspace. Run: npm run demo
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { startDaemon } from "../apps/client/src/server-main.js";
import { resolveCorePackDir } from "../apps/client/src/provision/core-pack.js";
import { bundleCatalogSource } from "../apps/client/src/brain/catalog-source.js";

const DEMO = process.env["BUILDEX_DEMO_DIR"] || join(homedir(), ".buildex-demo");
const configPath = join(DEMO, "demo.json");

if (!existsSync(configPath)) {
  console.error(`No demo found at ${DEMO}. Run:  npm run demo:setup`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));

// A friendly heads-up if `claude` isn't on PATH - the demo needs the operator's own CLI.
try {
  const v = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  console.log(`Using your claude CLI: ${v}`);
} catch {
  console.warn("⚠  `claude` was not found on PATH. The UI will load, but chat needs the Claude Code CLI installed + logged in.");
}

// Use the agent's isolated config dir only once it's logged in (npm run demo:agent-login). Otherwise
// fall back to the operator's own config - the agent still works via the injected file map.
if (config.agentConfigDir && !existsSync(join(config.agentConfigDir, ".buildex-ready"))) {
  console.log("ℹ  Agent is using your default Claude config (its own hooks apply). For full shell tools, run once:  npm run demo:agent-login");
  delete config.agentConfigDir;
} else if (config.agentConfigDir) {
  console.log(`Agent config (isolated, clean tools): ${config.agentConfigDir}`);
}

const port = Number(process.env["BUILDEX_DEMO_PORT"] || 4317);
// Turn the approval-card gate ON in the demo: thread a real PreToolUse hook command so ask-tier
// tools raise an approval card instead of using Claude's native permissions. The daemon's regenConfig
// writes this into the workspace .claude/settings.json at boot. The hook is plain `node` (fast - it
// fires on every tool call) and takes the daemon's own loopback URL, which we know here because the
// demo pins the port. Quoted so a repo path with spaces still parses as one argument in the shell.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const gateHook = join(REPO, "apps", "client", "scripts", "gate-hook.mjs");
const gateCommand = `node "${gateHook}" http://127.0.0.1:${port}`;
// Gateway port is env-overridable (BUILDEX_DEMO_GATEWAY_PORT) so multiple worktrees can each host
// their own connector gateway without colliding; falls back to founder config, then 4318.
const cm = config.connectorsMcp ?? { providers: [] };
const gatewayPort = Number(process.env["BUILDEX_DEMO_GATEWAY_PORT"] ?? cm.gatewayPort ?? 4318);
// File-connector OAuth client credentials come from the ENV, never a committed file. Each
// provider needs a client id (+ secret for confidential clients) from its real OAuth app; absent →
// that connector stays in fixture mode. This keeps real credentials out of this public repo.
const connectorsOAuth: Record<string, { clientId: string; clientSecret?: string }> = {};
for (const p of ["gmail", "slack", "notion"] as const) {
  const clientId = process.env[`BUILDEX_${p.toUpperCase()}_CLIENT_ID`];
  if (!clientId) continue;
  const secret = process.env[`BUILDEX_${p.toUpperCase()}_CLIENT_SECRET`];
  connectorsOAuth[p] = { clientId, ...(secret ? { clientSecret: secret } : {}) };
}
// Demo-only: opt into the seeded connector fixtures so "Sync now" visibly files material without
// real provider credentials. Fixtures are OFF by default everywhere else - a real install never
// files fabricated material into a real brain. Set BUILDEX_DEMO_FIXTURES=0 to turn them off here.
process.env["BUILDEX_DEMO_FIXTURES"] ??= "1";
// Show real Claude usage in the bottom strip by default in the demo (opt-in bright-line exception -
// a display-only read of your Claude sign-in to call the usage endpoint; see usage.ts).
// App Store catalogue: read LIVE from the bundled core pack (packs/core/catalog in dev,
// <resources>/core-pack/catalog when packaged) on each store open - never from the seeded-once
// workspace copy, which went stale across app updates. resolveCorePackDir prefers the packaged bundle
// and falls back to the in-repo pack, so this is correct in both dev and a future packaged app.
// (REPO is defined above, next to the gate-hook command.)
const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
const catalogSource = bundleCatalogSource(
  join(resolveCorePackDir({ ...(resourcesPath ? { resourcesPath } : {}), repoRoot: REPO }), "catalog"),
);
const daemon = await startDaemon({
  ...config,
  gateCommand,
  catalogSource,
  // Seed one realistic PENDING approval card the moment the broker is built, so the flagship human
  // gate (invariant 5) is visible the instant the demo opens - not only if the operator happens to
  // trigger an outward action first. This raises a REAL card in-process through the same
  // ApprovalBroker the connector gateway uses for a gated send (not the policy path: outward connector
  // sends are gated at the gateway by intent, so /api/gate would rightly wave one straight through).
  // Fire-and-forget: the card resolves when the operator taps, or auto-denies at its 10-minute TTL.
  // Opt out with BUILDEX_NO_SEED_CARD=1 (e.g. a capture flow that wants an empty tray first).
  onBroker: (broker) => {
    if (process.env["BUILDEX_NO_SEED_CARD"] === "1") return;
    broker.request({
      name: "gmail.send",
      input: {
        connector: "gmail",
        tool: "send",
        args: {
          to: "dana@globex.com",
          subject: "Re: Finance team expansion - next steps",
          body:
            "Hi Dana - on SSO: it isn't in v1 yet, so the interim is a shared service account (fine for ~60 days). " +
            "I've attached the data-access checklist. Excited to get the finance team on. - You",
        },
        summary:
          "Send email to dana@globex.com - reply on SSO (interim: a shared service account) with the data-access checklist attached.",
      },
    }); // returns { card, decision }; we intentionally don't await the operator's verdict here
  },
  usageOAuth: config.usageOAuth ?? true,
  // Host the OAuth+MCP connector gateway. Providers come from demo config; empty by default
  // (real provider OAuth apps are founder config), so the console shows the gateway live with none
  // connected. The gateway MCP endpoint is hosted on gatewayPort for the agent's .mcp.json.
  // `localhost` (not 127.0.0.1) for the gateway's OAuth redirect: some providers (Calendly) reject the
  // IP literal. The daemon also listens on ::1 (server-main.ts) so the callback lands either way.
  connectorsMcp: { ...cm, gatewayPort, redirectBase: cm.redirectBase ?? `http://localhost:${port}` },
  // File-connector OAuth: only set when at least one provider's client id is in the env.
  ...(Object.keys(connectorsOAuth).length ? { connectorsOAuth, connectorsRedirectBase: `http://127.0.0.1:${port}` } : {}),
  // Persist secrets to the OS keychain so an authorization survives a restart. Override with
  // BUILDEX_KEYCHAIN=memory (ephemeral) or =system (require the OS keychain).
  keychainMode: (process.env["BUILDEX_KEYCHAIN"] as "auto" | "system" | "memory") || "auto",
  port,
});

console.log(`
🟢  BuildEx demo is running.

    ${daemon.url}

    Company:    ${config.company?.name} (demo)
    Workspace:  ${config.workspace}

    Open that URL in your browser. Try asking:
      • "Summarize Acme's Q3 metrics and our charter."
      • "What did we decide about our niche, and why?"
      • "Draft this week's review from the brain."

    The agent reads and edits the workspace files directly, on your machine.
    Press Ctrl+C to stop.
`);

// Actually open the console in the operator's default browser - the guides promise "opens your
// browser", and the URL alone makes that a lie. Non-fatal by construction: on any failure we've
// already printed the URL above. Skipped on non-darwin, in CI, and when BUILDEX_NO_OPEN=1 (so
// headless capture flows don't pop a window).
if (process.platform === "darwin" && !process.env["CI"] && process.env["BUILDEX_NO_OPEN"] !== "1") {
  try {
    const opener = spawn("open", [daemon.url], { stdio: "ignore", detached: true });
    opener.on("error", () => {}); // never crash the demo just because the browser couldn't be opened
    opener.unref();
  } catch {
    /* the URL is already printed - opening is a convenience, not a requirement */
  }
}

// Keep the process alive until interrupted.
process.on("SIGINT", async () => {
  await daemon.close();
  process.exit(0);
});
await new Promise(() => {});
