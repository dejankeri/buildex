---
name: run-worktree-app
description: Use when asked to launch, open, run, or screenshot the local Electron/console app for the current git worktree - especially when several worktrees exist. Launches THIS worktree's app in an isolated demo environment (its own dir + its own ports) so it never collides with another worktree's running app.
---

# run-worktree-app - launch this worktree's app, isolated

Every git worktree shares three globals by default - the demo dir (`~/.buildex-demo`), the console
port (`4317`), and the gateway port (`4318`) - so only one worktree's app can run at a time, and the
wrong worktree's edits get served. `demo:app:here` fixes that: it derives a **stable, per-worktree**
demo dir and a **non-colliding** console/gateway port pair from the worktree path, then launches.
Same worktree → same URL every time; different worktrees → never collide.

## When to use

- Asked to run / open / launch / screenshot the app while working in a worktree (any worktree other
  than the one whose app is already on 4317).
- You need two or more worktrees' apps up at the same time to compare or dogfood.

## Steps

1. **Launch from the worktree root:**
   - Native app: `npm run demo:app:here`
   - Browser/console only: `npm run demo:here`
   The launcher prints a banner: `console http://127.0.0.1:<port>`, `gateway <port>`, `demoDir <path>`.
2. **Wait for readiness** on the console port from the banner:
   `curl -sf http://127.0.0.1:<port>/healthz && echo ready`
3. **Report** the console URL, gateway port, and demoDir back to the operator; they open/bookmark the
   console URL. Live HTML/CSS/JS edits under `apps/client/web/*` show on a window reload (Cmd-R); only
   TypeScript changes (`daemon`, `wiring`, `brain/*`, `scripts/*`) need a relaunch.

## Rules

- **One app per worktree, but many worktrees at once.** Each `demo:app:here` gets its own dir and
  ports - run it in as many worktrees as you like; do not run it twice from the *same* worktree (the
  second free-port-hops and confuses which URL is which).
- **Reset only your own worktree:** `rm -rf <demoDir>` (the path from the banner), then relaunch.
  Never `rm -rf ~/.buildex-demo` - that also wipes the legacy flat demo and every other worktree.
- **Never hand-patch `~/.buildex-demo/demo.json`** to change ports - that is the old brittle path the
  env-driven launcher (`BUILDEX_DEMO_GATEWAY_PORT`) replaces.
- Legacy `npm run demo` / `demo:app` still use the flat `~/.buildex-demo` on 4317/4318 and coexist with
  the per-worktree launchers. Derivation lives in `apps/client/src/demo/worktree-env.ts`.
