// The escape-hatch provisioning flow: a browser round-trip that mints a provider credential the MCP
// connection cannot carry (see PackProvision in catalog.ts).
//
// Shape, and why it is this shape: the operator approves on the PROVIDER's own consent page, which
// redirects back to a loopback path on this daemon carrying a single-use code. The daemon then
// exchanges that code server-to-server. The browser never sees the credential, and the code is
// useless to anyone who did not mint the matching state - so a hostile page that guesses the callback
// URL gets nothing.
//
// Invariant 7 applies exactly as it does to OAuth: the state nonce is one-time and short-TTL, and it
// is validated and CONSUMED before the code is exchanged. A replayed or forged callback never reaches
// the provider. Transport, clock, and randomness are injected so the whole flow is hermetic in tests.
import type { PackProvision } from "./catalog.js";

/** How long the operator has to finish the browser step before the state expires. Generous enough for
 *  a real sign-in (the provider may make them log in first), short enough to bound replay. */
export const PROVISION_STATE_TTL_MS = 10 * 60_000;

export interface ProvisionDeps {
  /** Injected so tests never touch the network. */
  fetch: typeof globalThis.fetch;
  /** Injected clock - drives the state TTL hermetically. */
  now?: () => number;
  /** Injected CSRF nonce source. */
  randomState?: () => string;
  /** A stable label for this machine. Providers use it to name and rotate the credential per device
   *  rather than accumulating one per connect. */
  host?: () => string;
}

export interface ProvisionResult {
  key: string;
  apiBase?: string;
}

/** Walk a dotted path ("data.protocolApiKey") through a parsed JSON body. Returns undefined for any
 *  missing or non-object hop, so a provider that changes its envelope fails loudly at the caller
 *  rather than storing `undefined` as a credential. */
export function dig(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The loopback path a provider redirects back to. Deliberately bare - no query string of its own,
 *  because consent pages commonly append their params with a raw `?`. Namespaced under /oauth/provision
 *  so it can never collide with the MCP gateway's /oauth/<name>/callback or the file connectors'. */
export function provisionRedirectUri(redirectBase: string, id: string): string {
  return `${redirectBase}/oauth/provision/${id}/callback`;
}

export class ProvisionFlow {
  private readonly pending = new Map<string, { state: string; expires: number }>();
  private readonly now: () => number;
  private readonly randomState: () => string;
  private readonly host: () => string;

  constructor(private readonly deps: ProvisionDeps) {
    this.now = deps.now ?? Date.now;
    this.randomState =
      deps.randomState ?? (() => globalThis.crypto.randomUUID().replace(/-/g, ""));
    this.host = deps.host ?? (() => "agent");
  }

  /** Mint a one-time state and build the provider's consent URL. Starting a second flow for the same
   *  pack replaces the first - only the most recent authorize link can complete. */
  begin(id: string, p: PackProvision, redirectBase: string): { authorizeUrl: string; grants: string } {
    const state = this.randomState();
    this.pending.set(id, { state, expires: this.now() + PROVISION_STATE_TTL_MS });
    const authorizeUrl = p.authorizeUrl
      .replace("{redirect_uri}", encodeURIComponent(provisionRedirectUri(redirectBase, id)))
      .replace("{state}", encodeURIComponent(state));
    return { authorizeUrl, grants: p.grants };
  }

  /** Validate + consume the state, then exchange the code for the credential. Throws with an operator-
   *  readable message on every failure path; never returns a partial result. */
  async finish(id: string, p: PackProvision, params: URLSearchParams): Promise<ProvisionResult> {
    const pend = this.pending.get(id);
    // Consume FIRST, unconditionally: a wrong or expired state must not leave the nonce usable for a
    // second attempt.
    this.pending.delete(id);
    const state = params.get("state");
    if (!pend || !state || state !== pend.state) throw new Error("authorization state did not match - start the connection again");
    if (this.now() > pend.expires) throw new Error("authorization expired - start the connection again");

    const code = params.get(p.codeParam ?? "code");
    if (!code) throw new Error("the provider did not return an authorization code");

    const body: Record<string, string> = { [p.codeField ?? "code"]: code };
    if (p.hostField) body[p.hostField] = this.host();

    const res = await this.deps.fetch(p.exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // These codes are single-use and short-lived by design, so the common failure is a slow browser
      // step rather than anything the operator did wrong - say so instead of echoing a raw status.
      if (res.status === 401) throw new Error("the provider rejected the authorization code (it is single-use and expires quickly) - start the connection again");
      throw new Error(`the provider refused the exchange (HTTP ${res.status})`);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error("the provider's response was not valid JSON");
    }
    const key = dig(parsed, p.keyPath);
    if (typeof key !== "string" || !key.trim()) throw new Error("the provider's response did not contain a credential");
    const apiBase = p.apiBasePath ? dig(parsed, p.apiBasePath) : undefined;
    return { key, ...(typeof apiBase === "string" && apiBase.trim() ? { apiBase } : {}) };
  }
}
