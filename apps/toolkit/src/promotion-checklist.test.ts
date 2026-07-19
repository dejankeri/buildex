import { describe, it, expect } from "vitest";
import { validateVerb } from "./promotion-checklist.js";

const goodVerb = `---
name: tidy
description: Use when the workspace has drifted - loose files, stale drafts, or inconsistent naming - and you want it organized to the conventions without losing anything.
---

# tidy - housekeep the workspace to its conventions

Reorganizes files to match conventions.md, as support, never destructively.

## When to use

- A backfill or a busy week left files loose or inconsistently named.

## Steps

1. Read conventions.md and survey the workspace.
2. Propose moves/renames as a reviewable diff.

## Rules

- Never delete; supersede and archive. Every change is a reviewable commit.
`;

describe("validateVerb (the promotion checklist)", () => {
  it("passes a well-formed verb", () => {
    const res = validateVerb(goodVerb);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it("flags a missing description", () => {
    const res = validateVerb(`---\nname: tidy\n---\n# tidy\n## When to use\n- x\n## Steps\n1. y\n`);
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toMatch(/description/i);
  });

  it("flags a non-kebab-case name", () => {
    const res = validateVerb(goodVerb.replace("name: tidy", "name: Tidy Workspace"));
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toMatch(/name/i);
  });

  it("flags a description that is not trigger-oriented", () => {
    const res = validateVerb(goodVerb.replace(/description: .*/, "description: Tidies the workspace."));
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toMatch(/trigger|use when/i);
  });

  it("flags a verb with no 'when to use' or steps", () => {
    const res = validateVerb(`---\nname: tidy\ndescription: Use when things drift and you want them organized.\n---\n# tidy\n\nDoes stuff.\n`);
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toMatch(/when to use|steps/i);
  });
});
