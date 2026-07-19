// Connector framework. The load-bearing property is READ-ONLY BY CONSTRUCTION:
// the only capability a connector's sync() receives is `writeSource`, and that writes exclusively
// under `sources/<name>/` (path-guarded, throws on escape). There is no generic filesystem access
// and no send/egress method anywhere in the interface - outbound actions use the same credentials
// but only through the agent's ask-gated path (invariant 5). This carries the connector gates invariant:
// a background connector sync cannot write outside sources/.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

export interface Provenance {
  source: string;
  id: string;
  at: string;
  link?: string;
}

/** The only surface a connector's sync() is given. Deliberately minimal - write-to-source only. */
export interface SourceContext {
  /** The watermark from the previous sync (undefined on first run). */
  readonly watermark: string | undefined;
  /** Write one filed item under sources/<name>/<relPath>, with provenance frontmatter prepended. */
  writeSource(relPath: string, body: string, prov: Provenance): void;
}

export interface Connector {
  name: string;
  auth: "oauth" | "apikey";
  /** Human cadence hint, e.g. "15m". */
  cadence: string;
  /** A conventions.md section describing how filed material should be organized. */
  filingRecipe: string;
  sync(ctx: SourceContext): Promise<{ watermark: string; wrote: number }>;
}

export interface RunOpts {
  workspaceDir: string;
  now: () => number;
  watermark?: string;
}

export interface RunResult {
  watermark: string;
  wrote: number;
  statusPath: string;
}

export async function runConnectorSync(connector: Connector, opts: RunOpts): Promise<RunResult> {
  const sourceRoot = resolve(join(opts.workspaceDir, "sources", connector.name));
  let wrote = 0;

  const ctx: SourceContext = {
    watermark: opts.watermark,
    writeSource(relPath, body, prov) {
      const target = resolve(join(sourceRoot, relPath));
      const rel = relative(sourceRoot, target);
      // The guard: the resolved target must stay inside sources/<name>/.
      if (isAbsolute(relPath) || rel.startsWith("..") || rel === "") {
        throw new Error(`connector "${connector.name}" may only write under sources/${connector.name}/ (refused ${JSON.stringify(relPath)})`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, renderFrontmatter(prov) + body.replace(/\n*$/, "\n"));
      wrote++;
    },
  };

  const result = await connector.sync(ctx);

  const statusPath = join(sourceRoot, "STATUS.md");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    statusPath,
    `# ${connector.name} - source status\n\n` +
      `Last sync: ${new Date(opts.now()).toISOString()}\n` +
      `Items written this run: ${result.wrote}\n` +
      `Watermark: ${result.watermark}\n`,
  );

  return { watermark: result.watermark, wrote: result.wrote, statusPath };
}

function renderFrontmatter(p: Provenance): string {
  const lines = [`source: ${p.source}`, `id: ${p.id}`, `at: ${p.at}`];
  if (p.link) lines.push(`link: ${p.link}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}
