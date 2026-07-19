import { describe, it, expect, vi } from "vitest";
import { createGmailApi } from "./gmail-api.js";

// A Gmail message in the API's wire shape (headers + base64url body + internalDate).
function wireMessage(id: string, opts: { from: string; subject: string; date: string; body: string }) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(new Date(opts.date).getTime()),
    payload: {
      headers: [
        { name: "From", value: opts.from },
        { name: "Subject", value: opts.subject },
        { name: "Date", value: opts.date },
      ],
      body: { data: Buffer.from(opts.body, "utf8").toString("base64url") },
    },
  };
}

// A fetch Response subset shaped like what rest-oauth/gmail-api depend on.
const resp = (status: number, body: unknown): { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> } => ({
  ok: status >= 200 && status < 300,
  status,
  json: (): Promise<unknown> => Promise.resolve(body),
  text: (): Promise<string> => Promise.resolve(JSON.stringify(body)),
});

// A fake Gmail API: routes messages.list vs messages.get, and can gate on the bearer token (for the
// 401→refresh path).
function fakeGmail(opts: { messages: ReturnType<typeof wireMessage>[]; acceptToken?: string }) {
  const listUrls: string[] = [];
  const fetch = vi.fn(async (url: string, init: { headers?: Record<string, string> } = {}) => {
    const token = (init.headers?.["authorization"] ?? "").replace("Bearer ", "");
    if (opts.acceptToken && token !== opts.acceptToken) return resp(401, { error: "invalid" });
    if (url.includes("/messages/")) {
      const id = url.split("/messages/")[1]!.split("?")[0];
      return resp(200, opts.messages.find((x) => x.id === id)!);
    }
    listUrls.push(url);
    return resp(200, { messages: opts.messages.map((m) => ({ id: m.id, threadId: m.threadId })) });
  });
  return { fetch: fetch as never, fetchSpy: fetch, listUrls };
}

describe("createGmailApi.list - live Gmail → GmailMessage[]", () => {
  it("maps the wire shape (headers + base64url body + internalDate) to GmailMessage", async () => {
    const g = fakeGmail({ messages: [wireMessage("g1", { from: "dana@globex.com", subject: "Kickoff", date: "2026-07-15T14:20:00.000Z", body: "checklist please" })] });
    const api = createGmailApi({ getAccessToken: async () => "tok", fetch: g.fetch });
    const out = await api.list();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "g1", threadId: "thread-g1", from: "dana@globex.com", subject: "Kickoff", body: "checklist please" });
    expect(out[0]!.date).toBe("2026-07-15T14:20:00.000Z");
  });

  it("turns the watermark into an after: query", async () => {
    const g = fakeGmail({ messages: [] });
    const api = createGmailApi({ getAccessToken: async () => "tok", fetch: g.fetch });
    await api.list("2026-07-14T00:00:00.000Z");
    const epoch = Math.floor(Date.parse("2026-07-14T00:00:00.000Z") / 1000);
    expect(g.listUrls[0]).toContain(`q=${encodeURIComponent("after:" + epoch)}`);
  });

  it("refreshes and retries once on a 401, then succeeds", async () => {
    const g = fakeGmail({ messages: [wireMessage("g2", { from: "a@b.co", subject: "Hi", date: "2026-07-15T10:00:00.000Z", body: "yo" })], acceptToken: "fresh" });
    const getAccessToken = vi.fn(async (o?: { forceRefresh?: boolean }) => (o?.forceRefresh ? "fresh" : "stale"));
    const api = createGmailApi({ getAccessToken, fetch: g.fetch });
    const out = await api.list();
    expect(out[0]!.id).toBe("g2");
    expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("throws when a refresh still yields a 401 (surfaces needs-auth)", async () => {
    const g = fakeGmail({ messages: [], acceptToken: "never" });
    const api = createGmailApi({ getAccessToken: async () => "stale", fetch: g.fetch });
    await expect(api.list()).rejects.toThrow(/401|gmail/i);
  });
});
