// CATALOG PACK SCHEMA VALIDATION. Every shipped pack (packs/core/catalog/<id>/pack.json) is validated
// here so a malformed pack FAILS CI instead of vanishing silently from the App Store (the store
// swallows a pack that fails to parse or resolves no faces - a silent gap the operator can't see).
// Mirrors the real loader contract (brain/catalog.ts: PackManifest / PackMcp / countSkills / the
// "must have >=1 face" rule) and catches the drift a type can't: unknown keys, id/folder mismatch,
// dangling skill references, orphan skill dirs.
import { describe, it, expect } from "vitest";
import { validateSkill } from "./skills.js";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// apps/client/src/brain → repo root → packs/core/catalog
const CATALOG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packs", "core", "catalog");
const NAME_RE = /^[a-z][a-z0-9-]*$/; // must match catalog.ts
const PACK_KEYS = new Set(["id", "name", "icon", "summary", "app", "mcp", "apiKey", "provision", "skills", "policy"]);
const MCP_KEYS = new Set(["kind", "url", "command", "args", "env", "scopes", "direct", "policy"]);
const APIKEY_KEYS = new Set(["transport", "header", "prefix", "apiBase", "docsUrl", "hint"]);
const PROVISION_KEYS = new Set([
  "authorizeUrl", "exchangeUrl", "codeParam", "codeField", "hostField",
  "keyPath", "apiBasePath", "envKey", "envBase", "grants", "docsUrl",
]);

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

describe("catalog packs - the escape-hatch (provision) face", () => {
  for (const id of packDirs) {
    const m = JSON.parse(readFileSync(join(CATALOG, id, "pack.json"), "utf8")) as Record<string, unknown>;
    const pv = m.provision as Record<string, unknown> | undefined;
    if (!pv) continue;
    describe(id, () => {
      it("declares only known keys", () => {
        for (const k of Object.keys(pv)) expect(PROVISION_KEYS.has(k), `unknown provision key: ${k}`).toBe(true);
      });
      it("requires the fields the daemon drives the flow from", () => {
        for (const k of ["authorizeUrl", "exchangeUrl", "keyPath", "envKey", "grants", "docsUrl"]) {
          expect(typeof pv[k], `${k} must be a non-empty string`).toBe("string");
          expect((pv[k] as string).trim().length).toBeGreaterThan(0);
        }
      });
      it("carries this credential over https only", () => {
        // Broader than the MCP connection - it never rides plaintext.
        for (const k of ["authorizeUrl", "exchangeUrl", "docsUrl"]) {
          expect((pv[k] as string).startsWith("https://"), `${k} must be https`).toBe(true);
        }
      });
      it("templates both loopback placeholders into the authorize URL", () => {
        // Without these the consent page has no way to send the operator back, and the CSRF nonce
        // never makes the round trip.
        expect(pv.authorizeUrl as string).toContain("{redirect_uri}");
        expect(pv.authorizeUrl as string).toContain("{state}");
      });
      it("says what the grant actually allows, at length", () => {
        // The operator sees this BEFORE the browser opens. A one-word `grants` would defeat the point.
        expect((pv.grants as string).length).toBeGreaterThan(40);
      });
    });
  }
});

describe("catalog packs - pack-shipped classifier corrections (mcp.policy)", () => {
  for (const id of packDirs) {
    const m = JSON.parse(readFileSync(join(CATALOG, id, "pack.json"), "utf8")) as Record<string, unknown>;
    const pol = (m.mcp as Record<string, unknown> | undefined)?.policy as Record<string, unknown> | undefined;
    if (!pol) continue;
    describe(id, () => {
      it("declares only read / gated / hidden", () => {
        for (const k of Object.keys(pol)) expect(["read", "gated", "hidden"].includes(k), `unknown policy key: ${k}`).toBe(true);
      });
      it("uses bare names or {tool, when} rules with non-empty value lists", () => {
        for (const k of ["read", "gated"] as const) {
          for (const e of (pol[k] as unknown[] | undefined) ?? []) {
            if (typeof e === "string") { expect(e.trim().length).toBeGreaterThan(0); continue; }
            const r = e as { tool?: unknown; when?: Record<string, unknown> };
            expect(typeof r.tool).toBe("string");
            for (const vals of Object.values(r.when ?? {})) {
              expect(Array.isArray(vals)).toBe(true);
              expect((vals as unknown[]).length).toBeGreaterThan(0);
            }
          }
        }
      });
      it("keeps `hidden` to bare tool names", () => {
        for (const e of (pol.hidden as unknown[] | undefined) ?? []) expect(typeof e).toBe("string");
      });
    });
  }
});

describe("catalog cleanup - Protocol", () => {
  const m = JSON.parse(readFileSync(join(CATALOG, "protocol", "pack.json"), "utf8")) as Record<string, unknown>;
  const mcp = m.mcp as Record<string, unknown>;

  it("points at the API host, never the app host", () => {
    // app.protocolcrm.com is a static S3 site: it answers /mcp with an HTML 200, so an MCP client gets
    // a garbage body instead of a clean failure and the pack looks connected while being dead.
    expect(mcp.url).toBe("https://api.protocolcrm.com/mcp");
  });

  it("gates the two verbs that can reach a real client, by action", () => {
    // Protocol's outward intent lives in an `action` argument, not the tool name, so the gateway's
    // name heuristic cannot see it: `schedule` and `manage_automations` both read as routine.
    const gated = (mcp.policy as { gated?: { tool: string; when?: Record<string, string[]> }[] }).gated ?? [];
    const byTool = Object.fromEntries(gated.map((r) => [r.tool, r.when?.action ?? []]));
    expect(byTool["schedule"]).toEqual(expect.arrayContaining(["send_reminder", "reminder"]));
    expect(byTool["manage_automations"]).toEqual(expect.arrayContaining(["run"]));
  });

  it("does not gate the actions that stay inside the building", () => {
    // Verified against Protocol's source: `cancel` never notifies the client (the cancellation-email
    // service was never ported) and `activate` cannot fire an automation - only `run` dispatches.
    const gated = (mcp.policy as { gated?: { tool: string; when?: Record<string, string[]> }[] }).gated ?? [];
    const byTool = Object.fromEntries(gated.map((r) => [r.tool, r.when?.action ?? []]));
    expect(byTool["schedule"]).not.toContain("cancel");
    expect(byTool["schedule"]).not.toContain("create");
    expect(byTool["manage_automations"]).not.toContain("activate");
  });

  it("widens `message`, which only reads despite its name", () => {
    expect((mcp.policy as { read?: string[] }).read).toContain("message");
  });
});

// Until now a catalog pack's skills were only checked for "a non-empty SKILL.md" - the teach-a-verb
// checklist ran over `packs/core/skills` alone. A pack skill the agent can't discover (no trigger in
// its description) is a skill that silently never fires, so hold every shipped pack to the same bar.
describe("catalog packs - skills meet the teach-a-verb checklist", () => {
  for (const id of packDirs) {
    const skillsRoot = join(CATALOG, id, "skills");
    if (!existsSync(skillsRoot)) continue;
    for (const name of readdirSync(skillsRoot).filter((d) => statSync(join(skillsRoot, d)).isDirectory())) {
      const file = join(skillsRoot, name, "SKILL.md");
      if (!existsSync(file)) continue;
      it(`${id}/${name}`, () => {
        const r = validateSkill(readFileSync(file, "utf8"));
        expect(r.ok, `${id}/${name}: ${r.issues.join("; ")}`).toBe(true);
      });
      it(`${id}/${name} declares a frontmatter name matching its directory`, () => {
        // The directory name is what installs into the operator's repo and what siblings cross-
        // reference by relative path; a mismatch makes those links dangle.
        const fm = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
        expect(fm, "missing frontmatter").toBeTruthy();
        expect(fm![1]!.match(/^name:\s*(.+)$/m)?.[1]?.trim()).toBe(name);
      });
    }
  }
});
