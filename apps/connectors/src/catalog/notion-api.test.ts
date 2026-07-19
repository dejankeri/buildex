import { describe, it, expect } from "vitest";
import { createNotionApi } from "./notion-api.js";

const resp = (body: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> } => ({
  ok: status >= 200 && status < 300,
  status,
  json: (): Promise<unknown> => Promise.resolve(body),
  text: (): Promise<string> => Promise.resolve(JSON.stringify(body)),
});

const title = (t: string) => ({ Name: { type: "title", title: [{ plain_text: t }] } });
const rt = (t: string) => ({ rich_text: [{ plain_text: t }] });

function fakeNotion(opts: { pages: { id: string; url?: string; last_edited_time: string; properties: unknown }[]; blocks?: Record<string, unknown[]>; acceptToken?: string }) {
  const fetch = (async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const token = (init.headers?.["authorization"] ?? "").replace("Bearer ", "");
    if (opts.acceptToken && token !== opts.acceptToken) return resp({ message: "unauthorized" }, 401);
    if (url.includes("/v1/search")) return resp({ results: opts.pages.map((p) => ({ object: "page", ...p })) });
    if (url.includes("/blocks/")) {
      const id = url.split("/blocks/")[1]!.split("/")[0]!;
      return resp({ results: opts.blocks?.[id] ?? [] });
    }
    return resp({}, 404);
  }) as never;
  return { fetch };
}

describe("createNotionApi.list - live Notion → NotionPage[]", () => {
  it("maps search results + child blocks to NotionPage (title H1 + markdown body)", async () => {
    const n = fakeNotion({
      pages: [{ id: "p1", url: "https://notion.so/p1", last_edited_time: "2026-07-16T09:00:00.000Z", properties: title("Q3 Roadmap") }],
      blocks: { p1: [
        { type: "heading_2", heading_2: rt("Goals") },
        { type: "bulleted_list_item", bulleted_list_item: rt("Land 3 partners") },
        { type: "paragraph", paragraph: rt("Ship reporting v2") },
      ] },
    });
    const api = createNotionApi({ getAccessToken: async () => "ntok", fetch: n.fetch });
    const out = await api.list();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "p1", title: "Q3 Roadmap", editedAt: "2026-07-16T09:00:00.000Z", url: "https://notion.so/p1" });
    expect(out[0]!.markdown).toContain("# Q3 Roadmap");
    expect(out[0]!.markdown).toContain("## Goals");
    expect(out[0]!.markdown).toContain("- Land 3 partners");
    expect(out[0]!.markdown).toContain("Ship reporting v2");
  });

  it("filters out pages not edited since the watermark", async () => {
    const n = fakeNotion({
      pages: [
        { id: "old", last_edited_time: "2026-07-10T00:00:00.000Z", properties: title("Old") },
        { id: "new", last_edited_time: "2026-07-16T00:00:00.000Z", properties: title("New") },
      ],
      blocks: {},
    });
    const api = createNotionApi({ getAccessToken: async () => "ntok", fetch: n.fetch });
    const out = await api.list("2026-07-15T00:00:00.000Z");
    expect(out.map((p) => p.id)).toEqual(["new"]);
  });

  it("refreshes and retries once on a 401", async () => {
    let forced = false;
    const n = fakeNotion({ pages: [{ id: "p1", last_edited_time: "2026-07-16T00:00:00.000Z", properties: title("Doc") }], blocks: {}, acceptToken: "fresh" });
    const api = createNotionApi({
      getAccessToken: async (o) => { if (o?.forceRefresh) { forced = true; return "fresh"; } return "stale"; },
      fetch: n.fetch,
    });
    const out = await api.list();
    expect(out[0]!.id).toBe("p1");
    expect(forced).toBe(true);
  });
});
