# catalog - capability packs (the App Store)

Each subfolder is a **capability pack**: a curated bundle of one system's faces - an external app
link, an MCP server the agent connects to, and skills that teach the agent to use it well. Packs are
shipped read-only in `core` and installed into `team`/`private` from the in-app **App Store**
(`brain/catalog.ts` + `/api/catalog`). A pack declares only the faces that exist; each is optional.

`pack.json` shape:

```jsonc
{
  "id": "notion",                 // kebab-case, matches the folder
  "name": "Notion", "icon": "🗒️",
  "summary": "one line",
  "app":   { "url": "https://…" },                    // optional - external app in the rail
  "mcp": {                                            // optional - pinned into .mcp.json; runtime owns OAuth
    "kind": "http", "url": "https://…/mcp",           //   "http" (remote) or "stdio" (local command)
    "scopes": ["mcp:read", "mcp:write"],              //   optional - OAuth scope hint for the gateway path; DCR falls back to server defaults
    "direct": true                                    //   optional - pin as a DIRECT remote instead of routing through the connector gateway, for non-DCR providers that need a static OAuth client (e.g. Google Gmail/Calendar/Drive)
  },
  "skills": ["skill-a", "skill-b"],                   // optional - SKILL.md dirs under this folder's skills/
  "policy": { "allow": [...], "ask": [...] }          // optional - gating hints merged into the preset
}
```

Every field above is validated in CI (`apps/client/src/brain/catalog-packs.test.ts`): a malformed
pack, an unknown key, an `id` that doesn't match its folder, or a `skills[]` entry with no `SKILL.md`
fails the build - so a broken pack can never vanish silently from the store.

## MCP endpoint status (v1)

Install pins `mcp.url` into `.mcp.json`; the agent runtime performs the OAuth handshake. A wrong URL
is non-destructive - the connection simply fails until corrected. Endpoints here still need care:

| Pack | app | skills | mcp | endpoint status |
|---|---|---|---|---|
| notion   | ✓ | ✓ | ✓ | `https://mcp.notion.com/mcp` - Notion's documented hosted MCP |
| protocol | ✓ | ✓ | ✓ | `https://app.protocolcrm.com/mcp` - **confirm the real endpoint** (owner-controlled) |
| stripe   | ✓ | ✓ | ✓ | `https://mcp.stripe.com` - Stripe's official hosted MCP (OAuth DCR) |
| linear   | ✓ | ✓ | ✓ | `https://mcp.linear.app/mcp` - Linear's official hosted MCP (OAuth 2.1) |
| hubspot  | ✓ | ✓ | ✓ | `https://mcp.hubspot.com` - HubSpot's official remote MCP (GA, OAuth 2.1 + PKCE) |
| asana    | ✓ | ✓ | ✓ | `https://mcp.asana.com/v2/mcp` - Asana's GA V2 MCP (OAuth); avoid the deprecated `/sse` beta |
| intercom | ✓ | ✓ | ✓ | `https://mcp.intercom.com/mcp` - Intercom's hosted MCP (OAuth; US-hosted workspaces only) |
| canva    | ✓ | ✓ | ✓ | `https://mcp.canva.com/mcp` - Canva's official hosted MCP (OAuth DCR) |
| heygen   | ✓ | ✓ | ✓ | `https://mcp.heygen.com/mcp/v1/` - HeyGen's official hosted MCP (OAuth); renders cost credits |
| calendly | ✓ | ✓ | ✓ | `https://mcp.calendly.com` - Calendly's official hosted MCP (OAuth 2.1 DCR) |
| gmail    | - | - | - | **not built** - Google first-party MCP (`https://gmailmcp.googleapis.com/mcp/v1`) is Developer Preview and needs a Google Cloud OAuth client (not DCR); build the pack when a static-client path lands |
| google-calendar | - | - | - | **not built** - same first-party-preview + OAuth-client situation as gmail |
| google-drive | - | - | - | **not built** - same first-party-preview + OAuth-client situation as gmail |
| slack    | ✓ | ✓ | - | no verified first-party hosted MCP yet - add the `mcp` face once an endpoint is confirmed |
| manychat | - | - | - | **not built** - no first-party hosted MCP; only aggregator (Zapier/Pipedream) or a stdio wrapper needing `MANYCHAT_API_TOKEN`. Deferred pending a token-handling decision (invariants #4/#8) |

**Policy hints are targeted, not blanket.** The base preset is wide-allow by design - autonomy is
the default, and gating happens by intent: a pack's `basePolicy` (and its `gated`/`when` rules)
marks the money / outbound-to-people / destructive tools that must wait for a human tap, and the
connector gateway enforces those marks on every call. When a pack's MCP is pinned live and its
actual tool-name prefix is observed (`mcp__<serverKey>__<tool>`), tighten the pack's rules to match
the real names - the operator's own overrides can only tighten further, never loosen.
