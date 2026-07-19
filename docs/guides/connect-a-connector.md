# Connect a connector

A **connector** brings a real service into your agent's reach — read your inbox, search Slack, look
up a Stripe customer. Two things are always true: the connector's data lands in your brain as plain
files, and any **write** back out (send, post, charge) waits for your approval.

There are two connection paths, depending on the provider.

## Path 1 — providers that self-register (the easy one)

Modern remote-MCP providers (for example **Linear**, **Notion**, **Stripe**) support dynamic client
registration, so there's nothing to set up ahead of time:

1. Install the pack from the **Store**.
2. In the Apps list, click **Connect** on the provider.
3. A browser window opens to the provider's sign-in. Authorize it.
4. Done — its tools go live for the agent, routed through a local, authenticated gateway on your
   machine. The token is stored in your OS keychain, never in the repo.

The gateway binds to loopback only, requires a per-boot token, and rejects cross-origin requests —
so a random web page can't reach your connected tools.

## Path 2 — bring your own OAuth app (Gmail, Slack, Notion file sync)

Some providers (Google especially) require a **registered OAuth application** with a fixed client ID
and secret. A public repo can't ship those — they'd be live credentials in git — so for self-serve
you register your own once. It's a five-minute, one-time step.

1. In the provider's developer console, create an OAuth app.
2. Add the loopback redirect the app expects — `http://127.0.0.1:<console-port>/oauth/connector/<provider>/callback`
   (the console prints its port on startup; the demo uses `4317`). Note the `/connector/` segment:
   the file-sync path uses `/oauth/connector/<provider>/callback`, kept distinct from the
   self-registering gateway's `/oauth/<provider>/callback` so a same-named provider never collides.
3. Copy the client ID/secret into environment variables before you start:

   ```sh
   export BUILDEX_GMAIL_CLIENT_ID=...      # and BUILDEX_GMAIL_CLIENT_SECRET=...
   export BUILDEX_SLACK_CLIENT_ID=...      # BUILDEX_SLACK_CLIENT_SECRET=...
   export BUILDEX_NOTION_CLIENT_ID=...     # BUILDEX_NOTION_CLIENT_SECRET=...
   npm run demo
   ```

Once connected, synced material shows up under `sources/<provider>/` in your brain — real files you
can read, search, and reference.

> **Heads up:** the in-console button that kicks off this bring-your-own-OAuth flow is temporarily
> removed while the App Store becomes the single install path. The backend (loopback redirect,
> keychain storage, file sync) is intact, but there is no button to click in the current UI. If you
> need Path 2 today, track this guide for its return; for now Path 1 providers are the supported
> route.

## Why it works this way

The conductor never proxies a model and never holds a provider's credentials on your behalf: your
tokens live in your keychain, your OAuth apps are yours, and the data is your files. That's the whole
point — the connector extends what the agent can do without any of it leaving your control.

> **Status:** Path 1 is live today. Path 2's backend is real, but its in-console entry point is
> temporarily removed during the App Store consolidation (see the heads-up above). Founder-registered
> apps for a zero-config Gmail/Slack/Notion experience are on the roadmap.
