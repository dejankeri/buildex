# Agent Context viewer — "what my agent sees" — design

**Date:** 2026-07-22
**Status:** proposed, awaiting review
**Surface:** `apps/client` (console web + daemon)

## Problem

An operator builds up a brain — verbs, standing instructions, policy, connected tools — and has to
*trust* that all of it actually reaches the agent when a chat starts. Today there's no single place
to confirm that. The `.claude` surface is buried behind the Files panel's "Show everything" reveal,
with no contents view and no check that what was *authored* actually got *wired in*. The operator
wants to be 100% sure the brain, skills, and policies are fed to Claude.

## What Claude actually loads (the ground truth)

The agent is the `claude` CLI, spawned with **`cwd = the workspace`** (`agent/claude-driver.ts:73`).
Claude Code therefore auto-loads, from that workspace, exactly the surface `generateAgentConfig`
materializes and `buildAgentView` already reports (invariant #9 — derived deterministically, zero
LLM):

- the assembled workspace **`CLAUDE.md`** (standing instructions),
- **`.claude/skills/*`** — every linked verb (precedence private > team > core), with a
  `skill-origins.json` provenance manifest,
- **`.mcp.json`** — pinned MCP servers (incl. installed app-pack faces),
- **`.claude/settings.json`** — the allow/ask/deny policy preset + the gate hook.

So a viewer over this data is an *honest* answer to "what does my agent see," not a guess. The one
honest caveat, stated in the UI: it shows what's **materialized on disk for the agent** (which is
what the CLI loads from cwd). A literal end-to-end capture from the CLI itself is a named v2 seam.

## Decisions (from brainstorming)

1. **Surface → center tab, two-pane.** Tapping the icon opens a center tab "Agent context": a
   checklist/tree of everything on the left, the selected file's full contents on the right. Reading
   a long assembled `CLAUDE.md` or a multi-file skill needs real space, so not a cramped modal.
2. **Verification → list + discrepancy checks.** Beyond listing, it actively flags gaps and offers a
   "Regenerate & re-verify" action. This is what delivers "I'm certain the brain reached Claude."

## Architecture

### Entry point

A small icon button (an eye / "context" glyph) pinned **top-right of the Brain rail** (`#rpanel`,
brain view only). `onclick → openAgentContextTab()`. The button is part of `renderBrainPanel()`'s
header row, absolutely positioned top-right so it never fights the star.

### The center tab — `openAgentContextTab()` (new `web/js/agent-context.js`)

A `type: "agentctx"` tab, pane class `agentctxpane`, two-pane layout:

- **Left (the checklist/tree):** grouped sections, each row carrying a ✓/✗/⚠ status:
  1. **Standing instructions** — `CLAUDE.md` (assembled). ✓ present / ✗ missing.
  2. **Verbs** — N linked, grouped by origin (Company / Private / app-pack). Each expandable to its
     source files (`SKILL.md` + scripts/references). ⚠ per authored-but-unlinked verb.
  3. **Tools & connections** — `.mcp.json` servers (pinned) + the live gateway tool list, each badged
     `gated`/`read`/`hidden`. ⚠ for a server configured but not live.
  4. **Policy** — `.claude/settings.json` (allow/ask/deny + gate hook). ✓/✗.
  5. **Sources** — read-only connector data filed into the workspace as context.
  Selecting any file row loads it into the right pane.
- **Right (the reader):** the selected file's full contents, rendered read-only via the existing
  root-confined `/api/doc` reader (markdown via `md()`, JSON/settings as a code block). This is how
  the operator *reads* CLAUDE.md, a SKILL.md, `.mcp.json`, `settings.json`.
- **Header:** a "derived from your repo · zero AI" badge (the trust framing) + a **Regenerate &
  re-verify** button.

### Discrepancy checks (the "100% sure" core)

The viewer's data comes from an extended agent-context payload. New/loud signals:

- **Authored-but-unlinked verb** — a `SKILL.md` under a repo root's `skills/` that has no entry in
  `skill-origins.json` (so it never linked into `.claude/skills` → the agent won't see it). Surfaced
  as ⚠ with the offending path.
- **Missing standing instructions / policy** — `CLAUDE.md` or `.claude/settings.json` absent.
- **MCP configured but not live** — a server in `.mcp.json` with no matching live gateway status.
- A top-line verdict: **"Everything the agent needs is wired"** vs **"N things need attention"**.

### Backend

- **Extend `buildAgentView`** (or a companion `buildAgentContext`) in `brain/agent-view.ts` to also
  return: authored skills per root (scan each `root.dir/skills/*/SKILL.md` — `generateAgentConfig`
  already walks these), the linked set (existing), and the derived `discrepancies[]`. MCP liveness is
  joined in the daemon from the gateway status the console already fetches
  (`/api/connectors/gateway`).
- **New route `POST /api/agent-view/regen`** — calls the existing `regenConfig()` then returns the
  fresh view. Powers "Regenerate & re-verify". (Plain "re-verify" is just a GET re-fetch.)
- Reuse `/api/doc` for file contents (already root-confined; already reads `CLAUDE.md`, `.claude/*`,
  and `<root>/skills/*` per `agent-view.ts`'s own comment).

## Seams / tests (invariant #1 discipline)

- **`buildAgentContext` / discrepancy derivation** — pure over a fixture workspace (tmpdir with
  planted `CLAUDE.md`, a linked skill, an *unlinked* `SKILL.md`, a `.mcp.json`, `settings.json`).
  Unit-tested in `brain/agent-view.test.ts`: correct counts, the unlinked verb is flagged, missing
  policy is flagged.
- **`/api/agent-view/regen`** — daemon route test: calls regen, returns a view.
- **`agent-context.js` render** — jsdom console-harness suite: the two-pane renders a row per group,
  status glyphs reflect the payload, a discrepancy row shows ⚠, selecting a file requests `/api/doc`,
  and hostile file/skill names are **escaped** (the XSS canary the net exists to hold).

## Out of scope (named seams)

- A literal CLI context snapshot (`claude` printing its resolved system prompt + tool list). v1 uses
  the deterministic derived surface, which is what the CLI loads from cwd.
- Editing from this viewer — it is read-only + verify; authoring stays in the existing editors.
- The isolated global config-dir layer (`CLAUDE_CONFIG_DIR`) contents; noted in the UI, not walked.
