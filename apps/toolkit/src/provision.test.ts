import { describe, it, expect } from "vitest";
import { provisionCompany, type FetchLike } from "./provision.js";

/** A fake fetch that records requests and returns canned JSON per path. */
function fakeFetch(responses: Record<string, unknown>) {
  const calls: { url: string; method: string; serviceKey: string | null; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      serviceKey: new Headers(init?.headers).get("x-service-key"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responses[path] ?? { ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("provisionCompany", () => {
  it("creates the company, the operator, and mints a setup token - all service-key gated", async () => {
    const { fetch, calls } = fakeFetch({ "/s2s/setup-tokens": { setupToken: "xsetup_abc123" } });
    const res = await provisionCompany(
      { fetch, syncUrl: "https://sync.buildexponential.org", serviceKey: "svc-key" },
      { companyId: "c1", slug: "northwind", name: "Northwind Labs", operatorId: "dan", email: "dan@northwind.co" },
    );

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/s2s/companies", "/s2s/operators", "/s2s/setup-tokens"]);
    expect(calls.every((c) => c.serviceKey === "svc-key")).toBe(true);
    expect(calls[0]!.body).toMatchObject({ id: "c1", slug: "northwind", name: "Northwind Labs" });
    expect(calls[1]!.body).toMatchObject({ id: "dan", companyId: "c1", email: "dan@northwind.co" });
    expect(calls[2]!.body).toMatchObject({ operatorId: "dan" });
    expect(res.setupToken).toBe("xsetup_abc123");
  });

  it("throws if the service rejects a step", async () => {
    const fetch: FetchLike = async () => new Response("nope", { status: 401 });
    await expect(
      provisionCompany({ fetch, syncUrl: "https://sync.test", serviceKey: "bad" }, { companyId: "c1", slug: "s", name: "n", operatorId: "o", email: "e@x" }),
    ).rejects.toThrow();
  });
});
