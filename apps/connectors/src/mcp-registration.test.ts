import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_SERVER_KEY,
  PACK_KEY_PREFIX,
  renderMcpJson,
  renderMcpEntries,
  writeGatewayRegistration,
  removeGatewayRegistration,
} from "./mcp-registration.js";

const URL = "http://127.0.0.1:4317/mcp/gateway";

describe("renderMcpJson - register BuildEx's gateway without clobbering the operator's servers", () => {
  it("adds the gateway as an http MCP server when none exists", () => {
    const doc = JSON.parse(renderMcpJson(undefined, { url: URL }));
    expect(doc.mcpServers[GATEWAY_SERVER_KEY]).toEqual({ type: "http", url: URL });
  });

  it("preserves other mcpServers already present", () => {
    const existing = JSON.stringify({ mcpServers: { "some-other": { command: "foo" } } });
    const doc = JSON.parse(renderMcpJson(existing, { url: URL }));
    expect(doc.mcpServers["some-other"]).toEqual({ command: "foo" });
    expect(doc.mcpServers[GATEWAY_SERVER_KEY]).toEqual({ type: "http", url: URL });
  });

  it("is idempotent - rendering twice yields identical output", () => {
    const once = renderMcpJson(undefined, { url: URL });
    const twice = renderMcpJson(once, { url: URL });
    expect(twice).toBe(once);
  });

  it("removes only the gateway entry when passed null, leaving others intact", () => {
    const existing = renderMcpJson(JSON.stringify({ mcpServers: { keep: { command: "x" } } }), { url: URL });
    const doc = JSON.parse(renderMcpJson(existing, null));
    expect(doc.mcpServers[GATEWAY_SERVER_KEY]).toBeUndefined();
    expect(doc.mcpServers.keep).toEqual({ command: "x" });
  });

  it("tolerates a corrupt existing file (starts fresh)", () => {
    const doc = JSON.parse(renderMcpJson("{ not json", { url: URL }));
    expect(doc.mcpServers[GATEWAY_SERVER_KEY]).toEqual({ type: "http", url: URL });
  });

  it("carries the gateway bearer headers into the entry (the agent's MCP client sends them - A3)", () => {
    const doc = JSON.parse(renderMcpJson(undefined, { url: URL, headers: { Authorization: "Bearer tok123" } }));
    expect(doc.mcpServers[GATEWAY_SERVER_KEY]).toEqual({ type: "http", url: URL, headers: { Authorization: "Bearer tok123" } });
  });
});

describe("renderMcpEntries (multi-entry - pack pins)", () => {
  it("merges http + stdio entries while preserving operator servers and the gateway key", () => {
    const existing = JSON.stringify({
      mcpServers: {
        [GATEWAY_SERVER_KEY]: { type: "http", url: "http://127.0.0.1:1/mcp" },
        "operator-thing": { type: "stdio", command: "foo" },
      },
    });
    const out = JSON.parse(renderMcpEntries(existing, {
      [`${PACK_KEY_PREFIX}notion`]: { type: "http", url: "https://mcp.notion.com/mcp" },
      [`${PACK_KEY_PREFIX}local`]: { type: "stdio", command: "npx", args: ["-y", "@x/mcp"] },
    }));
    expect(out.mcpServers[`${PACK_KEY_PREFIX}notion`]).toEqual({ type: "http", url: "https://mcp.notion.com/mcp" });
    expect(out.mcpServers[`${PACK_KEY_PREFIX}local`].command).toBe("npx");
    expect(out.mcpServers[GATEWAY_SERVER_KEY]).toBeDefined();
    expect(out.mcpServers["operator-thing"]).toBeDefined();
  });

  it("removes an entry when its value is null, leaving others intact", () => {
    const existing = JSON.stringify({ mcpServers: { [`${PACK_KEY_PREFIX}a`]: { type: "http", url: "https://a" }, keep: {} } });
    const out = JSON.parse(renderMcpEntries(existing, { [`${PACK_KEY_PREFIX}a`]: null }));
    expect(out.mcpServers[`${PACK_KEY_PREFIX}a`]).toBeUndefined();
    expect(out.mcpServers.keep).toBeDefined();
  });

  it("renderMcpJson still merges only the single gateway key (regression)", () => {
    const out = JSON.parse(renderMcpJson(undefined, { url: "http://127.0.0.1:2/mcp" }));
    expect(out.mcpServers[GATEWAY_SERVER_KEY]).toEqual({ type: "http", url: "http://127.0.0.1:2/mcp" });
  });
});

describe("writeGatewayRegistration / removeGatewayRegistration", () => {
  it("writes .mcp.json at the workspace root and can remove itself", () => {
    const ws = mkdtempSync(join(tmpdir(), "buildex-mcp-"));
    const path = writeGatewayRegistration(ws, { url: URL });
    expect(path).toBe(join(ws, ".mcp.json"));
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers[GATEWAY_SERVER_KEY].url).toBe(URL);

    removeGatewayRegistration(ws);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers[GATEWAY_SERVER_KEY]).toBeUndefined();
    expect(existsSync(path)).toBe(true); // file stays (may hold other servers)
  });

  it("merges into an operator's pre-existing .mcp.json on disk", () => {
    const ws = mkdtempSync(join(tmpdir(), "buildex-mcp-"));
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "y" } } }));
    writeGatewayRegistration(ws, { url: URL });
    const doc = JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8"));
    expect(doc.mcpServers.mine).toEqual({ command: "y" });
    expect(doc.mcpServers[GATEWAY_SERVER_KEY].url).toBe(URL);
  });
});
