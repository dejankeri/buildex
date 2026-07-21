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
   to paste a key anywhere. Once granted it reaches you as `PROTOCOL_API_KEY` with the base URL in
   `PROTOCOL_API_URL`.
5. With the key present, call REST directly: `Authorization: Bearer <key>`, responses wrapped as
   `{success, message, data}`. The spec is at `/v1/openapi.json` - read it rather than guessing routes.

## Rules

- **Never work around a wall silently.** If the operator asks to message a client and you use the
  REST API to do it, say so before, not after.
- The REST key is full coach access with no tier scoping - it bypasses every protection the MCP
  connection gives. Treat each use as a deliberate exception, not a convenience.
- Hard deletes are irreversible and Protocol keeps no undo. Confirm the exact entity, out loud, first.
- If no key is provisioned, say what is missing and stop. Do not ask the operator to paste one into
  a file or the chat.
