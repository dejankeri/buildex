// Live Gmail read API - the real `list()` behind the Gmail file connector. Read-only: it only
// lists + fetches messages the operator authorized (gmail.readonly), maps them to GmailMessage, and
// hands them to the connector to file under sources/gmail/. No send capability. fetch + token access
// are injected so this is hermetically testable against a fake Gmail; the access token comes from the
// keychain-backed TokenManager (never from the repo). On a 401 it refreshes once and retries.
import type { GmailMessage } from "./gmail.js";
import type { FetchLike } from "../rest-oauth.js";
import { PROVIDER_API_BASE } from "./oauth-registry.js";

export interface GmailApiDeps {
  getAccessToken: (o?: { forceRefresh?: boolean }) => Promise<string>;
  fetch: FetchLike;
  /** Defaults to the registry's Gmail base; injectable for tests. */
  apiBase?: string;
}

interface WireHeader { name: string; value: string }
interface WirePart { mimeType?: string; body?: { data?: string }; parts?: WirePart[] }
interface WireMessage { id: string; threadId: string; internalDate?: string; payload?: WirePart & { headers?: WireHeader[] } }

export function createGmailApi(deps: GmailApiDeps): { list: (since?: string) => Promise<GmailMessage[]> } {
  const base = deps.apiBase ?? PROVIDER_API_BASE["gmail"]!;

  // One authenticated GET; on 401 force a token refresh and retry exactly once.
  async function get<T>(path: string): Promise<T> {
    let token = await deps.getAccessToken();
    let res = await deps.fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      token = await deps.getAccessToken({ forceRefresh: true });
      res = await deps.fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    }
    if (!res.ok) throw new Error(`gmail API ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async list(since?: string): Promise<GmailMessage[]> {
      const q = since ? `?q=${encodeURIComponent("after:" + Math.floor(Date.parse(since) / 1000))}` : "";
      const listing = await get<{ messages?: { id: string }[] }>(`/gmail/v1/users/me/messages${q}`);
      const out: GmailMessage[] = [];
      for (const { id } of listing.messages ?? []) {
        out.push(mapMessage(await get<WireMessage>(`/gmail/v1/users/me/messages/${id}?format=full`)));
      }
      return out;
    },
  };
}

function mapMessage(m: WireMessage): GmailMessage {
  const headers = m.payload?.headers ?? [];
  const h = (name: string): string => headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const date = m.internalDate
    ? new Date(Number(m.internalDate)).toISOString()
    : h("Date")
      ? new Date(h("Date")).toISOString()
      : new Date(0).toISOString();
  return {
    id: m.id,
    threadId: m.threadId,
    from: h("From"),
    subject: h("Subject"),
    date,
    body: extractBody(m.payload),
    link: `https://mail.google.com/mail/#all/${m.id}`,
  };
}

/** Pull the plain-text body out of a Gmail payload (top-level or first text/plain part). */
function extractBody(payload?: WirePart & { headers?: WireHeader[] }): string {
  if (!payload) return "";
  if (payload.body?.data) return decode(payload.body.data);
  const parts = payload.parts ?? [];
  const part = parts.find((p) => p.mimeType === "text/plain") ?? parts[0];
  return part?.body?.data ? decode(part.body.data) : "";
}

const decode = (data: string): string => Buffer.from(data, "base64url").toString("utf8");
