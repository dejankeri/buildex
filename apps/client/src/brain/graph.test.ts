import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, changedDocs } from "./graph.js";
import { execFileSync } from "node:child_process";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-graph-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, content: string) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

describe("buildGraph", () => {
  it("emits a file node per markdown doc, prefixed by root name", () => {
    write("a.md", "# A\n");
    write("sub/b.md", "# B\n");
    const g = buildGraph([{ name: "team", dir }]);
    const ids = g.nodes.filter((n) => n.kind === "file").map((n) => n.id);
    expect(ids).toContain("team/a.md");
    expect(ids).toContain("team/sub/b.md");
  });

  it("links [[wikilinks]] by basename", () => {
    write("a.md", "see [[b]]\n");
    write("b.md", "# B\n");
    const g = buildGraph([{ name: "team", dir }]);
    expect(g.edges).toContainEqual({ from: "team/a.md", to: "team/b.md", kind: "link" });
  });

  it("links relative [text](path.md) markdown links", () => {
    write("a.md", "see [the b](b.md)\n");
    write("b.md", "# B\n");
    const g = buildGraph([{ name: "team", dir }]);
    expect(g.edges).toContainEqual({ from: "team/a.md", to: "team/b.md", kind: "link" });
  });

  it("ignores .git, .conflicts and dot-directories", () => {
    write("a.md", "# A\n");
    write(".conflicts/2026/old.md", "# old\n");
    write(".git/HEAD", "ref: x\n");
    const g = buildGraph([{ name: "team", dir }]);
    const ids = g.nodes.map((n) => n.id);
    expect(ids.some((i) => i.includes(".conflicts"))).toBe(false);
    expect(ids.some((i) => i.includes(".git"))).toBe(false);
  });

  it("excludes skill manifests (skills/<name>/SKILL.md) so the map isn't flooded with tooling", () => {
    write("charter.md", "# Charter\n");
    write("skills/weekly-review/SKILL.md", "# weekly-review\n");
    write("skills/capture-decision/SKILL.md", "# capture-decision\n");
    const g = buildGraph([{ name: "core", dir }]);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("core/charter.md");
    expect(ids.some((i) => i.endsWith("SKILL.md"))).toBe(false);
  });

  it("DETERMINISM INVARIANT: double-render produces byte-identical output", () => {
    write("a.md", "[[b]] and [[c]]\n");
    write("b.md", "[[a]]\n");
    write("c.md", "# C\n");
    const first = buildGraph([{ name: "team", dir }]);
    const second = buildGraph([{ name: "team", dir }]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("changedDocs", () => {
  it("lists markdown files changed vs the git index", () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
    execFileSync("git", ["init", "--initial-branch=main", dir], { env });
    write("committed.md", "# c\n");
    execFileSync("git", ["add", "."], { cwd: dir, env });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: dir, env });
    write("committed.md", "# changed\n");
    write("new.md", "# new\n");
    const changed = changedDocs(dir);
    expect(changed).toContain("committed.md");
    expect(changed).toContain("new.md");
  });
});
