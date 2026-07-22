// Provision/teardown of the throwaway BuildEx workspace. Real FS in a tmpdir (house pattern for
// git-touching tests); no network, no agent.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionRunContext, teardownRunContext } from "./run-context.js";
import { resolveCorePackDir } from "../provision/core-pack.js";

const bases: string[] = [];
afterEach(() => {
  for (const d of bases.splice(0)) rmSync(d, { recursive: true, force: true });
});

function base(): string {
  const d = mkdtempSync(join(tmpdir(), "harness-ctx-"));
  bases.push(d);
  return d;
}

// Resolve the repo root from this test file's location
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("provisionRunContext", () => {
  it("seeds a three-root workspace inside the run dir", () => {
    const ctx = provisionRunContext({ baseDir: base(), corePackDir: resolveCorePackDir({ repoRoot: REPO }), slug: "t1" });
    expect(ctx.roots.length).toBe(3);
    for (const r of ctx.roots) expect(existsSync(join(r.dir, ".git"))).toBe(true);
    expect(ctx.workspace).toBe(join(ctx.runDir, "workspace"));
  });

  it("teardown removes the workspace but keeps the run dir (artifacts survive)", () => {
    const ctx = provisionRunContext({ baseDir: base(), corePackDir: resolveCorePackDir({ repoRoot: REPO }), slug: "t2" });
    teardownRunContext(ctx);
    expect(existsSync(ctx.workspace)).toBe(false);
    expect(existsSync(ctx.runDir)).toBe(true);
  });
});
