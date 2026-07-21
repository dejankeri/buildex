# Install a capability pack

A **pack** is a bundle of capability you add to a company: an external app to open in a tab, a set of
skills, and (for connectors) the wiring to reach a provider. Packs are installed **per company**, so
different companies keep different stacks.

## Install from the App Store

1. Open the **Store** (in the **Apps & Tools** header at the top of the left rail).
2. Find a pack — Gmail, Slack, Notion, Linear, Stripe, HubSpot, Google Calendar, and more.
3. Click **Install**, and approve it.

There is no scope to choose. The pack shows **✓ Installed**, appears in your **Apps & Tools** rail,
and is ready to connect. Uninstall reverses it cleanly.

## What an install actually does

Installing is deterministic and writes plain files — nothing hidden. It writes to **two** places,
because a pack is two different kinds of thing:

**Yours** (your private brain) — installing is a personal act:

- **App face** → `apps/<id>/app.json` — the app in your rail, which you open in a tab.
- **MCP wiring** → the connector is pinned so *your* agent can reach the provider's tools (see
  [Connect a connector](connect-a-connector.md) for authorizing it).

**The company's** (the team brain) — how this company works with the tool:

- **Skills** → `skills/<skill>/SKILL.md` — the verbs the pack teaches every agent here.
- **Policy** → `policy/packs/<id>.json` — what this tool is allowed to do at this company, merged
  into everyone's gate.

Those company files land in the team brain whether or not your teammates install the pack, and sit
**inert** for anyone who hasn't: a rule about Stripe costs nothing until someone actually connects
Stripe. That way "what is this tool allowed to do here" is one reviewable file per tool, not one per
person — and a new teammate inherits the company's judgement instead of rediscovering it.

Two things follow from the split:

- **Nothing sensitive is shared.** Your credential is stored in your machine's keychain and never
  enters any repo, so a teammate seeing the app still connects it themselves.
- **Uninstalling only affects you.** It removes the app and the MCP pin from your brain and leaves
  the company's skills and policy alone — other people may be working against them, and one person
  leaving a tool must not quietly change what the company allows.

Every one of those is a committed file, so an install is visible in history and reviewable in a pull
request — the same as any other change to the brain.

## Where packs come from

The built-in catalog ships in `packs/core/catalog/`. Each pack is a folder with a `pack.json`
manifest and optional `skills/`. You can read exactly what any pack does before installing it — and
authoring your own is just adding a folder.
