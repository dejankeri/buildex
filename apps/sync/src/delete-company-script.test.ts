// Script-level coverage for scripts/delete-company.ts. company-delete.test.ts proves the route;
// this proves the *script* drives it correctly - the method, the header, the slug encoding, and the
// 404 branch a caller needs in order to tell "already gone" from "the call failed". `fetchImpl` is
// injected so this runs with no network.
import { describe, it, expect } from "vitest";
import { deleteCompany, S2sError, type DeleteDeps } from "../../../scripts/delete-company.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function fakeFetch(calls: RecordedCall[], status: number, body: unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(input), method: init?.method ?? "GET", headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
}

const deps = (fetchImpl: typeof fetch): DeleteDeps => ({
  baseUrl: "https://sync.example.test",
  serviceKey: "svc-key",
  fetchImpl,
});

describe("scripts/delete-company.ts", () => {
  it("DELETEs the slug with the service key and returns the removed repos", async () => {
    const calls: RecordedCall[] = [];
    const out = await deleteCompany(
      deps(fakeFetch(calls, 200, { ok: true, slug: "acme", repos: ["team-acme", "private-o1"] })),
      "acme",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://sync.example.test/s2s/companies/acme");
    // The key travels in the header, never the URL - a URL lands in access logs.
    expect(calls[0]!.headers["x-service-key"]).toBe("svc-key");
    expect(out.repos).toEqual(["team-acme", "private-o1"]);
  });

  it("percent-encodes the slug rather than splicing it into the path raw", async () => {
    const calls: RecordedCall[] = [];
    await deleteCompany(deps(fakeFetch(calls, 200, { ok: true, slug: "a b", repos: [] })), "a b");
    expect(calls[0]!.url).toBe("https://sync.example.test/s2s/companies/a%20b");
  });

  it("throws S2sError(404) for an unknown slug, so a caller can say 'already gone'", async () => {
    const err = await deleteCompany(deps(fakeFetch([], 404, { error: "company not found" })), "ghost").catch((e) => e);
    expect(err).toBeInstanceOf(S2sError);
    expect((err as S2sError).status).toBe(404);
  });

  it("throws with the status on any other failure rather than reporting success", async () => {
    const err = await deleteCompany(deps(fakeFetch([], 401, { error: "unauthorized" })), "acme").catch((e) => e);
    expect((err as S2sError).status).toBe(401);
  });
});
