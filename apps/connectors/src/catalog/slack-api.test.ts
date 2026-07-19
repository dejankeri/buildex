import { describe, it, expect } from "vitest";
import { createSlackApi } from "./slack-api.js";

const resp = (body: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> } => ({
  ok: status >= 200 && status < 300,
  status,
  json: (): Promise<unknown> => Promise.resolve(body),
  text: (): Promise<string> => Promise.resolve(JSON.stringify(body)),
});

// Slack Web API: conversations.list → channels, conversations.history → messages. Note Slack returns
// HTTP 200 with {ok:false, error} on failures, so the client must check `ok`, not just the status.
function fakeSlack(opts: { channels: { id: string; name: string }[]; history: Record<string, unknown[]>; authError?: boolean }) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    if (opts.authError) return resp({ ok: false, error: "invalid_auth" });
    if (url.includes("conversations.list")) return resp({ ok: true, channels: opts.channels });
    if (url.includes("conversations.history")) {
      const ch = new URL("http://x" + url.slice(url.indexOf("/api"))).searchParams.get("channel")!;
      return resp({ ok: true, messages: opts.history[ch] ?? [] });
    }
    return resp({ ok: false, error: "unknown_method" });
  }) as never;
  return { fetch, urls };
}

describe("createSlackApi.list - live Slack → SlackMessage[]", () => {
  it("walks channels → history and maps to SlackMessage (ts → ISO, skips system subtypes)", async () => {
    const s = fakeSlack({
      channels: [{ id: "C1", name: "sales" }],
      history: { C1: [
        { ts: "1752597600.000200", user: "dana", text: "Globex signed" },
        { ts: "1752597660.000300", user: "sam", text: "member joined", subtype: "channel_join" }, // skipped
      ] },
    });
    const api = createSlackApi({ getAccessToken: async () => "xoxp", fetch: s.fetch });
    const out = await api.list();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: "sales", user: "dana", text: "Globex signed" });
    expect(out[0]!.id).toBe("C1-1752597600.000200");
    expect(out[0]!.ts).toBe(new Date(1752597600 * 1000).toISOString());
  });

  it("passes the watermark as an oldest= epoch-seconds filter", async () => {
    const s = fakeSlack({ channels: [{ id: "C1", name: "sales" }], history: { C1: [] } });
    const api = createSlackApi({ getAccessToken: async () => "xoxp", fetch: s.fetch });
    await api.list("2026-07-15T16:00:00.000Z");
    const epoch = Math.floor(Date.parse("2026-07-15T16:00:00.000Z") / 1000);
    expect(s.urls.some((u) => u.includes(`oldest=${epoch}`))).toBe(true);
  });

  it("throws a clear re-authorize error when Slack reports an auth failure (200 + ok:false)", async () => {
    const s = fakeSlack({ channels: [], history: {}, authError: true });
    const api = createSlackApi({ getAccessToken: async () => "stale", fetch: s.fetch });
    await expect(api.list()).rejects.toThrow(/invalid_auth|re-authorize|slack/i);
  });
});
