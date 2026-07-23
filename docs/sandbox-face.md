# The `sandbox` pack face — throwaway provider workspaces for e2e testing

> Status: spec (design of record for the e2e test engine's provider seam).
> Audience: pack authors and the provider-side engineers implementing the endpoints.

Any pack that declares a `sandbox` face is end-to-end testable: the test engine can mint a
throwaway workspace on the provider, connect to it through the pack's normal connection
machinery, drive real work against it, and destroy it afterwards — leaving only the report.

The engine itself knows no provider. Like the other faces (`app`, `mcp`, `apiKey`, `provision`),
`sandbox` is declared in `pack.json` and consumed generically. A pack without a `sandbox` face is
simply not e2e-testable; nothing else changes for it.

## Design constraints

- **The face is a client, not a faucet.** Publishing these URLs grants nothing: the provider's
  server decides who may mint test workspaces (allowlist, admin secret, rate limits — the
  provider's call, server-side). The engine fails soft when the faucet says no.
- **No new connection machinery.** The workspace credential returned by `create` rides the pack's
  existing `apiKey` face transport (`mcp-bearer` header injection on the pack's MCP url). A pack
  therefore needs an `apiKey` face with `transport: "mcp-bearer"` to be sandbox-testable.
- **Secrets never in manifests.** The operator's sandbox admin secret (minted by the provider)
  lives in the keychain under `connector:<id>:sandbox`; the workspace credential a run mints is
  held in memory for the run and discarded at teardown — never persisted, never committed.
- **Fail closed.** A malformed `sandbox` face invalidates the face (the pack stays installable;
  it is just not e2e-testable) — unlike a malformed policy, which drops the whole pack.

## The face

```json
"sandbox": {
  "createUrl":  "https://api.example.com/v1/sandbox/workspaces",
  "destroyUrl": "https://api.example.com/v1/sandbox/workspaces/{id}",
  "seedUrl":    "https://api.example.com/v1/sandbox/workspaces/{id}/seed",
  "authHeader": "x-sandbox-key",
  "idPath":     "data.workspaceId",
  "keyPath":    "data.apiKey",
  "mcpUrlPath": "data.mcpUrl",
  "docsUrl":    "https://help.example.com/sandbox-testing",
  "hint":       "Sandbox admin key (sb_…) from the provider's developer page"
}
```

| Field | Required | Meaning |
|---|---|---|
| `createUrl` | yes | `POST` mints a workspace. Body: `{ "name": string, "host": string }` — a label for the run and this machine's name, so the provider can list and reap orphans. |
| `destroyUrl` | yes | `DELETE` destroys the workspace. Must contain the literal `{id}` placeholder, substituted with the id read from `idPath`. |
| `seedUrl` | no | `POST` bulk-loads seed data. Body: an opaque JSON document the provider interprets. When absent, the engine seeds through the provider's normal MCP/API surface instead (slower, but exercises the real write path). Must contain `{id}` if present. |
| `authHeader` | no | Header carrying the operator's sandbox admin secret on all three calls. Default `"x-sandbox-key"`. |
| `idPath` | yes | Dotted path to the workspace id in the `create` response. |
| `keyPath` | yes | Dotted path to the workspace-scoped API key in the `create` response. This key is what the run connects with. |
| `mcpUrlPath` | no | Dotted path to a workspace-specific MCP url in the `create` response, for providers whose sandbox lives on a different host. Default: the pack's own `mcp.url`. |
| `docsUrl` | yes | Public page describing the provider's sandbox program. |
| `hint` | no | Short hint shown where the operator pastes the sandbox admin secret. |

### Validation (fail closed)

- `createUrl`, `destroyUrl`, `seedUrl` (if present), `docsUrl`: non-empty, `https://` only.
- `destroyUrl` (and `seedUrl` if present) must contain `{id}`; `createUrl` must not.
- `idPath`, `keyPath`: non-empty strings.
- `authHeader`, `mcpUrlPath`, `hint`: when present, must be non-empty strings.
- The pack must also declare `apiKey` with `transport: "mcp-bearer"` and an http `mcp` face —
  otherwise the minted key has no path to ride, and the face is invalid.

## Endpoint contracts (what the provider implements)

All three endpoints are authenticated by the sandbox admin secret in `authHeader` and are
expected to be **gated server-side** — who holds a secret, how many workspaces, how fast, and
whether sandboxes auto-expire are provider policy, invisible to this contract.

### `POST createUrl`

Request: `{ "name": "e2e-2026-07-22-acme", "host": "OPERATOR-PC" }`

Response `201`:

```json
{ "data": { "workspaceId": "ws_…", "apiKey": "sb_pk_…", "mcpUrl": "https://…" } }
```

(Shape is the provider's; the engine only reads `idPath` / `keyPath` / `mcpUrlPath`.)
The workspace must be **hermetic**: seeded/created data must never reach real users, real
billing, or real outbound channels (mail, SMS, push). A sandbox workspace that can message a
human is a broken sandbox.

Recommended (not required): include an expiry (`expiresAt`) and reap expired sandboxes
server-side, so a crashed run cannot leak workspaces forever.

### `POST seedUrl` (optional)

Request body: an opaque JSON seed document. Response `2xx` on success. The engine treats the
document as provider-specific content generated per run-plan; the provider defines its schema on
`docsUrl`.

### `DELETE destroyUrl`

Response `2xx`; idempotent — destroying an already-destroyed workspace is `2xx` or `404`, both
treated as success by the engine. Destruction is permanent and must cascade (data, credentials,
anything the workspace minted).

## How the engine consumes the face (lifecycle)

1. Read the operator's sandbox admin secret from `connector:<id>:sandbox` (keychain). Absent →
   the pack is reported "not e2e-testable on this machine", not an error.
2. `POST createUrl` → workspace id + key (+ mcp url).
3. Connect the pack through the normal api-key path (`packApiKeyPin` semantics) using the minted
   key — the run exercises the same wiring an operator's api-key connection uses.
4. Run the test plan (seed → drive → judge).
5. `DELETE destroyUrl` — **always**, including on failure and on interrupt; teardown is the
   engine's only unconditional step. The minted key is discarded with the run.

## The local lane — running without the endpoints

A provider the operator runs locally needs none of the above: the engine's CLI takes
`--mcp-url <url>` plus a key in `BUILDEX_LOCAL_MCP_KEY` and writes the pin directly, skipping
mint/seed/destroy entirely. `http://` is accepted for loopback hosts only (`localhost`,
`127.0.0.1`, `[::1]`); everywhere else stays `https://`.

The clean-slate contract is correspondingly weaker and belongs to the operator: resetting the
local instance replaces `destroy`, and the hand-minted key has no TTL — after a hard kill
mid-run, sweep the leftover run dir (or rotate the key on the local instance) yourself. The
sandbox face remains the durable path for providers not run by the operator.

## Deferred — designed around, not built

- **OAuth-path sandboxes.** Driving the gateway's browser OAuth consent against a provider
  sandbox needs provider-side auto-consent; deferred until a provider offers it. The OAuth path
  keeps its hermetic gateway suites; the naturalistic run covers the api-key path.
- **A workspace registry.** The engine tracks nothing across runs; orphan-reaping is the
  provider's TTL job.
- **Sandbox mode for `stdio`/`direct` packs.** The engine targets gateway-routable http MCP
  packs with an `mcp-bearer` api-key face; other shapes wait until a pack needs them.
