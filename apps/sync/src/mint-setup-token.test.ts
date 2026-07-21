// Script-level coverage for scripts/mint-setup-token.ts. onboarding-flow.test.ts already proves the
// S2S routes support the sequence; this file proves the *script* drives them correctly - the exact
// field mapping (operator -> company id), request shape, and error handling that a route-only test
// can never see. `fetchImpl` is injected precisely so this can run with no network.
import { describe, it, expect } from "vitest";
import { onboard, mintForOperator, arg, type MintDeps } from "../../../scripts/mint-setup-token.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  calls: RecordedCall[],
  responder: (call: RecordedCall) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status, body } = responder(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const BASE = "https://sync.example.test";
const KEY = "k".repeat(32);

describe("onboard", () => {
  it("calls the three S2S endpoints in order, with the service key and JSON content type on each", async () => {
    const calls: RecordedCall[] = [];
    // The last call (/s2s/setup-tokens) needs a real token in its response.
    const withToken = fakeFetch(calls, (call) => {
      if (call.url.endsWith("/s2s/setup-tokens")) return { status: 200, body: { setupToken: "xsetup_abc123" } };
      return { status: 201, body: { ok: true } };
    });
    const deps: MintDeps = { baseUrl: BASE, serviceKey: KEY, fetchImpl: withToken };

    await onboard(deps, { companySlug: "acme", companyName: "Acme Labs", email: "operator@example.test" });

    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/s2s/companies`,
      `${BASE}/s2s/operators`,
      `${BASE}/s2s/setup-tokens`,
    ]);

    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.headers["x-service-key"]).toBe(KEY);
      expect(call.headers["content-type"]).toBe("application/json");
    }
  });

  it("references the just-created company id in the operator request (the field-mapping bug)", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch(calls, (call) => {
      if (call.url.endsWith("/s2s/setup-tokens")) return { status: 200, body: { setupToken: "xsetup_abc123" } };
      return { status: 201, body: { ok: true } };
    });
    const deps: MintDeps = { baseUrl: BASE, serviceKey: KEY, fetchImpl };

    const out = await onboard(deps, { companySlug: "acme", companyName: "Acme Labs", email: "operator@example.test" });

    const companyCall = calls[0]!;
    const operatorCall = calls[1]!;
    const tokenCall = calls[2]!;

    const companyBody = companyCall.body as { id: string; slug: string; name: string };
    const operatorBody = operatorCall.body as { id: string; companyId: string; email: string };
    const tokenBody = tokenCall.body as { operatorId: string };

    expect(companyBody.slug).toBe("acme");
    expect(companyBody.name).toBe("Acme Labs");
    // This is the assertion a route-only test cannot make: the operator must reference the
    // company id this same call just generated, not some other id.
    expect(operatorBody.companyId).toBe(companyBody.id);
    expect(operatorBody.email).toBe("operator@example.test");
    expect(tokenBody.operatorId).toBe(operatorBody.id);

    expect(out.companyId).toBe(companyBody.id);
    expect(out.operatorId).toBe(operatorBody.id);
    expect(out.setupToken).toBe("xsetup_abc123");
  });

  it("throws an operator-facing error naming the likely cause when /s2s/companies fails", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch(calls, () => ({ status: 500, body: { error: "internal error" } }));
    const deps: MintDeps = { baseUrl: BASE, serviceKey: KEY, fetchImpl };

    await expect(
      onboard(deps, { companySlug: "acme", companyName: "Acme Labs", email: "operator@example.test" }),
    ).rejects.toThrow(/slug/i);

    // Only the company call should have gone out - the failure must stop the sequence.
    expect(calls).toHaveLength(1);

    await expect(
      onboard(deps, { companySlug: "acme", companyName: "Acme Labs", email: "operator@example.test" }),
    ).rejects.toThrow(/--operator-id/);

    // The original error text must still be present so a genuine 500 stays diagnosable.
    await expect(
      onboard(deps, { companySlug: "acme", companyName: "Acme Labs", email: "operator@example.test" }),
    ).rejects.toThrow(/internal error/);
  });

  it("propagates a 401 from /s2s/companies untouched - a bad service key is not a slug problem", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch(calls, () => ({ status: 401, body: { error: "bad service key" } }));
    const deps: MintDeps = { baseUrl: BASE, serviceKey: KEY, fetchImpl };

    let caught: Error | undefined;
    try {
      await onboard(deps, { companySlug: "acme", companyName: "Acme Labs", email: "operator@example.test" });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/bad service key/);
    expect(caught?.message).not.toMatch(/slug/i);
    expect(caught?.message).not.toMatch(/already exist/i);
  });

  it("still attaches the duplicate-slug guidance for a 500, and keeps the original error text", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch(calls, () => ({ status: 500, body: { error: "internal error" } }));
    const deps: MintDeps = { baseUrl: BASE, serviceKey: KEY, fetchImpl };

    let caught: Error | undefined;
    try {
      await onboard(deps, { companySlug: "acme", companyName: "Acme Labs", email: "operator@example.test" });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/slug/i);
    expect(caught?.message).toMatch(/already exist/i);
    expect(caught?.message).toMatch(/internal error/);
  });

  it("propagates a network rejection from fetchImpl untouched - no slug framing invented", async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error("fetch failed: ECONNREFUSED"));
    const deps: MintDeps = { baseUrl: BASE, serviceKey: KEY, fetchImpl };

    let caught: Error | undefined;
    try {
      await onboard(deps, { companySlug: "acme", companyName: "Acme Labs", email: "operator@example.test" });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/ECONNREFUSED/);
    expect(caught?.message).not.toMatch(/slug/i);
    expect(caught?.message).not.toMatch(/already exist/i);
  });
});

describe("mintForOperator", () => {
  it("posts only to /s2s/setup-tokens with the given operator id, and returns the token", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch(calls, () => ({ status: 200, body: { setupToken: "xsetup_reissued" } }));
    const deps: MintDeps = { baseUrl: BASE, serviceKey: KEY, fetchImpl };

    const token = await mintForOperator(deps, "op_existing");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/s2s/setup-tokens`);
    const tokenBody = calls[0]!.body as { operatorId: string };
    expect(tokenBody.operatorId).toBe("op_existing");
    expect(token).toBe("xsetup_reissued");
  });

  it("throws naming the failing path and status on a non-OK response", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = fakeFetch(calls, () => ({ status: 404, body: { error: "operator not found" } }));
    const deps: MintDeps = { baseUrl: BASE, serviceKey: KEY, fetchImpl };

    await expect(mintForOperator(deps, "op_missing")).rejects.toThrow(/\/s2s\/setup-tokens/);
    await expect(mintForOperator(deps, "op_missing")).rejects.toThrow(/404/);
  });
});

describe("arg", () => {
  it("returns undefined when the next token starts with --, instead of treating it as a value", () => {
    const original = process.argv;
    try {
      process.argv = [...original.slice(0, 2), "--company-slug", "--email", "a@example.test"];
      expect(arg("company-slug")).toBeUndefined();
    } finally {
      process.argv = original;
    }
  });

  it("still returns a normal value when the flag is followed by a non-flag token", () => {
    const original = process.argv;
    try {
      process.argv = [...original.slice(0, 2), "--company-slug", "acme"];
      expect(arg("company-slug")).toBe("acme");
    } finally {
      process.argv = original;
    }
  });
});
