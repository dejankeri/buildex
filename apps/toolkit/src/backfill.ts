// Backfill helper. The first step when onboarding a company: stage its existing markdown
// knowledge into sources/<label>/ with provenance, so the agent can then file it into the brain via
// the `tidy` verb. This is the mechanical import; the intelligent filing is agent-driven. Used for
// BuildEx-on-BuildEx (the company's own private brain into its team workspace) and for every client backfill.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

export interface BackfillOpts {
  sourceDir: string;
  teamDir: string;
  /** The source label - files land under sources/<label>/. */
  label: string;
  /** ISO timestamp recorded in each file's provenance. */
  at: string;
}

export interface BackfillResult {
  wrote: number;
  skipped: string[];
}

export function backfillIntoSources(opts: BackfillOpts): BackfillResult {
  const root = join(opts.teamDir, "sources", opts.label);
  let wrote = 0;
  const skipped: string[] = [];

  for (const abs of walk(opts.sourceDir)) {
    const rel = relative(opts.sourceDir, abs);
    if (!abs.endsWith(".md")) {
      skipped.push(rel);
      continue;
    }
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const frontmatter = `---\nsource: ${opts.label}\nid: ${rel}\nat: ${opts.at}\n---\n\n`;
    writeFileSync(dest, frontmatter + readFileSync(abs, "utf8").replace(/\n*$/, "\n"));
    wrote++;
  }

  return { wrote, skipped };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) yield* walk(abs);
    else yield abs;
  }
}
