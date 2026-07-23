// The sentence an operator reads hours after the run that produced it, so it has to name the action
// without leaking a payload.
import { describe, it, expect } from "vitest";
import { describeTool } from "./describe.js";

describe("describeTool", () => {
  it("prefers a connector's own summary", () => {
    expect(describeTool({ name: "mcp:asana.create", input: { summary: "Create a task in Marketing" } })).toBe(
      "Create a task in Marketing",
    );
  });

  it("names the recipient of an email", () => {
    expect(describeTool({ name: "mcp:gmail.send", input: { tool: "send", args: { to: "ops@acme.com" } } })).toBe(
      "send an email to ops@acme.com",
    );
    expect(describeTool({ name: "SendEmail", input: { to: "ops@acme.com" } })).toBe("send an email to ops@acme.com");
  });

  it("names a skill, a fetch and a search", () => {
    expect(describeTool({ name: "Skill", input: { skill: "weekly-review" } })).toBe("run the weekly-review skill");
    expect(describeTool({ name: "WebFetch", input: { url: "https://example.com/a/b?c=d" } })).toBe("fetch example.com");
    expect(describeTool({ name: "WebSearch", input: { query: "acme pricing" } })).toBe('search the web for "acme pricing"');
  });

  it("quotes a shell command and clips a long one", () => {
    expect(describeTool({ name: "Bash", input: { command: "git push" } })).toBe("run `git push`");
    const long = describeTool({ name: "Bash", input: { command: "x".repeat(200) } });
    expect(long.length).toBeLessThan(70);
    expect(long).toContain("…");
  });

  it("falls back to the tool name rather than dumping its input", () => {
    expect(describeTool({ name: "SomeTool", input: { token: "sk-secret", nested: { a: 1 } } })).toBe("use SomeTool");
  });

  it("survives a malformed invocation", () => {
    expect(describeTool({ name: "WebFetch", input: { url: "not a url" } })).toBe("fetch not a url");
    expect(describeTool({ name: "Odd", input: {} })).toBe("use Odd");
  });
});
