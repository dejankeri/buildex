import { describe, it, expect } from "vitest";
import { parseUsage, fetchUsage, type TokenRef } from "./usage.js";

const NOW = 1_700_000_000_000;

// a trimmed but faithful copy of the real /api/oauth/usage response
const API_JSON = {
  five_hour: { utilization: 44, resets_at: "2026-07-17T11:39:59Z" },
  seven_day: { utilization: 15, resets_at: "2026-07-23T10:59:59Z" },
  limits: [
    { kind: "session", group: "session", percent: 44, severity: "normal", resets_at: "2026-07-17T11:39:59Z", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 15, severity: "normal", resets_at: "2026-07-23T10:59:59Z", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: null, scope: { model: { display_name: "Fable" } } },
  ],
};

describe("parseUsage", () => {
  it("maps the limits[] array to session / weekly / scoped-model segments", () => {
    const segs = parseUsage(API_JSON);
    expect(segs.map((s) => [s.key, s.label, s.pct])).toEqual([
      ["session", "Session", 44],
      ["wk", "Weekly", 15],
      ["fable", "Fable", 0],
    ]);
    expect(segs[0]!.resetsAt).toBe("2026-07-17T11:39:59Z");
    expect(segs[2]!.resetsAt).toBeNull();
  });

  it("clamps percent to 0–100 and defaults severity", () => {
    const segs = parseUsage({ limits: [{ kind: "session", percent: 130 }] });
    expect(segs[0]!.pct).toBe(100);
    expect(segs[0]!.severity).toBe("normal");
  });

  it("returns [] for a shapeless response", () => {
    expect(parseUsage(null)).toEqual([]);
    expect(parseUsage({})).toEqual([]);
  });
});

describe("fetchUsage", () => {
  const deps = (over: Partial<Parameters<typeof fetchUsage>[0]> & { token?: TokenRef | null }) => ({
    readToken: () => (over.token === undefined ? { token: "t-123" } : over.token),
    call: over.call ?? (async () => API_JSON),
    now: () => NOW,
  });

  it("returns live segments when the token reads and the call succeeds", async () => {
    const r = await fetchUsage(deps({}));
    expect(r.ok).toBe(true);
    expect(r.segments).toHaveLength(3);
  });

  it("is not-ok (never throws) when there is no token", async () => {
    const r = await fetchUsage(deps({ token: null }));
    expect(r.ok).toBe(false);
    expect(r.segments).toEqual([]);
    expect(r.note).toMatch(/sign-in/i);
  });

  it("is not-ok when the access token is expired", async () => {
    const r = await fetchUsage(deps({ token: { token: "t", expiresAt: NOW - 1 } }));
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/expired/i);
  });

  it("swallows fetch errors and never leaks the reason text", async () => {
    const r = await fetchUsage(
      deps({
        call: async () => {
          throw new Error("401 secret-token-in-url");
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.note).not.toMatch(/secret-token/);
  });
});
