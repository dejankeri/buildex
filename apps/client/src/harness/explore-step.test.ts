import { describe, it, expect } from "vitest";
import { buildExplorePrompt, exploreData } from "./explore-step.js";
import type { AgentDriver, RunPromptOpts, UiEvent } from "../agent/types.js";
import type { Surface } from "./discover.js";

const SURFACE: Surface = {
  pack: "acme",
  skills: [{ name: "acme-howto", description: "How to use Acme" }],
  tools: [{ name: "acme_search", description: "Search Acme records" }],
};

// Same house fake-driver idiom as the other step tests: a tiny async generator over a fixed UiEvent
// array, with `seen` capturing the RunPromptOpts the driver was invoked with.
function fakeDriver(events: UiEvent[]): { driver: AgentDriver; seen: RunPromptOpts[] } {
  const seen: RunPromptOpts[] = [];
  const driver = {
    detect: async () => ({ available: true }),
    // eslint-disable-next-line @typescript-eslint/require-await
    runPrompt: async function* (o: RunPromptOpts) {
      seen.push(o);
      for (const e of events) yield e;
    },
  } as unknown as AgentDriver;
  return { driver, seen };
}

describe("buildExplorePrompt", () => {
  it("embeds the surface and constrains the explorer to read-only with no inventing", () => {
    const p = buildExplorePrompt(SURFACE);
    const flat = p.replace(/\s+/g, " "); // the prompt wraps mid-phrase; match on flattened whitespace
    expect(p).toContain('"acme_search"'); // the surface tool is present verbatim
    expect(flat).toMatch(/read-only/i);
    expect(flat).toMatch(/never create, update, delete/i);
    expect(flat).toMatch(/do not invent/i);
    expect(flat).toMatch(/only what the tools actually return/i);
  });
});

describe("exploreData", () => {
  it("returns the explorer's catalog text (redacted) and passes the read-only allowedTools + strict-mcp config", async () => {
    const { driver, seen } = fakeDriver([
      { kind: "text", text: "Clients: Tom Alvarez, Mary Moore.\nKey leaked: pk_secret123" } as UiEvent,
      { kind: "done" } as UiEvent,
    ]);
    const out = await exploreData(driver, {
      workspace: "/disc",
      surface: SURFACE,
      allowedTools: ["mcp__buildex-pack_acme", "Read"],
      mcpConfigPath: "/disc/.mcp.json",
      redact: ["pk_secret123"],
    });
    expect(out).toContain("Tom Alvarez");
    expect(out).not.toContain("pk_secret123"); // any known secret scrubbed from the catalog
    expect(seen[0]!.allowedTools).toEqual(["mcp__buildex-pack_acme", "Read"]);
    expect(seen[0]!.mcpConfigPath).toBe("/disc/.mcp.json");
  });

  it("is fail-soft: returns '' on an error event so the caller falls back to ungrounded generation", async () => {
    const { driver } = fakeDriver([
      { kind: "text", text: "partial" } as UiEvent,
      { kind: "error", message: "boom" } as UiEvent,
    ]);
    const out = await exploreData(driver, { workspace: "/d", surface: SURFACE, allowedTools: [], redact: [] });
    expect(out).toBe("");
  });

  it("is fail-soft: returns '' when the explorer produced no text at all", async () => {
    const { driver } = fakeDriver([{ kind: "done" } as UiEvent]);
    const out = await exploreData(driver, { workspace: "/d", surface: SURFACE, allowedTools: [], redact: [] });
    expect(out).toBe("");
  });
});
