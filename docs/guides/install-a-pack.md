# Install a capability pack

A **pack** is a bundle of capability you add to a company: an external app to open in a tab, a set of
skills, and (for connectors) the wiring to reach a provider. Packs are installed **per company** into
a writable brain (your team or private repo), so different companies keep different stacks.

## Install from the App Store

1. Open the **Store** (top of the Apps list in the left rail).
2. Find a pack — Gmail, Slack, Notion, Linear, Stripe, HubSpot, Google Calendar, and more.
3. Click **Install**. Choose the target brain (team or private) if asked.

The pack now shows **✓ Installed** and appears in your Apps list. Uninstall reverses it cleanly.

## What an install actually does

Installing is deterministic and writes plain files into the target repo — nothing hidden:

- **App face** → `apps/<id>/app.json` — lets you open the provider in a tab.
- **Skills** → `skills/<skill>/SKILL.md` — the verbs the pack teaches your agent.
- **Policy** → `policy/packs/<id>.json` — the pack's allow/ask/deny rules, merged into your gate.
- **MCP wiring** → the connector is pinned so the agent can reach the provider's tools (see
  [Connect a connector](connect-a-connector.md) for authorizing it).

Every one of those is a committed file, so an install is visible in history and reviewable in a pull
request — the same as any other change to the brain.

## Where packs come from

The built-in catalog ships in `packs/core/catalog/`. Each pack is a folder with a `pack.json`
manifest and optional `skills/`. You can read exactly what any pack does before installing it — and
authoring your own is just adding a folder.
