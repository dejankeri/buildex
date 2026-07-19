// Live Slack read API - the real list() behind the Slack file connector. Read-only: it
// walks public channels and files their messages under sources/slack/; no post capability. Slack's
// Web API returns HTTP 200 even on failure (with {ok:false, error}), so we check `ok` explicitly and
// surface an auth error as a re-authorize prompt. fetch + token access are injected (hermetic).
import type { SlackMessage } from "./slack.js";
import type { FetchLike } from "../rest-oauth.js";
import { PROVIDER_API_BASE } from "./oauth-registry.js";

export interface SlackApiDeps {
  getAccessToken: (o?: { forceRefresh?: boolean }) => Promise<string>;
  fetch: FetchLike;
  apiBase?: string;
}

interface SlackChannel { id: string; name: string }
interface SlackWireMessage { ts: string; user?: string; text?: string; subtype?: string }

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_expired", "token_revoked", "account_inactive"]);

export function createSlackApi(deps: SlackApiDeps): { list: (since?: string) => Promise<SlackMessage[]> } {
  const base = deps.apiBase ?? PROVIDER_API_BASE["slack"]!;

  async function call<T extends { ok: boolean; error?: string }>(pathAndQuery: string): Promise<T> {
    const token = await deps.getAccessToken();
    const res = await deps.fetch(base + pathAndQuery, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`slack API ${pathAndQuery} → ${res.status}`);
    const j = (await res.json()) as T;
    if (!j.ok) {
      if (j.error && AUTH_ERRORS.has(j.error)) throw new Error(`slack authorization failed (${j.error}) - please re-authorize`);
      throw new Error(`slack API ${pathAndQuery} → ${j.error ?? "unknown error"}`);
    }
    return j;
  }

  return {
    async list(since?: string): Promise<SlackMessage[]> {
      const { channels = [] } = await call<{ ok: boolean; channels?: SlackChannel[] }>("/conversations.list?types=public_channel&limit=200");
      const oldest = since ? `&oldest=${Math.floor(Date.parse(since) / 1000)}` : "";
      const out: SlackMessage[] = [];
      for (const ch of channels) {
        const { messages = [] } = await call<{ ok: boolean; messages?: SlackWireMessage[] }>(`/conversations.history?channel=${encodeURIComponent(ch.id)}&limit=200${oldest}`);
        for (const m of messages) {
          if (m.subtype || !m.text) continue; // skip joins/leaves/system events
          out.push({
            id: `${ch.id}-${m.ts}`,
            channel: ch.name,
            user: m.user ?? "unknown",
            text: m.text,
            ts: new Date(Math.floor(Number(m.ts) * 1000)).toISOString(), // Slack ts is epoch seconds.micro
          });
        }
      }
      return out;
    },
  };
}
