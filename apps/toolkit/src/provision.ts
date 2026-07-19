// `toolkit provision` - one-command company setup. Drives the sync service's S2S
// provisioning API (the primary provisioning surface): create the company, create the first
// operator, and mint a setup token the operator redeems from the desktop app ("Log in with buildex").
// Fetch is injected so the command is testable without a running service.
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProvisionDeps {
  fetch: FetchLike;
  /** Base URL of the sync service, e.g. https://sync.buildexponential.org. */
  syncUrl: string;
  /** The S2S service key (from the operator's environment, never committed). */
  serviceKey: string;
}

export interface ProvisionOpts {
  companyId: string;
  slug: string;
  name: string;
  operatorId: string;
  email: string;
}

export async function provisionCompany(deps: ProvisionDeps, opts: ProvisionOpts): Promise<{ setupToken: string }> {
  await s2s(deps, "/s2s/companies", { id: opts.companyId, slug: opts.slug, name: opts.name });
  await s2s(deps, "/s2s/operators", { id: opts.operatorId, companyId: opts.companyId, email: opts.email });
  const minted = (await s2s(deps, "/s2s/setup-tokens", { operatorId: opts.operatorId })) as { setupToken: string };
  return { setupToken: minted.setupToken };
}

async function s2s(deps: ProvisionDeps, path: string, body: unknown): Promise<unknown> {
  const res = await deps.fetch(`${deps.syncUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-service-key": deps.serviceKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`provision step ${path} failed: ${res.status}`);
  }
  return res.json();
}
