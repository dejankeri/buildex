import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldConnector } from "./connector-new.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "buildex-scaffold-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("scaffoldConnector", () => {
  it("generates a connector module and a fixture-based test", () => {
    const res = scaffoldConnector({ name: "hubspot", dir });
    expect(res.files).toContain(join(dir, "hubspot.ts"));
    expect(res.files).toContain(join(dir, "hubspot.test.ts"));

    const mod = readFileSync(join(dir, "hubspot.ts"), "utf8");
    expect(mod).toContain("createHubspotConnector");
    expect(mod).toContain('name: "hubspot"');
    expect(mod).toContain("writeSource"); // uses the read-only-by-construction surface

    const test = readFileSync(join(dir, "hubspot.test.ts"), "utf8");
    expect(test).toContain("runConnectorSync");
    expect(test).toContain("fixture");
  });

  it("rejects an unsafe connector name", () => {
    expect(() => scaffoldConnector({ name: "../evil", dir })).toThrow();
  });

  it("refuses to overwrite an existing connector", () => {
    scaffoldConnector({ name: "hubspot", dir });
    expect(() => scaffoldConnector({ name: "hubspot", dir })).toThrow(/exists/i);
    expect(existsSync(join(dir, "hubspot.ts"))).toBe(true);
  });
});
