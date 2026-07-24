// The app fetch broker - how a LOCAL app reaches the outside world with a credential attached. The
// sandboxed iframe never holds the secret: values live in the keychain under app:<name>:secret:<slot>
// (invariant 4 - the daemon keeps custody, the same argument as the provision proxy: anything the
// sandbox holds, its scripts can exfiltrate), the manifest declares which slots and which https
// origins the app may use, and the daemon joins secret to request per call. Reads (GET/HEAD) pass
// silently; every other method waits on the same approver the connector gateway bridges to the
// ApprovalBroker, so an outbound send raises the same card an MCP send does (invariant 5). An
// undeclared origin or slot is refused before any network I/O happens.
import type { ApprovalRequest } from "@buildex/connectors";
import { appGrants } from "../brain/apps.js";
import type { Root } from "../brain/graph.js";

export interface AppFetchDeps {
  roots: Root[];
  /** Upstream transport - injected so tests never touch the network. */
  fetch: typeof globalThis.fetch;
  /** The keychain seam (invariant 4) - the only place an app secret ever lives. */
  keychain: { get(key: string): string | undefined };
  /** The human gate for non-GET/HEAD methods - the same approver seam the connector gateway and the
   *  provision proxy bridge to the ApprovalBroker, so approve/deny/TTL semantics are identical. */
  approve: (req: ApprovalRequest) => Promise<{ approved: boolean; reason?: string }>;
}

export interface AppFetchRequest {
  repo: string;
  name: string;
  /** The declared secret slot whose value the daemon attaches. */
  secret: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface AppFetchOutcome {
  ok: boolean;
  /** The upstream reply, relayed verbatim - status/body/content-type, never the request headers. */
  result?: { status: number; body: string; contentType?: string };
  error?: string;
  status: number;
}

/** Keychain key holding one app secret slot - the app:<name>:secret:<slot> namespace, a sibling of
 *  the connector:<id>:… namespaces and per-app by construction, so clearing one app's slots can
 *  never touch another's. Public convention - the value is never a manifest or repo secret. */
export function appSecretKeychainKey(app: string, secret: string): string {
  return `app:${app}:secret:${secret}`;
}

/** Does `url` land on one of the app's declared origins? https only. A `https://*.example.com`
 *  declaration matches any subdomain on the default port; everything else is an exact-origin
 *  comparison (URL.origin normalizes away a default :443, so declare ports explicitly or not at
 *  all). Unparseable urls are foreign by definition. */
export function urlOriginAllowed(origins: string[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return origins.some((o) =>
    o.startsWith("https://*.")
      ? u.port === "" && u.hostname.endsWith(o.slice("https://*".length))
      : o === u.origin,
  );
}

/** Broker one outbound call for an app: verify the slot and origin are declared, gate non-reads,
 *  attach the secret from the keychain, perform the request, relay status/body back. The secret
 *  value's whole journey is keychain → upstream request header - it never enters the outcome. */
export async function brokerAppFetch(deps: AppFetchDeps, req: AppFetchRequest): Promise<AppFetchOutcome> {
  const grants = appGrants(deps.roots, req.repo, req.name);
  if (!grants) return { ok: false, error: `unknown app: ${req.name}`, status: 404 };
  const slot = grants.secrets.find((s) => s.name === req.secret);
  if (!slot) return { ok: false, error: `app "${req.name}" declares no secret "${req.secret}"`, status: 403 };
  if (!urlOriginAllowed(grants.origins, req.url)) {
    return { ok: false, error: "url is outside the app's declared origins", status: 403 };
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    // A consequential outbound call - the same card, approver, and TTL auto-deny a gated gateway
    // tool (and a provision-proxy send) gets.
    const u = new URL(req.url);
    const verdict = await deps.approve({
      connector: req.name,
      tool: `${method} ${u.pathname}${u.search}`,
      args: { method, url: req.url },
      summary: `${req.name}: ${method} ${req.url}`,
    });
    if (!verdict.approved) return { ok: false, error: verdict.reason ?? "the operator did not approve this call", status: 403 };
  }
  const value = deps.keychain.get(appSecretKeychainKey(req.name, req.secret));
  if (!value) return { ok: false, error: `no value stored for secret "${req.secret}"`, status: 404 };
  // Only content negotiation crosses from the sandbox (same discipline as the provision proxy); the
  // secret header is attached LAST so nothing the app sends can shadow it. Default is
  // `Authorization: Bearer <value>`; a slot that names its own header gets the bare value under it.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const key = k.toLowerCase();
    if (key === "content-type" || key === "accept") headers[key] = v;
  }
  const header = slot.header ?? "Authorization";
  headers[header] = header === "Authorization" ? `Bearer ${value}` : value;
  let upstream: Response;
  try {
    upstream = await deps.fetch(req.url, { method, headers, ...(req.body ? { body: req.body } : {}) });
  } catch {
    return { ok: false, error: "the remote could not be reached", status: 502 };
  }
  const contentType = upstream.headers.get("content-type");
  return {
    ok: true,
    status: 200,
    result: { status: upstream.status, body: await upstream.text(), ...(contentType ? { contentType } : {}) },
  };
}

/** Store (value) or clear (null) one app secret slot - console-side, the same trust shape as saving
 *  a pack API key (/api/catalog/apikey): local credential storage in the keychain, no approval gate
 *  (the operator is authorizing their own workspace), and the value never touches the repo or a
 *  response body. A slot the manifest does not declare is refused (fail-closed) - declaring is what
 *  makes a slot exist. */
export function setAppSecret(
  roots: Root[],
  keychain: { set(key: string, value: string): void; delete(key: string): void },
  req: { repo: string; name: string; secret: string; value: string | null },
): { ok: boolean; error?: string; status: number } {
  const grants = appGrants(roots, req.repo, req.name);
  if (!grants) return { ok: false, error: `unknown app: ${req.name}`, status: 404 };
  if (!grants.secrets.some((s) => s.name === req.secret)) {
    return { ok: false, error: `app "${req.name}" declares no secret "${req.secret}"`, status: 403 };
  }
  if (req.value) keychain.set(appSecretKeychainKey(req.name, req.secret), req.value);
  else keychain.delete(appSecretKeychainKey(req.name, req.secret));
  return { ok: true, status: 200 };
}
