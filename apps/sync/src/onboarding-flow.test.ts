import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, type Services } from "./server.js";

const KEY = "k".repeat(32);
let dir: string;
let services: Services;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "buildex-onboard-"));
  services = await createServices({
    serviceKey: KEY,
    publicBaseUrl: "https://sync.example.test",
    dataDir: dir,
    port: 0,
  });
});

afterEach(() => {
  services.close();
  rmSync(dir, { recursive: true, force: true });
});

function s2s(path: string, body: unknown): Request {
  return new Request(`http://sync.test${path}`, {
    method: "POST",
    headers: { "x-service-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("founder onboarding sequence", () => {
  it("creates a company and operator, then mints a usable setup token", async () => {
    expect((await services.handler(s2s("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }))).status).toBe(201);
    expect(
      (await services.handler(s2s("/s2s/operators", { id: "o1", companyId: "c1", email: "a@example.test" }))).status,
    ).toBe(201);

    const minted = await services.handler(s2s("/s2s/setup-tokens", { operatorId: "o1" }));
    expect(minted.status).toBe(200);
    const { setupToken } = (await minted.json()) as { setupToken: string };
    expect(setupToken).toMatch(/^xsetup_/);

    // The whole point of the token: it provisions, and the clone URLs use the configured base URL.
    const provisioned = await services.handler(
      new Request("http://sync.test/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupToken, machineName: "laptop" }),
      }),
    );
    expect(provisioned.status).toBe(200);
    const creds = (await provisioned.json()) as { repos: { core: string; team: string; private: string } };
    expect(creds.repos.core).toBe("https://sync.example.test/git/core.git");
    expect(creds.repos.team).toBe("https://sync.example.test/git/team-acme.git");
  });

  it("rejects the whole sequence without the service key", async () => {
    const res = await services.handler(
      new Request("http://sync.test/s2s/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "c1", slug: "acme", name: "Acme" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
