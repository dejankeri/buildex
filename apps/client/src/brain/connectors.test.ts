import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorHub, CATALOG } from "./connectors.js";
import { InMemoryKeychain } from "../keychain/keychain.js";

let repo: string, keychain: InMemoryKeychain, hub: ConnectorHub;
const fixedNow = () => Date.parse("2026-07-16T12:00:00Z");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "buildex-conn-"));
  keychain = new InMemoryKeychain();
  hub = new ConnectorHub({
    repoDir: repo,
    keychain,
    now: fixedNow,
    fixtures: {
      gmail: [{ id: "m1", threadId: "t1", from: "a@x.com", subject: "Hi", date: "2026-07-16T09:00:00Z", body: "hello" }],
      slack: [{ id: "s1", channel: "general", user: "dana", text: "morning", ts: "2026-07-16T08:00:00Z" }],
      notion: [{ id: "p1", title: "Roadmap", markdown: "# Roadmap\n\n- ship", editedAt: "2026-07-16T07:00:00Z" }],
    },
  });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("ConnectorHub - connect + sync the v1 catalog", () => {
  it("lists the catalog with everything disconnected on a fresh workspace", () => {
    const cat = hub.catalog();
    expect(cat.map((c) => c.name).sort()).toEqual(CATALOG.map((c) => c.name).sort());
    expect(cat.every((c) => c.connected === false)).toBe(true);
  });

  it("connect stores the credential in the keychain (never on disk) and flips connected", () => {
    hub.connect("gmail", "oauth-token-abc");
    expect(keychain.get("connector:gmail")).toBe("oauth-token-abc");
    expect(hub.catalog().find((c) => c.name === "gmail")!.connected).toBe(true);
  });

  it("shows a connector as connected when sources/<name>/ already exists (seeded)", () => {
    mkdirSync(join(repo, "sources", "gmail"), { recursive: true });
    writeFileSync(join(repo, "sources", "gmail", "seed.md"), "x");
    expect(hub.catalog().find((c) => c.name === "gmail")!.connected).toBe(true);
  });

  it("sync files material under sources/<name>/ with provenance + a STATUS.md", async () => {
    hub.connect("gmail", "tok");
    const res = await hub.sync("gmail");
    expect(res.wrote).toBe(1);
    const filed = join(repo, "sources", "gmail", "t1.md");
    expect(existsSync(filed)).toBe(true);
    expect(readFileSync(filed, "utf8")).toContain("source: gmail");
    expect(readFileSync(filed, "utf8")).toContain("# Hi");
    expect(existsSync(join(repo, "sources", "gmail", "STATUS.md"))).toBe(true);
    // lastSync now surfaces in the catalog
    expect(hub.catalog().find((c) => c.name === "gmail")!.lastSync).toBeTruthy();
  });

  it("refuses sync for an unknown connector", async () => {
    await expect(hub.sync("dropbox")).rejects.toThrow(/unknown connector/i);
  });
});

// A8 - fabricated demo material must never be filed into a real brain. Fixtures are an explicit
// opt-in (the `fixtures` option, or the demo entrypoint's BUILDEX_DEMO_FIXTURES=1); without it, an
// unconfigured or half-authorized connector refuses to sync instead of silently writing fakes.
describe("ConnectorHub - fixtures never reach a real brain (A8)", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env["BUILDEX_DEMO_FIXTURES"];
    delete process.env["BUILDEX_DEMO_FIXTURES"]; // these tests control the demo opt-in themselves
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env["BUILDEX_DEMO_FIXTURES"];
    else process.env["BUILDEX_DEMO_FIXTURES"] = savedEnv;
  });

  it("OAuth configured but not yet authorized: sync refuses and files NOTHING (no fixture fallback)", async () => {
    const h = new ConnectorHub({ repoDir: repo, keychain, now: fixedNow, oauthClients: { gmail: { clientId: "cid" } } });
    expect(h.needsAuth("gmail")).toBe(true);
    await expect(h.sync("gmail")).rejects.toThrow(/not authorized/i);
    expect(existsSync(join(repo, "sources"))).toBe(false);
  });

  it("…even when fixtures are explicitly enabled - a configured provider always wins over demo data", async () => {
    const h = new ConnectorHub({ repoDir: repo, keychain, now: fixedNow, fixtures: true, oauthClients: { gmail: { clientId: "cid" } } });
    await expect(h.sync("gmail")).rejects.toThrow(/not authorized/i);
    expect(existsSync(join(repo, "sources"))).toBe(false);
  });

  it("no provider configured and no fixtures opt-in: sync refuses and files nothing", async () => {
    const h = new ConnectorHub({ repoDir: repo, keychain, now: fixedNow });
    await expect(h.sync("gmail")).rejects.toThrow(/no provider configured/i);
    // A stored credential alone doesn't conjure data either - there is no live API behind it yet.
    h.connect("slack", "apikey-123");
    await expect(h.sync("slack")).rejects.toThrow(/no provider configured/i);
    expect(existsSync(join(repo, "sources"))).toBe(false);
  });

  it("fixtures: true opts into the built-in demo set (the demo experience, unchanged)", async () => {
    const h = new ConnectorHub({ repoDir: repo, keychain, now: fixedNow, fixtures: true });
    const res = await h.sync("gmail");
    expect(res.wrote).toBe(2);
    const filed = join(repo, "sources", "gmail", "globex-kickoff.md");
    expect(existsSync(filed)).toBe(true);
    expect(readFileSync(filed, "utf8")).toContain("dana@globex.com");
  });

  it("BUILDEX_DEMO_FIXTURES=1 opts in via the env - the seam the demo entrypoint uses", async () => {
    process.env["BUILDEX_DEMO_FIXTURES"] = "1";
    const h = new ConnectorHub({ repoDir: repo, keychain, now: fixedNow });
    const res = await h.sync("gmail");
    expect(res.wrote).toBe(2);
    expect(existsSync(join(repo, "sources", "gmail", "STATUS.md"))).toBe(true);
  });
});
