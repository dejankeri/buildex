import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confinePath } from "./confine-path.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-confine-"));
  mkdirSync(join(dir, "team", "notes"), { recursive: true });
  writeFileSync(join(dir, "team", "notes", "a.md"), "# a\n");
  // A sibling whose name string-prefix-matches the base - the payload bare startsWith() accepted.
  mkdirSync(join(dir, "team-evil"));
  writeFileSync(join(dir, "team-evil", "evil.md"), "evil\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("confinePath - the one shared path-confinement implementation", () => {
  it("accepts a benign nested path to an existing file", () => {
    expect(confinePath(join(dir, "team"), "notes/a.md")).toBe(join(dir, "team", "notes", "a.md"));
  });

  it("accepts a target that does not exist yet (saveDoc/writeSkillFile create files)", () => {
    expect(confinePath(join(dir, "team"), "new/deep/idea.md")).toBe(join(dir, "team", "new", "deep", "idea.md"));
  });

  it("accepts the base itself and confines within a base dir that hasn't been created yet", () => {
    expect(confinePath(join(dir, "team"), ".")).toBe(join(dir, "team"));
    // A fresh repo's skills/ or apps/ doesn't exist until the first write - still confined.
    expect(confinePath(join(dir, "team", "skills"), "my-verb")).toBe(join(dir, "team", "skills", "my-verb"));
    expect(confinePath(join(dir, "team", "skills"), "../../../team-evil")).toBeNull();
  });

  it("rejects the sibling-prefix payload (team/../team-evil string-prefix-matches team)", () => {
    expect(confinePath(join(dir, "team"), "../team-evil/evil.md")).toBeNull();
  });

  it("rejects plain .. traversal and an absolute rel", () => {
    expect(confinePath(join(dir, "team"), "../../etc/passwd")).toBeNull();
    expect(confinePath(join(dir, "team"), "/etc/passwd")).toBeNull();
  });

  it("rejects a symlink inside the base pointing outside it (existing target)", () => {
    symlinkSync(join(dir, "team-evil"), join(dir, "team", "out"));
    expect(confinePath(join(dir, "team"), "out/evil.md")).toBeNull();
  });

  it("rejects a write path THROUGH an escaping symlinked dir when the target doesn't exist yet", () => {
    symlinkSync(join(dir, "team-evil"), join(dir, "team", "out"));
    // The deepest existing ancestor (team/out) canonicalizes outside the base → refused.
    expect(confinePath(join(dir, "team"), "out/new.md")).toBeNull();
  });

  it("rejects a dangling symlink (a write through it would land wherever it points)", () => {
    symlinkSync(join(dir, "nowhere", "ghost.md"), join(dir, "team", "dangle.md"));
    expect(confinePath(join(dir, "team"), "dangle.md")).toBeNull();
  });

  it("survives an aliased base (the macOS /var -> /private/var trap): own files still accepted", () => {
    // mkdtemp under tmpdir IS this case on macOS; emulate the alias explicitly so the test also
    // bites on Linux: the caller addresses the base through a symlink, files must still resolve.
    const alias = join(dir, "alias-to-team");
    symlinkSync(join(dir, "team"), alias);
    expect(confinePath(alias, "notes/a.md")).toBe(join(alias, "notes", "a.md"));
    // …and escapes through the alias are still refused.
    expect(confinePath(alias, "../team-evil/evil.md")).toBeNull();
  });
});
