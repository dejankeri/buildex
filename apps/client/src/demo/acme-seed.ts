// The Acme Labs demo brain, as a reusable LIBRARY. This is the single source of truth for the
// rich sandbox company every demo shows - a lived-in B2B analytics startup (~9 months in): strategy,
// clients, finance, GTM, hiring, connector sources, a decision log, seeded sessions/projects. It is
// consumed two ways:
//   - dev: scripts/demo-setup.ts writes this content into repos with file:// remotes (so the local
//     sync demo works), then clones a workspace.
//   - packaged (org sandbox): seedAcmeWorkspace() lays the same content down as no-remote git repos,
//     so the "Acme Labs" org is permanently local-only (the sync engine reports "local"; nothing ever
//     leaves the machine). This is what the packaged app's first-run demo uses - no shell-out, no repo.
//
// All content is plain markdown; git is the database. Session/automation timestamps are stamped
// relative to the real clock at seed time, so the demo never looks stale.
import { mkdirSync, writeFileSync, existsSync, cpSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import type { Root } from "../brain/graph.js";
import type { PolicyPreset } from "../gate/policy.js";
import { initAndCommit } from "../provision/core-pack.js";
import { generateAgentConfig } from "../brain/agent-config.js";
import { serializeLoopsYaml, type LoopDef } from "../brain/loops.js";

/** Write one file, creating parent dirs. */
function file(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// Install a catalog app into the seeded roots exactly as a real install would (brain/catalog.ts
// installPack), so the demo boots with a populated App Store, Skills panel, and per-app policy - all
// detected via the same on-disk markers `installedRoot` reads. The faces SPLIT the way a real install
// splits them: the app manifest and the install marker are the operator's (private), while the skills
// and the policy are company rules (team). No `.mcp.json` is seeded: boot re-pins every installed
// pack's MCP into the workspace `.mcp.json` (brain/pack-config.ts) on the first config regen.
function installApp(appRootDir: string, rulesRootDir: string, corePackDir: string, id: string): void {
  const pack = JSON.parse(readFileSync(join(corePackDir, "catalog", id, "pack.json"), "utf8")) as {
    name?: string;
    app?: { url: string; icon?: string };
    skills?: string[];
    policy?: Record<string, unknown>;
  };
  if (pack.app) {
    // `name` is the display title - without it the rail falls back to the folder id ("stripe").
    file(appRootDir, join("apps", id, "app.json"), JSON.stringify({ kind: "external", name: pack.name ?? id, url: pack.app.url, ...(pack.app.icon ? { icon: pack.app.icon } : {}) }, null, 2) + "\n");
  }
  file(appRootDir, join("policy", "packs", `${id}.json`), JSON.stringify({}, null, 2) + "\n"); // per-operator install marker
  file(rulesRootDir, join("policy", "packs", `${id}.json`), JSON.stringify(pack.policy ?? {}, null, 2) + "\n"); // the company rule
  for (const s of pack.skills ?? []) {
    const src = join(corePackDir, "catalog", id, "skills", s);
    if (existsSync(src)) cpSync(src, join(rulesRootDir, "skills", s), { recursive: true });
  }
}

/** The catalog apps the demo operator has installed (see installApp for how the faces split). */
export const DEMO_INSTALLED_PACKS = ["slack", "notion", "linear", "stripe", "hubspot", "intercom"];

/**
 * Install the demo's stack across a root PAIR. Exported because an install now spans two repos, which
 * no per-repo writer can express - both consumers (the packaged sandbox in seedAcmeWorkspace and the
 * dev script scripts/demo-setup.ts, which seeds each repo in its own clone) must call this explicitly
 * once both roots exist. Keeping it here keeps "what the demo has installed" a single definition.
 * @param appRootDir - the operator's private root (app manifests + install markers).
 * @param rulesRootDir - the team root (skills + policy: the company rules).
 * @param corePackDir - the bundled core pack holding `catalog/<id>/`.
 */
export function installDemoPacks(appRootDir: string, rulesRootDir: string, corePackDir: string): void {
  for (const id of DEMO_INSTALLED_PACKS) installApp(appRootDir, rulesRootDir, corePackDir, id);
}

/** core: the product pack (rules, verbs, conventions) laid down from the bundled pack. */
export function writeCoreContent(dir: string, opts: { corePackDir: string }): void {
  cpSync(opts.corePackDir, dir, { recursive: true });
  file(dir, "CLAUDE.md", readFileSync(join(opts.corePackDir, "rules", "operating.md"), "utf8"));
}

/** private-you: the operator's personal scratch space (never shared with the team repo). */
export function writePrivateContent(dir: string): void {
  file(dir, "notes.md", [
    "# My notes",
    "",
    "Private to me - the team repo can't see this.",
    "",
    "- Ask the agent: *\"draft this week's investor update from the brain.\"*",
    "- Ask the agent: *\"which client looks like a churn risk and why?\"*",
    "- Umbrella security review is the unlock for the biggest deal - do it first.",
    "",
  ].join("\n"));
  file(dir, "1-1s/maya.md", [
    "# 1:1 - Maya",
    "",
    "## 2026-07-15",
    "- Wants to own the connector pipeline end-to-end - good, aligns with the backend hire.",
    "- Feeling stretched on-call. The hire helps. Reassured her it's the next hire.",
    "",
  ].join("\n"));
  file(dir, "reflections/2026-07.md", [
    "# July reflections",
    "",
    "The wedge is working - narrowing to RevOps leads (D6) made every call easier. The risk isn't",
    "demand, it's onboarding time. If self-serve setup lands, Q4 is a different company.",
    "",
  ].join("\n"));
}

/** team-acme: a lived-in company brain (Acme Labs, a B2B ops-analytics startup ~9 months in). Deep
 *  enough that a fresh operator - or a screenshot - shows a real company running on BuildEx. */
export function writeAcmeContent(dir: string, opts: { corePackDir: string }): void {
  file(dir, "CLAUDE.md", [
    "# Acme Labs - team operating rules",
    "",
    "We're a 6-person B2B analytics company. We help mid-market operations teams see their",
    "operational data clearly, without a data team of their own.",
    "",
    "- **Ship weekly.** Small, reversible changes every Friday.",
    "- **Decisions live in `decisions/log.md`** - newest first, dated, one paragraph each.",
    "- **Clients are the priority.** When in doubt, unblock a design partner.",
    "- **Write it down.** If it mattered, it's a file. The brain is the source of truth.",
    "- Money: never send an invoice or a contract without a human approving it first.",
    "",
    "Maps: see `maps/overview.md`. Metrics: `finance/metrics-q3.md`. Strategy: `strategy/charter.md`.",
    "",
  ].join("\n"));

  // --- strategy/ ---
  file(dir, "strategy/charter.md", [
    "# Acme Labs - charter",
    "",
    "We help mid-market operations teams see their operational data clearly. No warehouse project,",
    "no BI hire - connect your tools, get the dashboards and alerts that matter in an afternoon.",
    "",
    "## 2026 goal",
    "Land 5 paying design partners and reach **$40k MRR** by end of Q3. Prove the ops-analytics",
    "wedge before we widen the ICP.",
    "",
    "## Who we're for",
    "Ops and RevOps leads at 50-500 person B2B companies who live in spreadsheets and Slack and",
    "have no analytics engineer.",
    "",
    "See [positioning](positioning.md), the Q3 targets in [the OKRs](okrs-2026-q3.md), and the [decision log](../decisions/log.md).",
    "",
  ].join("\n"));
  file(dir, "strategy/positioning.md", [
    "# Positioning",
    "",
    "**For** ops leads at mid-market B2B companies **who** have no data team,",
    "**Acme** is an operational-analytics service **that** turns the tools you already use into",
    "the dashboards and alerts you'd otherwise wait a quarter for.",
    "",
    "**Unlike** a BI platform (Looker/Tableau) that assumes a data engineer, we do the modeling for",
    "you and stay in your existing workflow (Slack, email, sheets).",
    "",
    "One-liner: *\"Your ops data, finally legible - without hiring a data team.\"*",
    "",
  ].join("\n"));
  file(dir, "strategy/okrs-2026-q3.md", [
    "# OKRs - 2026 Q3",
    "",
    "## O1 - Prove the wedge with paying design partners",
    "- KR1: 5 paying design partners (now: 4) - **on track**",
    "- KR2: $40k MRR (now: $34.2k) - **on track**",
    "- KR3: < 5% logo churn this quarter - **green** (0 churned)",
    "",
    "## O2 - Make onboarding self-serve enough to scale",
    "- KR1: time-to-first-dashboard < 1 day (now: ~2 days) - **at risk**",
    "- KR2: 80% of new connectors set up without a call (now: 55%) - **at risk**",
    "",
    "## O3 - Keep the team lean and shipping",
    "- KR1: weekly release cadence held every week - **green**",
    "- KR2: hire one backend engineer - **in progress** (see people/hiring)",
    "",
  ].join("\n"));

  // --- product/ ---
  file(dir, "product/roadmap.md", [
    "# Product roadmap",
    "",
    "## Now (Q3)",
    "- **Dashboards v2** - saved views + shareable links (see the [spec](specs/dashboards-v2.md))",
    "- **Slack alerts** - threshold + anomaly alerts into a channel",
    "- **Self-serve connector setup** - cut the onboarding call (ties to O2)",
    "",
    "## Next",
    "- Scheduled email digests",
    "- Role-based sharing",
    "",
    "## Later",
    "- Warehouse sync (Snowflake/BigQuery) for larger accounts",
    "",
  ].join("\n"));
  file(dir, "product/changelog.md", [
    "# Changelog",
    "",
    "## 2026-07-17",
    "- Faster metric refresh (p95 down from 9s to 3s)",
    "- Fix: timezone drift on weekly rollups",
    "",
    "## 2026-07-10",
    "- Slack alerts (beta) for Globex and Initech",
    "- New \"pipeline health\" template",
    "",
    "## 2026-07-03",
    "- CSV export on every dashboard",
    "",
  ].join("\n"));
  file(dir, "product/specs/dashboards-v2.md", [
    "# Spec - Dashboards v2",
    "",
    "**Problem:** operators rebuild the same views weekly and can't share a link with their team.",
    "",
    "**Solution:** saved views (named, per-workspace) + a read-only shareable link.",
    "",
    "## Scope",
    "- Save the current filter/date-range/layout as a named view",
    "- A shareable read-only URL (no login) with an expiry",
    "- \"Duplicate view\" to fork a starting point",
    "",
    "## Out of scope (v2)",
    "- Editing shared views by link recipients",
    "- Embedding",
    "",
    "Decision to ship read-only-first: see the [decision log](../../decisions/log.md), entry D9.",
    "",
  ].join("\n"));

  // --- clients/ ---
  file(dir, "clients/globex/profile.md", [
    "# Globex - client profile",
    "",
    "- **Stage:** paying design partner (converted from pilot 2026-07-01)",
    "- **Plan:** $2,400/mo annual",
    "- **Champion:** Dana Whitfield (VP Ops)",
    "- **Users:** 11 seats",
    "- **Constraint:** data cannot leave their VPC - self-hosted connector only",
    "- **Health:** 🟢 green - weekly active, expanding to finance team next quarter",
    "",
    "History and threads in `notes.md` and `sources/`.",
    "",
  ].join("\n"));
  file(dir, "clients/globex/notes.md", [
    "# Globex - notes",
    "",
    "## 2026-07-14 - kickoff of the finance-team expansion",
    "Dana wants the finance team on before Q4. Blocker: they need SSO (not in v1). Parked - offered",
    "a shared service account for now, she's OK with it for 60 days.",
    "",
    "## 2026-07-01 - converted to annual",
    "Pilot went well; signed a 12-month at $2,400/mo. Invoice sent (see finance/invoices).",
    "",
    "## 2026-06-10 - pilot kickoff",
    "Connected Salesforce + their ops Postgres (read replica). First dashboard live in 3 days.",
    "",
  ].join("\n"));
  file(dir, "clients/initech/profile.md", [
    "# Initech - client profile",
    "",
    "- **Stage:** paying design partner",
    "- **Plan:** $1,800/mo monthly",
    "- **Champion:** Peter G. (Head of RevOps)",
    "- **Users:** 6 seats",
    "- **Health:** 🟡 amber - low weekly usage, check in this week",
    "- **Next:** Slack-alerts onboarding call booked for 2026-07-22",
    "",
  ].join("\n"));
  file(dir, "clients/umbrella/profile.md", [
    "# Umbrella Corp - pipeline",
    "",
    "- **Stage:** pilot proposal out",
    "- **Potential:** ~$3k/mo (largest to date)",
    "- **Champion:** Alexia B. (COO)",
    "- **Constraint:** wants a security review before pilot - see gtm/pipeline",
    "- **Next:** send the pilot proposal + one-pager (session in progress)",
    "",
  ].join("\n"));
  file(dir, "clients/hooli/profile.md", [
    "# Hooli - pipeline (early)",
    "",
    "- **Stage:** discovery call done, evaluating",
    "- **Potential:** $1.5k/mo",
    "- **Notes:** price-sensitive, comparing against a spreadsheet consultant. Low priority.",
    "",
  ].join("\n"));

  // --- gtm/ ---
  file(dir, "gtm/pipeline.md", [
    "# Sales pipeline",
    "",
    "| Account | Stage | MRR | Next step | Owner |",
    "|---|---|---|---|---|",
    "| Globex | 🟢 Closed (annual) | $2,400 | Expansion: finance team | You |",
    "| Initech | 🟢 Closed | $1,800 | Drive usage | You |",
    "| Vandelay | 🟢 Closed | $1,200 | Renewal in Sep | You |",
    "| Wonka | 🟢 Closed | $900 | Healthy | You |",
    "| Umbrella | 🟠 Proposal out | ~$3,000 | Security review + proposal | You |",
    "| Hooli | 🔵 Evaluating | ~$1,500 | Follow up next week | You |",
    "",
    "Committed MRR: **$6,300** closed + **$4,500** weighted pipeline.",
    "",
  ].join("\n"));
  file(dir, "gtm/messaging.md", [
    "# Messaging house",
    "",
    "- **Headline:** Your ops data, finally legible.",
    "- **Subhead:** Connect your tools, get the dashboards and alerts that matter - no data team.",
    "- **Proof points:** live in a day · works in Slack · your data stays in your VPC.",
    "- **Objection - \"we have Looker\":** Looker needs an engineer; we do the modeling for you.",
    "",
  ].join("\n"));
  file(dir, "gtm/launch-plan.md", [
    "# Dashboards v2 - launch plan",
    "",
    "- **Ship date:** 2026-08-01",
    "- Announce to design partners first (email + Slack), then a short public post.",
    "- Record a 90-second Loom of save-view → share-link.",
    "- Update the site's proof page with a real shared-view link.",
    "",
  ].join("\n"));

  // --- finance/ ---
  file(dir, "finance/metrics-q3.md", [
    "# Metrics - Q3 2026",
    "",
    "*As of 2026-07-18.*",
    "",
    "- **MRR:** $34,200 (up 16% MoM)",
    "- **Paying design partners:** 4 (target 5)",
    "- **Net revenue retention:** 112%",
    "- **Logo churn (qtr):** 0",
    "- **Cash:** $612k · **Burn:** ~$41k/mo · **Runway:** ~15 months",
    "- **Weekly active operators:** 38",
    "",
    "See [the model](model.md) and the [runway detail](runway.md).",
    "",
  ].join("\n"));
  file(dir, "finance/model.md", [
    "# Simple model",
    "",
    "- Avg contract: ~$1,650/mo, annual bias",
    "- CAC (founder-led): ~$900/logo, mostly time",
    "- Gross margin: ~86% (hosting + model API)",
    "- Plan: reach $40k MRR at current burn → default-alive by ~Q1 next year",
    "",
  ].join("\n"));
  file(dir, "finance/runway.md", [
    "# Runway",
    "",
    "Cash $612k / burn ~$41k = **~15 months**. The backend hire adds ~$11k/mo → ~12 months.",
    "Decision to hire anyway: growth is the bigger risk than runway right now (see the [decision log](../decisions/log.md), entry D11).",
    "",
  ].join("\n"));
  file(dir, "finance/invoices/2026-07-globex.md", [
    "---",
    "client: Globex",
    "amount: 28800",
    "currency: USD",
    "period: 2026-07-01 annual",
    "status: paid",
    "---",
    "",
    "# Invoice - Globex (annual)",
    "",
    "12 months @ $2,400/mo, paid up front on conversion. Paid 2026-07-03 via Stripe.",
    "",
  ].join("\n"));

  // --- people/ ---
  file(dir, "people/team.md", [
    "# The team",
    "",
    "- **You** - founder / operator (runs the company on BuildEx)",
    "- **Maya** - founding engineer (product + infra)",
    "- **Jon** - design + front-end",
    "- **Priya** - customer success (part-time)",
    "- **Sam & Lee** - contractors (data modeling)",
    "",
  ].join("\n"));
  file(dir, "people/hiring/backend-engineer.md", [
    "# Hiring - Backend Engineer",
    "",
    "**Status:** open · first hire beyond the founding two.",
    "",
    "## What they'll do",
    "Own the connector + sync pipeline: reliable ingestion from customer tools, the modeling layer,",
    "and the alert engine. TypeScript/Node, Postgres, a bias for reliability over cleverness.",
    "",
    "## Must-haves",
    "- Built and run data pipelines in production",
    "- Comfortable owning reliability (on-call for your own code)",
    "- Startup-early temperament",
    "",
    "Draft of the public post: a session is open for this (see the left rail).",
    "",
  ].join("\n"));

  // --- meetings/ ---
  file(dir, "meetings/2026-07-13-weekly.md", [
    "# Weekly - 2026-07-13",
    "",
    "**Wins:** Globex finance-team expansion in motion; MRR crossed $34k.",
    "**Risks:** Initech usage soft; Umbrella wants a security review.",
    "**Decisions:** ship Dashboards v2 read-only first (D9).",
    "**Next week:** send Umbrella proposal, backend-eng post live, Initech usage call.",
    "",
  ].join("\n"));
  file(dir, "meetings/2026-07-06-weekly.md", [
    "# Weekly - 2026-07-06",
    "",
    "**Wins:** Slack alerts beta live for two accounts.",
    "**Risks:** onboarding still needs a call - hurts O2.",
    "**Next week:** self-serve connector setup spike.",
    "",
  ].join("\n"));

  // --- decisions/log.md (lived-in, newest first) ---
  file(dir, "decisions/log.md", [
    "# Decisions",
    "",
    "Newest first. One paragraph each. This is the company's memory.",
    "",
    "## D12 - Add a security-review one-pager to the sales kit (2026-07-15)",
    "Umbrella (and likely every account above ~$3k) will ask. Cheaper to have a standing answer than",
    "to scramble each time. Owner: you.",
    "",
    "## D11 - Hire a backend engineer now despite runway (2026-07-13)",
    "Reliability of the connector pipeline is the top churn risk. The hire cuts runway to ~12 months;",
    "we accept that - growth risk > cash risk at this stage.",
    "",
    "## D10 - Annual-bias pricing (2026-07-08)",
    "Offer 2 months free for annual. Globex took it; improves cash and retention.",
    "",
    "## D9 - Ship Dashboards v2 read-only first (2026-07-06)",
    "Shareable read-only links cover 90% of the ask and ship in weeks; editable-by-link is a v3",
    "problem. Avoids a permissions rabbit hole now.",
    "",
    "## D8 - Slack is the alert surface, not email (2026-06-28)",
    "Our users live in Slack. Email digests come later; alerts go to a channel first.",
    "",
    "## D7 - Self-host the connector for VPC-locked accounts (2026-06-18)",
    "Globex can't let data leave their VPC. A thin self-hosted connector unlocks that segment.",
    "",
    "## D6 - RevOps lead is the buyer, not the CFO (2026-06-05)",
    "Sharper ICP: the person who feels the pain signs. Rewrote positioning around them.",
    "",
    "## D5 - Founder-led sales only until $40k MRR (2026-05-30)",
    "No sales hire yet; the founder runs every deal to keep learning the market.",
    "",
    "## D4 - Price at $1.5-2.5k/mo (2026-05-22)",
    "Mid-market can pay it; it filters out tire-kickers and funds white-glove onboarding.",
    "",
    "## D3 - Charge from day one (2026-05-15)",
    "No free tier. Paid pilots only - it qualifies interest and funds the work.",
    "",
    "## D2 - Focus on the ops-analytics niche (2026-05-08)",
    "Narrowed from \"analytics for everyone\" to mid-market operations teams. Sharper story, easier sales.",
    "",
    "## D1 - Weekly release cadence (2026-05-01)",
    "Ship every Friday; it forces small, reversible changes and keeps momentum visible.",
    "",
  ].join("\n"));

  // --- sources/ (connector material - what a synced connector deposits into the brain) ---
  file(dir, "sources/gmail/globex-kickoff.md", [
    "---",
    "source: gmail",
    "id: thread-globex-kickoff",
    "from: dana@globex.com",
    "at: 2026-07-14T09:12:00Z",
    "link: https://mail.google.com/thread-globex-kickoff",
    "---",
    "",
    "# Finance team expansion - next steps",
    "",
    "Hi - excited to get the finance team on. Before we do, do you support SSO yet? If not, what's",
    "the interim? Also can you send the data-access checklist? - Dana",
    "",
  ].join("\n"));
  file(dir, "sources/gmail/umbrella-intro.md", [
    "---",
    "source: gmail",
    "id: thread-umbrella-intro",
    "from: alexia@umbrella.example",
    "at: 2026-07-16T15:40:00Z",
    "link: https://mail.google.com/thread-umbrella-intro",
    "---",
    "",
    "# Re: pilot",
    "",
    "Thanks for the demo. The team's keen. Our security lead will need a short review doc before we",
    "can start a pilot - can you share one? Then let's line up the proposal. - Alexia",
    "",
  ].join("\n"));
  file(dir, "sources/slack/ops-alerts.md", [
    "---",
    "source: slack",
    "channel: \"#ops-alerts\"",
    "at: 2026-07-17T13:02:00Z",
    "---",
    "",
    "# #ops-alerts",
    "",
    "**Acme bot** 🔔 Globex - weekly active seats down 20% WoW. Threshold alert.",
    "**Dana** on it, one team was OOO. Thanks for the heads up.",
    "",
  ].join("\n"));
  file(dir, "sources/slack/team-standup.md", [
    "---",
    "source: slack",
    "channel: \"#team\"",
    "at: 2026-07-18T09:05:00Z",
    "---",
    "",
    "# #team",
    "",
    "**Maya** Dashboards v2 save-view is behind the flag on staging. Share-link next.",
    "**Jon** New empty-states are in. Will grab screenshots for the launch post.",
    "",
  ].join("\n"));
  file(dir, "sources/notion/onboarding-runbook.md", [
    "---",
    "source: notion",
    "page: Onboarding runbook",
    "at: 2026-07-11T00:00:00Z",
    "link: https://notion.so/onboarding-runbook",
    "---",
    "",
    "# Onboarding runbook (synced from Notion)",
    "",
    "1. Connect the customer's primary source (Salesforce/HubSpot/Postgres).",
    "2. Ship the \"pipeline health\" starter dashboard.",
    "3. Turn on one Slack alert they'll feel.",
    "4. Book the week-1 check-in.",
    "",
    "Goal: first dashboard live in < 1 day (O2, KR1).",
    "",
  ].join("\n"));

  // --- maps/ ---
  file(dir, "maps/overview.md", [
    "# Acme Labs - map",
    "",
    "- **strategy/** - charter, positioning, Q3 OKRs",
    "- **product/** - roadmap, specs, changelog",
    "- **clients/** - Globex, Initech (paying) · Umbrella, Hooli (pipeline)",
    "- **gtm/** - pipeline, messaging, launch plan",
    "- **finance/** - Q3 metrics, model, runway, invoices",
    "- **people/** - team, hiring",
    "- **meetings/** - weekly notes",
    "- **decisions/** - the log (the company's memory)",
    "- **sources/** - connector material (gmail, slack, notion)",
    "",
  ].join("\n"));

}

// --- Workspace extras: daemon-owned files that make the left rail feel lived-in (sessions,
//     projects, loop run-state) plus the generated agent config and the committed loops.yaml.
//     Timestamps stamped relative to the real clock so nothing looks stale. ---

type SeedEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; path?: string }
  | { kind: "tool_result"; id: string; name: string; ok: boolean; output?: string }
  | { kind: "done" };
interface SeedSession {
  folder: string;
  title: string;
  status: "idle" | "running" | "needs-attention" | "error";
  at: string;
  preview: string;
  events?: SeedEvent[];
}

const seedSessions: SeedSession[] = [
  {
    folder: "Fundraising",
    title: "Draft the Q3 investor update",
    status: "idle",
    at: "2026-07-19T08:12:00Z",
    preview: "Draft ready at investors/2026-q3-update.md — $34.2k MRR up 16% MoM, Globex on annual, 15mo runway.",
    events: [
      { kind: "text", text: "Draft the Q3 investor update from the brain." },
      { kind: "text", text: "I'll pull the latest metrics, the Globex conversion, and the two open risks." },
      { kind: "thinking", text: "Metrics are in finance/metrics-q3.md; Globex status in clients/globex/. Read those, then write investors/2026-q3-update.md." },
      { kind: "tool", id: "r1", name: "Read", input: { path: "team-acme/finance/metrics-q3.md" }, path: "team-acme/finance/metrics-q3.md" },
      { kind: "tool_result", id: "r1", name: "Read", ok: true, output: "MRR $34,200 (+16% MoM) · 4 design partners · NRR 112% · runway ~15 months" },
      { kind: "tool", id: "w1", name: "Write", input: { path: "private-you/investors/2026-q3-update.md" }, path: "private-you/investors/2026-q3-update.md" },
      { kind: "tool_result", id: "w1", name: "Write", ok: true, output: "wrote investors/2026-q3-update.md (1.4 KB)" },
      { kind: "text", text: "Draft ready at **investors/2026-q3-update.md**. Here's the headline, straight from the brain:\n\n| Metric | Q3 so far | Q3 target |\n|---|---|---|\n| MRR | $34,200 | $40,000 |\n| Paying design partners | 4 | 5 |\n| Net revenue retention | 112% | — |\n| Runway | ~15 months | — |\n\nGlobex converted to annual. Two risks flagged in the draft: Initech usage is soft, and the backend hire trims runway by ~2 months. Want me to tighten the ask paragraph?" },
      { kind: "done" },
    ],
  },
  {
    folder: "Operations",
    title: "Friday weekly review",
    status: "idle",
    at: "2026-07-17T17:02:00Z",
    preview: "Posted the weekly to meetings/2026-07-17-weekly.md — wins, risks, and next week's three moves.",
    events: [
      { kind: "text", text: "Draft this week's Friday review from the brain." },
      { kind: "text", text: "Pulling this week's wins and risks from the brain." },
      { kind: "tool", id: "g1", name: "Grep", input: { pattern: "2026-07-1", path: "team-acme" } },
      { kind: "tool_result", id: "g1", name: "Grep", ok: true, output: "12 matches across decisions, meetings, sources/slack" },
      { kind: "tool", id: "w2", name: "Write", input: { path: "team-acme/meetings/2026-07-17-weekly.md" }, path: "team-acme/meetings/2026-07-17-weekly.md" },
      { kind: "tool_result", id: "w2", name: "Write", ok: true, output: "wrote meetings/2026-07-17-weekly.md" },
      { kind: "text", text: "Weekly is up. Wins: MRR $34k, Globex expansion. Risks: Initech usage soft. Next week: Umbrella proposal, backend-eng post, Initech usage call." },
      { kind: "done" },
    ],
  },
  {
    folder: "Finance",
    title: "Reconcile Globex invoices for July",
    status: "needs-attention",
    at: "2026-07-18T14:20:00Z",
    preview: "Ready to record the paid Globex annual invoice — waiting for your approval to write to finance/.",
    events: [
      { kind: "text", text: "Record the paid Globex annual invoice under finance/invoices/." },
      { kind: "text", text: "Globex paid the annual invoice via Stripe on 2026-07-03. I'd like to record it under finance/invoices/. This writes to the brain — approve when ready." },
      { kind: "tool", id: "w3", name: "Write", input: { path: "team-acme/finance/invoices/2026-07-globex.md" }, path: "team-acme/finance/invoices/2026-07-globex.md" },
    ],
  },
  {
    folder: "Product",
    title: "Update the roadmap from Linear issues",
    status: "running",
    at: "2026-07-19T09:40:00Z",
    preview: "Reading open Linear issues to reconcile product/roadmap.md with what's actually in flight…",
    events: [
      { kind: "text", text: "Update the roadmap from the open Linear issues." },
      { kind: "text", text: "Checking open Linear issues to reconcile the roadmap with what's actually shipping." },
      { kind: "tool", id: "l1", name: "linear-search", input: { query: "state:started" } },
    ],
  },
  {
    folder: "Clients",
    title: "Summarize this week's design-partner calls",
    status: "idle",
    at: "2026-07-16T11:05:00Z",
    preview: "3 calls summarized into clients/ notes — Globex expanding, Initech needs a usage nudge, Umbrella wants security.",
  },
  {
    folder: "Sales",
    title: "Prep the Umbrella pilot proposal",
    status: "idle",
    at: "2026-07-18T16:30:00Z",
    preview: "Outlined the pilot proposal + a security-review one-pager (the unlock, per D12).",
  },
  {
    folder: "Hiring",
    title: "Draft the backend engineer job post",
    status: "idle",
    at: "2026-07-15T13:15:00Z",
    preview: "Public job post drafted from people/hiring/backend-engineer.md — reliability-first framing.",
  },
  {
    folder: "Clients",
    title: "Reply to Dana's kickoff email",
    status: "needs-attention",
    at: "2026-07-14T10:02:00Z",
    preview: "Drafted a reply on SSO (interim service account) + attached the data-access checklist — waiting for your approval to send.",
    events: [
      { kind: "text", text: "Reply to Dana's kickoff email — she asked about SSO and how data access works." },
      { kind: "text", text: "Let me pull the thread and the security notes, then draft a reply in your voice." },
      { kind: "tool", id: "s1", name: "gmail-search", input: { query: "from:dana@globex.com finance team expansion" } },
      { kind: "tool_result", id: "s1", name: "gmail-search", ok: true, output: "1 thread — \"Finance team expansion - next steps\" (2 messages)" },
      { kind: "tool", id: "r1", name: "Read", input: { path: "team-acme/clients/globex/profile.md" }, path: "team-acme/clients/globex/profile.md" },
      { kind: "tool_result", id: "r1", name: "Read", ok: true, output: "SSO not in v1 · interim: shared service account (≤60 days) · data-access checklist in sources/" },
      { kind: "text", text: "Drafted the reply: SSO isn't in v1 yet, so the interim is a shared service account (fine for ~60 days), with the data-access checklist attached. **Sending an email is an outward action — the draft is waiting for your approval in the Pending tray. Nothing goes out until you tap Approve.**" },
    ],
  },
];

export function writeWorkspaceExtras(workspace: string, opts: { roots: Root[]; preset: PolicyPreset }): void {
  // Agent config: native allow/ask/deny permissions here (reads and edits flow; outward waits). The
  // `npm run demo` boot (scripts/demo.ts) additionally threads the real PreToolUse gate hook
  // (apps/client/scripts/gate-hook.mjs) so ask-tier tools raise an approval card - the daemon
  // regenerates .claude/settings.json with that hook at startup. Enforcement is never faked.
  generateAgentConfig({ workspace, roots: opts.roots, preset: opts.preset });

  // Loops: seed a few so the panel shows a real, populated example - one at a time of day, one on an
  // interval, one paused. Run-state is stamped relative to the REAL clock and always LESS than a full
  // window ago, so the enabled loops read as healthy but are NOT due: a demo boot must never
  // auto-spawn the agent (which would spend the operator's Claude usage unprompted). "Run now" is how
  // the operator sees one work. Definitions go in the committed team root (invariant 2); the stamps
  // stay in the workspace, uncommitted.
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const nowMs = Date.now();
  const loopsRoot = opts.roots.find((r) => r.name !== "core") ?? opts.roots[0];
  const loopDefs: LoopDef[] = [
    {
      name: "friday-review",
      title: "Friday review",
      prompt: "Read this week's activity log and draft the weekly review for the team.",
      schedule: { kind: "at", hour: 16, minute: 0, days: ["fri"] },
      enabled: true,
    },
    {
      name: "pipeline-digest",
      title: "Pipeline digest",
      verb: "pipeline-digest",
      schedule: { kind: "every", ms: 12 * HOUR, raw: "12h" },
      enabled: true,
    },
    {
      name: "inbox-triage",
      title: "Inbox triage",
      prompt: "Go through the inbox, draft replies to anything routine, and list what needs me.",
      schedule: { kind: "at", hour: 9, minute: 0, days: [] },
      enabled: false,
    },
  ];
  writeFileSync(join(loopsRoot ? loopsRoot.dir : workspace, "loops.yaml"), serializeLoopsYaml(loopDefs));
  writeFileSync(
    join(workspace, ".loops-state.json"),
    JSON.stringify(
      {
        // activeHere: this demo machine has adopted all three. A loop arriving from another machine
        // in the company would land WITHOUT this and stay inert until the operator switches it on.
        "friday-review": { activeHere: true, firstSeen: nowMs - 30 * DAY, lastRun: nowMs - 2 * DAY, status: "ok" },
        "pipeline-digest": { activeHere: true, firstSeen: nowMs - 30 * DAY, lastRun: nowMs - 2 * HOUR, status: "ok" },
        "inbox-triage": { activeHere: true, firstSeen: nowMs - 30 * DAY, lastRun: nowMs - 6 * HOUR, status: "ok" },
      },
      null,
      2,
    ) + "\n",
  );

  // Sessions: a lived-in history for the left rail (daemon-owned, NEVER synced - lives under .sessions/).
  // Each file is `<uuid>.json`; the id MUST be a real uuid so the console can open it. A couple carry
  // full transcripts so opening one shows a real read→write→summarize turn; the rest carry a preview.
  const sessionsDir = join(workspace, ".sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionIdByTitle = new Map<string, string>();
  for (const s of seedSessions) {
    const id = randomUUID();
    sessionIdByTitle.set(s.title, id);
    writeFileSync(
      join(sessionsDir, `${id}.json`),
      JSON.stringify({ id, folder: s.folder, title: s.title, status: s.status, updatedAt: Date.parse(s.at), preview: s.preview, events: s.events ?? [] }),
    );
  }

  // Projects (the left-rail task containers): group the sessions into workstreams, each holding its
  // chats plus a relevant doc/map so the rail shows a real mix (chat · doc · map). Chats reference
  // sessions by id; docs reference real seeded files (a doc item opens the file). NEVER synced.
  // `app` marks a chat that was started from an installed app (the rail badges it with that app's
  // mark) - the demo has to show the mixed case: some chats are about a tool, most are not.
  const chat = (title: string, app?: string): { type: "chat"; sessionId: string; title: string; app?: string } => ({ type: "chat", sessionId: sessionIdByTitle.get(title)!, title, ...(app ? { app } : {}) });
  const doc = (path: string): { type: "doc"; path: string } => ({ type: "doc", path });
  const projects = [
    { name: "Fundraising", items: [chat("Draft the Q3 investor update"), doc("team-acme/finance/metrics-q3.md")] },
    { name: "Clients", items: [chat("Summarize this week's design-partner calls"), chat("Reply to Dana's kickoff email"), doc("team-acme/clients/globex/profile.md")] },
    { name: "Finance", items: [chat("Reconcile Globex invoices for July", "stripe"), doc("team-acme/finance/runway.md")] },
    { name: "Product", items: [chat("Update the roadmap from Linear issues", "linear"), doc("team-acme/product/roadmap.md")] },
    { name: "Sales", items: [chat("Prep the Umbrella pilot proposal", "hubspot"), doc("team-acme/gtm/pipeline.md")] },
    { name: "Operations", items: [chat("Friday weekly review"), { type: "map" as const }] },
    { name: "Hiring", items: [chat("Draft the backend engineer job post"), doc("team-acme/people/hiring/backend-engineer.md")] },
  ].map((p) => ({ id: randomUUID(), name: p.name, items: p.items, createdAt: Date.parse("2026-07-19T09:00:00Z") }));
  writeFileSync(join(workspace, ".projects.json"), JSON.stringify(projects, null, 2) + "\n");
}

export interface SeedAcmeOpts {
  /** The org's workspace dir; repos are created at `<workspace>/{core,team-acme,private-you}`. */
  workspace: string;
  /** Resolved bundled core pack (see resolveCorePackDir) - source for `core` + the installed apps. */
  corePackDir: string;
  /** Commit author label; defaults to "operator". */
  actor?: string;
}

/** Seed the Acme Labs SANDBOX workspace: the three repos as LOCAL, no-remote git repos (so the org
 *  never syncs - the sync engine reports the neutral "local" state), plus the daemon-owned workspace
 *  extras. Idempotent per repo (an already-provisioned repo is left untouched - invariant #8). Returns
 *  the roots in precedence order [core, team-acme, private-you]. This is the packaged app's demo seed -
 *  no shell-out, no repo checkout; all content is compiled into the bundle. */
export function seedAcmeWorkspace(opts: SeedAcmeOpts): Root[] {
  const actor = opts.actor ?? "operator";
  const writers: Record<string, (dir: string) => void> = {
    core: (dir) => writeCoreContent(dir, { corePackDir: opts.corePackDir }),
    "team-acme": (dir) => writeAcmeContent(dir, { corePackDir: opts.corePackDir }),
    "private-you": (dir) => writePrivateContent(dir),
  };
  // An install spans TWO repos (app face → private, company rules → team), so it cannot happen inside
  // a per-repo writer. Lay the content down first, then install into the pair - but only when BOTH
  // were freshly created, so a re-seed never clobbers a provisioned repo (invariant #8).
  const fresh = new Set<string>();
  const roots: Root[] = ["core", "team-acme", "private-you"].map((name) => {
    const dir = join(opts.workspace, name);
    const root: Root = { name, dir };
    if (existsSync(join(dir, ".git"))) return root; // already provisioned - never clobber (invariant #8)
    mkdirSync(dir, { recursive: true });
    writers[name]!(dir);
    fresh.add(name);
    return root;
  });
  // The stack a B2B SaaS operator would actually run on.
  if (fresh.has("team-acme") && fresh.has("private-you")) {
    installDemoPacks(join(opts.workspace, "private-you"), join(opts.workspace, "team-acme"), opts.corePackDir);
  }
  for (const root of roots) {
    if (!fresh.has(root.name)) continue;
    initAndCommit(root.dir, actor, `seed ${root.name}`); // no remote → permanently local (non-syncable sandbox)
  }
  const preset = JSON.parse(readFileSync(join(opts.corePackDir, "policy", "preset.json"), "utf8")) as PolicyPreset;
  writeWorkspaceExtras(opts.workspace, { roots, preset });
  return roots;
}
