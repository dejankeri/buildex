# Run the app

BuildEx runs on your machine. There's no account and nothing to sign up for to try it.

**The easiest path is the packaged desktop app** — download the installer and open it; first-run
walks you through connecting your agent (see `docs/package-macos.md` / `docs/package-windows.md` to
build one until signed downloads ship). The path below is the developer demo — it runs the same
product from a source checkout and seeds a throwaway company to explore.

## Prerequisites (developer demo)

- **macOS**, or **Windows 10/11** (Linux is on the roadmap)
- **Node 22+**
- **git**
- **[Claude Code](https://claude.com/claude-code)** signed in with **Claude Pro or higher** — BuildEx
  drives your own agent; it never sees your keys or resells a model.

(Contributors running the `task ci` gate also need [go-task](https://taskfile.dev) — `brew install
go-task`. The demo itself doesn't use it.)

## Start the demo

```sh
git clone https://github.com/dejankeri/buildex.git
cd buildex
npm install
npm run demo
```

This provisions a demo company (*Acme Labs* — a seeded brain, sessions, and installed
apps) under `~/.buildex-demo`, then opens the operator console in your browser. Everything is
local; nothing is sent anywhere.

Prefer the native desktop app?

```sh
npm run demo:app
```

## What you'll see

- **Left rail — Sessions**: your work, grouped into sessions. A session lists its **chats**; docs,
  browsers and the map you open in it are tabs in the center, not rail entries.
- **Center**: the active session — a chat with your company brain, or a rendered/editable document.
- **Left rail — Apps**: the tools installed for this company, and the **Store** to add more.
- **Right rail**: **Pending** (outward actions waiting for your approval), **Files** (the whole
  brain), and **Skills** (verbs the agent can run). Apps are managed in the left rail and the
  ⊕ **Store** - there is no separate apps panel on the right.

Open a session, edit a document, watch the **History** on any doc — every change is a git commit.

## Let the agent run

By default the console reads and writes the brain, but the agent isn't wired to a login. To let it
actually run turns, give it an isolated login once:

```sh
npm run demo:agent-login
```

This uses a config directory separate from your own Claude Code, so the demo agent gets a clean,
predictable tool set and none of your personal hooks.

## Reset

```sh
npm run demo:setup -- --reset
```

Rebuilds the demo company from scratch. To wipe a single environment, delete its demo directory
(printed on startup) — never delete all of `~/.buildex-demo` if you run more than one.

## Running more than one at once

Each git worktree can host its own app on a stable, non-colliding port and demo directory:

```sh
npm run demo:here        # browser console for THIS worktree
npm run demo:app:here    # native app for THIS worktree
```

The launcher prints the console URL, gateway port, and demo directory.
