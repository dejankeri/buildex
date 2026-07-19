// `toolkit connector new <name>` - scaffold a new connector plus its fixture-based hermetic test,
// so a new source starts from the read-only-by-construction framework and a green test harness
//. The generated connector receives only `writeSource` - the safe pattern by
// default.
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ScaffoldOpts {
  name: string;
  /** Directory the connector files are written into (e.g. apps/connectors/src/catalog). */
  dir: string;
}

export function scaffoldConnector(opts: ScaffoldOpts): { files: string[] } {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(opts.name)) {
    throw new Error(`unsafe connector name: ${JSON.stringify(opts.name)} (use lower-case letters, digits, - or _)`);
  }
  const modPath = join(opts.dir, `${opts.name}.ts`);
  const testPath = join(opts.dir, `${opts.name}.test.ts`);
  if (existsSync(modPath) || existsSync(testPath)) {
    throw new Error(`connector "${opts.name}" already exists in ${opts.dir}`);
  }

  const Cap = opts.name.charAt(0).toUpperCase() + opts.name.slice(1);
  writeFileSync(modPath, connectorTemplate(opts.name, Cap));
  writeFileSync(testPath, testTemplate(opts.name, Cap));
  return { files: [modPath, testPath] };
}

function connectorTemplate(name: string, Cap: string): string {
  return `// ${name} connector - read-only by construction (files under sources/${name}/ only).
import type { Connector } from "../framework.js";

export interface ${Cap}Item {
  id: string;
  /** ISO timestamp - watermark ordering key. */
  at: string;
  body: string;
}

export interface ${Cap}Deps {
  list: (since?: string) => Promise<${Cap}Item[]>;
}

export function create${Cap}Connector(deps: ${Cap}Deps): Connector {
  return {
    name: "${name}",
    auth: "apikey",
    cadence: "30m",
    filingRecipe: "TODO: describe how ${name} material should be filed under sources/${name}/.",
    async sync(ctx) {
      const items = await deps.list(ctx.watermark);
      let watermark = ctx.watermark ?? "";
      for (const item of items) {
        ctx.writeSource(\`\${item.id}.md\`, item.body, { source: "${name}", id: item.id, at: item.at });
        if (item.at > watermark) watermark = item.at;
      }
      return { watermark, wrote: items.length };
    },
  };
}
`;
}

function testTemplate(name: string, Cap: string): string {
  return `import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create${Cap}Connector } from "./${name}.js";
import { runConnectorSync } from "../framework.js";

let ws: string;
beforeEach(() => (ws = mkdtempSync(join(tmpdir(), "buildex-${name}-"))));
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const fixture = [{ id: "a1", at: "2026-01-01T00:00:00Z", body: "hello from ${name}" }];

describe("${name} connector (fixture-based, hermetic)", () => {
  it("files items under sources/${name}/ with provenance", async () => {
    const connector = create${Cap}Connector({ list: async () => fixture });
    const res = await runConnectorSync(connector, { workspaceDir: ws, now: () => 0 });
    const doc = readFileSync(join(ws, "sources", "${name}", "a1.md"), "utf8");
    expect(doc).toContain("source: ${name}");
    expect(doc).toContain("hello from ${name}");
    expect(res.wrote).toBe(1);
  });
});
`;
}
