// Notion connector. Read-only by construction - files pages under sources/notion/;
// no write-back to Notion (edits flow through the agent's gated path, never the connector).
import type { Connector } from "../framework.js";

export interface NotionPage {
  id: string;
  title: string;
  markdown: string;
  /** ISO timestamp of the last edit - watermark ordering key. */
  editedAt: string;
  url?: string;
}

export interface NotionDeps {
  list: (since?: string) => Promise<NotionPage[]>;
}

export function createNotionConnector(deps: NotionDeps): Connector {
  return {
    name: "notion",
    auth: "oauth",
    cadence: "30m",
    filingRecipe:
      "File each page under sources/notion/<pageId>.md, keeping the page title as the H1 and the " +
      "body as markdown; overwrite on re-sync so the file mirrors the current page.",
    async sync(ctx) {
      const pages = await deps.list(ctx.watermark);
      let watermark = ctx.watermark ?? "";
      for (const p of pages) {
        ctx.writeSource(`${p.id}.md`, p.markdown, {
          source: "notion",
          id: p.id,
          at: p.editedAt,
          ...(p.url ? { link: p.url } : {}),
        });
        if (p.editedAt > watermark) watermark = p.editedAt;
      }
      return { watermark, wrote: pages.length };
    },
  };
}
