// Live Claude subscription usage for the bottom status strip - the real numbers `/usage` shows.
//
// ── DOCUMENTED BRIGHT-LINE EXCEPTION ─────────────────────────────────────────
// The conductor bright-line (invariant 4) says buildex never reads the operator's provider credential
// to RUN the agent - the agent's `claude` self-authenticates, and the driver never injects a key.
// That still holds: this module is a *display-only* read-out, completely separate from the driver.
// It reads the operator's Claude OAuth token ONLY to call Anthropic's usage endpoint and show the
// operator their own usage percentages. Hard guardrails:
//   • opt-in - only runs when the operator sets `usageOAuth: true` (off by default).
//   • the token is used for exactly one request and never persisted, logged, synced, or committed
//     (the secrets invariant - no keychain value in a repo/log/synced/config/session artifact - holds).
//   • it is never injected into the agent's environment and never becomes ANTHROPIC_API_KEY.
//   • read-only: it fetches a usage stat, nothing else.
// We take the API path (not a PTY-scrape fallback).
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.0";

export interface UsageSegment {
  key: string;
  label: string;
  /** whole-number percent used (0–100) */
  pct: number;
  /** ISO timestamp when this window resets, if the API provides one */
  resetsAt: string | null;
  /** the API's own severity band ("normal" | "warning" | "critical" | …) */
  severity: string;
}
export interface UsageReport {
  segments: UsageSegment[];
  at: number;
  /** true when the numbers are live; false when unavailable (opt-out, no token, fetch error) */
  ok: boolean;
  /** short human reason when !ok (shown as a tooltip; never contains the token) */
  note?: string;
}

export interface TokenRef {
  token: string;
  /** epoch ms the access token expires, if known */
  expiresAt?: number;
}

export interface UsageDeps {
  /** returns the operator's Claude OAuth access token, or null if none is readable */
  readToken: () => TokenRef | null;
  /** performs the usage HTTP request with the given bearer token and returns parsed JSON */
  call: (token: string) => Promise<unknown>;
  now: () => number;
}

// The canonical shape is the API's `limits[]` array; map each entry to a display segment.
type RawLimit = {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
};

function labelFor(l: RawLimit, idx: number): { key: string; label: string } {
  const model = l.scope?.model?.display_name;
  if (model) return { key: model.toLowerCase(), label: model };
  if (l.kind === "session" || l.group === "session") return { key: "session", label: "Session" };
  if (l.kind === "weekly_all" || (l.group === "weekly" && !model)) return { key: "wk", label: "Weekly" };
  return { key: l.kind || `limit${idx}`, label: l.kind || `Limit ${idx + 1}` };
}

/** Map the usage-endpoint JSON into display segments (session, weekly, then any scoped models). */
export function parseUsage(apiJson: unknown): UsageSegment[] {
  const limits = (apiJson as { limits?: RawLimit[] } | null)?.limits;
  if (!Array.isArray(limits)) return [];
  return limits.map((l, i) => {
    const { key, label } = labelFor(l, i);
    const pct = Math.max(0, Math.min(100, Math.round(Number(l.percent) || 0)));
    return { key, label, pct, resetsAt: l.resets_at ?? null, severity: String(l.severity || "normal") };
  });
}

/** Read the token, fetch usage, parse it - returning a report that is safe to serialize (no token). */
export async function fetchUsage(deps: UsageDeps): Promise<UsageReport> {
  const at = deps.now();
  let ref: TokenRef | null;
  try {
    ref = deps.readToken();
  } catch {
    ref = null;
  }
  if (!ref || !ref.token) return { segments: [], at, ok: false, note: "No Claude sign-in found" };
  if (ref.expiresAt && ref.expiresAt <= at) {
    return { segments: [], at, ok: false, note: "Sign-in expired - open Claude Code to refresh" };
  }
  try {
    const json = await deps.call(ref.token);
    const segments = parseUsage(json);
    if (!segments.length) return { segments, at, ok: false, note: "Usage endpoint returned no limits" };
    return { segments, at, ok: true };
  } catch {
    // Never surface the underlying error text - it could echo request details. Keep it generic.
    return { segments: [], at, ok: false, note: "Couldn't reach the usage endpoint" };
  }
}

// ── real ports (not unit-tested; exercised live) ────────────────────────────────────────────────

/** Read the Claude OAuth access token from the file credential store, then the macOS keychain. */
export function nodeTokenReader(configDir: string): () => TokenRef | null {
  const fromRaw = (raw: string): TokenRef | null => {
    try {
      const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth;
      if (oauth?.accessToken) return { token: oauth.accessToken, ...(oauth.expiresAt ? { expiresAt: oauth.expiresAt } : {}) };
    } catch {
      /* fall through */
    }
    return null;
  };
  return () => {
    // 1) file credential store (Linux, and any platform that uses it)
    try {
      const ref = fromRaw(readFileSync(join(configDir, ".credentials.json"), "utf8"));
      if (ref) return ref;
    } catch {
      /* no file creds */
    }
    // 2) macOS keychain (where Claude Code stores creds on a Mac)
    if (process.platform === "darwin") {
      try {
        const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const ref = fromRaw(raw);
        if (ref) return ref;
      } catch {
        /* no keychain creds */
      }
    }
    return null;
  };
}

/** The real usage HTTP call (Node 20+ global fetch), mirroring Claude Code's own headers. */
export function anthropicUsageCall(): (token: string) => Promise<unknown> {
  return async (token) => {
    const res = await fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
      },
    });
    if (!res.ok) throw new Error(`usage ${res.status}`);
    return res.json();
  };
}
