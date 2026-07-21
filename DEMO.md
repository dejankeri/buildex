# Run the BuildEx demo locally

A one-command local demo: a seeded company brain, the operator console, and **your own `claude` CLI**
doing the work. No cloud, no login for BuildEx - the agent uses your local Claude Code login (the
conductor pattern).

## Prerequisites

- **macOS**
- **Node 22+** and **git**
- **Claude Code CLI** installed and signed in with **Claude Pro or higher** - check with `claude --version`
- Dependencies installed: `npm install` (from the repo root)

## Start it

```sh
# Option A - in your browser (nothing extra to install)
npm run demo
#   → prints a http://127.0.0.1:4317 URL; open it.

# Option B - the native desktop app
npm run demo:app
#   → opens the Electron window onto the same daemon.
```

Both boot the same local daemon against a seeded workspace and drive your real `claude`.

## The console

A three-pane workspace (both rails collapse via the top-bar toggles):

- **Left rail** - two stacked sections:
  - **Sessions** - your chats and tasks. Each remembers its transcript; reopen one and the work is
    still there. **＋ New session** starts one.
  - **Apps** - the tools installed into this company (Gmail, Slack, Notion, Linear, Stripe, …). The
    **＋** opens the **Store** - the one path to install a new app or connector.
- **Middle** - a tabbed workspace. The **＋** opens a **Chat**, a **New document** (a split markdown
  editor - pick where in the brain to save it), a **document reader** (rendered markdown + git
  history, with an **Edit** button), a **web browser**, or the **workspace map**. The chat box grows
  with longer messages and has a **model** picker, an **effort** (thinking) level, and a 📎 to
  **attach** a workspace file.
- **Right rail** - icon mini-tabs in the top bar, each one actionable:
  - **Pending** - outward actions waiting for your approval (with a badge). This is the human gate.
  - **Files** - a real tree with find-files; click a file to open it.
  - **Skills** - your verbs. Click one to read it, **+ Teach** to write a new one (it's validated,
    linked into the agent, and committed), or **Run** to invoke it in a fresh chat.
  - **Apps & connectors** - **Connect** a source (Gmail/Slack/Notion), then **Sync now** to file its
    material into `sources/<name>/` with provenance. Credentials go to your OS keychain, never the repo.
- **Top bar** - the **sync dot** (click it for the recent-changes log), a theme toggle, and the two
  rail toggles.

Chat renders markdown and shows the agent's working trace - thinking and each tool step - folded into
one collapsible line (`Worked · N steps`), like Claude Code; the answer stays clean below it.
Conversation titles come from your first message.

## What you get

A demo company - **Acme Labs** - provisioned at `~/.buildex-demo/`:

| Repo | What's in it |
|---|---|
| `core` | the product pack - operating rules, conventions, the verbs |
| `team-acme` | the company brain - charter, decisions, a client (Globex), Q3 metrics, a Gmail source |
| `private-you` | your personal notes |

> **Demo credentials:** Company **Acme Labs**, operator **you@acme.demo**. There's no BuildEx password -
> the only credential that matters is your `claude` login, which BuildEx never sees or handles.

## Try these

In the chat, ask:

- *"Summarize Acme's Q3 metrics and our charter."*
- *"What did we decide about our niche, and why?"*  (it reads `decisions/log.md`)
- *"Draft this week's review from the brain and save it to `team-acme/meetings/`."*  (watch it write a file)
- *"What does the Globex kickoff email ask us to send?"*  (it reads the Gmail source)
- *"Look up what's at buildex.dev and summarize the homepage."*  (an outward `WebFetch` - it stops at
  the **Pending** tray for your approval before it touches the network)

The demo also boots with one approval already waiting in the **Pending** tray - a drafted reply to
Globex's Dana that would send email outward. Approve or deny it to watch the gate close the loop.

As the agent works, the **live map** highlights the files it touches, the **Files** tree shows every
doc with its history, and the big outward moves — sending, posting, paying — wait in the **Pending** tray for your tap.

Then try the right-rail panels: **Teach** a new skill, or **Connect**
a source and hit **Sync now** to watch it file email/chat/docs into the brain.

> The demo's connectors use built-in sample data instead of live provider APIs. Real OAuth is the
> production path - the plumbing (keychain, read-only-by-construction filing, the gate) is the same.

## Agent tools (optional)

The agent runs your own `claude` CLI. If your machine's global Claude Code config gates tools (e.g. an
app that installs `PreToolUse`/`PermissionRequest` hooks), a spawned agent can't use the shell - so the
daemon hands it the workspace **file map** and it works via `Read`/`Edit`/`Write`. To give it full
shell tools instead, run once:

```sh
npm run demo:agent-login   # logs a config home isolated from your own Claude Code (no inherited hooks)
```

Same account; just a separate config so the agent gets clean, predictable tools. Your own Claude Code
(and any skills toolkits like gstack) are untouched.

## Reset

```sh
npm run demo:setup -- --reset      # rebuild the demo workspace from scratch
```

The demo lives entirely under `~/.buildex-demo/` - delete that folder to remove it.

## Notes

- **The approval gate is real, and it is on in this demo.** `npm run demo` threads a live PreToolUse
  hook (`apps/client/scripts/gate-hook.mjs`) into the agent's workspace `.claude/settings.json`:
  before every tool call, the hook relays the tool to the daemon's gate at **`POST /api/gate`**, which
  applies the allow/ask/deny policy. Reads and local edits flow through; an ask-tier action (an
  outward send, a `WebFetch`, an arbitrary shell command) blocks and raises an approval card. The
  console reads the queue from **`GET /api/pending`** and posts your verdict to **`POST /api/approve`**.
  Nothing is faked - the daemon gate, not Claude's native prompt, is the single source of truth, and
  on any failure the hook fails closed (denies).
- Git sync works against local `file://` remotes under `~/.buildex-demo/remotes/` - edits commit and
  push locally, exactly as they would to the cloud sync service.
