// Live Notion read API - the real list() behind the Notion file connector. Read-only: it
// searches the pages the operator shared, renders each to markdown, and files them under
// sources/notion/; no write-back. Notion needs a Notion-Version header and JSON bodies. fetch + token
// access are injected (hermetic); on a 401 it refreshes once and retries.
import type { NotionPage } from "./notion.js";
import type { FetchLike } from "../rest-oauth.js";
import { PROVIDER_API_BASE } from "./oauth-registry.js";

const NOTION_VERSION = "2022-06-28";

export interface NotionApiDeps {
  getAccessToken: (o?: { forceRefresh?: boolean }) => Promise<string>;
  fetch: FetchLike;
  apiBase?: string;
}

interface RichText { plain_text?: string }
interface Block { type: string; [k: string]: unknown }
interface WirePage { id: string; url?: string; last_edited_time?: string; properties?: Record<string, { type?: string; title?: RichText[] }> }

export function createNotionApi(deps: NotionApiDeps): { list: (since?: string) => Promise<NotionPage[]> } {
  const base = deps.apiBase ?? PROVIDER_API_BASE["notion"]!;

  async function req<T>(path: string, init: { method?: string; body?: string }): Promise<T> {
    const headers = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION, "content-type": "application/json" });
    let token = await deps.getAccessToken();
    let res = await deps.fetch(base + path, { ...init, headers: headers(token) });
    if (res.status === 401) {
      token = await deps.getAccessToken({ forceRefresh: true });
      res = await deps.fetch(base + path, { ...init, headers: headers(token) });
    }
    if (!res.ok) throw new Error(`notion API ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async list(since?: string): Promise<NotionPage[]> {
      const search = await req<{ results?: WirePage[] }>("/v1/search", {
        method: "POST",
        body: JSON.stringify({ filter: { property: "object", value: "page" }, page_size: 100, sort: { direction: "descending", timestamp: "last_edited_time" } }),
      });
      const out: NotionPage[] = [];
      for (const pg of search.results ?? []) {
        const editedAt = pg.last_edited_time ?? new Date(0).toISOString();
        if (since && editedAt <= since) continue; // watermark: only pages edited since last sync
        const t = pageTitle(pg);
        const blocks = await req<{ results?: Block[] }>(`/v1/blocks/${pg.id}/children?page_size=100`, {});
        const body = blocksToMarkdown(blocks.results ?? []);
        out.push({
          id: pg.id,
          title: t,
          markdown: `# ${t}\n\n${body}`.replace(/\n*$/, "\n"),
          editedAt,
          ...(pg.url ? { url: pg.url } : {}),
        });
      }
      return out;
    },
  };
}

function pageTitle(pg: WirePage): string {
  for (const prop of Object.values(pg.properties ?? {})) {
    if (prop?.type === "title") return richText(prop.title) || "Untitled";
  }
  return "Untitled";
}

const richText = (rt?: RichText[]): string => (rt ?? []).map((x) => x.plain_text ?? "").join("");

/** Render Notion's common block types to markdown (best-effort; unknown blocks fall back to text). */
function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => {
      const t = richText((b[b.type] as { rich_text?: RichText[] } | undefined)?.rich_text);
      switch (b.type) {
        case "heading_1": return `# ${t}`;
        case "heading_2": return `## ${t}`;
        case "heading_3": return `### ${t}`;
        case "bulleted_list_item": return `- ${t}`;
        case "numbered_list_item": return `1. ${t}`;
        case "to_do": return `- [${(b["to_do"] as { checked?: boolean } | undefined)?.checked ? "x" : " "}] ${t}`;
        case "quote": return `> ${t}`;
        case "code": return "```\n" + t + "\n```";
        default: return t;
      }
    })
    .filter((line) => line.trim() !== "")
    .join("\n\n");
}
