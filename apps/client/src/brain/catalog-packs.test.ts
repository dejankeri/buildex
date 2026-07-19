// CATALOG PACK SCHEMA VALIDATION. Every shipped pack (packs/core/catalog/<id>/pack.json) is validated
// here so a malformed pack FAILS CI instead of vanishing silently from the App Store (the store
// swallows a pack that fails to parse or resolves no faces - a silent gap the operator can't see).
// Mirrors the real loader contract (brain/catalog.ts: PackManifest / PackMcp / countSkills / the
// "must have >=1 face" rule) and catches the drift a type can't: unknown keys, id/folder mismatch,
// dangling skill references, orphan skill dirs.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// apps/client/src/brain → repo root → packs/core/catalog
const CATALOG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packs", "core", "catalog");
const NAME_RE = /^[a-z][a-z0-9-]*$/; // must match catalog.ts
const PACK_KEYS = new Set(["id", "name", "icon", "summary", "app", "mcp", "apiKey", "skills", "policy"]);
const MCP_KEYS = new Set(["kind", "url", "command", "args", "env", "scopes", "direct"]);
const APIKEY_KEYS = new Set(["transport", "header", "prefix", "apiBase", "docsUrl", "hint"]);

const packDirs = readdirSync(CATALOG).filter((n) => existsSync(join(CATALOG, n, "pack.json")));

describe("catalog packs - schema validation (a malformed pack must fail CI, never vanish silently)", () => {
  it("the catalog ships packs", () => {
    expect(packDirs.length).toBeGreaterThan(0);
  });

  for (const id of packDirs) {
    const dir = join(CATALOG, id);
    let m: Record<string, unknown> | null = null;
    let parseErr: string | null = null;
    try {
      m = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as Record<string, unknown>;
    } catch (e) {
      parseErr = e instanceof Error ? e.message : String(e);
    }

    describe(`pack: ${id}`, () => {
      it("is valid JSON", () => {
        expect(parseErr, `pack.json did not parse: ${parseErr}`).toBeNull();
      });
      if (!m) return;
      const mm = m;

      it("id is kebab-case and matches the folder name", () => {
        expect(mm.id).toBe(id);
        expect(NAME_RE.test(String(mm.id))).toBe(true);
      });

      it("has a non-empty name, icon and summary (the store renders all three)", () => {
        for (const k of ["name", "icon", "summary"]) {
          expect(typeof mm[k], `${k} must be a string`).toBe("string");
          expect((mm[k] as string).trim().length).toBeGreaterThan(0);
        }
      });

      it("has no unknown top-level keys (typo guard - a stray key is silently ignored by the loader)", () => {
        for (const k of Object.keys(mm)) expect(PACK_KEYS.has(k), `unknown pack key: ${k}`).toBe(true);
      });

      it("declares at least one face (app | mcp | a resolvable skill) - or the loader drops it", () => {
        const skills = Array.isArray(mm.skills) ? (mm.skills as string[]) : [];
        const resolvable = skills.filter((s) => NAME_RE.test(s) && existsSync(join(dir, "skills", s, "SKILL.md")));
        expect(Boolean(mm.app) || Boolean(mm.mcp) || resolvable.length > 0).toBe(true);
      });

      it("app face (if present) has a url", () => {
        if (!mm.app) return;
        expect(typeof (mm.app as { url?: unknown }).url).toBe("string");
      });

      it("mcp face (if present) is well-formed: kind, url/command, known keys, correct direct/scopes types", () => {
        if (!mm.mcp) return;
        const mcp = mm.mcp as Record<string, unknown>;
        expect(["http", "stdio"], `bad mcp.kind: ${String(mcp.kind)}`).toContain(mcp.kind);
        if (mcp.kind === "http") expect(typeof mcp.url, "http mcp needs a url").toBe("string");
        if (mcp.kind === "stdio") expect(typeof mcp.command, "stdio mcp needs a command").toBe("string");
        if ("direct" in mcp) expect(typeof mcp.direct).toBe("boolean");
        if ("scopes" in mcp) expect(Array.isArray(mcp.scopes)).toBe(true);
        for (const k of Object.keys(mcp)) expect(MCP_KEYS.has(k), `unknown mcp key: ${k}`).toBe(true);
      });

      it("apiKey face (if present) is well-formed: transport, docsUrl, known keys, apiBase only for rest", () => {
        if (!mm.apiKey) return;
        const ak = mm.apiKey as Record<string, unknown>;
        expect(["mcp-bearer", "rest"], `bad apiKey.transport: ${String(ak.transport)}`).toContain(ak.transport);
        expect(typeof ak.docsUrl, "apiKey needs a docsUrl").toBe("string");
        expect((ak.docsUrl as string).startsWith("https://"), "docsUrl must be https").toBe(true);
        for (const k of Object.keys(ak)) expect(APIKEY_KEYS.has(k), `unknown apiKey key: ${k}`).toBe(true);
        // A mcp-bearer key rides the pack's own MCP url, so the pack must also declare an mcp face.
        if (ak.transport === "mcp-bearer") expect(Boolean(mm.mcp), "mcp-bearer apiKey needs an mcp face").toBe(true);
        // A rest key targets a REST base the gateway connector calls.
        if (ak.transport === "rest") expect(typeof ak.apiBase, "rest apiKey needs an apiBase").toBe("string");
      });

      it("every declared skill resolves to a non-empty SKILL.md", () => {
        const skills = Array.isArray(mm.skills) ? (mm.skills as string[]) : [];
        for (const s of skills) {
          expect(NAME_RE.test(s), `bad skill name: ${s}`).toBe(true);
          const p = join(dir, "skills", s, "SKILL.md");
          expect(existsSync(p), `missing SKILL.md for declared skill: ${s}`).toBe(true);
          expect(readFileSync(p, "utf8").trim().length).toBeGreaterThan(0);
        }
      });

      it("has no orphan skill dirs (every skills/<dir> is declared in skills[])", () => {
        const skillsRoot = join(dir, "skills");
        if (!existsSync(skillsRoot)) return;
        const declared = new Set(Array.isArray(mm.skills) ? (mm.skills as string[]) : []);
        for (const d of readdirSync(skillsRoot)) {
          if (statSync(join(skillsRoot, d)).isDirectory())
            expect(declared.has(d), `orphan skill dir not in skills[]: ${d}`).toBe(true);
        }
      });
    });
  }
});

// The App-store-cleanup connection decisions, pinned so a regression fails CI
// (spec: .local/specs/2026-07-19-app-store-connections-design.md).
describe("catalog cleanup - connection decisions", () => {
  const load = (id: string): Record<string, unknown> | null =>
    existsSync(join(CATALOG, id, "pack.json"))
      ? (JSON.parse(readFileSync(join(CATALOG, id, "pack.json"), "utf8")) as Record<string, unknown>)
      : null;

  it("drops the non-DCR, no-key Google packs", () => {
    for (const id of ["gmail", "google-calendar", "google-drive"]) expect(load(id), `${id} should be dropped`).toBeNull();
  });

  it("routes the DCR apps through the gateway - no stale `direct` pin", () => {
    for (const id of ["asana", "protocol", "stripe", "intercom", "notion", "linear", "calendly", "canva", "heygen"]) {
      const m = load(id);
      expect(m, `${id} missing`).not.toBeNull();
      const mcp = m!.mcp as Record<string, unknown> | undefined;
      expect(mcp, `${id} should keep its mcp face`).toBeTruthy();
      expect(mcp!.direct, `${id} must not be direct-pinned (it supports DCR)`).toBeUndefined();
    }
  });

  it("exposes the dual-door key on the servers that accept it (mcp-bearer)", () => {
    for (const id of ["stripe", "protocol", "intercom"]) {
      const ak = load(id)!.apiKey as Record<string, unknown> | undefined;
      expect(ak?.transport, `${id} should offer a mcp-bearer key`).toBe("mcp-bearer");
    }
  });

  it("keeps HubSpot + Slack as API-key-only (mcp dropped)", () => {
    for (const id of ["hubspot", "slack"]) {
      const m = load(id)!;
      expect(m.mcp, `${id} mcp should be dropped`).toBeUndefined();
      expect((m.apiKey as Record<string, unknown>)?.transport, `${id} should be a rest key`).toBe("rest");
    }
  });
});
