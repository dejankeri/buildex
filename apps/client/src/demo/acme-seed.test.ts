// The packaged app's demo sandbox seeder: lay down the Acme brain as LOCAL, no-remote repos so
// the "Acme Labs" org is permanently non-syncable, plus the lived-in left rail with FRESH timestamps.
// Uses the REAL bundled core pack (packs/core) so the installed-apps/skills path is exercised too.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { seedAcmeWorkspace } from "./acme-seed.js";
import { SyncEngine } from "../sync/engine.js";

const CORE_PACK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packs", "core");
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "buildex-acme-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("seedAcmeWorkspace - the non-syncable demo sandbox", () => {
  it("creates core + team-acme + private-you as local git repos with NO remote", () => {
    const ws = join(tmp, "ws");
    const roots = seedAcmeWorkspace({ workspace: ws, corePackDir: CORE_PACK });

    expect(roots.map((r) => r.name)).toEqual(["core", "team-acme", "private-you"]);
    for (const r of roots) {
      expect(existsSync(join(r.dir, ".git"))).toBe(true);
      expect(git(["remote"], r.dir)).toBe(""); // sandbox → never syncs
    }
  });

  it("drives the sync engine to the neutral 'local' state (permanently non-syncable)", async () => {
    const ws = join(tmp, "ws");
    const roots = seedAcmeWorkspace({ workspace: ws, corePackDir: CORE_PACK });
    const engine = new SyncEngine({ now: () => 1_700_000_000_000, actor: "operator" });
    for (const r of roots) {
      expect(await engine.syncWritable(r.dir)).toBe("local");
    }
  });

  it("lays down the lived-in company brain and installed apps", () => {
    const ws = join(tmp, "ws");
    seedAcmeWorkspace({ workspace: ws, corePackDir: CORE_PACK });
    // a few signature files across the three repos
    expect(existsSync(join(ws, "core", "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(ws, "team-acme", "decisions", "log.md"), "utf8")).toContain("Weekly release cadence");
    expect(readFileSync(join(ws, "team-acme", "finance", "metrics-q3.md"), "utf8")).toContain("$34,200");
    expect(existsSync(join(ws, "private-you", "notes.md"))).toBe(true);
    // installed apps: the external-app manifest + policy marker + linked skills
    expect(existsSync(join(ws, "team-acme", "apps", "slack", "app.json"))).toBe(true);
    expect(existsSync(join(ws, "team-acme", "policy", "packs", "gmail.json"))).toBe(true);
  });

  it("seeds the daemon-owned left rail (sessions, projects, automations)", () => {
    const ws = join(tmp, "ws");
    seedAcmeWorkspace({ workspace: ws, corePackDir: CORE_PACK });
    expect(existsSync(join(ws, ".projects.json"))).toBe(true);
    expect(existsSync(join(ws, ".automations.json"))).toBe(true);
    // 8 seeded sessions, each a `<uuid>.json`
    const sessions = readdirSync(join(ws, ".sessions")).filter((f) => f.endsWith(".json"));
    expect(sessions.length).toBe(8);
  });

  it("stamps left-rail timestamps relative to the real clock, not a frozen literal", () => {
    const ws = join(tmp, "ws");
    const before = Date.now();
    seedAcmeWorkspace({ workspace: ws, corePackDir: CORE_PACK });
    const after = Date.now();
    // friday-review last ran ~1 day ago (relative to now); prove it tracks the real clock, not build time
    const state = JSON.parse(readFileSync(join(ws, ".automations-state.json"), "utf8")) as Record<string, number>;
    const DAY = 24 * 3600_000;
    expect(state["friday-review"]).toBeGreaterThan(before - 1.5 * DAY);
    expect(state["friday-review"]).toBeLessThanOrEqual(after - 0.5 * DAY);
  });

  it("uses only markup the console renderer supports (no [[wikilinks]], no _underscore_ italics)", () => {
    // The console renderer (web/md.js) supports *asterisk* emphasis and [text](url) links only. The
    // seed is what every launch screenshot shows, so it must never rely on syntax that renders as
    // literal markup. Walk every seeded brain doc and assert it is clean.
    const ws = join(tmp, "ws");
    seedAcmeWorkspace({ workspace: ws, corePackDir: CORE_PACK });
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === ".git") return [];
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : e.name.endsWith(".md") ? [p] : [];
      });
    // Only the company brain is authored seed prose; `core` is the bundled pack (out of scope here).
    for (const f of walk(join(ws, "team-acme"))) {
      const text = readFileSync(f, "utf8");
      expect(text, `${f} must not use [[wikilinks]]`).not.toMatch(/\[\[/);
      expect(text, `${f} must not use _underscore_ italics`).not.toMatch(/(^|[^\w*])_[A-Za-z][^_\n]*_(?=[\s.,)]|$)/m);
    }
  });

  it("is idempotent - a second seed never clobbers an existing repo", () => {
    const ws = join(tmp, "ws");
    seedAcmeWorkspace({ workspace: ws, corePackDir: CORE_PACK });
    const head1 = git(["rev-parse", "HEAD"], join(ws, "team-acme"));
    // re-seed: existing repos are left untouched (invariant #8 - never lose operator work)
    const roots = seedAcmeWorkspace({ workspace: ws, corePackDir: CORE_PACK });
    expect(roots.map((r) => r.name)).toEqual(["core", "team-acme", "private-you"]);
    expect(git(["rev-parse", "HEAD"], join(ws, "team-acme"))).toBe(head1); // same commit → not re-seeded
  });
});
