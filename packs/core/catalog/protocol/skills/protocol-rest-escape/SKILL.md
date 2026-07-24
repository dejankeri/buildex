---
name: protocol-rest-escape
description: Use when a Protocol request cannot be done through the MCP tools at all - billing, permanent deletes, or messaging a client - so the operator learns whether it needs the broader REST key rather than being told a flat no.
---

# protocol-rest-escape - what MCP will not do, and what it costs

Protocol's MCP surface deliberately omits four things. They are missing on purpose, not by oversight,
so no amount of rephrasing will find a tool for them.

## When to use

- The operator asks to message a client, take a payment, issue a refund, or permanently delete
  something.
- You have checked `../protocol-reference/references/mcp-surface.md` and there is genuinely no verb.

## Steps

1. Confirm it really is missing. Check the verb list first - `manage_*` verbs cover more than their
   names suggest, and `find`/`get` reach 23 and 17 entity kinds respectively.
2. Name the wall plainly to the operator. The four:
   - **Messaging clients** - no MCP verb sends a message. `message` only reads.
   - **Billing and commerce** - checkout, refunds, invoices, subscriptions: none are exposed.
   - **Hard deletes** - MCP serves no delete tool for any entity.
   - **Protocol's own AI generation** - not invoked without the coach's say-so.
3. Say whether the REST API can do it, and what that requires: a **separate, broader credential** than
   the MCP connection - full coach-level access to the whole account, owner-only, granted through its
   own browser approval. It is not enabled by default.
4. If the operator wants it, point them at the pack's escape-hatch connection rather than asking them
   to paste a key anywhere. Once granted, the key stays with the BuildEx daemon - it never appears in
   your environment. What you get instead is a local proxy that attaches it for you:
   `BUILDEX_PROVISION_URL` (where the proxy is) and `BUILDEX_PROVISION_TOKEN` (your pass for it),
   with the API's own base URL in `PROTOCOL_API_URL` for reference.
5. With the grant in place, call REST through the proxy - same paths, the daemon adds the credential
   on the way through:
   `curl -H "Authorization: Bearer $BUILDEX_PROVISION_TOKEN" $BUILDEX_PROVISION_URL/protocol/v1/openapi.json`
   Responses are wrapped as `{success, message, data}`. The spec is at `/v1/openapi.json` - read it
   rather than guessing routes. Reads (GET) go straight through; anything else waits for the
   operator's tap first, exactly like a gated MCP tool.

## Rules

- **Never work around a wall silently.** If the operator asks to message a client and you use the
  REST API to do it, say so before, not after.
- The REST grant is full coach access with no tier scoping - it bypasses every protection the MCP
  connection gives. Treat each use as a deliberate exception, not a convenience.
- A denied approval card is the operator saying no. Stop there; do not retry or look for another
  route to the same effect.
- Hard deletes are irreversible and Protocol keeps no undo. Confirm the exact entity, out loud, first.
- If nothing is provisioned (`BUILDEX_PROVISION_URL` unset, or the proxy answers 404 for
  `protocol`), say what is missing and stop. Do not ask the operator to paste a key into a file or
  the chat.
